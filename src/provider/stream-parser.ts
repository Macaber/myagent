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

          if (line === 'data: [DONE]') {
            yield { type: 'done' };
            return;
          }

          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6);
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

              // 2. Check delta choices
              const choice = data.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta;
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

              // Tool calls delta
              if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  yield {
                    type: 'tool_call_delta',
                    toolCallDelta: {
                      index: tc.index ?? 0,
                      id: tc.id,
                      name: tc.function?.name,
                      argumentsChunk: tc.function?.arguments,
                    },
                  };
                }
              }
            } catch (err) {
              console.warn('[StreamParser] Error parsing SSE data JSON:', jsonStr, err);
            }
          }
        }
      }
    } finally {
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

    for await (const chunk of generator) {
      if (chunk.type === 'content' && chunk.deltaText) {
        fullContent += chunk.deltaText;
      } else if (chunk.type === 'tool_call_delta' && chunk.toolCallDelta) {
        const { index, id, name, argumentsChunk } = chunk.toolCallDelta;
        const current = toolCallsMap.get(index) ?? { id: '', name: '', args: '' };
        if (id) current.id = id;
        if (name) current.name = name;
        if (argumentsChunk) current.args += argumentsChunk;
        toolCallsMap.set(index, current);
      } else if (chunk.type === 'usage' && chunk.usage) {
        usage = chunk.usage;
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
    };
  }
}
