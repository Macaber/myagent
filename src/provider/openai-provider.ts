import {
  ChatMessage,
  ToolSchema,
  ProviderConfig,
  StreamDeltaChunk,
  CompletionResult,
} from './types.js';
import { StreamParser } from './stream-parser.js';

export class OpenAIProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private fallbackModel?: string;
  private maxRetries: number;

  constructor(config: ProviderConfig = {}) {
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = (config.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = config.model || process.env.OPENAI_MODEL || 'gpt-4o';
    this.fallbackModel = config.fallbackModel;
    this.maxRetries = config.maxRetries ?? 3;
  }

  public getModel(): string {
    return this.model;
  }

  /**
   * Sanitizes the messages array to strictly conform to OpenAI Chat Completions API rules:
   * 1. A message with role 'tool' MUST be preceded by an assistant message with 'tool_calls'
   *    containing a matching tool_call id.
   * 2. If an assistant message specifies 'tool_calls', all corresponding tool responses must be provided.
   * 3. Any orphan tool messages (e.g. from context truncation or bad slicing) are safely converted to
   *    informational user messages so they preserve context without causing HTTP 400.
   */
  public static sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
    const sanitized: ChatMessage[] = [];
    let pendingToolCallIds = new Set<string>();

    for (const msg of messages) {
      if (msg.role === 'tool') {
        const toolId = msg.tool_call_id;
        if (toolId && pendingToolCallIds.has(toolId)) {
          sanitized.push(msg);
          pendingToolCallIds.delete(toolId);
        } else {
          // Orphan tool message: convert to user message
          sanitized.push({
            role: 'user',
            content: `[Previous Tool Execution Result]: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}`,
          });
        }
      } else {
        // If previous assistant message had tool calls that were never answered before this new message,
        // fill them with placeholder tool responses so OpenAI doesn't reject
        if (pendingToolCallIds.size > 0) {
          for (const missingId of pendingToolCallIds) {
            sanitized.push({
              role: 'tool',
              tool_call_id: missingId,
              content: '[Tool output omitted or skipped]',
            });
          }
          pendingToolCallIds.clear();
        }

        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
          pendingToolCallIds = new Set(msg.tool_calls.map((tc) => tc.id).filter(Boolean));
        }

        sanitized.push(msg);
      }
    }

    return sanitized;
  }

  public async *chatStream(params: {
    messages: ChatMessage[];
    tools?: ToolSchema[];
    temperature?: number;
    abortSignal?: AbortSignal;
    modelOverride?: string;
  }): AsyncGenerator<StreamDeltaChunk> {
    const primaryModel = params.modelOverride || this.model;
    const modelsToTry = [primaryModel];
    if (this.fallbackModel && this.fallbackModel !== primaryModel) {
      modelsToTry.push(this.fallbackModel);
    }

    const sanitizedMessages = OpenAIProvider.sanitizeMessages(params.messages);
    let lastError: Error | null = null;

    for (const currentModel of modelsToTry) {
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        if (params.abortSignal?.aborted) {
          throw new Error('Chat completion request was aborted');
        }

        try {
          const body: Record<string, any> = {
            model: currentModel,
            messages: sanitizedMessages,
            stream: true,
            stream_options: { include_usage: true },
            temperature: params.temperature ?? 0.2,
          };

          if (params.tools && params.tools.length > 0) {
            body.tools = params.tools;
          }

          const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: params.abortSignal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            const status = response.status;
            // Retryable statuses: 429 (Rate Limit), 500, 502, 503, 504
            const isRetryable = status === 429 || (status >= 500 && status <= 504);

            if (isRetryable && attempt < this.maxRetries) {
              const backoffMs = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 10000);
              console.warn(`[OpenAIProvider] Attempt ${attempt + 1} failed with status ${status}. Retrying in ${Math.round(backoffMs)}ms...`);
              await new Promise((r) => setTimeout(r, backoffMs));
              continue;
            }

            throw new Error(`OpenAI API error [${status}]: ${errorText}`);
          }

          if (!response.body) {
            throw new Error('Response body is null');
          }

          // Parse SSE stream
          yield* StreamParser.parseSseStream(response.body);
          return; // Successfully finished stream
        } catch (err: any) {
          lastError = err;
          if (err.name === 'AbortError' || params.abortSignal?.aborted) {
            throw new Error('Chat completion request was aborted');
          }
          if (attempt < this.maxRetries) {
            const backoffMs = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 8000);
            await new Promise((r) => setTimeout(r, backoffMs));
          }
        }
      }
      console.warn(`[OpenAIProvider] Model '${currentModel}' exhausted ${this.maxRetries + 1} attempts. Checking fallback...`);
    }

    throw lastError || new Error('All model attempts failed');
  }

  public async complete(params: {
    messages: ChatMessage[];
    tools?: ToolSchema[];
    temperature?: number;
    abortSignal?: AbortSignal;
    modelOverride?: string;
  }): Promise<CompletionResult> {
    const stream = this.chatStream(params);
    return StreamParser.accumulateStream(stream);
  }
}
