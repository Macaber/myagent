import { OpenAIProvider } from '../provider/openai-provider.js';
import { CompletionResult } from '../provider/types.js';
import {
  aggregateStream,
  parseToolCalls,
  reportParseErrors,
  runToolCalls,
  createElicitationBridge,
} from './agent-loop-core.js';
import { ToolRegistry, ToolExecutionContext } from '../tools/tool-registry.js';
import { ToolRouter } from './tool-router.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import { DynamicContextAssembler } from '../context/dynamic-context-assembler.js';
import { ThreadContext } from '../runtime/thread-context.js';
import { TurnContext } from '../runtime/turn-context.js';
import { LoopDetector } from './loop-detector.js';
import { ErrorClassifier } from './error-classifier.js';
import { isConversationalGoal } from './planner.js';
import {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  convertToChatMessages,
} from './agent-message.js';
import { shouldCompact, compactHistory } from './compaction.js';

export interface DirectAgentLoopOptions {
  threadContext: ThreadContext;
  turnContext: TurnContext;
  toolContext: ToolExecutionContext;
  provider?: OpenAIProvider;
  toolRegistry?: ToolRegistry;
  toolRouter?: ToolRouter;
  skillRegistry?: SkillRegistry;
  contextAssembler?: DynamicContextAssembler;
  userHint?: string;
  steeringQueue?: UserMessage[];
  maxSteps?: number;
  contextWindow?: number;
  abortSignal?: AbortSignal;
}

export interface DirectAgentLoopResult {
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  summary: string;
  error?: string;
  totalSteps?: number;
}

export class DirectAgentLoop {
  constructor(
    private readonly provider?: OpenAIProvider,
    private readonly toolRegistry: ToolRegistry = new ToolRegistry(),
    private readonly toolRouter: ToolRouter = new ToolRouter(toolRegistry),
    private readonly skillRegistry: SkillRegistry = new SkillRegistry(),
    private readonly contextAssembler: DynamicContextAssembler = new DynamicContextAssembler()
  ) {}

  public async run(options: DirectAgentLoopOptions): Promise<DirectAgentLoopResult> {
    const {
      threadContext,
      turnContext,
      toolContext,
      provider = this.provider,
      toolRegistry = this.toolRegistry,
      toolRouter = this.toolRouter,
      skillRegistry = this.skillRegistry,
      contextAssembler = this.contextAssembler,
      userHint,
      steeringQueue,
      maxSteps,
      contextWindow = 128000,
      abortSignal,
    } = options;

    const rawPrompt = threadContext.prompt || 'Continue';
    const isConversational = isConversationalGoal(rawPrompt);

    // Initial conversation state for this turn
    const messages: AgentMessage[] = [
      {
        role: 'user',
        content: userHint ? `${rawPrompt}\n[User Directive]: ${userHint}` : rawPrompt,
        timestamp: Date.now(),
      },
    ];

    const maxStepsPerTurn = maxSteps ?? (Number(process.env.MAX_STEPS_PER_TURN) || 60);
    const maxModelIterations = Number(process.env.MAX_MODEL_ITERATIONS) || 12;
    const loopDetector = new LoopDetector(maxStepsPerTurn, 2, maxModelIterations);

    // ACP elicitation bridge for the `question` tool (shared kernel helper)
    const requestElicitation = createElicitationBridge(turnContext);

    let forcedAnswerAttempt = false;
    let accumulatedTokens = 0;
    let lastAssistantContent = '';
    let totalStepsCount = 0;

    // Offline mock execution fallback
    if (!provider) {
      totalStepsCount++;
      const step = turnContext.createStep({
        stepType: 'MODEL_CALL',
        metadata: { mode: 'direct_agent_loop_offline' },
      });
      step.end({ status: 'SUCCESS' });
      const summary = `Task "${rawPrompt}" executed successfully (offline mode).`;
      turnContext.dispatcher?.emitSessionUpdate({
        sessionId: toolContext.threadId,
        updateType: 'agent_message_chunk',
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `${summary}\n` },
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `${summary}\n` },
        },
        data: { text: `${summary}\n` },
        timestamp: Date.now(),
      });
      return { status: 'COMPLETED', summary, totalSteps: totalStepsCount };
    }

    try {
      while (true) {
        if (abortSignal?.aborted) {
          throw new Error('Direct agent loop aborted by client');
        }

        loopDetector.recordModelIteration();
        const budgetStatus = loopDetector.getBudgetStatus();

        // 1. Circuit Breaker
        const breaker = loopDetector.checkCircuitBreaker();
        if (breaker.tripped) {
          if (breaker.reason?.includes('dead-loop') || breaker.reason?.includes('oscillation') || forcedAnswerAttempt) {
            return {
              status: 'FAILED',
              summary: `Circuit breaker tripped: ${breaker.reason}`,
              error: breaker.reason,
              totalSteps: totalStepsCount,
            };
          }
        }

        let isForcingAnswer = false;
        if (budgetStatus.shouldForceAnswer) {
          isForcingAnswer = true;
          forcedAnswerAttempt = true;
          messages.push({
            role: 'user',
            content:
              '⚠️ [SYSTEM INSTRUCTION - BUDGET REACHED]: Exploration budget is reached. Tools are now DISABLED. Synthesize your complete final answer based on all gathered context.',
          });
        } else if (budgetStatus.shouldWarnBudget) {
          messages.push({
            role: 'user',
            content:
              '⚠️ [SYSTEM NOTICE]: Budget nearly exhausted. Do NOT call additional tools unless strictly necessary. Deliver your final response now.',
          });
        }

        // 2. Compaction Check
        if (shouldCompact(accumulatedTokens, contextWindow, 0.75)) {
          const compactionRes = await compactHistory(messages, {
            preserveRecentCount: 4,
            provider,
            currentTokens: accumulatedTokens,
          });
          messages.length = 0;
          messages.push(...compactionRes.compactedMessages);
        }

        // 3. Active Tool Schemas
        // If conversational goal (e.g. "你好", "你会做什么？", "你是谁？"), disable tools completely
        const activeToolSchemas = isConversational || isForcingAnswer
          ? undefined
          : toolRouter.getActiveToolSchemas(turnContext.turnId, 'worker');

        // 4. Assemble Full Context
        const chatMessages = convertToChatMessages(messages);
        const assembledMessages = contextAssembler.assemble({
          threadPrompt: rawPrompt,
          turnId: turnContext.turnId,
          stage: 'worker',
          blackboard: toolContext.blackboard,
          skillRegistry,
          recentMessages: chatMessages,
        });

        // 5. Model Call Step
        totalStepsCount++;
        const modelStep = turnContext.createStep({
          stepType: 'MODEL_CALL',
          metadata: { isConversational },
        });

        let response: CompletionResult;
        try {
          const stream = provider.chatStream({
            messages: assembledMessages,
            tools: activeToolSchemas,
            temperature: isConversational ? 0.4 : 0.2,
            abortSignal,
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
            accumulatedTokens += response.usage.totalTokens;
            toolContext.blackboard.recordTokenUsage(response.usage.totalTokens);
          }

          modelStep.end({
            status: 'SUCCESS',
            tokens: response.usage,
          });

          if (response.content) {
            lastAssistantContent = response.content;
          }
        } catch (err: any) {
          modelStep.end({ status: 'FAILED', errorMessage: err.message });
          const classified = ErrorClassifier.classify(err);
          if (classified.severity === 'FATAL') {
            return {
              status: 'FAILED',
              summary: `Fatal error encountered: ${err.message}`,
              error: err.message,
              totalSteps: totalStepsCount,
            };
          }
          throw err;
        }

        // Add Assistant Message to conversation
        messages.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
          timestamp: Date.now(),
        });

        // 6. If no tool calls requested, we are done!
        if (!response.toolCalls || response.toolCalls.length === 0) {
          return {
            status: 'COMPLETED',
            summary: lastAssistantContent || 'Completed successfully.',
            totalSteps: totalStepsCount,
          };
        }

        // 7. Execute Tool Calls (shared AgentLoopCore kernel:
        // strict arg parsing, read-parallel/write-serial, ordered steps)
        {
          const { executable, parseErrors } = parseToolCalls(response.toolCalls);
          const runCtx = {
            toolRegistry,
            turnContext,
            toolContext,
            loopDetector,
            requestElicitation,
          };
          for (const msg of reportParseErrors(runCtx, parseErrors)) {
            totalStepsCount++;
            messages.push({
              role: 'tool',
              tool_call_id: msg.tool_call_id,
              toolName: 'parse_error',
              content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
              isError: true,
              timestamp: Date.now(),
            } as ToolResultMessage);
          }
          if (executable.length > 0) {
            const executed = await runToolCalls(runCtx, executable);
            totalStepsCount += executed.length;
            for (const e of executed) {
              if (e.fatalError) {
                return {
                  status: 'FAILED',
                  summary: `Fatal tool failure in ${e.toolName}: ${e.fatalError}`,
                  error: e.fatalError,
                  totalSteps: totalStepsCount,
                };
              }
              messages.push({
                role: 'tool',
                tool_call_id: e.toolCallId,
                toolName: e.toolName,
                content: e.output,
                isError: e.hasError,
                timestamp: Date.now(),
              });
            }
          }
        }

        // 8. In-Turn Steering Check: Pick up steering messages queued while tools were executing
        if (steeringQueue && steeringQueue.length > 0) {
          while (steeringQueue.length > 0) {
            const steering = steeringQueue.shift()!;
            messages.push({
              role: 'user',
              content: steering.content,
              isSteering: true,
              timestamp: Date.now(),
            });

            turnContext.dispatcher?.emitSessionUpdate({
              sessionId: toolContext.threadId,
              updateType: 'agent_thought_chunk',
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: `[User Steering Intervened]: ${steering.content}\n` },
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: `[User Steering Intervened]: ${steering.content}\n` },
              },
              data: { text: `[User Steering Intervened]: ${steering.content}\n` },
              timestamp: Date.now(),
            });
          }
        }
      }
    } catch (err: any) {
      return {
        status: abortSignal?.aborted ? 'CANCELLED' : 'FAILED',
        summary: err.message,
        error: err.message,
        totalSteps: totalStepsCount,
      };
    }
  }
}
