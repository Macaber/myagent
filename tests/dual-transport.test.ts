import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { PassThrough } from 'node:stream';
import { HttpTransport } from '../dist/protocol/http-transport.js';
import { StdioTransport } from '../dist/protocol/stdio-transport.js';
import { DualTransport } from '../dist/protocol/dual-transport.js';
import { RpcDispatcher } from '../dist/protocol/rpc-dispatcher.js';
import { createAgentRuntime } from '../dist/index.js';

describe('Dual-Mode Transport (Stdio + HTTP/SSE)', () => {
  test('1. HttpTransport starts HTTP server, serves /health, and processes JSON-RPC /rpc requests', async () => {
    const httpTransport = new HttpTransport({ port: 0 }); // ephemeral port
    const port = await httpTransport.start();
    assert.ok(port > 0);

    const dispatcher = new RpcDispatcher(httpTransport);
    dispatcher.registerMethod<{ a: number; b: number }, { sum: number }>('calc/add', async (params) => {
      return { sum: params.a + params.b };
    });

    try {
      // 1. Health check
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      assert.strictEqual(healthRes.status, 200);
      const healthJson: any = await healthRes.json();
      assert.strictEqual(healthJson.status, 'ok');
      assert.strictEqual(healthJson.transport, 'http');

      // 2. RPC call via POST /rpc
      const rpcRes = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'test_http_1',
          method: 'calc/add',
          params: { a: 19, b: 23 },
        }),
      });

      assert.strictEqual(rpcRes.status, 200);
      const rpcJson: any = await rpcRes.json();
      assert.strictEqual(rpcJson.jsonrpc, '2.0');
      assert.strictEqual(rpcJson.id, 'test_http_1');
      assert.strictEqual(rpcJson.result.sum, 42);
    } finally {
      await httpTransport.close();
    }
  });

  test('2. HttpTransport streams Server-Sent Events via GET /events', async () => {
    const httpTransport = new HttpTransport({ port: 0 });
    const port = await httpTransport.start();
    const dispatcher = new RpcDispatcher(httpTransport);

    const receivedEvents: any[] = [];
    const abortController = new AbortController();

    try {
      // Connect to SSE stream
      const sseRes = await fetch(`http://127.0.0.1:${port}/events`, {
        signal: abortController.signal,
      });
      assert.strictEqual(sseRes.status, 200);
      assert.strictEqual(sseRes.headers.get('content-type'), 'text/event-stream');

      // Read SSE stream in background
      const reader = sseRes.body?.getReader();
      const readPromise = (async () => {
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader!.read();
            if (done) break;
            const text = decoder.decode(value);
            const lines = text.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  receivedEvents.push(JSON.parse(line.slice(6)));
                } catch {}
              }
            }
          }
        } catch {
          // aborted on test cleanup
        }
      })();

      // Emit session/update notification from agent
      await new Promise((r) => setTimeout(r, 50));
      dispatcher.emitSessionUpdate({
        sessionId: 'sess_123',
        updateType: 'step_progress',
        status: 'RUNNING',
        data: { stepId: 'step_01', message: 'Analyzing requirements' },
      });

      // Wait for SSE client to receive notification
      for (let i = 0; i < 30; i++) {
        if (receivedEvents.length > 0) break;
        await new Promise((r) => setTimeout(r, 30));
      }

      assert.strictEqual(receivedEvents.length, 1);
      assert.strictEqual(receivedEvents[0].method, 'session/update');
      assert.strictEqual(receivedEvents[0].params.sessionId, 'sess_123');
      assert.strictEqual(receivedEvents[0].params.updateType, 'step_progress');

      abortController.abort();
      await readPromise.catch(() => {});
    } finally {
      await httpTransport.close();
    }
  });

  test('3. DualTransport simultaneously routes stdio and HTTP requests', async () => {
    const clientInput = new PassThrough();
    const agentOutput = new PassThrough();
    const stdioTransport = new StdioTransport(clientInput, agentOutput);
    const httpTransport = new HttpTransport({ port: 0 });
    const port = await httpTransport.start();

    const dualTransport = new DualTransport([stdioTransport, httpTransport]);
    const runtime = createAgentRuntime({
      transport: dualTransport,
      dbPath: ':memory:',
      autoScanSkills: false,
      autoLoadMcp: false,
    });

    // 1. Send request via HTTP POST /rpc
    const httpRes = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'http_req_init',
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      }),
    });

    const httpJson: any = await httpRes.json();
    assert.strictEqual(httpJson.id, 'http_req_init');
    assert.strictEqual(httpJson.result.agentInfo.name, 'MyAgent-Runtime');

    // 2. Send request via Stdio PassThrough stream
    const stdioResponses: any[] = [];
    agentOutput.setEncoding('utf8');
    let buffer = '';
    agentOutput.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) stdioResponses.push(JSON.parse(line));
      }
    });

    clientInput.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'stdio_req_session',
        method: 'session/new',
        params: { sessionId: 'dual_test_session' },
      }) + '\n'
    );

    // Wait for stdio response
    for (let i = 0; i < 30; i++) {
      if (stdioResponses.some((m) => m.id === 'stdio_req_session')) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const stdioRes = stdioResponses.find((m) => m.id === 'stdio_req_session');
    assert.ok(stdioRes);
    assert.strictEqual(stdioRes.result.sessionId, 'dual_test_session');

    // Clean up
    await dualTransport.close();
  });
});
