import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { createMemoryTransportPair } from '../dist/client/memory-transport.js';
import { AcpClient } from '../dist/client/acp-client.js';
import { createAgentRuntime } from '../dist/index.js';

describe('Decoupled ACP Client & Memory Transport', () => {
  test('MemoryTransport sends and dispatches JSON-RPC packets in both directions', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();

    const clientReceived: any[] = [];
    const serverReceived: any[] = [];

    clientTransport.onMessage((msg) => clientReceived.push(msg));
    serverTransport.onMessage((msg) => serverReceived.push(msg));

    clientTransport.send({ jsonrpc: '2.0', id: '1', method: 'ping', params: { hello: 'server' } });
    serverTransport.send({ jsonrpc: '2.0', id: '2', method: 'pong', params: { hello: 'client' } });

    // Wait for microtask tick
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.strictEqual(serverReceived.length, 1);
    assert.strictEqual(serverReceived[0].params.hello, 'server');

    assert.strictEqual(clientReceived.length, 1);
    assert.strictEqual(clientReceived[0].params.hello, 'client');

    clientTransport.close();
    serverTransport.close();
  });

  test('AcpClient performs ACP handshake, session lifecycle and receives updates', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();

    const runtime = createAgentRuntime({
      transport: serverTransport,
      dbPath: ':memory:',
    });

    const client = new AcpClient(clientTransport);

    // 1. Initialize
    const initResult = await client.initialize({
      clientInfo: { name: 'TestClient', version: '1.0.0' },
    });
    assert.ok(initResult);
    assert.strictEqual(initResult.agentInfo.name, 'MyAgent-Runtime');

    // 2. Track updates
    const updates: any[] = [];
    client.onSessionUpdate((u) => updates.push(u));

    // 3. New Session
    const sessionRes = await client.newSession({
      systemPrompt: 'Test prompt',
      workspacePath: process.cwd(),
    });
    assert.ok(sessionRes.sessionId);

    // Wait for initial session/update state_changed event
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(updates.length > 0);
    assert.strictEqual(updates[0].sessionId, sessionRes.sessionId);

    // 4. Cancel Session
    const cancelRes = await client.cancelSession(sessionRes.sessionId);
    assert.strictEqual(cancelRes.sessionId, sessionRes.sessionId);

    // Clean up
    await client.close();
    runtime.db.close();
  });

  test('AcpClient handles HITL permission requests and sends approval decisions', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();

    const runtime = createAgentRuntime({
      transport: serverTransport,
      dbPath: ':memory:',
    });

    const client = new AcpClient(clientTransport);

    let permissionRequested = false;
    client.onRequestPermission((req, respond) => {
      permissionRequested = true;
      assert.strictEqual(req.toolCall?.name, 'bash');
      respond('approved');
    });

    await client.initialize();

    // Directly simulate approval gate requesting permission through dispatcher
    const responsePromise = runtime.dispatcher.requestClient('session/request_permission', {
      sessionId: 'session_test_1',
      requestId: 'perm_1',
      toolCall: { name: 'bash', arguments: { command: 'echo 1' } },
      riskLevel: 'high_risk_exec',
      description: 'Run echo command',
    });

    const decisionResult = await responsePromise;
    assert.strictEqual(permissionRequested, true);
    assert.strictEqual(decisionResult.decision, 'approved');

    await client.close();
    runtime.db.close();
  });

  test('AcpClient supports multi-turn prompts on the same session without state transition error', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();

    const runtime = createAgentRuntime({
      transport: serverTransport,
      dbPath: ':memory:',
    });

    const client = new AcpClient(clientTransport);
    await client.initialize();

    const sessionRes = await client.newSession({
      systemPrompt: 'You are an assistant',
      workspacePath: process.cwd(),
    });
    const sessionId = sessionRes.sessionId;

    // Turn 1: conversational goal "你好"
    const prompt1 = await client.promptSession(sessionId, '你好');
    assert.strictEqual(prompt1.status, 'completed');

    // Turn 2: second question in the same session
    const prompt2 = await client.promptSession(sessionId, '介绍一下你自己');
    assert.strictEqual(prompt2.status, 'completed');

    await client.close();
    runtime.db.close();
  });
});
