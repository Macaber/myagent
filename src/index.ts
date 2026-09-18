#!/usr/bin/env node
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { AgentDatabase } from './persistence/db.js';
import { AcpTransport } from './protocol/transport.js';
import { StdioTransport } from './protocol/stdio-transport.js';
import { HttpTransport } from './protocol/http-transport.js';
import { DualTransport } from './protocol/dual-transport.js';
import { RpcDispatcher } from './protocol/rpc-dispatcher.js';
import { WorkspaceJail } from './security/workspace-jail.js';
import { PolicyEngine } from './security/policy-engine.js';
import { ApprovalGate } from './security/approval-gate.js';
import { ToolRegistry } from './tools/tool-registry.js';
import {
  bashTool,
  editTool,
  writeTool,
  readTool,
  grepTool,
  globTool,
} from './tools/core-tools.js';
import {
  todoWriteTool,
  skillTool,
  questionTool,
  patchTool,
} from './tools/extended-tools.js';
import { SkillRegistry } from './skills/skill-registry.js';
import { McpManager } from './mcp/mcp-manager.js';
import { McpServerConfig } from './mcp/types.js';
import { OpenAIProvider } from './provider/openai-provider.js';
import { VerificationGuard } from './engine/verification-guard.js';
import { Planner } from './engine/planner.js';
import { WorkerAgent } from './engine/worker.js';
import { ToolRouter } from './engine/tool-router.js';
import { DynamicContextAssembler } from './context/dynamic-context-assembler.js';
import { TaskRunner } from './runtime/task-runner.js';
import { ThreadContext } from './runtime/thread-context.js';
import { SubagentManager } from './runtime/subagent-manager.js';
import { createInvokeSubagentTool } from './tools/subagent-tool.js';
import {
  InitializeParams,
  InitializeResult,
  SessionNewParams,
  SessionNewResult,
  SessionPromptParams,
  SessionPromptResult,
  SessionLoadParams,
  SessionLoadResult,
  SessionCancelParams,
  SessionCancelResult,
  TaskStartParams,
  TaskStartResult,
  TaskResumeParams,
  TaskResumeResult,
} from './protocol/types.js';

export interface AgentRuntimeOptions {
  workspaceRoot?: string;
  dbPath?: string;
  transport?: AcpTransport;
  transportMode?: 'stdio' | 'http' | 'dual';
  httpPort?: number;
  httpHost?: string;
  provider?: OpenAIProvider;
  autoDiscoverProvider?: boolean;
  autoScanSkills?: boolean;
  autoLoadMcp?: boolean;
}

export function extractPromptText(raw: any): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          return item.text || item.content || item.value || '';
        }
        return String(item || '');
      })
      .filter(Boolean)
      .join('\n');
  }
  if (raw && typeof raw === 'object') {
    return raw.text || raw.content || raw.value || JSON.stringify(raw);
  }
  return String(raw || '');
}

export function resolveDefaultProvider(root: string): OpenAIProvider | undefined {
  if (process.env.OPENAI_API_KEY) {
    return new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_MODEL,
    });
  }

  // 1. Try loading .env from root or ~/.agent/.env
  try {
    const cwdEnv = path.join(root, '.env');
    if (fs.existsSync(cwdEnv) && typeof (process as any).loadEnvFile === 'function') {
      (process as any).loadEnvFile(cwdEnv);
    }
    const homeAgentEnv = path.join(os.homedir(), '.agent', '.env');
    if (fs.existsSync(homeAgentEnv) && typeof (process as any).loadEnvFile === 'function') {
      (process as any).loadEnvFile(homeAgentEnv);
    }
  } catch {}

  if (process.env.OPENAI_API_KEY) {
    return new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_MODEL,
    });
  }

  // 2. Try loading from ~/.pi/agent/auth.json
  try {
    const authPath = path.join(os.homedir(), '.pi', 'agent', 'auth.json');
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      if (auth.deepseek?.key) {
        return new OpenAIProvider({
          apiKey: auth.deepseek.key,
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
        });
      }
      if (auth.openai?.key) {
        return new OpenAIProvider({
          apiKey: auth.openai.key,
        });
      }
    }
  } catch {}

  return undefined;
}

export function createAgentRuntime(options: AgentRuntimeOptions = {}) {
  const root = path.resolve(options.workspaceRoot || process.cwd());
  const db = new AgentDatabase({ dbPath: options.dbPath });

  // Transport initialization (Stdio, HTTP, or Dual)
  let transport: AcpTransport;
  let httpTransport: HttpTransport | undefined;
  let dualTransport: DualTransport | undefined;

  if (options.transport) {
    transport = options.transport;
  } else if (options.transportMode === 'http') {
    httpTransport = new HttpTransport({ port: options.httpPort, host: options.httpHost });
    transport = httpTransport;
  } else if (options.transportMode === 'dual') {
    const stdio = new StdioTransport();
    httpTransport = new HttpTransport({ port: options.httpPort, host: options.httpHost });
    dualTransport = new DualTransport([stdio, httpTransport]);
    transport = dualTransport;
  } else {
    // Default: official ACP stdio transport
    transport = new StdioTransport();
  }

  const dispatcher = new RpcDispatcher(transport);

  const jail = new WorkspaceJail(root);
  const policyEngine = new PolicyEngine(jail);
  const approvalGate = new ApprovalGate(policyEngine, dispatcher);

  const toolRegistry = new ToolRegistry(approvalGate);
  // Register Core Tools
  toolRegistry.registerTool(bashTool);
  toolRegistry.registerTool(editTool);
  toolRegistry.registerTool(writeTool);
  toolRegistry.registerTool(readTool);
  toolRegistry.registerTool(grepTool);
  toolRegistry.registerTool(globTool);

  // Register Extended Tools (websearch and webfetch deleted)
  toolRegistry.registerTool(todoWriteTool);
  toolRegistry.registerTool(skillTool);
  toolRegistry.registerTool(questionTool);
  toolRegistry.registerTool(patchTool);

  // Initialize Dynamic Skills Registry
  const skillRegistry = new SkillRegistry();
  if (options.autoScanSkills !== false) {
    skillRegistry.loadSkillsFromDirectory(path.join(root, '.agent', 'skills')).catch(() => {});
    skillRegistry.loadSkillsFromDirectory(path.join(root, 'skills')).catch(() => {});
    skillRegistry.watchSkillsDirectory(path.join(root, '.agent', 'skills'));
  }

  // Initialize MCP Dynamic Manager
  const mcpManager = new McpManager(toolRegistry);
  if (options.autoLoadMcp !== false) {
    mcpManager.loadConfigFile(path.join(root, '.agent', 'mcp.json')).catch(() => {});
  }
  let provider = options.provider;
  if (!provider) {
    if (process.env.OPENAI_API_KEY) {
      provider = new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_BASE_URL,
        model: process.env.OPENAI_MODEL,
      });
    } else if (options.autoDiscoverProvider) {
      provider = resolveDefaultProvider(root);
    }
  }

  const verificationGuard = new VerificationGuard(toolRegistry);
  const toolRouter = new ToolRouter(toolRegistry);
  const contextAssembler = new DynamicContextAssembler();
  const planner = new Planner(provider, toolRegistry);
  const worker = new WorkerAgent(provider, toolRegistry, skillRegistry, verificationGuard, toolRouter, contextAssembler);
  const runner = new TaskRunner(planner, worker, toolRegistry);

  const activeThreads = new Map<string, ThreadContext>();
  const sessionAbortControllers = new Map<string, AbortController>();

  // Register Subagent Manager & Tool
  const subagentManager = new SubagentManager(db, worker, toolRegistry, skillRegistry, dispatcher);
  const invokeSubagentTool = createInvokeSubagentTool(subagentManager, (id) => activeThreads.get(id));
  toolRegistry.registerTool(invokeSubagentTool);

  // =========================================================================
  // 1. Official Canonical ACP Methods (agentclientprotocol.com)
  // =========================================================================

  // ACP: initialize
  dispatcher.registerMethod<InitializeParams, InitializeResult>('initialize', async (params) => {
    return {
      protocolVersion: '2024-11-05',
      agentInfo: { name: 'MyAgent-Runtime', version: '0.1.0' },
      agentCapabilities: {
        loadSession: true,
        prompt: true,
        streaming: true,
        tools: toolRegistry.getAllTools().map((t) => t.name),
        skills: skillRegistry.listSkills().map((s) => s.id),
      },
      capabilities: {
        permissions: true,
        streaming: true,
        tools: toolRegistry.getAllTools().map((t) => t.name),
        skills: skillRegistry.listSkills().map((s) => s.id),
      },
    };
  });

  // ACP: session/new
  dispatcher.registerMethod<SessionNewParams, SessionNewResult>('session/new', async (params) => {
    const sessionId = params.sessionId || `session_${Date.now()}`;
    const workspace = (params.roots && params.roots[0]) || params.workspacePath || root;

    const thread = new ThreadContext(
      {
        threadId: sessionId,
        sessionId,
        prompt: params.systemPrompt || 'Session initialized',
        workspacePath: path.resolve(workspace),
      },
      db,
      dispatcher
    );

    activeThreads.set(sessionId, thread);
    return { sessionId };
  });

  // ACP: session/prompt
  dispatcher.registerMethod<SessionPromptParams, SessionPromptResult>('session/prompt', async (params) => {
    const rawPrompt = params.prompt ?? params.content;
    const promptText = extractPromptText(rawPrompt);

    let thread = activeThreads.get(params.sessionId);
    if (!thread) {
      thread = new ThreadContext(
        {
          threadId: params.sessionId,
          sessionId: params.sessionId,
          prompt: promptText,
          workspacePath: root,
        },
        db,
        dispatcher
      );
      activeThreads.set(params.sessionId, thread);
    } else {
      thread.setPrompt(promptText);
    }

    const abortController = new AbortController();
    sessionAbortControllers.set(params.sessionId, abortController);

    try {
      const report = await runner.runTask(thread, {
        userHint: params.userHint,
        abortSignal: abortController.signal,
      });

      const summaryText =
        report.status === 'COMPLETED'
          ? 'Task completed successfully'
          : report.status === 'SUSPENDED_INPUT'
          ? 'Execution blocked: requires user input'
          : `Execution failed: ${report.status}`;

      const stopReason =
        report.status === 'COMPLETED'
          ? 'end_turn'
          : report.status === 'SUSPENDED_INPUT'
          ? 'requires_action'
          : 'error';

      return {
        sessionId: params.sessionId,
        stopReason,
        status: report.status === 'COMPLETED' ? 'completed' : report.status === 'SUSPENDED_INPUT' ? 'blocked' : 'error',
        summary: summaryText,
        content: [{ type: 'text', text: summaryText }],
        metrics: report,
      };
    } finally {
      sessionAbortControllers.delete(params.sessionId);
    }
  });

  // ACP: session/load
  dispatcher.registerMethod<SessionLoadParams, SessionLoadResult>('session/load', async (params) => {
    const thread = activeThreads.get(params.sessionId);
    if (!thread) {
      throw new Error(`Session '${params.sessionId}' not found`);
    }

    const abortController = new AbortController();
    sessionAbortControllers.set(params.sessionId, abortController);

    try {
      const report = await runner.resumeTask(thread, {
        targetMilestoneId: params.targetMilestoneId,
        userHint: params.userHint,
        abortSignal: abortController.signal,
      });

      return {
        sessionId: params.sessionId,
        status: report.status,
        resumedFromMilestoneId: params.targetMilestoneId,
        metrics: report,
      };
    } finally {
      sessionAbortControllers.delete(params.sessionId);
    }
  });

  // ACP: session/cancel
  dispatcher.registerMethod<SessionCancelParams, SessionCancelResult>('session/cancel', async (params) => {
    const controller = sessionAbortControllers.get(params.sessionId);
    if (controller) {
      controller.abort();
      sessionAbortControllers.delete(params.sessionId);
      return { sessionId: params.sessionId, cancelled: true };
    }
    return { sessionId: params.sessionId, cancelled: false };
  });

  // =========================================================================
  // 2. Legacy / Task-Centric Compatibility Aliases
  // =========================================================================

  dispatcher.registerMethod<TaskStartParams, TaskStartResult>('task/start', async (params) => {
    const threadId = params.taskId || `task_${Date.now()}`;
    const workspace = params.workspacePath ? path.resolve(params.workspacePath) : root;

    const thread = new ThreadContext(
      {
        threadId,
        sessionId: `session_${Date.now()}`,
        prompt: params.prompt,
        workspacePath: workspace,
      },
      db,
      dispatcher
    );

    activeThreads.set(threadId, thread);

    queueMicrotask(async () => {
      try {
        await runner.runTask(thread, { userHint: params.userHints });
      } catch (err: any) {
        console.error(`[AgentRuntime] Error running task ${threadId}:`, err);
      }
    });

    return {
      threadId,
      status: 'ACCEPTED',
    };
  });

  dispatcher.registerMethod<TaskResumeParams, TaskResumeResult>('task/resume', async (params) => {
    const thread = activeThreads.get(params.threadId);
    if (!thread) {
      throw new Error(`Thread '${params.threadId}' not found in active threads`);
    }

    queueMicrotask(async () => {
      try {
        await runner.resumeTask(thread, {
          targetMilestoneId: params.targetMilestoneId,
          userHint: params.userHint,
        });
      } catch (err: any) {
        console.error(`[AgentRuntime] Error resuming task ${params.threadId}:`, err);
      }
    });

    return {
      threadId: params.threadId,
      status: 'RESUMED',
      resumedFromMilestoneId: params.targetMilestoneId,
    };
  });

  dispatcher.registerMethod<{ threadId: string }, any>('task/status', async (params) => {
    const thread = activeThreads.get(params.threadId);
    if (!thread) {
      throw new Error(`Thread '${params.threadId}' not found`);
    }
    return thread.telemetryStore.getThreadMetrics(params.threadId);
  });

  // =========================================================================
  // 3. Dynamic MCP & Skills Control Methods
  // =========================================================================

  dispatcher.registerMethod<McpServerConfig, any>('mcp/mount', async (params) => {
    return mcpManager.mountServer(params);
  });

  dispatcher.registerMethod<{ id: string }, any>('mcp/unmount', async (params) => {
    const success = await mcpManager.unmountServer(params.id);
    return { id: params.id, success };
  });

  dispatcher.registerMethod<void, any>('mcp/list', async () => {
    return { servers: mcpManager.listMountedServers() };
  });

  dispatcher.registerMethod<void, any>('skills/list', async () => {
    return { skills: skillRegistry.listSkills() };
  });

  dispatcher.registerMethod<{ path?: string }, any>('skills/reload', async (params) => {
    const dir = params?.path || path.join(root, '.agent', 'skills');
    const loaded = await skillRegistry.loadSkillsFromDirectory(dir);
    return { reloadedCount: loaded.length, skills: skillRegistry.listSkills().map((s) => s.id) };
  });

  return {
    db,
    dispatcher,
    transport,
    httpTransport,
    dualTransport,
    toolRegistry,
    skillRegistry,
    toolRouter,
    contextAssembler,
    mcpManager,
    runner,
    activeThreads,
  };
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    const entryPath = fs.realpathSync(process.argv[1]);
    const selfPath = fs.realpathSync(fileURLToPath(import.meta.url));
    return entryPath === selfPath;
  } catch {
    return false;
  }
}

// Direct CLI Execution
if (isDirectExecution()) {
  const args = process.argv.slice(2);
  let mode: 'stdio' | 'http' | 'dual' = 'stdio';
  let port = 3000;

  for (const arg of args) {
    if (arg.startsWith('--mode=')) mode = arg.split('=')[1] as any;
    if (arg === '--http') mode = 'http';
    if (arg === '--dual') mode = 'dual';
    if (arg.startsWith('--port=')) port = parseInt(arg.split('=')[1], 10);
  }

  // Write status to stderr so stdout remains 100% clean JSON-RPC for ACP stdio clients
  console.error(`[MyAgent] Starting Agent Runtime (mode: ${mode}, port: ${port})...`);
  const runtime = createAgentRuntime({
    workspaceRoot: process.cwd(),
    dbPath: path.join(process.cwd(), '.agent', 'data.db'),
    transportMode: mode,
    httpPort: port,
    autoDiscoverProvider: true,
  });

  if (runtime.httpTransport) {
    runtime.httpTransport.start().then((actualPort) => {
      console.error(`[MyAgent] HTTP JSON-RPC & SSE server listening at http://127.0.0.1:${actualPort}`);
    });
  }
}
