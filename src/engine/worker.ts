import { OpenAIProvider } from '../provider/openai-provider.js';
import { ChatMessage } from '../provider/types.js';
import { ToolRegistry, ToolExecutionContext } from '../tools/tool-registry.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import { TurnContext } from '../runtime/turn-context.js';
import { Milestone } from './dag.js';
import { LoopDetector } from './loop-detector.js';
import { ErrorClassifier } from './error-classifier.js';
import { VerificationGuard } from './verification-guard.js';
import { ToolRouter } from './tool-router.js';
import { DynamicContextAssembler } from '../context/dynamic-context-assembler.js';

export interface WorkerExecutionResult {
  status: 'SUCCESS' | 'FAILED' | 'BLOCKED';
  summary: string;
  error?: string;
  remedySuggestion?: string;
}

export class WorkerAgent {
  public readonly toolRouter: ToolRouter;
  public readonly contextAssembler: DynamicContextAssembler;

  constructor(
    private readonly provider: OpenAIProvider | undefined,
    private readonly toolRegistry: ToolRegistry,
    private readonly skillRegistry: SkillRegistry,
    private readonly verificationGuard: VerificationGuard,
    toolRouter?: ToolRouter,
    contextAssembler?: DynamicContextAssembler
  ) {
    this.toolRouter = toolRouter || new ToolRouter(this.toolRegistry);
    this.contextAssembler = contextAssembler || new DynamicContextAssembler();
  }

  public async executeMilestone(
    milestone: Milestone,
    turnContext: TurnContext,
    toolContext: ToolExecutionContext,
    userHint?: string
  ): Promise<WorkerExecutionResult> {
    // 1. Activate assigned L2 Skill for this turn (turn-scoped)
    const skillName = milestone.assignedSkill || 'developer';
    this.skillRegistry.activateSkillForTurn(turnContext.turnId, skillName);

    // Ephemeral messages for the active milestone
    const localTurnMessages: ChatMessage[] = [
      {
        role: 'user',
        content:
          `Begin execution of milestone '${milestone.title}'.\n` +
          `Objective: ${milestone.description}\n` +
          `Acceptance Criteria: ${milestone.acceptanceCriteria || 'Deliver completed changes and report summary.'}\n` +
          (userHint ? `User Remediation / Directive: "${userHint}"\n` : ''),
      },
    ];

    const loopDetector = new LoopDetector(10, 2);

    // If no LLM provider (offline/mock mode), perform direct mock execution
    if (!this.provider) {
      const step = turnContext.createStep({
        stepType: 'MODEL_CALL',
        metadata: { milestoneId: milestone.id },
      });
      step.end({ status: 'SUCCESS' });
      milestone.resultSummary = `Milestone '${milestone.title}' executed successfully (offline mode).`;

      // Lifecycle cleanup & recording
      toolContext.blackboard.recordMilestoneCompletion(milestone.id, milestone.title, milestone.resultSummary);
      this.skillRegistry.clearTurnSkills(turnContext.turnId);
      this.toolRouter.clearTurnTools(turnContext.turnId);

      return { status: 'SUCCESS', summary: milestone.resultSummary };
    }

    try {
      // 2. ReAct Loop
      while (true) {
        if (toolContext.abortSignal?.aborted) {
          throw new Error('Milestone execution aborted by client');
        }

        // Check Circuit Breaker
        const breaker = loopDetector.checkCircuitBreaker();
        if (breaker.tripped) {
          return {
            status: 'BLOCKED',
            summary: `Circuit breaker tripped during milestone '${milestone.id}'.`,
            error: breaker.reason,
            remedySuggestion: 'Inspect the dead-loop error and supply guidance or manually fix conflict.',
          };
        }

        // Dynamically get active tools and minimal assembled context
        const activeToolSchemas = this.toolRouter.getActiveToolSchemas(turnContext.turnId, 'worker');
        const assembledMessages = this.contextAssembler.assemble({
          threadPrompt: toolContext.threadId,
          turnId: turnContext.turnId,
          stage: 'worker',
          currentMilestoneTitle: milestone.title,
          currentMilestoneDescription: milestone.description,
          blackboard: toolContext.blackboard,
          skillRegistry: this.skillRegistry,
          recentMessages: localTurnMessages,
        });

        // Step: Model Call
        const modelStep = turnContext.createStep({
          stepType: 'MODEL_CALL',
          metadata: { milestoneId: milestone.id },
        });

        let response;
        try {
          response = await this.provider.complete({
            messages: assembledMessages,
            tools: activeToolSchemas,
            temperature: 0.2,
            abortSignal: toolContext.abortSignal,
          });

          if (response.usage) {
            toolContext.blackboard.recordTokenUsage(response.usage.totalTokens);
          }

          modelStep.end({
            status: 'SUCCESS',
            tokens: response.usage,
          });
        } catch (err: any) {
          modelStep.end({ status: 'FAILED', errorMessage: err.message });
          const classified = ErrorClassifier.classify(err);
          if (classified.severity === 'FATAL') {
            return {
              status: 'BLOCKED',
              summary: `Fatal error encountered: ${err.message}`,
              error: err.message,
              remedySuggestion: classified.remedySuggestion,
            };
          }
          throw err;
        }

        // Add Assistant Message to Ephemeral Context
        localTurnMessages.push({
          role: 'assistant',
          content: response.content,
          tool_calls: response.toolCalls,
        });

        // 3. Check if Model wants to call Tools
        if (response.toolCalls && response.toolCalls.length > 0) {
          for (const tc of response.toolCalls) {
            const toolName = tc.function.name;
            let parsedArgs = {};
            try {
              parsedArgs = JSON.parse(tc.function.arguments || '{}');
            } catch {
              parsedArgs = {};
            }

            // Step: Tool Execution
            const toolStep = turnContext.createStep({
              stepType: 'TOOL_EXECUTION',
              toolName,
              metadata: { args: parsedArgs },
            });

            const executionResult = await this.toolRegistry.executeTool(
              toolName,
              parsedArgs,
              {
                ...toolContext,
                turnId: turnContext.turnId,
                stepId: toolStep.stepId,
              }
            );

            const hasError = !!executionResult.error;
            loopDetector.recordAction(toolName, parsedArgs, hasError);

            toolStep.end({
              status: hasError ? 'FAILED' : 'SUCCESS',
              errorMessage: executionResult.error,
            });

            // Check if tool error is Fatal
            if (hasError) {
              const classified = ErrorClassifier.classify(executionResult.error!);
              if (classified.severity === 'FATAL') {
                return {
                  status: 'BLOCKED',
                  summary: `Fatal tool failure in ${toolName}: ${executionResult.error}`,
                  error: executionResult.error,
                  remedySuggestion: classified.remedySuggestion,
                };
              }
            }

            // Push tool response into messages
            localTurnMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: executionResult.output,
            });
          }
        } else {
          // 4. Model produced final answer without tool calls -> Verify Acceptance
          milestone.resultSummary = response.content || 'Completed';

          const verification = await this.verificationGuard.verifyMilestone(milestone, toolContext);
          if (verification.passed) {
            // Success: Record folded milestone summary in blackboard
            toolContext.blackboard.recordMilestoneCompletion(
              milestone.id,
              milestone.title,
              milestone.resultSummary
            );

            return {
              status: 'SUCCESS',
              summary: milestone.resultSummary,
            };
          } else {
            // Verification failed -> Feed back to LLM to self-heal
            localTurnMessages.push({
              role: 'user',
              content: `Acceptance verification failed:\n${verification.message}\nPlease resolve the issue.`,
            });
          }
        }
      }
    } finally {
      // 5. Automatic turn cleanup: unload L2 skills and unmount turn-specific tools
      this.skillRegistry.clearTurnSkills(turnContext.turnId);
      this.toolRouter.clearTurnTools(turnContext.turnId);
    }
  }
}
