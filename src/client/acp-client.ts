import { AcpTransport } from '../protocol/transport.js';
import {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcId,
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
  RequestPermissionRequest,
  RequestPermissionResponse,
  RequestPermissionOutcome,
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
  CompleteElicitationNotification,
  SessionNotification,
  SessionUpdateNotification,
  SessionUpdate,
  ContentBlock,
  PlanEntry,
  AvailableCommand,
  UsageUpdate,
  PermissionDecision,
  SessionCancelParams,
  SessionCancelResult,
  SessionLoadParams,
  SessionLoadResult,
  SessionNewParams,
  SessionNewResult,
  SessionPromptParams,
  SessionPromptResult,
  SessionRequestPermissionParams,
  SessionRequestPermissionResult,
} from '../protocol/types.js';

export type SessionUpdateListener = (update: SessionUpdateNotification | SessionNotification) => void;
export type PermissionRequestListener = (
  req: SessionRequestPermissionParams | RequestPermissionRequest,
  respond: (decision: PermissionDecision | string, reason?: string) => void
) => void;

export interface AcpClientHandlers {
  onReadTextFile?: (params: ReadTextFileRequest) => Promise<ReadTextFileResponse>;
  onWriteTextFile?: (params: WriteTextFileRequest) => Promise<WriteTextFileResponse>;
  onCreateTerminal?: (params: CreateTerminalRequest) => Promise<CreateTerminalResponse>;
  onTerminalOutput?: (params: TerminalOutputRequest) => Promise<TerminalOutputResponse>;
  onWaitForTerminalExit?: (params: WaitForTerminalExitRequest) => Promise<WaitForTerminalExitResponse>;
  onKillTerminal?: (params: KillTerminalRequest) => Promise<KillTerminalResponse>;
  onReleaseTerminal?: (params: ReleaseTerminalRequest) => Promise<ReleaseTerminalResponse>;
  onCreateElicitation?: (params: CreateElicitationRequest) => Promise<CreateElicitationResponse>;
}

export class AcpClient {
  private nextRequestId = 1;
  private pendingRequests = new Map<
    JsonRpcId,
    { resolve: (val: any) => void; reject: (err: any) => void; timer?: NodeJS.Timeout }
  >();

  private updateListeners = new Set<SessionUpdateListener>();
  private permissionListeners = new Set<PermissionRequestListener>();
  private elicitationCompleteListeners = new Set<(notif: CompleteElicitationNotification) => void>();

  private userMessageListeners = new Set<(content: ContentBlock, sessionId: string) => void>();
  private agentMessageListeners = new Set<(content: ContentBlock, sessionId: string) => void>();
  private agentThoughtListeners = new Set<(content: ContentBlock, sessionId: string) => void>();
  private toolCallListeners = new Set<(toolCall: any, sessionId: string) => void>();
  private toolCallUpdateListeners = new Set<(update: any, sessionId: string) => void>();
  private planListeners = new Set<(entries: PlanEntry[], sessionId: string) => void>();
  private availableCommandsListeners = new Set<(commands: AvailableCommand[], sessionId: string) => void>();
  private modeUpdateListeners = new Set<(modeId: string, sessionId: string) => void>();
  private configOptionUpdateListeners = new Set<(optionId: string, value: any, sessionId: string) => void>();
  private usageUpdateListeners = new Set<(usage: UsageUpdate, sessionId: string) => void>();

  public handlers: AcpClientHandlers = {};

  constructor(private readonly transport: AcpTransport, handlers?: AcpClientHandlers) {
    if (handlers) this.handlers = handlers;
    this.transport.onMessage((msg) => this.handleMessage(msg));
  }

  public async request<TParams = any, TResult = any>(
    method: string,
    params: TParams,
    timeoutMs = 600000 // 10 minutes default for long running session/prompt
  ): Promise<TResult> {
    const id = `client_req_${this.nextRequestId++}`;
    const requestMsg: JsonRpcRequest<TParams> = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<TResult>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`ACP request '${method}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.transport.send(requestMsg);
    });
  }

  public notify<TParams = any>(method: string, params: TParams): void {
    const notification: JsonRpcNotification<TParams> = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.transport.send(notification);
  }

  // 1. initialize
  public async initialize(params: Partial<InitializeRequest> = {}): Promise<InitializeResponse> {
    return this.request<InitializeRequest, InitializeResponse>('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'MyAgent-Client', version: '0.1.0' },
      clientCapabilities: {
        permissions: true,
        streaming: true,
        terminal: true,
        fs: { readTextFile: true, writeTextFile: true },
        session: { configOptions: { boolean: {} } },
        configOptions: { boolean: {} },
      },
      ...params,
    });
  }

  // 2. authenticate
  public async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return this.request<AuthenticateRequest, AuthenticateResponse>('authenticate', params);
  }

  // 3. logout
  public async logout(params: LogoutRequest = {}): Promise<LogoutResponse> {
    return this.request<LogoutRequest, LogoutResponse>('logout', params);
  }

  // 4. session/new
  public async newSession(params: Partial<NewSessionRequest & SessionNewParams> = {}): Promise<NewSessionResponse & SessionNewResult> {
    return this.request<any, NewSessionResponse & SessionNewResult>('session/new', params);
  }

  // 5. session/load
  public async loadSession(
    sessionId: string,
    params: Partial<LoadSessionRequest & SessionLoadParams> = {}
  ): Promise<LoadSessionResponse & SessionLoadResult> {
    return this.request<any, LoadSessionResponse & SessionLoadResult>('session/load', {
      sessionId,
      ...params,
    });
  }

  // 6. session/resume
  public async resumeSession(
    sessionId: string,
    params: Partial<ResumeSessionRequest> = {}
  ): Promise<ResumeSessionResponse> {
    return this.request<ResumeSessionRequest, ResumeSessionResponse>('session/resume', {
      sessionId,
      ...params,
    });
  }

  // 7. session/list
  public async listSessions(params: ListSessionsRequest = {}): Promise<ListSessionsResponse> {
    return this.request<ListSessionsRequest, ListSessionsResponse>('session/list', params);
  }

  // 8. session/close
  public async closeSession(sessionId: string): Promise<CloseSessionResponse> {
    return this.request<CloseSessionRequest, CloseSessionResponse>('session/close', { sessionId });
  }

  // 9. session/delete
  public async deleteSession(sessionId: string): Promise<DeleteSessionResponse> {
    return this.request<DeleteSessionRequest, DeleteSessionResponse>('session/delete', { sessionId });
  }

  // 10. session/prompt
  public async promptSession(
    sessionId: string,
    prompt: string | ContentBlock[],
    options?: { userHint?: string; maxTokens?: number }
  ): Promise<PromptResponse & SessionPromptResult> {
    return this.request<any, PromptResponse & SessionPromptResult>('session/prompt', {
      sessionId,
      prompt,
      userHint: options?.userHint,
      maxTokens: options?.maxTokens,
    });
  }

  // 11. session/set_mode
  public async setSessionMode(sessionId: string, modeId: string): Promise<SetSessionModeResponse> {
    return this.request<SetSessionModeRequest, SetSessionModeResponse>('session/set_mode', {
      sessionId,
      modeId,
    });
  }

  // 12. session/set_config_option
  public async setSessionConfigOption(
    sessionId: string,
    configOptionId: string,
    value: any
  ): Promise<SetSessionConfigOptionResponse> {
    return this.request<SetSessionConfigOptionRequest, SetSessionConfigOptionResponse>('session/set_config_option', {
      sessionId,
      configOptionId,
      value,
    });
  }

  // Notifications
  public async cancelSession(sessionId: string, reason?: string): Promise<SessionCancelResult> {
    this.notify('session/cancel', { sessionId, reason });
    try {
      return await this.request<SessionCancelParams, SessionCancelResult>(
        'session/cancel',
        { sessionId, reason },
        3000
      );
    } catch {
      return { sessionId, cancelled: true };
    }
  }

  public cancelRequest(requestId: JsonRpcId): void {
    this.notify('$/cancel_request', { id: requestId });
  }

  // Subscriptions
  public onSessionUpdate(listener: SessionUpdateListener): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  public onRequestPermission(listener: PermissionRequestListener): () => void {
    this.permissionListeners.add(listener);
    return () => this.permissionListeners.delete(listener);
  }

  public onUserMessageChunk(listener: (content: ContentBlock, sessionId: string) => void): () => void {
    this.userMessageListeners.add(listener);
    return () => this.userMessageListeners.delete(listener);
  }

  public onAgentMessageChunk(listener: (content: ContentBlock, sessionId: string) => void): () => void {
    this.agentMessageListeners.add(listener);
    return () => this.agentMessageListeners.delete(listener);
  }

  public onAgentThoughtChunk(listener: (content: ContentBlock, sessionId: string) => void): () => void {
    this.agentThoughtListeners.add(listener);
    return () => this.agentThoughtListeners.delete(listener);
  }

  public onToolCall(listener: (toolCall: any, sessionId: string) => void): () => void {
    this.toolCallListeners.add(listener);
    return () => this.toolCallListeners.delete(listener);
  }

  public onToolCallUpdate(listener: (update: any, sessionId: string) => void): () => void {
    this.toolCallUpdateListeners.add(listener);
    return () => this.toolCallUpdateListeners.delete(listener);
  }

  public onPlan(listener: (entries: PlanEntry[], sessionId: string) => void): () => void {
    this.planListeners.add(listener);
    return () => this.planListeners.delete(listener);
  }

  public onAvailableCommands(listener: (commands: AvailableCommand[], sessionId: string) => void): () => void {
    this.availableCommandsListeners.add(listener);
    return () => this.availableCommandsListeners.delete(listener);
  }

  public onModeUpdate(listener: (modeId: string, sessionId: string) => void): () => void {
    this.modeUpdateListeners.add(listener);
    return () => this.modeUpdateListeners.delete(listener);
  }

  public onConfigOptionUpdate(listener: (optionId: string, value: any, sessionId: string) => void): () => void {
    this.configOptionUpdateListeners.add(listener);
    return () => this.configOptionUpdateListeners.delete(listener);
  }

  public onUsageUpdate(listener: (usage: UsageUpdate, sessionId: string) => void): () => void {
    this.usageUpdateListeners.add(listener);
    return () => this.usageUpdateListeners.delete(listener);
  }

  public onElicitationComplete(listener: (notif: CompleteElicitationNotification) => void): () => void {
    this.elicitationCompleteListeners.add(listener);
    return () => this.elicitationCompleteListeners.delete(listener);
  }

  public async close(): Promise<void> {
    for (const [, pending] of this.pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error('ACP client closed'));
    }
    this.pendingRequests.clear();
    this.updateListeners.clear();
    this.permissionListeners.clear();
    this.elicitationCompleteListeners.clear();
    this.userMessageListeners.clear();
    this.agentMessageListeners.clear();
    this.agentThoughtListeners.clear();
    this.toolCallListeners.clear();
    this.toolCallUpdateListeners.clear();
    this.planListeners.clear();
    this.availableCommandsListeners.clear();
    this.modeUpdateListeners.clear();
    this.configOptionUpdateListeners.clear();
    this.usageUpdateListeners.clear();
    if (this.transport.close) {
      await this.transport.close();
    }
  }

  private async handleMessage(message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): Promise<void> {
    // 1. Response to our request
    if ('id' in message && ('result' in message || 'error' in message) && !('method' in message)) {
      const resp = message as JsonRpcResponse;
      const pending = this.pendingRequests.get(resp.id);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingRequests.delete(resp.id);
        if (resp.error) {
          const err: any = new Error(resp.error.message || `RPC Error code ${resp.error.code}`);
          err.code = resp.error.code;
          err.data = resp.error.data;
          pending.reject(err);
        } else {
          pending.resolve(resp.result);
        }
      }
      return;
    }

    // 2. Incoming request from Agent (session/request_permission, fs/*, terminal/*, elicitation/*)
    if ('method' in message && 'id' in message) {
      const req = message as JsonRpcRequest;

      if (req.method === 'session/request_permission') {
        let responded = false;
        const respond = (decision: PermissionDecision | string, reason?: string) => {
          if (responded) return;
          responded = true;
          const isAccept =
            decision === 'approved' ||
            decision === 'approved_once' ||
            decision === 'approved_always' ||
            decision === 'accept' ||
            decision === 'accepted';

          const outcome: RequestPermissionOutcome = isAccept
            ? {
                outcome: 'accepted',
                optionId: decision === 'approved_always' ? 'allow_always' : 'allow_once',
              }
            : { outcome: 'cancelled' };

          const responsePayload: SessionRequestPermissionResult & RequestPermissionResponse = {
            outcome,
            decision: decision as PermissionDecision,
            reason,
          };
          this.transport.send({
            jsonrpc: '2.0',
            id: req.id,
            result: responsePayload,
          });
        };

        if (this.permissionListeners.size === 0) {
          respond('rejected', 'No approval handler registered');
        } else {
          // First listener wins; extra listeners observe but must not double-respond.
          const [first] = Array.from(this.permissionListeners);
          try {
            (first as any)(req.params as any, respond);
          } catch (err: any) {
            respond('rejected', err?.message || 'Permission handler error');
          }
        }
        return;
      }

      // fs/* have no safe default: without a host handler, fail closed
      // (never let the agent drive the client to read/write arbitrary paths).
      if (req.method === 'fs/read_text_file') {
        try {
          if (!this.handlers.onReadTextFile) {
            throw new Error('Client does not support fs/read_text_file');
          }
          const res = await this.handlers.onReadTextFile(req.params as ReadTextFileRequest);
          this.transport.send({ jsonrpc: '2.0', id: req.id, result: res });
        } catch (err: any) {
          this.transport.send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: err.message } });
        }
        return;
      }

      if (req.method === 'fs/write_text_file') {
        try {
          if (!this.handlers.onWriteTextFile) {
            throw new Error('Client does not support fs/write_text_file');
          }
          const res = await this.handlers.onWriteTextFile(req.params as WriteTextFileRequest);
          this.transport.send({ jsonrpc: '2.0', id: req.id, result: res });
        } catch (err: any) {
          this.transport.send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: err.message } });
        }
        return;
      }

      // terminal/* have no safe default: fake success would make the agent
      // believe commands ran. Fail closed instead.
      if (req.method === 'terminal/create') {
        try {
          if (!this.handlers.onCreateTerminal) {
            throw new Error('Client does not support terminal/create');
          }
          const res = await this.handlers.onCreateTerminal(req.params as CreateTerminalRequest);
          this.transport.send({ jsonrpc: '2.0', id: req.id, result: res });
        } catch (err: any) {
          this.transport.send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: err.message } });
        }
        return;
      }

      if (req.method === 'terminal/output') {
        try {
          if (!this.handlers.onTerminalOutput) {
            throw new Error('Client does not support terminal/output');
          }
          const res = await this.handlers.onTerminalOutput(req.params as TerminalOutputRequest);
          this.transport.send({ jsonrpc: '2.0', id: req.id, result: res });
        } catch (err: any) {
          this.transport.send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: err.message } });
        }
        return;
      }

      if (req.method === 'terminal/wait_for_exit') {
        try {
          if (!this.handlers.onWaitForTerminalExit) {
            throw new Error('Client does not support terminal/wait_for_exit');
          }
          const res = await this.handlers.onWaitForTerminalExit(req.params as WaitForTerminalExitRequest);
          this.transport.send({ jsonrpc: '2.0', id: req.id, result: res });
        } catch (err: any) {
          this.transport.send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: err.message } });
        }
        return;
      }

      if (req.method === 'terminal/kill') {
        try {
          if (!this.handlers.onKillTerminal) {
            throw new Error('Client does not support terminal/kill');
          }
          const res = await this.handlers.onKillTerminal(req.params as KillTerminalRequest);
          this.transport.send({ jsonrpc: '2.0', id: req.id, result: res });
        } catch (err: any) {
          this.transport.send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: err.message } });
        }
        return;
      }

      if (req.method === 'terminal/release') {
        try {
          if (!this.handlers.onReleaseTerminal) {
            throw new Error('Client does not support terminal/release');
          }
          const res = await this.handlers.onReleaseTerminal(req.params as ReleaseTerminalRequest);
          this.transport.send({ jsonrpc: '2.0', id: req.id, result: res });
        } catch (err: any) {
          this.transport.send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: err.message } });
        }
        return;
      }

      if (req.method === 'elicitation/create') {
        try {
          if (!this.handlers.onCreateElicitation) {
            throw new Error('Client does not support elicitation/create');
          }
          const res = await this.handlers.onCreateElicitation(req.params as CreateElicitationRequest);
          this.transport.send({ jsonrpc: '2.0', id: req.id, result: res });
        } catch (err: any) {
          this.transport.send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: err.message } });
        }
        return;
      }

      // Unknown client method
      this.transport.send({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32601, message: `Client does not support method '${req.method}'` },
      });
      return;
    }

    // 3. Incoming Notification from Agent (session/update, elicitation/complete, task/event)
    if ('method' in message && !('id' in message)) {
      const notif = message as JsonRpcNotification;

      if (notif.method === 'session/update') {
        const payload = notif.params as any;
        for (const listener of this.updateListeners) {
          try {
            listener(payload);
          } catch (err) {
            console.error('[AcpClient] Error in updateListener:', err);
          }
        }

        const update = payload?.update || payload;
        const updateKind = update?.sessionUpdate || update?.updateType;
        const sessionId = payload?.sessionId || '';

        if (updateKind === 'user_message_chunk' && update?.content) {
          for (const listener of this.userMessageListeners) listener(update.content, sessionId);
        } else if (updateKind === 'agent_message_chunk' && update?.content) {
          for (const listener of this.agentMessageListeners) listener(update.content, sessionId);
        } else if (updateKind === 'agent_thought_chunk' && update?.content) {
          for (const listener of this.agentThoughtListeners) listener(update.content, sessionId);
        } else if (updateKind === 'tool_call') {
          for (const listener of this.toolCallListeners) listener(update, sessionId);
        } else if (updateKind === 'tool_call_update') {
          for (const listener of this.toolCallUpdateListeners) listener(update, sessionId);
        } else if (updateKind === 'plan' && update?.entries) {
          for (const listener of this.planListeners) listener(update.entries, sessionId);
        } else if (updateKind === 'available_commands_update' && update?.availableCommands) {
          for (const listener of this.availableCommandsListeners) listener(update.availableCommands, sessionId);
        } else if (updateKind === 'current_mode_update' && update?.modeId) {
          for (const listener of this.modeUpdateListeners) listener(update.modeId, sessionId);
        } else if (updateKind === 'config_option_update') {
          for (const listener of this.configOptionUpdateListeners) listener(update.configOptionId, update.value, sessionId);
        } else if (updateKind === 'usage_update' && update?.usage) {
          for (const listener of this.usageUpdateListeners) listener(update.usage, sessionId);
        }
        return;
      }

      if (notif.method === 'elicitation/complete') {
        const payload = notif.params as CompleteElicitationNotification;
        for (const listener of this.elicitationCompleteListeners) {
          try {
            listener(payload);
          } catch (err) {
            console.error('[AcpClient] Error in elicitationCompleteListener:', err);
          }
        }
        return;
      }
    }
  }
}
