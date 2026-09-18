import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TruncationConfig {
  maxCharacters?: number; // default 8000 (approx 2000 tokens)
  headCharacters?: number; // default 1500
  tailCharacters?: number; // default 1500
  logDir?: string;
}

export class MemoryCompactor {
  private readonly maxChars: number;
  private readonly headChars: number;
  private readonly tailChars: number;
  private readonly logDir?: string;

  constructor(config: TruncationConfig = {}) {
    this.maxChars = config.maxCharacters ?? 8000;
    this.headChars = config.headCharacters ?? 1500;
    this.tailChars = config.tailCharacters ?? 1500;
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
  public checkWatermarkAndFold<T extends { role: string; content?: any }>(
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
    const recentMsgs = messages.slice(-keepRecentCount);
    const middleMsgs = messages.slice(1, -keepRecentCount);

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
}
