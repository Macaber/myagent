import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { PassThrough } from 'node:stream';
import { ToolRegistry } from '../dist/tools/tool-registry.js';
import { StdioTransport } from '../dist/protocol/stdio-transport.js';
import { McpManager } from '../dist/mcp/mcp-manager.js';
import { WorkspaceJail } from '../dist/security/workspace-jail.js';
import { Blackboard } from '../dist/context/blackboard.js';
import { createAgentRuntime } from '../dist/index.js';

describe('MCP Dynamic Mounting & Tool Lifecycle', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  const mockServerScript = path.join(tempDir, 'mock-server.cjs');

  // Create mock MCP Server process script
  fs.writeFileSync(
    mockServerScript,
    `
process.stdin.setEncoding('utf8');
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcp-server', version: '1.0.0' }
        }
      }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'calculate_sum',
              description: 'Calculate sum of two numbers',
              inputSchema: {
                type: 'object',
                properties: { a: { type: 'number' }, b: { type: 'number' } },
                required: ['a', 'b']
              }
            },
            {
              name: 'format_greeting',
              description: 'Format greeting message',
              inputSchema: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name']
              }
            }
          ]
        }
      }) + '\\n');
    } else if (msg.method === 'tools/call') {
      if (msg.params.name === 'calculate_sum') {
        const sum = (msg.params.arguments.a || 0) + (msg.params.arguments.b || 0);
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: 'Result is ' + sum }]
          }
        }) + '\\n');
      } else if (msg.params.name === 'format_greeting') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: 'Hello, ' + msg.params.arguments.name + '!' }]
          }
        }) + '\\n');
      }
    }
  }
});
`
  );

  test('1. McpManager mounts mock server and exposes namespaced tools', async () => {
    const toolRegistry = new ToolRegistry();
    const manager = new McpManager(toolRegistry);

    const serverInfo = await manager.mountServer({
      id: 'calculator',
      name: 'Calculator Server',
      command: process.execPath,
      args: [mockServerScript],
    });

    assert.strictEqual(serverInfo.status, 'connected');
    assert.strictEqual(serverInfo.tools.length, 2);
    assert.ok(serverInfo.tools.includes('mcp__calculator__calculate_sum'));
    assert.ok(serverInfo.tools.includes('mcp__calculator__format_greeting'));

    // Check ToolRegistry has the namespaced tools
    assert.ok(toolRegistry.hasTool('mcp__calculator__calculate_sum'));
    assert.ok(toolRegistry.hasTool('mcp__calculator__format_greeting'));

    // Execute MCP tool via ToolRegistry
    const jail = new WorkspaceJail(tempDir);
    const blackboard = new Blackboard();
    const result = await toolRegistry.executeTool(
      'mcp__calculator__calculate_sum',
      { a: 15, b: 27 },
      {
        threadId: 'test_thread',
        workspaceJail: jail,
        blackboard,
      }
    );

    assert.strictEqual(result.output, 'Result is 42');
    assert.strictEqual(result.error, undefined);

    // Execute second tool
    const greetingResult = await toolRegistry.executeTool(
      'mcp__calculator__format_greeting',
      { name: 'Alice' },
      {
        threadId: 'test_thread',
        workspaceJail: jail,
        blackboard,
      }
    );

    assert.strictEqual(greetingResult.output, 'Hello, Alice!');

    // Unmount and verify cleanup
    const unmounted = await manager.unmountServer('calculator');
    assert.strictEqual(unmounted, true);
    assert.strictEqual(toolRegistry.hasTool('mcp__calculator__calculate_sum'), false);
    assert.strictEqual(toolRegistry.hasTool('mcp__calculator__format_greeting'), false);
  });

  test('2. ACP dispatcher handles mcp/mount, mcp/list, and mcp/unmount RPC methods', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new StdioTransport(input, output);

    const runtime = createAgentRuntime({
      transport,
      workspaceRoot: tempDir,
      dbPath: ':memory:',
      autoScanSkills: false,
      autoLoadMcp: false,
    });

    // Mount via ACP method
    const mountRes = await runtime.dispatcher['methodHandlers'].get('mcp/mount')!({
      id: 'mycalc',
      command: process.execPath,
      args: [mockServerScript],
    });

    assert.strictEqual(mountRes.status, 'connected');
    assert.strictEqual(mountRes.tools.length, 2);

    // List via ACP method
    const listRes = await runtime.dispatcher['methodHandlers'].get('mcp/list')!();
    assert.strictEqual(listRes.servers.length, 1);
    assert.strictEqual(listRes.servers[0].id, 'mycalc');

    // Unmount via ACP method
    const unmountRes = await runtime.dispatcher['methodHandlers'].get('mcp/unmount')!({
      id: 'mycalc',
    });
    assert.strictEqual(unmountRes.success, true);

    const listAfter = await runtime.dispatcher['methodHandlers'].get('mcp/list')!();
    assert.strictEqual(listAfter.servers.length, 0);
  });
});
