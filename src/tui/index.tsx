#!/usr/bin/env node
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as util from 'node:util';
import React from 'react';
import { render } from 'ink';
import { AcpClient } from '../client/acp-client.js';
import { createMemoryTransportPair } from '../client/memory-transport.js';
import { HttpAcpClientTransport } from '../client/http-client-transport.js';
import { createAgentRuntime, resolveDefaultProvider } from '../index.js';
import { OpenAIProvider } from '../provider/openai-provider.js';
import { getMyAgentHome, getDefaultDbPath } from '../config/paths.js';
import { App } from './app.js';

interface TuiCliOptions {
  connectUrl?: string;
  workspacePath: string;
  model?: string;
  resumeSessionId?: string;
}

function parseCliArgs(): TuiCliOptions {
  const args = process.argv.slice(2);
  let connectUrl: string | undefined;
  let workspacePath = process.cwd();
  let model: string | undefined;
  let resumeSessionId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--connect=')) {
      connectUrl = arg.split('=')[1];
    } else if (arg === '--connect' && args[i + 1]) {
      connectUrl = args[++i];
    } else if (arg.startsWith('--workspace=')) {
      workspacePath = path.resolve(arg.split('=')[1]);
    } else if (arg === '--workspace' && args[i + 1]) {
      workspacePath = path.resolve(args[++i]);
    } else if (arg.startsWith('--model=')) {
      model = arg.split('=')[1];
    } else if (arg === '--model' && args[i + 1]) {
      model = args[++i];
    } else if (arg.startsWith('--resume=')) {
      resumeSessionId = arg.split('=')[1];
    } else if (arg === '--resume' && args[i + 1]) {
      resumeSessionId = args[++i];
    } else if (arg.startsWith('--session=')) {
      resumeSessionId = arg.split('=')[1];
    } else if (arg === '--session' && args[i + 1]) {
      resumeSessionId = args[++i];
    }
  }

  return { connectUrl, workspacePath, model, resumeSessionId };
}

function redirectConsoleToLogFile(logFilePath: string): () => void {
  const logDir = path.dirname(logFilePath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;

  const writeLog = (prefix: string, ...args: any[]) => {
    const formatted = util.format(...args);
    const line = `[${new Date().toISOString()}] ${prefix} ${formatted}\n`;
    logStream.write(line);
  };

  console.log = (...args: any[]) => writeLog('[INFO]', ...args);
  console.info = (...args: any[]) => writeLog('[INFO]', ...args);
  console.warn = (...args: any[]) => writeLog('[WARN]', ...args);
  console.error = (...args: any[]) => writeLog('[ERROR]', ...args);

  return () => {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    console.info = originalInfo;
    logStream.end();
  };
}

export async function runTui(): Promise<void> {
  const options = parseCliArgs();
  const workspaceRoot = path.resolve(options.workspacePath);

  let client: AcpClient;
  let restoreConsole: (() => void) | undefined;
  let modelName = options.model || process.env.OPENAI_MODEL || 'default';
  let cleanupRuntime: (() => void) | undefined;

  if (options.connectUrl) {
    // 1. Remote ACP connection
    const transport = new HttpAcpClientTransport(options.connectUrl);
    await transport.connect();
    client = new AcpClient(transport);
  } else {
    // 2. Out-of-the-box decoupled in-process ACP communication
    const logFilePath = path.join(getMyAgentHome(), 'tui.log');
    restoreConsole = redirectConsoleToLogFile(logFilePath);

    const { clientTransport, serverTransport } = createMemoryTransportPair();

    let provider: OpenAIProvider | undefined;
    if (process.env.OPENAI_API_KEY) {
      provider = new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_BASE_URL,
        model: options.model || process.env.OPENAI_MODEL,
      });
      modelName = provider.getModel();
    } else {
      provider = resolveDefaultProvider(workspaceRoot);
      if (provider) {
        modelName = provider.getModel();
      }
    }

    const runtime = createAgentRuntime({
      workspaceRoot,
      dbPath: getDefaultDbPath(),
      transport: serverTransport,
      provider,
    });

    cleanupRuntime = () => {
      runtime.db.close();
    };

    client = new AcpClient(clientTransport);
  }

  // 3. ACP Handshake
  await client.initialize({
    roots: [workspaceRoot],
  });

  // 4. Create or Resume Session
  let sessionId: string;
  const initialReplayUpdates: any[] = [];

  if (options.resumeSessionId) {
    sessionId = options.resumeSessionId;
    const unsub = client.onSessionUpdate((notif: any) => {
      initialReplayUpdates.push(notif);
    });

    try {
      await client.loadSession(sessionId);
    } catch (err: any) {
      process.stderr.write(`[TUI Warning] Failed to load session '${sessionId}': ${err.message}. Initializing new session instead.\n`);
      const sessionResult = await client.newSession({
        workspacePath: workspaceRoot,
        roots: [workspaceRoot],
        systemPrompt: 'You are a helpful AI software engineer assistant.',
      });
      sessionId = sessionResult.sessionId;
    } finally {
      unsub();
    }
  } else {
    const sessionResult = await client.newSession({
      workspacePath: workspaceRoot,
      roots: [workspaceRoot],
      systemPrompt: 'You are a helpful AI software engineer assistant.',
    });
    sessionId = sessionResult.sessionId;
  }

  // 5. Render Ink TUI
  const inkApp = render(
    React.createElement(App, {
      client,
      sessionId,
      modelName,
      workspacePath: workspaceRoot,
      initialUpdates: initialReplayUpdates,
      onExit: async () => {
        if (restoreConsole) restoreConsole();
        if (cleanupRuntime) cleanupRuntime();
        await client.close();
        process.exit(0);
      },
    })
  );

  await inkApp.waitUntilExit();
}

// Direct execution
if (process.argv[1] && fs.realpathSync(process.argv[1]).includes('tui')) {
  runTui().catch((err) => {
    process.stderr.write(`[TUI Fatal Error] ${err.message}\n${err.stack || ''}\n`);
    process.exit(1);
  });
}
