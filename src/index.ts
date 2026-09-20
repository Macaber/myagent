#!/usr/bin/env node
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { AgentDatabase } from './persistence/db.js';
import { getMyAgentHome, getDefaultDbPath, getSkillsDir, getMcpConfigPath, getEnvFilePath } from './config/paths.js';
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
import { planTaskTool } from './tools/plan-tool.js';
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
  ACP_ERROR_CODES,
  InitializeRequest,
  InitializeResponse,
  AuthenticateRequest,
  AuthenticateResponse,
  LogoutRequest,
  LogoutResponse,
  NewSessionRequest,
  NewSessionResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  CancelNotification,
  SessionMode,
  SessionModeState,
  SessionConfigOption,
  SessionInfo,
  SessionUpdate,
  UserMessageChunkUpdate,
  AgentMessageChunkUpdate,
  UsageNotificationUpdate,
  McpServer,
  StopReason,
  ContentBlock,
  ClientCapabilities,
  ClientInfo,
  AvailableCommand,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  CreateElicitationRequest,
  CreateElicitationResponse,
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

export const DEFAULT_AVAILABLE_COMMANDS: AvailableCommand[] = [
  { name: 'help', description: 'Show available commands and runtime tips' },
  { name: 'mode', description: 'Switch execution mode (code, ask, architect)' },
  { name: 'clear', description: 'Clear context or reset session state' },
  { name: 'plan', description: 'View current execution plan and milestones' },
];

export const DEFAULT_MODES: SessionMode[] = [
  { id: 'code', name: 'Code', description: 'Write and modify code with full tool access' },
  { id: 'ask', name: 'Ask', description: 'Request permission before making any changes' },
  { id: 'architect', name: 'Architect', description: 'Design and plan systems without implementation' },
];

export function createDefaultConfigOptions(supportsBoolean: boolean): SessionConfigOption[] {
  const options: SessionConfigOption[] = [
    {
      type: 'select',
      id: 'mode',
      name: 'Session Mode',
      description: 'Controls how the agent requests permission',
      category: 'mode',
      currentValue: 'code',
      options: [
        { value: 'code', name: 'Code', description: 'Write and modify code with full tool access' },
        { value: 'ask', name: 'Ask', description: 'Request permission before making any changes' },
        { value: 'architect', name: 'Architect', description: 'Design and plan systems without implementation' },
      ],
    },
    {
      type: 'select',
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default Model', description: 'The configured default LLM' },
      ],
    },
  ];

  if (supportsBoolean) {
    options.push({
      type: 'boolean',
      id: 'auto_approve',
      name: 'Auto Approve',
      description: 'Skip manual confirmation for read-only actions',
      category: '_approval',
      currentValue: false,
    });
  }

  return options;
}

export interface StoredSession {
  sessionId: string;
  cwd: string;
  additionalDirectories: string[];
  title: string | null;
  createdAt: string;
  updatedAt: string;
  currentModeId: string;
  configOptions: SessionConfigOption[];
  mcpServers: McpServer[];
  history: SessionUpdate[];
  thread: ThreadContext;
  deleted: boolean;
  closed: boolean;
}

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

export function toEnvRecord(env: any): Record<string, string> | undefined {
  if (Array.isArray(env)) {
    return Object.fromEntries(env.map((e: any) => [e.name, e.value]));
  }
  if (env && typeof env === 'object') {
    return env as Record<string, string>;
  }
  return undefined;
}

export function resolveDefaultProvider(root: string): OpenAIProvider | undefined {
  if (process.env.OPENAI_API_KEY) {
    return new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_MODEL,
    });
  }

  // 1. Try loading .env from root or ~/.myagent/.env
  try {
    const cwdEnv = path.join(root, '.env');
    if (fs.existsSync(cwdEnv) && typeof (process as any).loadEnvFile === 'function') {
      (process as any).loadEnvFile(cwdEnv);
    }
    const homeAgentEnv = getEnvFilePath();
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
  toolRegistry.registerTool(planTaskTool);
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

  const sessions = new Map<string, StoredSession>();
  const activeThreads = new Map<string, ThreadContext>();
  const sessionAbortControllers = new Map<string, AbortController>();
  let clientCapabilities: ClientCapabilities = {};
  let clientInfo: ClientInfo | null | undefined = undefined;
  let authenticated: boolean = false;

  // Register Subagent Manager & Tool
  const subagentManager = new SubagentManager(db, worker, toolRegistry, skillRegistry, dispatcher);
  const invokeSubagentTool = createInvokeSubagentTool(subagentManager, (id) => activeThreads.get(id));
  toolRegistry.registerTool(invokeSubagentTool);

  // =========================================================================
  // 1. Official Canonical ACP Methods (agentclientprotocol.com)
  // =========================================================================

  // ACP: initialize
  dispatcher.registerMethod<InitializeRequest, InitializeResponse>('initialize', async (params) => {
    let version: any = 1;
    if (params?.protocolVersion !== undefined) {
      version = params.protocolVersion;
    }

    clientCapabilities = params?.clientCapabilities || {};
    clientInfo = params?.clientInfo;

    return {
      protocolVersion: version,
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
      authMethods: [
        { id: 'token', name: 'API Token', description: 'Authenticate using OpenAI or DeepSeek API key' },
      ],
    };
  });

  // ACP: authenticate
  dispatcher.registerMethod<AuthenticateRequest, AuthenticateResponse>('authenticate', async (params) => {
    if (!params || !params.methodId) {
      throw { code: ACP_ERROR_CODES.INVALID_PARAMS, message: 'Missing methodId' };
    }
    if (params.data?.token || params.data?.apiKey) {
      const apiKey = params.data.token || params.data.apiKey;
      provider = new OpenAIProvider({
        apiKey,
        baseUrl: params.data.baseUrl,
        model: params.data.model,
      });
    }
    authenticated = true;
    return { success: true };
  });

  // ACP: logout
  dispatcher.registerMethod<LogoutRequest, LogoutResponse>('logout', async () => {
    authenticated = false;
    return { success: true };
  });

  let nextSessionSeq = 1;

  // ACP: session/new
  dispatcher.registerMethod<NewSessionRequest, NewSessionResponse>('session/new', async (params) => {
    const sessionId = (params as any)?.sessionId || `session_${Date.now()}_${nextSessionSeq++}`;
    const cwd = params?.cwd || (params as any)?.workspacePath || ((params as any)?.roots && (params as any)?.roots[0]) || root;
    const additionalDirectories = params?.additionalDirectories || [];
    const mcpServers = params?.mcpServers || [];

    // Mount MCP servers if provided in params
    if (mcpServers.length > 0) {
      for (const server of mcpServers) {
        if ('command' in server) {
          await mcpManager.mountServer({
            id: server.name,
            name: server.name,
            transport: 'stdio',
            command: server.command,
            args: server.args,
            env: toEnvRecord(server.env),
          }).catch(() => {});
        }
      }
    }

    const supportsBoolean = Boolean(
      clientCapabilities?.session?.configOptions?.boolean || (clientCapabilities as any)?.configOptions?.boolean
    );
    const configOptions = createDefaultConfigOptions(supportsBoolean);
    const currentModeId = 'code';

    const thread = new ThreadContext(
      {
        threadId: sessionId,
        sessionId,
        prompt: (params as any)?.systemPrompt || 'Session initialized',
        workspacePath: path.resolve(cwd),
      },
      db,
      dispatcher
    );

    const storedSession: StoredSession = {
      sessionId,
      cwd: path.resolve(cwd),
      additionalDirectories,
      title: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentModeId,
      configOptions,
      mcpServers,
      history: [],
      thread,
      deleted: false,
      closed: false,
    };

    sessions.set(sessionId, storedSession);
    activeThreads.set(sessionId, thread);

    db.saveAcpSession({
      sessionId,
      cwd: storedSession.cwd,
      title: storedSession.title,
      additionalDirectories,
      currentModeId,
      configOptions,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Emit available_commands_update per ACP specification
    dispatcher.emitSessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: DEFAULT_AVAILABLE_COMMANDS,
      },
    });

    return {
      sessionId,
      modes: {
        currentModeId,
        availableModes: DEFAULT_MODES,
      },
      configOptions,
    };
  });

  // ACP: session/load
  dispatcher.registerMethod<LoadSessionRequest, LoadSessionResponse>('session/load', async (params) => {
    let session = sessions.get(params.sessionId);
    if (!session) {
      const fromDb = db.getAcpSession(params.sessionId);
      if (!fromDb) {
        const err: any = new Error(`Session '${params.sessionId}' not found`);
        err.code = ACP_ERROR_CODES.RESOURCE_NOT_FOUND;
        throw err;
      }
      const thread = new ThreadContext(
        {
          threadId: fromDb.sessionId,
          sessionId: fromDb.sessionId,
          prompt: 'Session loaded',
          workspacePath: path.resolve(fromDb.cwd),
        },
        db,
        dispatcher
      );
      const history = (fromDb.history && fromDb.history.length > 0)
        ? fromDb.history
        : db.synthesizeSessionHistory(params.sessionId);

      session = {
        sessionId: fromDb.sessionId,
        cwd: fromDb.cwd,
        additionalDirectories: fromDb.additionalDirectories,
        title: fromDb.title,
        createdAt: new Date(fromDb.createdAt).toISOString(),
        updatedAt: new Date(fromDb.updatedAt).toISOString(),
        currentModeId: fromDb.currentModeId || 'code',
        configOptions: fromDb.configOptions || createDefaultConfigOptions(true),
        mcpServers: [],
        history,
        thread,
        deleted: false,
        closed: false,
      };
      sessions.set(params.sessionId, session);
      activeThreads.set(params.sessionId, thread);
    }

    if (session.deleted) {
      const err: any = new Error(`Session '${params.sessionId}' not found`);
      err.code = ACP_ERROR_CODES.RESOURCE_NOT_FOUND;
      throw err;
    }

    if (params.cwd) session.cwd = path.resolve(params.cwd);
    if (params.additionalDirectories) session.additionalDirectories = params.additionalDirectories;
    if (params.mcpServers) {
      session.mcpServers = params.mcpServers;
      for (const server of params.mcpServers) {
        if ('command' in server) {
          await mcpManager.mountServer({
            id: server.name,
            name: server.name,
            transport: 'stdio',
            command: server.command,
            args: server.args,
            env: toEnvRecord(server.env),
          }).catch(() => {});
        }
      }
    }

    // Replay conversation history via session/update notifications so the client reconstructs the conversation!
    for (const histUpdate of session.history) {
      dispatcher.emitSessionUpdate({
        sessionId: session.sessionId,
        update: histUpdate,
      });
    }

    // Legacy support for targetMilestoneId / userHint
    if ((params as any)?.targetMilestoneId || (params as any)?.userHint) {
      const abortController = new AbortController();
      sessionAbortControllers.set(params.sessionId, abortController);
      try {
        const report = await runner.resumeTask(session.thread, {
          targetMilestoneId: (params as any).targetMilestoneId,
          userHint: (params as any).userHint,
          abortSignal: abortController.signal,
        });
        return {
          sessionId: params.sessionId,
          modes: {
            currentModeId: session.currentModeId,
            availableModes: DEFAULT_MODES,
          },
          configOptions: session.configOptions,
          status: report.status,
          resumedFromMilestoneId: (params as any).targetMilestoneId,
          metrics: report,
        } as any;
      } finally {
        sessionAbortControllers.delete(params.sessionId);
      }
    }

    return {
      sessionId: params.sessionId,
      modes: {
        currentModeId: session.currentModeId,
        availableModes: DEFAULT_MODES,
      },
      configOptions: session.configOptions,
      status: 'READY',
    } as any;
  });

  // ACP: session/resume
  dispatcher.registerMethod<ResumeSessionRequest, ResumeSessionResponse>('session/resume', async (params) => {
    let session = sessions.get(params.sessionId);
    if (!session) {
      const fromDb = db.getAcpSession(params.sessionId);
      if (!fromDb) {
        const err: any = new Error(`Session '${params.sessionId}' not found`);
        err.code = ACP_ERROR_CODES.RESOURCE_NOT_FOUND;
        throw err;
      }
      const thread = new ThreadContext(
        {
          threadId: fromDb.sessionId,
          sessionId: fromDb.sessionId,
          prompt: 'Session resumed',
          workspacePath: path.resolve(fromDb.cwd),
        },
        db,
        dispatcher
      );
      const history = (fromDb.history && fromDb.history.length > 0)
        ? fromDb.history
        : db.synthesizeSessionHistory(params.sessionId);

      session = {
        sessionId: fromDb.sessionId,
        cwd: fromDb.cwd,
        additionalDirectories: fromDb.additionalDirectories,
        title: fromDb.title,
        createdAt: new Date(fromDb.createdAt).toISOString(),
        updatedAt: new Date(fromDb.updatedAt).toISOString(),
        currentModeId: fromDb.currentModeId || 'code',
        configOptions: fromDb.configOptions || createDefaultConfigOptions(true),
        mcpServers: [],
        history,
        thread,
        deleted: false,
        closed: false,
      };
      sessions.set(params.sessionId, session);
      activeThreads.set(params.sessionId, thread);
    }

    if (session.deleted) {
      const err: any = new Error(`Session '${params.sessionId}' not found`);
      err.code = ACP_ERROR_CODES.RESOURCE_NOT_FOUND;
      throw err;
    }

    if (params.cwd) session.cwd = path.resolve(params.cwd);
    if (params.additionalDirectories) session.additionalDirectories = params.additionalDirectories;
    if (params.mcpServers) {
      session.mcpServers = params.mcpServers;
      for (const server of params.mcpServers) {
        if ('command' in server) {
          await mcpManager.mountServer({
            id: server.name,
            name: server.name,
            transport: 'stdio',
            command: server.command,
            args: server.args,
            env: toEnvRecord(server.env),
          }).catch(() => {});
        }
      }
    }

    return {
      sessionId: params.sessionId,
      modes: {
        currentModeId: session.currentModeId,
        availableModes: DEFAULT_MODES,
      },
      configOptions: session.configOptions,
    };
  });

  // ACP: session/list
  dispatcher.registerMethod<ListSessionsRequest, ListSessionsResponse>('session/list', async (params) => {
    const cwdFilter = params?.cwd ? path.resolve(params.cwd) : undefined;
    const result = db.listAcpSessions(cwdFilter, 50, params?.cursor || undefined);
    return {
      sessions: result.sessions,
      nextCursor: result.nextCursor,
    };
  });

  // ACP: session/close
  dispatcher.registerMethod<CloseSessionRequest, CloseSessionResponse>('session/close', async (params) => {
    const controller = sessionAbortControllers.get(params.sessionId);
    if (controller) {
      controller.abort();
      sessionAbortControllers.delete(params.sessionId);
    }
    const session = sessions.get(params.sessionId);
    if (session) {
      session.closed = true;
      session.updatedAt = new Date().toISOString();
    }
    return { success: true, sessionId: params.sessionId, closed: true } as any;
  });

  // ACP: session/delete
  dispatcher.registerMethod<DeleteSessionRequest, DeleteSessionResponse>('session/delete', async (params) => {
    const controller = sessionAbortControllers.get(params.sessionId);
    if (controller) {
      controller.abort();
      sessionAbortControllers.delete(params.sessionId);
    }
    const session = sessions.get(params.sessionId);
    if (session) {
      session.deleted = true;
      sessions.delete(params.sessionId);
      activeThreads.delete(params.sessionId);
    }
    db.deleteAcpSession(params.sessionId);
    return { success: true, sessionId: params.sessionId, deleted: true } as any;
  });

  // ACP: session/prompt
  dispatcher.registerMethod<PromptRequest, PromptResponse>('session/prompt', async (params) => {
    const rawPrompt = (params as any)?.prompt ?? (params as any)?.content;
    const promptText = extractPromptText(rawPrompt);

    let session = sessions.get(params.sessionId);
    if (!session) {
      const fromDb = db.getAcpSession(params.sessionId);
      if (fromDb) {
        const thread = new ThreadContext(
          {
            threadId: fromDb.sessionId,
            sessionId: fromDb.sessionId,
            prompt: promptText,
            workspacePath: path.resolve(fromDb.cwd),
          },
          db,
          dispatcher
        );
        session = {
          sessionId: fromDb.sessionId,
          cwd: fromDb.cwd,
          additionalDirectories: fromDb.additionalDirectories,
          title: fromDb.title,
          createdAt: new Date(fromDb.createdAt).toISOString(),
          updatedAt: new Date(fromDb.updatedAt).toISOString(),
          currentModeId: fromDb.currentModeId || 'code',
          configOptions: fromDb.configOptions || createDefaultConfigOptions(true),
          mcpServers: [],
          history: [],
          thread,
          deleted: false,
          closed: false,
        };
        sessions.set(params.sessionId, session);
        activeThreads.set(params.sessionId, thread);
      } else {
        const thread = new ThreadContext(
          {
            threadId: params.sessionId,
            sessionId: params.sessionId,
            prompt: promptText,
            workspacePath: root,
          },
          db,
          dispatcher
        );
        session = {
          sessionId: params.sessionId,
          cwd: root,
          additionalDirectories: [],
          title: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          currentModeId: 'code',
          configOptions: createDefaultConfigOptions(true),
          mcpServers: [],
          history: [],
          thread,
          deleted: false,
          closed: false,
        };
        sessions.set(params.sessionId, session);
        activeThreads.set(params.sessionId, thread);
        db.saveAcpSession({
          sessionId: params.sessionId,
          cwd: root,
          title: null,
          additionalDirectories: [],
          currentModeId: 'code',
          configOptions: session.configOptions,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    } else {
      if (session.thread.getState() === 'RUNNING') {
        session.thread.pushSteering(promptText);
        const userChunk: SessionUpdate = {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: promptText },
        };
        session.history.push(userChunk);
        dispatcher.emitSessionUpdate({
          sessionId: params.sessionId,
          update: userChunk,
        });
        return {
          sessionId: params.sessionId,
          stopReason: 'steering_queued',
          status: 'running',
          summary: 'Steering directive queued for active turn',
          content: [{ type: 'text', text: promptText }],
        } as any;
      }
      session.thread.setPrompt(promptText);
      session.updatedAt = new Date().toISOString();
    }

    // Record and emit user message chunk update
    const userChunk: SessionUpdate = {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: promptText },
    };
    session.history.push(userChunk);
    dispatcher.emitSessionUpdate({
      sessionId: params.sessionId,
      update: userChunk,
    });

    const abortController = new AbortController();
    sessionAbortControllers.set(params.sessionId, abortController);

    try {
      const report = await runner.runTask(session.thread, {
        userHint: (params as any)?.userHint,
        abortSignal: abortController.signal,
      });

      if (abortController.signal.aborted) {
        return {
          sessionId: params.sessionId,
          stopReason: 'cancelled',
          status: 'cancelled',
          summary: 'Turn cancelled by client',
          content: [{ type: 'text', text: 'Turn cancelled' }],
        } as any;
      }

      const lastTurn = (report as any).turnsBreakdown?.[(report as any).turnsBreakdown?.length - 1];
      const blockedDetail = lastTurn?.summary ? ` (${lastTurn.summary})` : '';
      const summaryText =
        report.status === 'COMPLETED'
          ? 'Task completed successfully'
          : report.status === 'SUSPENDED_INPUT'
          ? `Execution blocked / suspended${blockedDetail}`
          : `Execution failed: ${report.status}${blockedDetail}`;

      const stopReason: StopReason =
        report.status === 'COMPLETED'
          ? 'end_turn'
          : report.status === 'SUSPENDED_INPUT'
          ? 'requires_action'
          : 'error';

      // Agent message chunk
      const agentChunk: SessionUpdate = {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: summaryText },
      };
      session.history.push(agentChunk);
      dispatcher.emitSessionUpdate({
        sessionId: params.sessionId,
        updateType: 'agent_message_chunk',
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: summaryText },
        data: { text: summaryText },
        update: agentChunk,
      });

      // Usage update
      const usageUpdate: SessionUpdate = {
        sessionUpdate: 'usage_update',
        usage: {
          inputTokens: (report as any).tokenUsage?.inputTokens || 0,
          outputTokens: (report as any).tokenUsage?.outputTokens || 0,
          totalTokens: (report as any).tokenUsage?.totalTokens || 0,
        },
      };
      session.history.push(usageUpdate);
      dispatcher.emitSessionUpdate({
        sessionId: params.sessionId,
        update: usageUpdate,
      });

      // Persist full conversation history to database
      db.saveAcpSession({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: session.title,
        additionalDirectories: session.additionalDirectories,
        currentModeId: session.currentModeId,
        configOptions: session.configOptions,
        history: session.history,
        updatedAt: Date.now(),
      });

      return {
        sessionId: params.sessionId,
        stopReason,
        status: report.status === 'COMPLETED' ? 'completed' : report.status === 'SUSPENDED_INPUT' ? 'blocked' : 'error',
        summary: summaryText,
        content: [{ type: 'text', text: summaryText }],
        metrics: report,
      };
    } catch (err: any) {
      if (abortController.signal.aborted || err?.name === 'AbortError') {
        return {
          sessionId: params.sessionId,
          stopReason: 'cancelled',
          status: 'cancelled',
          summary: 'Turn cancelled',
          content: [{ type: 'text', text: 'Turn cancelled' }],
        } as any;
      }
      throw err;
    } finally {
      sessionAbortControllers.delete(params.sessionId);
    }
  });

  // ACP: session/set_mode
  dispatcher.registerMethod<SetSessionModeRequest, SetSessionModeResponse>('session/set_mode', async (params) => {
    const session = sessions.get(params.sessionId);
    if (!session) {
      const err: any = new Error(`Session '${params.sessionId}' not found`);
      err.code = ACP_ERROR_CODES.RESOURCE_NOT_FOUND;
      throw err;
    }
    const mode = DEFAULT_MODES.find((m) => m.id === params.modeId);
    if (!mode) {
      throw { code: ACP_ERROR_CODES.INVALID_PARAMS, message: `Unknown modeId: ${params.modeId}` };
    }
    session.currentModeId = params.modeId;
    session.updatedAt = new Date().toISOString();
    db.saveAcpSession({
      sessionId: session.sessionId,
      cwd: session.cwd,
      title: session.title,
      additionalDirectories: session.additionalDirectories,
      currentModeId: session.currentModeId,
      configOptions: session.configOptions,
      updatedAt: Date.now(),
    });

    const modeUpdate: SessionUpdate = {
      sessionUpdate: 'current_mode_update',
      modeId: params.modeId,
    };
    session.history.push(modeUpdate);
    dispatcher.emitSessionUpdate({
      sessionId: params.sessionId,
      update: modeUpdate,
    });

    return {
      modes: {
        currentModeId: session.currentModeId,
        availableModes: DEFAULT_MODES,
      },
    };
  });

  // ACP: session/set_config_option
  dispatcher.registerMethod<SetSessionConfigOptionRequest, SetSessionConfigOptionResponse>(
    'session/set_config_option',
    async (params) => {
      const session = sessions.get(params.sessionId);
      if (!session) {
        const err: any = new Error(`Session '${params.sessionId}' not found`);
        err.code = ACP_ERROR_CODES.RESOURCE_NOT_FOUND;
        throw err;
      }
      const option = session.configOptions.find((o) => o.id === params.configOptionId);
      if (!option) {
        throw { code: ACP_ERROR_CODES.INVALID_PARAMS, message: `Config option '${params.configOptionId}' not found` };
      }
      option.currentValue = params.value;
      session.updatedAt = new Date().toISOString();
      db.saveAcpSession({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: session.title,
        additionalDirectories: session.additionalDirectories,
        currentModeId: session.currentModeId,
        configOptions: session.configOptions,
        updatedAt: Date.now(),
      });

      const configUpdate: SessionUpdate = {
        sessionUpdate: 'config_option_update',
        configOptionId: params.configOptionId,
        value: params.value,
      };
      session.history.push(configUpdate);
      dispatcher.emitSessionUpdate({
        sessionId: params.sessionId,
        update: configUpdate,
      });

      return {
        configOptions: session.configOptions,
      };
    }
  );

  // ACP: session/cancel (Both notification and RPC method for compatibility)
  const handleCancelSession = async (params: SessionCancelParams | any) => {
    const sessionId = params?.sessionId;
    if (!sessionId) return { sessionId: '', cancelled: false };
    const controller = sessionAbortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      sessionAbortControllers.delete(sessionId);
      return { sessionId, cancelled: true };
    }
    return { sessionId, cancelled: false };
  };
  dispatcher.registerNotification('session/cancel', async (params) => {
    await handleCancelSession(params);
  });
  dispatcher.registerMethod<SessionCancelParams, SessionCancelResult>('session/cancel', handleCancelSession);

  // =========================================================================
  // 2. Legacy / Task-Centric Compatibility Aliases
  // =========================================================================

  dispatcher.registerMethod<TaskStartParams, TaskStartResult>('task/start', async (params) => {
    const sessionId = params.taskId || `session_${Date.now()}`;
    const threadId = sessionId;
    const workspace = params.workspacePath ? path.resolve(params.workspacePath) : root;

    const thread = new ThreadContext(
      {
        threadId,
        sessionId,
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

  const clientBridge = {
    requestPermission: (params: RequestPermissionRequest) =>
      dispatcher.requestClient<RequestPermissionRequest, RequestPermissionResponse>('session/request_permission', params),
    readTextFile: (params: ReadTextFileRequest) =>
      dispatcher.requestClient<ReadTextFileRequest, ReadTextFileResponse>('fs/read_text_file', params),
    writeTextFile: (params: WriteTextFileRequest) =>
      dispatcher.requestClient<WriteTextFileRequest, WriteTextFileResponse>('fs/write_text_file', params),
    createTerminal: (params: CreateTerminalRequest) =>
      dispatcher.requestClient<CreateTerminalRequest, CreateTerminalResponse>('terminal/create', params),
    terminalOutput: (params: TerminalOutputRequest) =>
      dispatcher.requestClient<TerminalOutputRequest, TerminalOutputResponse>('terminal/output', params),
    waitForTerminalExit: (params: WaitForTerminalExitRequest) =>
      dispatcher.requestClient<WaitForTerminalExitRequest, WaitForTerminalExitResponse>('terminal/wait_for_exit', params),
    killTerminal: (params: KillTerminalRequest) =>
      dispatcher.requestClient<KillTerminalRequest, KillTerminalResponse>('terminal/kill', params),
    releaseTerminal: (params: ReleaseTerminalRequest) =>
      dispatcher.requestClient<ReleaseTerminalRequest, ReleaseTerminalResponse>('terminal/release', params),
    createElicitation: (params: CreateElicitationRequest) =>
      dispatcher.requestClient<CreateElicitationRequest, CreateElicitationResponse>('elicitation/create', params),
  };

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
    sessions,
    activeThreads,
    clientBridge,
    close: () => {
      skillRegistry.closeWatchers();
      db.close();
      httpTransport?.close();
      transport.close?.();
    },
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

  if (args[0] === 'tui' || args.includes('--tui')) {
    import('./tui/index.js').then((m) => m.runTui()).catch((err) => {
      console.error('[MyAgent TUI] Failed to start:', err);
      process.exit(1);
    });
  } else {
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
    dbPath: getDefaultDbPath(),
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
}
