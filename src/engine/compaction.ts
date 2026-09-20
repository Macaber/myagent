import { AgentMessage, CompactionSummaryMessage, UserMessage, AssistantMessage, ToolResultMessage } from './agent-message.js';
import { OpenAIProvider } from '../provider/openai-provider.js';

export interface FileOperationsLedger {
  readFiles: Set<string>;
  modifiedFiles: Set<string>;
}

export function createFileOperationsLedger(): FileOperationsLedger {
  return {
    readFiles: new Set<string>(),
    modifiedFiles: new Set<string>(),
  };
}

/**
 * Scans AgentMessage history and extracts all touched files.
 */
export function extractFileOperations(messages: AgentMessage[]): FileOperationsLedger {
  const ledger = createFileOperationsLedger();

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const call of msg.toolCalls) {
        try {
          const args = JSON.parse(call.function.arguments || '{}');
          const filePath = args.filePath || args.path || args.file || args.targetFile;
          if (typeof filePath === 'string' && filePath.trim()) {
            const normalized = filePath.trim();
            const name = call.function.name;
            if (name === 'read' || name === 'read_file' || name === 'view_file') {
              ledger.readFiles.add(normalized);
            } else if (name === 'write' || name === 'edit' || name === 'patch' || name === 'write_to_file') {
              ledger.modifiedFiles.add(normalized);
            }
          }
        } catch {}
      }
    } else if ('isCompaction' in msg && msg.isCompaction) {
      const comp = msg as CompactionSummaryMessage;
      comp.readFiles?.forEach((f) => ledger.readFiles.add(f));
      comp.modifiedFiles?.forEach((f) => ledger.modifiedFiles.add(f));
    }
  }

  return ledger;
}

/**
 * Checks whether current token usage exceeds the compaction watermark (default 75% of context window).
 */
export function shouldCompact(
  currentTokens: number,
  contextWindow: number = 128000,
  watermarkRatio: number = 0.75
): boolean {
  if (contextWindow <= 0) return false;
  return currentTokens >= Math.floor(contextWindow * watermarkRatio);
}

/**
 * Compacts older conversation history into a structured summary + file operations ledger,
 * while preserving the most recent turns (default: preserve last 4 messages).
 */
export async function compactHistory(
  messages: AgentMessage[],
  options: {
    preserveRecentCount?: number;
    provider?: OpenAIProvider;
    currentTokens?: number;
  } = {}
): Promise<{
  compactedMessages: AgentMessage[];
  summary: string;
  ledger: FileOperationsLedger;
}> {
  const preserveCount = options.preserveRecentCount ?? 4;
  if (messages.length <= preserveCount + 1) {
    const ledger = extractFileOperations(messages);
    return {
      compactedMessages: [...messages],
      summary: '',
      ledger,
    };
  }

  // Split into messages to compact and recent messages to keep intact
  const splitIndex = Math.max(1, messages.length - preserveCount);
  const toCompact = messages.slice(0, splitIndex);
  const toPreserve = messages.slice(splitIndex);

  const ledger = extractFileOperations(toCompact);

  // Generate structured summary
  let summaryText = '';
  if (options.provider) {
    try {
      const summaryPrompt = [
        {
          role: 'system' as const,
          content:
            'You are a context compaction engine. Summarize the preceding conversation into concise, structured key technical facts, user goals, and decisions. Preserve file names and key conclusions. Be dense and concise.',
        },
        {
          role: 'user' as const,
          content: `Please summarize the following conversation history:\n\n${toCompact
            .map((m) => {
              if (m.role === 'user') return `[User]: ${m.content}`;
              if (m.role === 'assistant') return `[Assistant]: ${m.content || '(Tool calls)'}`;
              if (m.role === 'tool') return `[Tool Result ${m.toolName}]: ${m.content.slice(0, 300)}`;
              return '';
            })
            .filter(Boolean)
            .join('\n')}`,
        },
      ];

      for await (const chunk of options.provider.chatStream({
        messages: summaryPrompt,
        temperature: 0.1,
      })) {
        if (chunk.type === 'content' && chunk.deltaText) {
          summaryText += chunk.deltaText;
        }
      }
    } catch {
      summaryText = `Historical context compacted (${toCompact.length} messages summarized).`;
    }
  } else {
    // Offline deterministic summary
    summaryText = `Historical conversation compacted. Total messages summarized: ${toCompact.length}.`;
  }

  const compactionMsg: CompactionSummaryMessage = {
    role: 'user',
    content: summaryText,
    isCompaction: true,
    readFiles: Array.from(ledger.readFiles),
    modifiedFiles: Array.from(ledger.modifiedFiles),
    tokensBefore: options.currentTokens,
    timestamp: Date.now(),
  };

  return {
    compactedMessages: [compactionMsg, ...toPreserve],
    summary: summaryText,
    ledger,
  };
}
