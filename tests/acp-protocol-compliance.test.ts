import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { PassThrough } from 'node:stream';
import { StdioTransport } from '../dist/protocol/stdio-transport.js';
import { createAgentRuntime } from '../dist/index.js';

describe('Official ACP Protocol Full Compliance', () => {
  function setupTestHarness() {
    const clientInput = new PassThrough();  // Agent reads from this
    const agentOutput = new PassThrough();  // Agent writes to this

    const agentTransport = new StdioTransport(clientInput, agentOutput);
    const runtime = createAgentRuntime({
      transport: agentTransport,
      dbPath: ':memory:',
    });

    const receivedMessages: any[] = [];
    agentOutput.setEncoding('utf8');
    let buffer = '';
    agentOutput.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          receivedMessages.push(JSON.parse(line));
        }
      }
    });

    function sendToAgent(msg: any) {
      clientInput.write(JSON.stringify(msg) + '\n');
    }

    async function waitForResponse(id: string | number): Promise<any> {
      for (let i = 0; i < 50; i++) {
        const found = receivedMessages.find((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
        if (found) return found;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timeout waiting for response to id '${id}'`);
    }

    async function waitForNotification(method: string, updateType?: string): Promise<any> {
      for (let i = 0; i < 50; i++) {
        const found = receivedMessages.find(
          (m) => m.method === method && (!updateType || m.params?.updateType === updateType)
        );
        if (found) return found;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timeout waiting for notification '${method}' (${updateType || ''})`);
    }

    return {
      runtime,
      sendToAgent,
      waitForResponse,
      waitForNotification,
      receivedMessages,
    };
  }

  test('1. initialize: Handshake & capability negotiation matches canonical ACP', async () => {
    const harness = setupTestHarness();

    harness.sendToAgent({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'Zed-Editor', version: '0.150.0' },
        clientCapabilities: { streaming: true, permissions: true },
      },
    });

    const res = await harness.waitForResponse(1);
    assert.strictEqual(res.result.protocolVersion, '2024-11-05');
    assert.strictEqual(res.result.agentInfo.name, 'MyAgent-Runtime');
    assert.ok(res.result.agentCapabilities.prompt, 'Should support prompt');
    assert.ok(res.result.agentCapabilities.loadSession, 'Should support loadSession');
    assert.ok(res.result.agentCapabilities.tools.includes('bash'), 'Should include bash tool');
    assert.ok(res.result.agentCapabilities.tools.includes('edit'), 'Should include edit tool');
  });

  test('2. session/new: Creates new session context', async () => {
    const harness = setupTestHarness();

    harness.sendToAgent({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: {
        sessionId: 'session_acp_101',
        roots: ['/tmp/my_project'],
        systemPrompt: 'You are an assistant',
      },
    });

    const res = await harness.waitForResponse(2);
    assert.strictEqual(res.result.sessionId, 'session_acp_101');
  });

  test('3. session/prompt: Processes prompt and streams session/update notifications', async () => {
    const harness = setupTestHarness();

    // 1. Create session
    harness.sendToAgent({
      jsonrpc: '2.0',
      id: 10,
      method: 'session/new',
      params: { sessionId: 'sess_stream_test' },
    });
    await harness.waitForResponse(10);

    // 2. Send prompt
    harness.sendToAgent({
      jsonrpc: '2.0',
      id: 11,
      method: 'session/prompt',
      params: {
        sessionId: 'sess_stream_test',
        prompt: 'Build auth module',
      },
    });

    // Verify session/update notifications stream
    const update = await harness.waitForNotification('session/update', 'plan_generated');
    assert.strictEqual(update.params.sessionId, 'sess_stream_test');
    assert.strictEqual(update.params.updateType, 'plan_generated');

    // Wait for prompt turn completion
    const promptRes = await harness.waitForResponse(11);
    assert.strictEqual(promptRes.result.sessionId, 'sess_stream_test');
    assert.strictEqual(promptRes.result.status, 'completed');
    assert.strictEqual(promptRes.result.stopReason, 'end_turn');
    assert.ok(promptRes.result.metrics.counts.turns >= 1);
  });

  test('4. session/cancel: Cancels running session', async () => {
    const harness = setupTestHarness();

    harness.sendToAgent({
      jsonrpc: '2.0',
      id: 20,
      method: 'session/cancel',
      params: { sessionId: 'sess_unknown' },
    });

    const res = await harness.waitForResponse(20);
    assert.strictEqual(res.result.cancelled, false);
  });

  test('5. session/prompt: Supports content block array and emits agent_message_chunk', async () => {
    const harness = setupTestHarness();

    harness.sendToAgent({
      jsonrpc: '2.0',
      id: 30,
      method: 'session/new',
      params: { sessionId: 'sess_blocks_test' },
    });
    await harness.waitForResponse(30);

    harness.sendToAgent({
      jsonrpc: '2.0',
      id: 31,
      method: 'session/prompt',
      params: {
        sessionId: 'sess_blocks_test',
        prompt: [{ type: 'text', text: 'Explain the codebase architecture' }],
      },
    });

    const chunk = await harness.waitForNotification('session/update', 'agent_message_chunk');
    assert.strictEqual(chunk.params.sessionId, 'sess_blocks_test');
    assert.ok(chunk.params.content?.text || chunk.params.data?.text);

    const res = await harness.waitForResponse(31);
    assert.strictEqual(res.result.sessionId, 'sess_blocks_test');
    assert.strictEqual(res.result.stopReason, 'end_turn');
    assert.strictEqual(res.result.status, 'completed');
    assert.ok(Array.isArray(res.result.content));
  });
});
