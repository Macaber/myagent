import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { StreamParser } from '../dist/provider/stream-parser.js';

describe('StreamParser', () => {
  test('Parses delta content chunks and usage from SSE stream', async () => {
    const sseText = [
      `data: ${JSON.stringify({ id: '1', choices: [{ delta: { content: 'Hello' } }] })}\n\n`,
      `data: ${JSON.stringify({ id: '1', choices: [{ delta: { content: ' world!' } }] })}\n\n`,
      `data: ${JSON.stringify({ id: '1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseText));
        controller.close();
      },
    });

    const generator = StreamParser.parseSseStream(stream);
    const result = await StreamParser.accumulateStream(generator);

    assert.strictEqual(result.content, 'Hello world!');
    assert.strictEqual(result.usage.promptTokens, 10);
    assert.strictEqual(result.usage.completionTokens, 2);
    assert.strictEqual(result.usage.totalTokens, 12);
  });

  test('Assembles multi-chunk fragmented tool_calls', async () => {
    const sseText = [
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_abc',
                  function: { name: 'edit', arguments: '{"file' },
                },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: 'Path":"a' },
                },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '.ts"}' },
                },
              ],
            },
          },
        ],
      })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseText));
        controller.close();
      },
    });

    const generator = StreamParser.parseSseStream(stream);
    const result = await StreamParser.accumulateStream(generator);

    assert.ok(result.toolCalls, 'toolCalls should be present');
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].id, 'call_abc');
    assert.strictEqual(result.toolCalls[0].function.name, 'edit');
    assert.strictEqual(result.toolCalls[0].function.arguments, '{"filePath":"a.ts"}');
  });
});
