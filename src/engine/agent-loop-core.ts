import { randomUUID } from 'node:crypto';
import {
  ChatMessage,
  CompletionResult,
  CompletionUsage,
  StreamDeltaChunk,
  ToolCallItem,
} from '../provider/types.js';
import { ToolRegistry, ToolExecutionContext } from '../tools/tool-registry.js';
import { TurnContext } from '../runtime/turn-context.js';
import { LoopDetector } from './loop-detector.js';
import { ErrorClassifier } from './error-classifier.js';

export const MAX_TOOL_ARGS_CHARS = 262144;

/**
 * Shared kernel for WorkerAgent and DirectAgentLoop (previously ~250 lines of
 * duplicated stream aggregation + tool execution logic each).
 *
 * - aggregateStream: fold an SSE delta stream into a CompletionResult while
 *   streaming thought/content chunks to the client.
 * - parseToolCalls: strict JSON parsing that feeds structured errors back
 *   instead of executing tools with silent `{}` args.
 * - runToolCalls: read-only tools in parallel (≤5), writers serially, with
 *   ordered step reservation, session/update emits, loop-detector recording
 *   and fatal-error classification.
 */

export interface StreamHooks {
  onThought?: (text: string) => void;
  onContent?: (text: string) => void;
}

export async function aggregateStream(
  stream: AsyncGenerator<StreamDeltaChunk>,
  hooks: StreamHooks = {},
  onUsage?: (usage: CompletionUsage) => void
): Promise<CompletionResult> {
  let fullContent = '';
  const toolCallsMap = new Map<number, { id: string; name: string; args: string }>();
  let usage: CompletionUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let finishReason: string | undefined;

  for await (const chunk of stream) {
    if (chunk.type === 'thought' && chunk.thoughtText) {
      hooks.onThought?.(chunk.thoughtText);
    } else if (chunk.type === 'content') {
      if (chunk.deltaText) {
        fullContent += chunk.deltaText;
        hooks.onContent?.(chunk.deltaText);
      }
      if (chunk.finishReason) finishReason = chunk.finishReason;
    } else if (chunk.type === 'tool_call_delta' && chunk.toolCallDelta) {
      const { index, id, name, argumentsChunk } = chunk.toolCallDelta;
      const current = toolCallsMap.get(index) ?? { id: '', name: '', args: '' };
      if (id) current.id = id;
      if (name) current.name = name;
      if (argumentsChunk) {
        current.args = (current.args + argumentsChunk).slice(0, MAX_TOOL_ARGS_CHARS);
      }
      toolCallsMap.set(index, current);
    } else if (chunk.type === 'usage' && chunk.usage) {
      usage = {
        promptTokens: usage.promptTokens + (chunk.usage.promptTokens || 0),
        completionTokens: usage.completionTokens + (chunk.usage.completionTokens || 0),
        totalTokens: usage.totalTokens + (chunk.usage.totalTokens || 0),
      };
      onUsage?.(chunk.usage);
    }
  }

  const toolCalls: ToolCallItem[] = Array.from(toolCallsMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, val]) => ({
      id: val.id || `call_${randomUUID().slice(0, 8)}`,
      type: 'function',
      function: { name: val.name, arguments: val.args },
    }));

  return {
    content: fullContent.length > 0 ? fullContent : null,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
    finishReason,
  };
}

export interface ParsedToolCall {
  raw: ToolCallItem;
  toolName: string;
  toolCallId: string;
  parsedArgs: Record<string, any>;
  parseError?: string;
}

export function parseToolCalls(toolCalls: ToolCallItem[]): {
  executable: ParsedToolCall[];
  parseErrors: ParsedToolCall[];
} {
  const executable: ParsedToolCall[] = [];
  const parseErrors: ParsedToolCall[] = [];
  for (const tc of toolCalls) {
    const toolName = tc.function.name;
    const toolCallId = tc.id || `call_${randomUUID().slice(0, 8)}`;
    try {
      const p = JSON.parse(tc.function.arguments || '{}');
      const entry: ParsedToolCall = {
        raw: tc,
        toolName,
        toolCallId,
        parsedArgs: p === null || typeof p !== 'object' ? {} : p,
      };
      executable.push(entry);
    } catch (parseErr: any) {
      parseErrors.push({
        raw: tc,
        toolName,
        toolCallId,
        parsedArgs: {},
        parseError:
          `Invalid tool arguments JSON for '${toolName}': ${parseErr?.message || parseErr}. ` +
          `Raw: ${(tc.function.arguments || '').slice(0, 500)}`,
      });
    }
  }
  return { executable, parseErrors };
}

export function toolKind(toolName: string): string {
  if (toolName === 'read' || toolName === 'grep' || toolName === 'glob') return 'read';
  if (toolName === 'edit' || toolName === 'write' || toolName === 'patch') return 'edit';
  if (toolName === 'bash') return 'execute';
  return 'other';
}

const READ_PARALLEL_TOOLS = new Set(['read', 'glob', 'grep', 'todowrite', 'skill']);

export interface ExecutedToolCall extends ParsedToolCall {
  output: string;
  error?: string;
  hasError: boolean;
  fatalError?: string;
  fatalRemedy?: string;
}

export interface RunToolCallsContext {
  toolRegistry: ToolRegistry;
  turnContext: TurnContext;
  toolContext: ToolExecutionContext;
  loopDetector?: LoopDetector;
  requestElicitation?: ToolExecutionContext['requestElicitation'];
  maxReadParallel?: number;
}

function emitStart(turnContext: TurnContext, threadId: string, p: ParsedToolCall): void {
  turnContext.dispatcher?.emitSessionUpdate({
    sessionId: threadId,
    updateType: 'tool_call',
    sessionUpdate: 'tool_call',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: p.toolCallId,
      title: p.toolName,
      kind: toolKind(p.toolName),
      status: 'in_progress',
      rawInput: p.parsedArgs,
    },
    timestamp: Date.now(),
  });
}

function emitUpdate(
  turnContext: TurnContext,
  threadId: string,
  toolCallId: string,
  ok: boolean,
  text: string
): void {
  turnContext.dispatcher?.emitSessionUpdate({
    sessionId: threadId,
    updateType: 'tool_call_update',
    sessionUpdate: 'tool_call_update',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: ok ? 'completed' : 'failed',
      content: [{ type: 'content', content: { type: 'text', text: text.slice(0, 2000) } }],
      rawOutput: text,
    },
    timestamp: Date.now(),
  });
}

/**
 * Report parse errors without executing (feeds back for model self-heal).
 * Returns tool-style messages the caller appends to its message list.
 */
export function reportParseErrors(
  ctx: RunToolCallsContext,
  parseErrors: ParsedToolCall[]
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const p of parseErrors) {
    emitUpdate(ctx.turnContext, ctx.toolContext.threadId, p.toolCallId, false, p.parseError!);
    ctx.loopDetector?.recordAction(p.toolName, { __parseError: true }, true);
    out.push({
      role: 'tool',
      tool_call_id: p.toolCallId,
      content: `Tool '${p.toolName}' was NOT executed: ${p.parseError} Please retry with valid JSON arguments.`,
    });
  }
  return out;
}

export async function runToolCalls(
  ctx: RunToolCallsContext,
  executable: ParsedToolCall[]
): Promise<ExecutedToolCall[]> {
  const { toolRegistry, turnContext, toolContext } = ctx;
  if (executable.length === 0) return [];

  for (const p of executable) emitStart(turnContext, toolContext.threadId, p);

  // Reserve steps up-front so stepIds stay ordered under parallel execution
  const steps = executable.map((p) =>
    turnContext.createStep({
      stepType: 'TOOL_EXECUTION',
      toolName: p.toolName,
      metadata: { args: p.parsedArgs },
    })
  );

  const runOne = async (idx: number) => {
    const p = executable[idx];
    const executionResult = await toolRegistry.executeTool(p.toolName, p.parsedArgs, {
      ...toolContext,
      turnId: turnContext.turnId,
      stepId: steps[idx].stepId,
      requestElicitation: ctx.requestElicitation,
    });
    return { p, step: steps[idx], executionResult };
  };

  const readIdx: number[] = [];
  const writeIdx: number[] = [];
  executable.forEach((p, i) => {
    if (READ_PARALLEL_TOOLS.has(p.toolName)) readIdx.push(i);
    else writeIdx.push(i);
  });

  const seen = new Map<number, Awaited<ReturnType<typeof runOne>>>();
  const chunkSize = ctx.maxReadParallel ?? 5;
  for (let s = 0; s < readIdx.length; s += chunkSize) {
    const chunk = readIdx.slice(s, s + chunkSize);
    const results = await Promise.all(chunk.map((i) => runOne(i)));
    for (const r of results) seen.set(executable.indexOf(r.p), r);
    if (toolContext.abortSignal?.aborted) break;
  }
  for (const i of writeIdx) {
    if (toolContext.abortSignal?.aborted) break;
    seen.set(i, await runOne(i));
  }

  const ordered = Array.from(seen.entries())
    .sort(([a], [b]) => a - b)
    .map(([, v]) => v);

  const out: ExecutedToolCall[] = [];
  for (const { p, step, executionResult } of ordered) {
    const hasError = !!executionResult.error;
    ctx.loopDetector?.recordAction(p.toolName, p.parsedArgs, hasError);
    const text = executionResult.output || executionResult.error || '';
    emitUpdate(turnContext, toolContext.threadId, p.toolCallId, !hasError, text);
    step.end({ status: hasError ? 'FAILED' : 'SUCCESS', errorMessage: executionResult.error });

    let fatalError: string | undefined;
    let fatalRemedy: string | undefined;
    if (hasError) {
      const classified = ErrorClassifier.classify(executionResult.error!);
      if (classified.severity === 'FATAL') {
        fatalError = executionResult.error;
        fatalRemedy = classified.remedySuggestion;
      }
    }
    out.push({
      ...p,
      output: text,
      error: executionResult.error,
      hasError,
      fatalError,
      fatalRemedy,
    });
  }
  return out;
}

/** Build the ACP elicitation bridge for the `question` tool. */
export function createElicitationBridge(
  turnContext: TurnContext
): ToolExecutionContext['requestElicitation'] {
  if (!turnContext.dispatcher) return undefined;
  return async (params: { question: string; options?: string[]; threadId: string; turnId?: string }) => {
    const res: any = await turnContext.dispatcher!.requestClient(
      'elicitation/create',
      {
        mode: 'form',
        message: params.question,
        requestedSchema: {
          type: 'object',
          properties: {
            answer: params.options ? { type: 'string', enum: params.options } : { type: 'string' },
          },
          required: ['answer'],
        },
        sessionId: params.threadId,
      },
      300000
    );
    return {
      answer: res?.content?.answer ?? res?.values?.answer ?? res?.answer ?? undefined,
      action: String(res?.action ?? 'cancel'),
    };
  };
}
