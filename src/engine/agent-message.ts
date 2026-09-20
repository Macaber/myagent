import { ChatMessage, ToolCallItem } from '../provider/types.js';

export interface SystemMessage {
  role: 'system';
  content: string;
  sections?: Record<string, string>;
  timestamp?: number;
}

export interface UserMessage {
  role: 'user';
  content: string;
  isSteering?: boolean;
  timestamp?: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  thought?: string;
  toolCalls?: ToolCallItem[];
  stopReason?: string;
  timestamp?: number;
}

export interface ToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  toolName: string;
  content: string;
  isError?: boolean;
  timestamp?: number;
}

export interface CompactionSummaryMessage {
  role: 'user';
  content: string;
  isCompaction: true;
  readFiles: string[];
  modifiedFiles: string[];
  tokensBefore?: number;
  timestamp?: number;
}

export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | CompactionSummaryMessage;

/**
 * Converts rich AgentMessage items to provider-compatible ChatMessage array.
 */
export function convertToChatMessages(messages: AgentMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({
        role: 'system',
        content: msg.content,
      });
    } else if (msg.role === 'user') {
      if ('isCompaction' in msg && msg.isCompaction) {
        // Render compaction summary block
        const fileSection = [
          msg.readFiles.length > 0 ? `Read files: ${msg.readFiles.join(', ')}` : '',
          msg.modifiedFiles.length > 0 ? `Modified files: ${msg.modifiedFiles.join(', ')}` : '',
        ].filter(Boolean).join('\n');

        const text = [
          '⚠️ [PRIOR CONVERSATION SUMMARY - COMPACTED CONTEXT]:',
          msg.content,
          fileSection ? `\n[FILE OPERATIONS LEDGER]:\n${fileSection}` : '',
        ].filter(Boolean).join('\n');

        result.push({
          role: 'user',
          content: text,
        });
      } else if ('isSteering' in msg && msg.isSteering) {
        result.push({
          role: 'user',
          content: `⚠️ [USER STEERING INTERVENTION]: ${msg.content}`,
        });
      } else {
        result.push({
          role: 'user',
          content: msg.content,
        });
      }
    } else if (msg.role === 'assistant') {
      result.push({
        role: 'assistant',
        content: msg.content,
        tool_calls: msg.toolCalls,
      });
    } else if (msg.role === 'tool') {
      result.push({
        role: 'tool',
        tool_call_id: msg.tool_call_id,
        name: msg.toolName,
        content: msg.content,
      });
    }
  }

  return result;
}
