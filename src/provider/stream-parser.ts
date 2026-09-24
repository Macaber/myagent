import { StreamDeltaChunk, CompletionResult, ToolCallItem, CompletionUsage } from './types.js';

export class StreamParser {
  /**
   * Parse an SSE byte stream from OpenAI into structured delta chunks
   */
  public static async *parseSseStream(
    stream: ReadableStream<Uint8Array>
  ): AsyncGenerator<StreamDeltaChunk> {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf8');
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || line.startsWith(':')) continue; // Ignore comments/empty lines

          if (line === 'data: [DONE]' || line === 'data:[DONE]') {
            try {
              await reader.cancel();
            } catch {}
            yield { type: 'done' };
            return;
          }

          if (line.startsWith('data:')) {
            const jsonStr = line.slice(5).trimStart();
            try {
              const data = JSON.parse(jsonStr);

              // 1. Check for usage field (e.g. OpenAI stream_options: { include_usage: true })
              if (data.usage) {
                yield {
                  type: 'usage',
                  usage: {
                    promptTokens: data.usage.prompt_tokens ?? 0,
                    completionTokens: data.usage.completion_tokens ?? 0,
                    totalTokens: data.usage.total_tokens ?? 0,
                  },
                };
              }

              // 2. Check delta choices (fall back to `message` for non-streaming-compatible gateways)
              const choice = data.choices?.[0];
              if (!choice) continue;

              if (choice.finish_reason) {
                yield {
                  type: 'content',
                  deltaText: '',
                  finishReason: choice.finish_reason,
                };
              }

              const delta = choice.delta ?? choice.message;
              if (!delta) continue;

              // Thought / reasoning delta (DeepSeek, etc.)
              const reasoning = (delta as any).reasoning_content ?? (delta as any).reasoning;
              if (reasoning) {
                yield {
                  type: 'thought',
                  thoughtText: reasoning,
                };
              }

              // Content text delta
              if (delta.content) {
                yield {
                  type: 'content',
                  deltaText: delta.content,
                };
              }

              // Tool calls delta (cap args at 256KB to bound malicious models)
              if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const chunk = tc.function?.arguments;
                  yield {
                    type: 'tool_call_delta',
                    toolCallDelta: {
                      index: tc.index ?? 0,
                      id: tc.id,
                      name: tc.function?.name,
                      argumentsChunk: typeof chunk === 'string' ? chunk.slice(0, 262144) : chunk,
                    },
                  };
                }
              }
            } catch (err) {
              console.warn('[StreamParser] Error parsing SSE data JSON:', String(jsonStr).slice(0, 200));
            }
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {}
      reader.releaseLock();
    }
  }

  /**
   * Accumulate stream chunks into a full CompletionResult
   */
  public static async accumulateStream(
    generator: AsyncGenerator<StreamDeltaChunk>
  ): Promise<CompletionResult> {
    let fullContent = '';
    const toolCallsMap = new Map<number, { id: string; name: string; args: string }>();
    let usage: CompletionUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let finishReason: string | undefined;

    for await (const chunk of generator) {
      if (chunk.type === 'content') {
        if (chunk.deltaText) fullContent += chunk.deltaText;
        if (chunk.finishReason) finishReason = chunk.finishReason;
      } else if (chunk.type === 'tool_call_delta' && chunk.toolCallDelta) {
        const { index, id, name, argumentsChunk } = chunk.toolCallDelta;
        const current = toolCallsMap.get(index) ?? { id: '', name: '', args: '' };
        if (id) current.id = id;
        if (name) current.name = name;
        if (argumentsChunk) {
          current.args = (current.args + argumentsChunk).slice(0, 262144);
        }
        toolCallsMap.set(index, current);
      } else if (chunk.type === 'usage' && chunk.usage) {
        // Accumulate across chunks (some gateways emit multiple usage frames)
        usage = {
          promptTokens: usage.promptTokens + (chunk.usage.promptTokens || 0),
          completionTokens: usage.completionTokens + (chunk.usage.completionTokens || 0),
          totalTokens: usage.totalTokens + (chunk.usage.totalTokens || 0),
        };
      }
    }

    const toolCalls: ToolCallItem[] = Array.from(toolCallsMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([_, val]) => ({
        id: val.id || `call_${Date.now()}`,
        type: 'function',
        function: {
          name: val.name,
          arguments: val.args,
        },
      }));

    return {
      content: fullContent.length > 0 ? fullContent : null,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      finishReason,
    };
  }
}
