import { OpenAIProvider } from '../provider/openai-provider.js';
import { ChatMessage, CompletionResult } from '../provider/types.js';
import { ToolRegistry, ToolExecutionContext } from '../tools/tool-registry.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import { TurnContext } from '../runtime/turn-context.js';
import { Milestone } from './dag.js';
import { LoopDetector } from './loop-detector.js';
import { ErrorClassifier } from './error-classifier.js';
import { VerificationGuard } from './verification-guard.js';
import { ToolRouter } from './tool-router.js';
import { DynamicContextAssembler } from '../context/dynamic-context-assembler.js';
import {
  aggregateStream,
  parseToolCalls,
  reportParseErrors,
  runToolCalls,
  createElicitationBridge,
} from './agent-loop-core.js';

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
    public readonly provider: OpenAIProvider | undefined,
    private readonly toolRegistry: ToolRegistry,
    public readonly skillRegistry: SkillRegistry,
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
    userHint?: string,
    maxStepsOverride?: number
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

    const maxStepsPerTurn = maxStepsOverride ?? (Number(process.env.MAX_STEPS_PER_TURN) || 60);
    const maxModelIterations = Number(process.env.MAX_MODEL_ITERATIONS) || 12;
    const loopDetector = new LoopDetector(maxStepsPerTurn, 2, maxModelIterations);
    let forcedAnswerAttempt = false;
    let consecutiveVerificationFailures = 0;

    // ACP elicitation bridge for the `question` tool (true blocking when connected)
    const requestElicitation = createElicitationBridge(turnContext);

    // If no LLM provider (offline/mock mode), perform direct mock execution
    if (!this.provider) {
      const step = turnContext.createStep({
        stepType: 'MODEL_CALL',
        metadata: { milestoneId: milestone.id },
      });
      step.end({ status: 'SUCCESS' });
      milestone.resultSummary = `Milestone '${milestone.title}' executed successfully (offline mode).`;

      // Emit agent_message_chunk so ACP client receives output
      turnContext.dispatcher?.emitSessionUpdate({
        sessionId: toolContext.threadId,
        updateType: 'agent_message_chunk',
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `${milestone.resultSummary}\n` },
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `${milestone.resultSummary}\n` },
        },
        data: { text: `${milestone.resultSummary}\n` },
        timestamp: Date.now(),
      });

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

        loopDetector.recordModelIteration();
        const budgetStatus = loopDetector.getBudgetStatus();

        // Check Circuit Breaker for dead loops or oscillation
        const breaker = loopDetector.checkCircuitBreaker();
        if (breaker.tripped) {
          // If dead-loop or cognitive oscillation, block immediately
          if (breaker.reason?.includes('dead-loop') || breaker.reason?.includes('oscillation')) {
            return {
              status: 'BLOCKED',
              summary: `Circuit breaker tripped during milestone '${milestone.id}'.`,
              error: breaker.reason,
              remedySuggestion: 'Inspect the dead-loop error and supply guidance or manually fix conflict.',
            };
          }

          // If budget exhaustion happened after a forced answer was already attempted, block
          if (forcedAnswerAttempt) {
            return {
              status: 'BLOCKED',
              summary: `Circuit breaker tripped during milestone '${milestone.id}'.`,
              error: breaker.reason,
              remedySuggestion: 'Inspect the dead-loop error and supply guidance or manually fix conflict.',
            };
          }
        }

        let isForcingAnswer = false;
        if (budgetStatus.shouldForceAnswer) {
          // Graceful degradation: budget reached, disable tools and force final synthesis
          isForcingAnswer = true;
          forcedAnswerAttempt = true;
          localTurnMessages.push({
            role: 'user',
            content:
              '⚠️ [SYSTEM INSTRUCTION - BUDGET REACHED]: Exploration budget is reached. Tools are now DISABLED. ' +
              'Synthesize your complete and comprehensive final answer based on all information already gathered above.',
          });
        } else if (budgetStatus.shouldWarnBudget) {
          localTurnMessages.push({
            role: 'user',
            content:
              '⚠️ [SYSTEM NOTICE]: Exploration budget for this milestone is nearly exhausted. ' +
              'Do NOT call additional exploration tools unless strictly necessary. Directly provide your final answer now.',
          });
        }

        // Dynamically get active tools and minimal assembled context
        const isConversational = milestone.title === 'Direct Conversational Response';
        const activeToolSchemas = (isConversational || isForcingAnswer)
          ? undefined
          : this.toolRouter.getActiveToolSchemas(turnContext.turnId, 'worker', milestone.assignedSkill);

        const assembledMessages = this.contextAssembler.assemble({
          threadPrompt: toolContext.prompt || toolContext.threadId,
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

        let response: CompletionResult;
        try {
          const stream = this.provider.chatStream({
            messages: assembledMessages,
            tools: activeToolSchemas,
            temperature: 0.2,
            abortSignal: toolContext.abortSignal,
          });

          const emitChunk = (
            updateType: 'agent_thought_chunk' | 'agent_message_chunk',
            text: string
          ) => {
            turnContext.dispatcher?.emitSessionUpdate({
              sessionId: toolContext.threadId,
              updateType,
              sessionUpdate: updateType,
              content: { type: 'text', text },
              update: {
                sessionUpdate: updateType,
                content: { type: 'text', text },
              },
              data: { text },
              timestamp: Date.now(),
            });
          };

          // Shared kernel: fold SSE deltas (content/thought/tool_calls/usage)
          response = await aggregateStream(
            stream,
            {
              onThought: (t) => emitChunk('agent_thought_chunk', t),
              onContent: (t) => emitChunk('agent_message_chunk', t),
            },
            undefined
          );

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

        // 3. Check if Model wants to call Tools (shared AgentLoopCore kernel)
        if (response.toolCalls && response.toolCalls.length > 0) {
          const { executable, parseErrors } = parseToolCalls(response.toolCalls);
          const runCtx = {
            toolRegistry: this.toolRegistry,
            turnContext,
            toolContext,
            loopDetector,
            requestElicitation,
          };
          for (const msg of reportParseErrors(runCtx, parseErrors)) {
            localTurnMessages.push(msg);
          }
          if (executable.length === 0) continue;

          const executed = await runToolCalls(runCtx, executable);
          let fatalReturn: WorkerExecutionResult | undefined;
          for (const e of executed) {
            if (e.fatalError && !fatalReturn) {
              fatalReturn = {
                status: 'BLOCKED',
                summary: `Fatal tool failure in ${e.toolName}: ${e.fatalError}`,
                error: e.fatalError,
                remedySuggestion: e.fatalRemedy,
              };
            }
            localTurnMessages.push({
              role: 'tool',
              tool_call_id: e.toolCallId,
              content: e.hasError
                ? `Tool '${e.toolName}' failed: ${e.error}${e.output && e.output !== e.error ? `\nOutput: ${e.output.slice(0, 2000)}` : ''}`
                : e.output,
            });
          }
          if (fatalReturn) return fatalReturn;
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
            consecutiveVerificationFailures++;
            if (consecutiveVerificationFailures >= 2) {
              return {
                status: 'BLOCKED',
                summary: `Milestone '${milestone.title}' failed acceptance verification after ${consecutiveVerificationFailures} attempts.`,
                error: verification.message,
                remedySuggestion: 'Please verify the milestone criteria or resolve the failing check.',
              };
            }

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
