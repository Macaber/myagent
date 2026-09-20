import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TruncationConfig {
  maxCharacters?: number; // default 4000 (approx 1000 tokens)
  headCharacters?: number; // default 1200
  tailCharacters?: number; // default 1200
  logDir?: string;
}

export class MemoryCompactor {
  private readonly maxChars: number;
  private readonly headChars: number;
  private readonly tailChars: number;
  private readonly logDir?: string;

  constructor(config: TruncationConfig = {}) {
    this.maxChars = config.maxCharacters ?? 4000;
    this.headChars = config.headCharacters ?? 1200;
    this.tailChars = config.tailCharacters ?? 1200;
    this.logDir = config.logDir;
  }

  public truncateToolOutput(
    output: string,
    contextInfo?: { toolName: string; stepId?: string }
  ): { text: string; isTruncated: boolean; fullLogPath?: string } {
    if (output.length <= this.maxChars) {
      return { text: output, isTruncated: false };
    }

    let fullLogPath: string | undefined;
    if (this.logDir) {
      try {
        if (!fs.existsSync(this.logDir)) {
          fs.mkdirSync(this.logDir, { recursive: true });
        }
        const fileName = `tool_${contextInfo?.toolName || 'unknown'}_${Date.now()}.log`;
        fullLogPath = path.join(this.logDir, fileName);
        fs.writeFileSync(fullLogPath, output, 'utf8');
      } catch (err) {
        console.warn('[MemoryCompactor] Failed to write full log to disk:', err);
      }
    }

    const head = output.slice(0, this.headChars);
    const tail = output.slice(-this.tailChars);
    const omittedChars = output.length - (this.headChars + this.tailChars);
    const logNotice = fullLogPath ? ` Full output written to ${fullLogPath}.` : '';

    const truncatedText = `${head}\n\n... [TRUNCATED ${omittedChars} characters.${logNotice}] ...\n\n${tail}`;

    return {
      text: truncatedText,
      isTruncated: true,
      fullLogPath,
    };
  }

  /**
   * Compaction: Synthesize a series of granular steps into a compact, high-density milestone summary.
   */
  public compactStepHistory(
    steps: Array<{ stepId: string; toolName?: string; output?: string; status?: string }>
  ): string {
    if (steps.length === 0) return 'No steps executed.';

    const actions = steps.map((s, idx) => {
      const tool = s.toolName || 'reasoning';
      const status = s.status || 'OK';
      const snippet = s.output ? s.output.slice(0, 120).replace(/\s+/g, ' ') : '';
      return `${idx + 1}. [${tool}] ${status}${snippet ? `: ${snippet}` : ''}`;
    });

    return `Completed ${steps.length} steps:\n` + actions.join('\n');
  }

  /**
   * Token Watermark Check: If messages exceed the soft token budget, fold older messages
   * into a compact historical summary while preserving system prompt, goal anchor, and recent turns.
   */
  public checkWatermarkAndFold<T extends { role: string; content?: any; tool_call_id?: string; tool_calls?: any[] }>(
    messages: T[],
    maxCharacters: number = 32000,
    keepRecentCount: number = 6
  ): { messages: T[]; wasFolded: boolean } {
    const totalLength = messages.reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 100), 0);

    if (totalLength <= maxCharacters || messages.length <= keepRecentCount + 2) {
      return { messages, wasFolded: false };
    }

    // Preserve first message (System/Goal prompt) and last keepRecentCount messages
    const firstMsg = messages[0];
    let splitIndex = Math.max(1, messages.length - keepRecentCount);

    // CRITICAL: Ensure splitIndex does NOT cut inside a tool call transaction!
    // A role: 'tool' message must never appear without its preceding assistant tool_calls message.
    // First attempt: backtrack to include the assistant message that initiated the tool call.
    let candidate = splitIndex;
    while (candidate > 1 && messages[candidate].role === 'tool') {
      candidate--;
    }

    if (candidate > 1) {
      splitIndex = candidate;
    } else {
      // If backtracking would consume all earlier messages, advance forward to the next turn boundary
      while (splitIndex < messages.length && messages[splitIndex].role === 'tool') {
        splitIndex++;
      }
    }

    // If no valid split boundary exists that allows folding earlier messages, don't fold
    if (splitIndex <= 1 || splitIndex >= messages.length) {
      return { messages, wasFolded: false };
    }

    const recentMsgs = messages.slice(splitIndex);
    const middleMsgs = messages.slice(1, splitIndex);

    const foldedSummaryContent = `[CONTEXT COMPACTED: Folded ${middleMsgs.length} earlier intermediate reasoning steps and tool outputs to preserve token budget. Core decisions and outputs remain recorded in Blackboard.]`;

    const summaryMsg = {
      role: 'system',
      content: foldedSummaryContent,
    } as unknown as T;

    return {
      messages: [firstMsg, summaryMsg, ...recentMsgs],
      wasFolded: true,
    };
  }

  /**
   * Observation Masking (Sliding Window for Tool Outputs):
   * Preserves full raw tool outputs for the most recent `keepRecentToolTurns` tool turns.
   * For older tool outputs, condenses the content into a lightweight observation summary
   * while STRICTLY preserving `role: 'tool'` and its matching `tool_call_id`.
   * This breaks the O(N^2) token inflation in multi-turn ReAct loops.
   */
  public maskOldToolObservations<T extends { role: string; content?: any; tool_call_id?: string }>(
    messages: T[],
    keepRecentToolTurns: number = 2
  ): T[] {
    const toolIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'tool') {
        toolIndices.push(i);
      }
    }

    if (toolIndices.length <= keepRecentToolTurns) {
      return messages;
    }

    // Retain full output for the most recent keepRecentToolTurns
    const activeToolIndices = new Set(toolIndices.slice(-keepRecentToolTurns));

    return messages.map((msg, idx) => {
      if (msg.role !== 'tool' || activeToolIndices.has(idx)) {
        return msg;
      }

      const rawContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
      if (rawContent.length <= 250) {
        return msg;
      }

      const firstLine = rawContent.split('\n')[0].slice(0, 120);
      const maskedContent = `${firstLine}...\n[Tool observation (${rawContent.length} chars) compacted - processed in earlier reasoning step]`;

      return {
        ...msg,
        content: maskedContent,
      };
    });
  }
}

