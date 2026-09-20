import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createMemoryTransportPair } from '../dist/client/memory-transport.js';
import { AcpClient } from '../dist/client/acp-client.js';
import { createAgentRuntime } from '../dist/index.js';
import { ACP_ERROR_CODES } from '../dist/protocol/types.js';
import type { ContentBlock, PlanEntry, AvailableCommand, UsageUpdate } from '../dist/protocol/types.js';

describe('ACP Protocol v1 - Complete Specification Verification', () => {
  test('1. initialize: capability negotiation, authMethods, and agentInfo', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({ transport: serverTransport, dbPath: ':memory:' });
    const client = new AcpClient(clientTransport);

    const initRes = await client.initialize({
      protocolVersion: 1,
      clientInfo: { name: 'Canonical-ACP-Client', version: '1.0.0' },
      clientCapabilities: {
        streaming: true,
        terminal: true,
        session: { configOptions: { boolean: {} } },
      },
    });

    assert.strictEqual(initRes.protocolVersion, 1);
    assert.strictEqual(initRes.agentInfo?.name, 'MyAgent-Runtime');
    assert.strictEqual(initRes.agentInfo?.version, '0.1.0');
    assert.ok(initRes.capabilities?.streaming, 'Streaming capability supported');
    assert.ok(initRes.capabilities?.permissions, 'Permissions capability supported');
    assert.ok(Array.isArray(initRes.capabilities?.tools), 'Tools advertised');
    assert.ok(Array.isArray(initRes.authMethods), 'Auth methods advertised');
    assert.strictEqual(initRes.authMethods?.[0]?.id, 'token');

    await client.close();
    runtime.db.close();
  });

  test('2. authenticate & logout lifecycle', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({ transport: serverTransport, dbPath: ':memory:' });
    const client = new AcpClient(clientTransport);

    await client.initialize();

    // Authenticate with API key
    const authRes = await client.authenticate({
      methodId: 'token',
      data: { apiKey: 'sk-mock-key', baseUrl: 'https://api.mock.ai/v1' },
    });
    assert.strictEqual(authRes.success, true);

    // Logout
    const logoutRes = await client.logout();
    assert.strictEqual(logoutRes.success, true);

    await client.close();
    runtime.db.close();
  });

  test('3. session/new: initializes session, modes, configOptions, and emits available_commands_update', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({ transport: serverTransport, dbPath: ':memory:' });
    const client = new AcpClient(clientTransport);

    let receivedCommands: AvailableCommand[] | undefined;
    client.onAvailableCommands((cmds) => {
      receivedCommands = cmds;
    });

    await client.initialize();

    const cwd = process.cwd();
    const sessionRes = await client.newSession({
      cwd,
      additionalDirectories: ['/tmp'],
    });

    assert.ok(sessionRes.sessionId, 'Session ID created');
    assert.strictEqual(sessionRes.modes?.currentModeId, 'code');
    assert.strictEqual(sessionRes.modes?.availableModes.length, 3);
    assert.ok(sessionRes.configOptions && sessionRes.configOptions.length >= 2);

    // Wait microtask tick for available_commands_update notification
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(receivedCommands, 'Received available_commands_update notification');
    assert.ok(receivedCommands.some((c) => c.name === 'help'));
    assert.ok(receivedCommands.some((c) => c.name === 'mode'));

    await client.close();
    runtime.db.close();
  });

  test('4. session/prompt: accepts ContentBlock[], streams user/agent chunks and usage_update, returns stopReason', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({ transport: serverTransport, dbPath: ':memory:' });
    const client = new AcpClient(clientTransport);

    const userChunks: ContentBlock[] = [];
    const agentChunks: ContentBlock[] = [];
    let usageNotif: UsageUpdate | undefined;

    client.onUserMessageChunk((chunk) => userChunks.push(chunk));
    client.onAgentMessageChunk((chunk) => agentChunks.push(chunk));
    client.onUsageUpdate((usage) => {
      usageNotif = usage;
    });

    await client.initialize();
    const session = await client.newSession({ cwd: process.cwd() });

    const promptBlocks: ContentBlock[] = [
      { type: 'text', text: 'Hello, please confirm you are ready.' },
    ];

    const promptRes = await client.promptSession(session.sessionId, promptBlocks);

    assert.strictEqual(promptRes.stopReason, 'end_turn');
    assert.strictEqual(promptRes.status, 'completed');
    assert.ok(userChunks.length > 0, 'Should stream user message chunk');
    assert.ok(agentChunks.length > 0, 'Should stream agent message chunk');
    assert.ok(usageNotif, 'Should emit usage_update notification');

    await client.close();
    runtime.db.close();
  });

  test('5. session/set_mode & session/set_config_option with real-time notifications', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({ transport: serverTransport, dbPath: ':memory:' });
    const client = new AcpClient(clientTransport);

    let updatedMode: string | undefined;
    let updatedConfigOption: { optionId: string; value: any } | undefined;

    client.onModeUpdate((modeId) => {
      updatedMode = modeId;
    });
    client.onConfigOptionUpdate((optionId, val) => {
      updatedConfigOption = { optionId, value: val };
    });

    await client.initialize();
    const session = await client.newSession({ cwd: process.cwd() });

    // Set Mode: 'code' -> 'ask'
    const modeRes = await client.setSessionMode(session.sessionId, 'ask');
    assert.strictEqual(modeRes.modes?.currentModeId, 'ask');

    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(updatedMode, 'ask');

    // Set Config Option
    const configRes = await client.setSessionConfigOption(session.sessionId, 'mode', 'architect');
    assert.ok(configRes.configOptions);

    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(updatedConfigOption?.optionId, 'mode');
    assert.strictEqual(updatedConfigOption?.value, 'architect');

    // Invalid mode error
    await assert.rejects(
      async () => {
        await client.setSessionMode(session.sessionId, 'non_existent_mode');
      },
      (err: any) => err.code === ACP_ERROR_CODES.INVALID_PARAMS
    );

    await client.close();
    runtime.db.close();
  });

  test('6. session/load: replays conversation history to reconstruct transcript', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({ transport: serverTransport, dbPath: ':memory:' });
    const client = new AcpClient(clientTransport);

    await client.initialize();
    const session = await client.newSession({ cwd: process.cwd() });

    // Run first prompt turn
    await client.promptSession(session.sessionId, 'Turn 1 greeting');

    // Now disconnect / connect a new client to load session
    const client2 = new AcpClient(clientTransport);
    const replayedUpdates: any[] = [];
    client2.onSessionUpdate((up) => {
      replayedUpdates.push(up);
    });

    const loadRes = await client2.loadSession(session.sessionId);
    assert.strictEqual(loadRes.sessionId, session.sessionId);
    assert.strictEqual(loadRes.modes?.currentModeId, 'code');

    // Verify history was replayed
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(replayedUpdates.length >= 2, 'Should replay history updates to client');
    const hasUserChunk = replayedUpdates.some(
      (u) => (u.update?.sessionUpdate || u.sessionUpdate) === 'user_message_chunk'
    );
    const hasAgentChunk = replayedUpdates.some(
      (u) => (u.update?.sessionUpdate || u.sessionUpdate) === 'agent_message_chunk'
    );
    assert.ok(hasUserChunk, 'Replayed history must include user message chunk');
    assert.ok(hasAgentChunk, 'Replayed history must include agent message chunk');

    await client.close();
    runtime.db.close();
  });

  test('7. session/resume: restores context without replaying history', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({ transport: serverTransport, dbPath: ':memory:' });
    const client = new AcpClient(clientTransport);

    await client.initialize();
    const session = await client.newSession({ cwd: process.cwd() });
    await client.promptSession(session.sessionId, 'Turn 1');

    const replayedUpdates: any[] = [];
    client.onSessionUpdate((u) => replayedUpdates.push(u));

    const resumeRes = await client.resumeSession(session.sessionId);
    assert.strictEqual(resumeRes.sessionId, session.sessionId);

    // Give time for any unexpected updates
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(replayedUpdates.length, 0, 'session/resume must not replay history');

    await client.close();
    runtime.db.close();
  });

  test('8. session/list: lists sessions filtered by cwd with cursor pagination', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({ transport: serverTransport, dbPath: ':memory:' });
    const client = new AcpClient(clientTransport);

    await client.initialize();
    const s1 = await client.newSession({ cwd: '/workspace/projectA' });
    const s2 = await client.newSession({ cwd: '/workspace/projectA' });
    const s3 = await client.newSession({ cwd: '/workspace/projectB' });

    // List for projectA
    const listA = await client.listSessions({ cwd: '/workspace/projectA' });
    assert.strictEqual(listA.sessions.length, 2);
    assert.ok(listA.sessions.some((s) => s.sessionId === s1.sessionId));
    assert.ok(listA.sessions.some((s) => s.sessionId === s2.sessionId));

    // List for projectB
    const listB = await client.listSessions({ cwd: '/workspace/projectB' });
    assert.strictEqual(listB.sessions.length, 1);
    assert.strictEqual(listB.sessions[0].sessionId, s3.sessionId);

    await client.close();
    runtime.db.close();
  });

  test('9. session/close & session/delete lifecycle and RESOURCE_NOT_FOUND error', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({ transport: serverTransport, dbPath: ':memory:' });
    const client = new AcpClient(clientTransport);

    await client.initialize();
    const session = await client.newSession({ cwd: process.cwd() });

    // Close session
    const closeRes = await client.closeSession(session.sessionId);
    assert.ok(closeRes);

    // Delete session
    const delRes = await client.deleteSession(session.sessionId);
    assert.ok(delRes);

    // Load deleted session should throw RESOURCE_NOT_FOUND (-32002)
    await assert.rejects(
      async () => {
        await client.loadSession(session.sessionId);
      },
      (err: any) => err.code === ACP_ERROR_CODES.RESOURCE_NOT_FOUND
    );

    await client.close();
    runtime.db.close();
  });

  test('10. session/cancel: aborts running prompt turn and returns stopReason cancelled', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({ transport: serverTransport, dbPath: ':memory:' });
    const client = new AcpClient(clientTransport);

    await client.initialize();
    const session = await client.newSession({ cwd: process.cwd() });

    let cancelTriggered = false;
    client.onUserMessageChunk(async () => {
      if (!cancelTriggered) {
        cancelTriggered = true;
        await client.cancelSession(session.sessionId, 'User cancelled');
      }
    });

    const result = await client.promptSession(session.sessionId, 'Long running job');
    assert.strictEqual(result.stopReason, 'cancelled');

    await client.close();
    runtime.db.close();
  });

  test('11. Client Methods: session/request_permission with canonical selection outcome', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({ transport: serverTransport, dbPath: ':memory:' });

    let receivedApprovalReq: any;
    const client = new AcpClient(clientTransport);
    client.onRequestPermission((req, respond) => {
      receivedApprovalReq = req;
      respond('approved_always');
    });

    await client.initialize();

    // Agent invokes client session/request_permission via clientBridge
    const permissionRes = await runtime.clientBridge.requestPermission({
      sessionId: 'session_bridge_test',
      toolCall: { toolCallId: 'call_1', title: 'Execute command' },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
      ],
    });

    assert.ok(receivedApprovalReq);
    assert.strictEqual(permissionRes.outcome.outcome, 'accepted');
    assert.strictEqual((permissionRes.outcome as any).optionId, 'allow_always');

    await client.close();
    runtime.db.close();
  });

  test('12. Client Methods: fs/read_text_file & fs/write_text_file', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({ transport: serverTransport, dbPath: ':memory:' });

    const virtualFiles = new Map<string, string>([['/tmp/virtual.txt', 'Hello from virtual FS']]);

    const client = new AcpClient(clientTransport, {
      onReadTextFile: async (params) => {
        const content = virtualFiles.get(params.path);
        if (content === undefined) throw new Error(`File not found: ${params.path}`);
        return { content };
      },
      onWriteTextFile: async (params) => {
        virtualFiles.set(params.path, params.content);
        return {};
      },
    });

    await client.initialize();

    // Agent reads text file from client
    const readRes = await runtime.clientBridge.readTextFile({
      sessionId: 'sess_1',
      path: '/tmp/virtual.txt',
    });
    assert.strictEqual(readRes.content, 'Hello from virtual FS');

    // Agent writes text file to client
    await runtime.clientBridge.writeTextFile({
      sessionId: 'sess_1',
      path: '/tmp/newfile.txt',
      content: 'Written by agent',
    });
    assert.strictEqual(virtualFiles.get('/tmp/newfile.txt'), 'Written by agent');

    await client.close();
    runtime.db.close();
  });

  test('13. Client Methods: terminal lifecycle (create, output, wait_for_exit, kill, release)', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({ transport: serverTransport, dbPath: ':memory:' });

    const client = new AcpClient(clientTransport, {
      onCreateTerminal: async (params) => ({ terminalId: 'term_custom_42' }),
      onTerminalOutput: async (params) => ({ output: 'test terminal output\n' }),
      onWaitForTerminalExit: async (params) => ({ exitCode: 0 }),
      onKillTerminal: async (params) => ({}),
      onReleaseTerminal: async (params) => ({}),
    });

    await client.initialize();

    const term = await runtime.clientBridge.createTerminal({
      sessionId: 'sess_1',
      command: 'echo',
      args: ['hello'],
    });
    assert.strictEqual(term.terminalId, 'term_custom_42');

    const output = await runtime.clientBridge.terminalOutput({
      sessionId: 'sess_1',
      terminalId: term.terminalId,
    });
    assert.strictEqual(output.output, 'test terminal output\n');

    const exit = await runtime.clientBridge.waitForTerminalExit({
      sessionId: 'sess_1',
      terminalId: term.terminalId,
    });
    assert.strictEqual(exit.exitCode, 0);

    const killRes = await runtime.clientBridge.killTerminal({
      sessionId: 'sess_1',
      terminalId: term.terminalId,
    });
    assert.ok(killRes);

    const relRes = await runtime.clientBridge.releaseTerminal({
      sessionId: 'sess_1',
      terminalId: term.terminalId,
    });
    assert.ok(relRes);

    await client.close();
    runtime.db.close();
  });

  test('14. Client Methods: elicitation/create and complete notification', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({ transport: serverTransport, dbPath: ':memory:' });

    let elicitationCompleted = false;
    const client = new AcpClient(clientTransport, {
      onCreateElicitation: async (params) => {
        return { action: 'submit', values: { username: 'alice' } };
      },
    });

    client.onElicitationComplete((notif) => {
      elicitationCompleted = true;
    });

    await client.initialize();

    const elicitationRes = await runtime.clientBridge.createElicitation({
      sessionId: 'sess_1',
      elicitationId: 'elicit_1',
      title: 'Configure User',
      requestedFields: [{ id: 'username', label: 'Username', type: 'string', required: true }],
    });

    assert.strictEqual(elicitationRes.action, 'submit');
    assert.strictEqual(elicitationRes.values?.username, 'alice');

    // Agent emits elicitation/complete notification
    runtime.dispatcher.emitCompleteElicitation({
      elicitationId: 'elicit_1',
    });

    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(elicitationCompleted, true);

    await client.close();
    runtime.db.close();
  });
});
