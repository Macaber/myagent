/**
 * Agent Client Protocol (ACP) v1 - Canonical Specification Types
 * Reference: https://agentclientprotocol.com/protocol/v1/overview
 * Official Schema: https://agentclientprotocol.com/protocol/v1/schema
 */

// =========================================================================
// 1. JSON-RPC 2.0 Base Protocol & Error Codes
// =========================================================================

export type JsonRpcId = string | number;

export interface JsonRpcRequest<T = any> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params: T;
}

export interface JsonRpcNotification<T = any> {
  jsonrpc: '2.0';
  method: string;
  params: T;
}

export interface JsonRpcResponse<T = any> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: T;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: any;
}

export const ACP_ERROR_CODES = {
  // Standard JSON-RPC 2.0
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // ACP Protocol-level cancellation
  REQUEST_CANCELLED: -32800,

  // ACP Application-level Error Codes
  AUTH_REQUIRED: -32000,
  RESOURCE_NOT_FOUND: -32002,

  // Legacy / internal convenience aliases
  SESSION_NOT_FOUND: -32001,
  PERMISSION_DENIED: -32002,
  SESSION_BLOCKED: -32003,
} as const;

export type ProtocolVersion = number;

// =========================================================================
// 2. Common Data Structures & Extensibility
// =========================================================================

export interface MetaObject {
  _meta?: Record<string, any> | null;
}

export interface Implementation extends MetaObject {
  name: string;
  title?: string | null;
  version: string;
}

export interface EnvVariable extends MetaObject {
  name: string;
  value: string;
}

export interface HttpHeader extends MetaObject {
  name: string;
  value: string;
}

export interface Cost extends MetaObject {
  amount: number;
  currency: string;
}

export interface Annotations {
  audience?: ('user' | 'assistant')[];
  priority?: number;
  [key: string]: any;
}

// =========================================================================
// 3. Content Blocks & Payloads
// =========================================================================

export interface TextContent extends MetaObject {
  type: 'text';
  text: string;
  annotations?: Annotations | null;
}

export interface ImageContent extends MetaObject {
  type: 'image';
  data: string; // Base64
  mimeType: string;
  uri?: string | null;
  annotations?: Annotations | null;
}

export interface AudioContent extends MetaObject {
  type: 'audio';
  data: string; // Base64
  mimeType: string;
  annotations?: Annotations | null;
}

export interface TextResourceContents extends MetaObject {
  uri: string;
  text: string;
  mimeType?: string;
}

export interface BlobResourceContents extends MetaObject {
  uri: string;
  blob: string; // Base64
  mimeType?: string;
}

export type EmbeddedResourceResource = TextResourceContents | BlobResourceContents;

export interface EmbeddedResource extends MetaObject {
  type: 'resource';
  resource: EmbeddedResourceResource;
  annotations?: Annotations | null;
}

export interface ResourceLink extends MetaObject {
  type: 'resource_link';
  uri: string;
  name: string;
  title?: string | null;
  description?: string | null;
  mimeType?: string | null;
  size?: number | null;
  annotations?: Annotations | null;
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | EmbeddedResource
  | ResourceLink;

export type ContentChunk = ContentBlock;

// =========================================================================
// 4. MCP Servers Configuration
// =========================================================================

export interface McpServerStdio extends MetaObject {
  type?: 'stdio';
  name: string;
  command: string;
  args: string[];
  env: EnvVariable[];
}

export interface McpServerHttp extends MetaObject {
  type: 'http';
  name: string;
  url: string;
  headers: HttpHeader[];
}

export interface McpServerSse extends MetaObject {
  type: 'sse';
  name: string;
  url: string;
  headers: HttpHeader[];
}

export type McpServer = McpServerStdio | McpServerHttp | McpServerSse;

// =========================================================================
// 5. Capabilities & Initialization
// =========================================================================

export type AuthMethodId = string;

export interface AuthMethodAgent extends MetaObject {
  type?: 'agent';
  id: AuthMethodId;
  name: string;
  description?: string | null;
}

export interface AuthMethodTerminal extends MetaObject {
  type: 'terminal';
  id: AuthMethodId;
  name: string;
  description?: string | null;
  args?: string[];
  env?: Record<string, string>;
}

export type AuthMethod = AuthMethodAgent | AuthMethodTerminal;

export interface LogoutCapabilities extends MetaObject {}

export interface AgentAuthCapabilities extends MetaObject {
  logout?: LogoutCapabilities | null;
}

export interface PromptCapabilities extends MetaObject {
  audio?: boolean;
  embeddedContext?: boolean;
  image?: boolean;
}

export interface McpCapabilities extends MetaObject {
  http?: boolean;
  sse?: boolean;
}

export interface SessionListCapabilities extends MetaObject {}
export interface SessionDeleteCapabilities extends MetaObject {}
export interface SessionResumeCapabilities extends MetaObject {}
export interface SessionCloseCapabilities extends MetaObject {}
export interface SessionAdditionalDirectoriesCapabilities extends MetaObject {}

export interface SessionCapabilities extends MetaObject {
  list?: SessionListCapabilities | null;
  delete?: SessionDeleteCapabilities | null;
  resume?: SessionResumeCapabilities | null;
  close?: SessionCloseCapabilities | null;
  additionalDirectories?: SessionAdditionalDirectoriesCapabilities | null;
}

export interface AgentCapabilities extends MetaObject {
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities | null;
  mcpCapabilities?: McpCapabilities | null;
  sessionCapabilities?: SessionCapabilities | null;
  auth?: AgentAuthCapabilities | null;
  // Compatibility / legacy properties
  prompt?: boolean;
  streaming?: boolean;
  tools?: string[];
  skills?: string[];
}

export interface AuthCapabilities extends MetaObject {
  terminal?: boolean;
}

export interface FileSystemCapabilities extends MetaObject {
  readTextFile?: boolean;
  writeTextFile?: boolean;
}

export interface ElicitationFormCapabilities extends MetaObject {}
export interface ElicitationUrlCapabilities extends MetaObject {}

export interface ElicitationCapabilities extends MetaObject {
  form?: ElicitationFormCapabilities | null;
  url?: ElicitationUrlCapabilities | null;
}

export interface BooleanConfigOptionCapabilities extends MetaObject {}

export interface SessionConfigOptionsCapabilities extends MetaObject {
  boolean?: BooleanConfigOptionCapabilities | null;
}

export interface ClientSessionCapabilities extends MetaObject {
  configOptions?: SessionConfigOptionsCapabilities | null;
}

export interface ClientCapabilities extends MetaObject {
  auth?: AuthCapabilities | null;
  fs?: FileSystemCapabilities | null;
  terminal?: boolean;
  elicitation?: ElicitationCapabilities | null;
  session?: ClientSessionCapabilities | null;
  // Compatibility properties
  permissions?: boolean;
  streaming?: boolean;
  modelSelector?: boolean;
  configOptions?: SessionConfigOptionsCapabilities | null;
}

export interface InitializeRequest extends MetaObject {
  protocolVersion: ProtocolVersion;
  clientCapabilities?: ClientCapabilities;
  clientInfo?: Implementation | null;
  // Compatibility properties
  roots?: string[];
  workspacePath?: string;
}

export interface InitializeResponse extends MetaObject {
  protocolVersion: ProtocolVersion;
  agentCapabilities: AgentCapabilities;
  agentInfo?: Implementation | null;
  authMethods: AuthMethod[];
  // Compatibility property
  capabilities?: any;
}

export type InitializeParams = InitializeRequest;
export type InitializeResult = InitializeResponse;
export type ClientInfo = Implementation;
export type AgentInfo = Implementation;

// =========================================================================
// 6. Authentication & Logout
// =========================================================================

export interface AuthenticateRequest extends MetaObject {
  methodId: AuthMethodId;
  data?: Record<string, any>;
}

export interface AuthenticateResponse extends MetaObject {
  success?: boolean;
}

export interface LogoutRequest extends MetaObject {}
export interface LogoutResponse extends MetaObject {
  success?: boolean;
}

// =========================================================================
// 7. Session Configuration Options & Modes
// =========================================================================

export type SessionId = string;
export type SessionModeId = string;

export interface SessionMode extends MetaObject {
  id: SessionModeId;
  name: string;
  description?: string | null;
}

export interface SessionModeState extends MetaObject {
  currentModeId: SessionModeId;
  availableModes: SessionMode[];
}

export type SessionConfigId = string;
export type SessionConfigValueId = string;
export type SessionConfigGroupId = string;
export type SessionConfigOptionCategory =
  | 'mode'
  | 'model'
  | 'model_config'
  | 'thought_level'
  | string;

export interface SessionConfigSelectOption extends MetaObject {
  value: SessionConfigValueId;
  name: string;
  description?: string | null;
}

export interface SessionConfigSelectGroup extends MetaObject {
  group: SessionConfigGroupId;
  name: string;
  options: SessionConfigSelectOption[];
}

export interface SessionConfigSelect extends MetaObject {
  type: 'select';
  id: SessionConfigId;
  name: string;
  description?: string | null;
  category?: SessionConfigOptionCategory | null;
  currentValue: SessionConfigValueId;
  options: (SessionConfigSelectOption | SessionConfigSelectGroup)[];
}

export interface SessionConfigBoolean extends MetaObject {
  type: 'boolean';
  id: SessionConfigId;
  name: string;
  description?: string | null;
  category?: SessionConfigOptionCategory | null;
  currentValue: boolean;
}

export type SessionConfigOption = SessionConfigSelect | SessionConfigBoolean;

// =========================================================================
// 8. Session Setup, Listing, Resuming & Deletion
// =========================================================================

export interface NewSessionRequest extends MetaObject {
  cwd: string;
  mcpServers: McpServer[];
  additionalDirectories?: string[];
  // Compatibility properties
  sessionId?: string;
  roots?: string[];
  systemPrompt?: string;
  workspacePath?: string;
}

export interface NewSessionResponse extends MetaObject {
  sessionId: SessionId;
  configOptions?: SessionConfigOption[] | null;
  modes?: SessionModeState | null;
}

export type SessionNewParams = NewSessionRequest;
export type SessionNewResult = NewSessionResponse;

export interface LoadSessionRequest extends MetaObject {
  sessionId: SessionId;
  cwd: string;
  mcpServers: McpServer[];
  additionalDirectories?: string[];
  // Compatibility properties
  userHint?: string;
  targetMilestoneId?: string;
}

export interface LoadSessionResponse extends MetaObject {
  configOptions?: SessionConfigOption[] | null;
  modes?: SessionModeState | null;
  // Compatibility properties
  sessionId?: string;
  status?: string;
  resumedFromMilestoneId?: string;
  metrics?: any;
}

export type SessionLoadParams = LoadSessionRequest;
export type SessionLoadResult = LoadSessionResponse;

export interface ResumeSessionRequest extends MetaObject {
  sessionId: SessionId;
  cwd?: string;
  mcpServers?: McpServer[];
  additionalDirectories?: string[];
}

export interface ResumeSessionResponse extends MetaObject {
  configOptions?: SessionConfigOption[] | null;
  modes?: SessionModeState | null;
  sessionId?: string;
  status?: string;
}

export interface SessionInfo extends MetaObject {
  sessionId: SessionId;
  cwd: string;
  additionalDirectories?: string[];
  title?: string | null;
  updatedAt?: string | null;
}

export interface ListSessionsRequest extends MetaObject {
  cursor?: string | null;
  cwd?: string | null;
}

export interface ListSessionsResponse extends MetaObject {
  sessions: SessionInfo[];
  nextCursor?: string | null;
}

export interface CloseSessionRequest extends MetaObject {
  sessionId: SessionId;
}

export interface CloseSessionResponse extends MetaObject {
  sessionId?: string;
  closed?: boolean;
}

export interface DeleteSessionRequest extends MetaObject {
  sessionId: SessionId;
}

export interface DeleteSessionResponse extends MetaObject {
  sessionId?: string;
  deleted?: boolean;
}

export interface SetSessionModeRequest extends MetaObject {
  sessionId: SessionId;
  modeId: SessionModeId;
}

export interface SetSessionModeResponse extends MetaObject {
  modes?: SessionModeState;
}

export interface SetSessionConfigOptionRequest extends MetaObject {
  sessionId: SessionId;
  configId?: SessionConfigId;
  configOptionId?: SessionConfigId;
  value: SessionConfigValueId | boolean | any;
  type?: 'boolean' | 'value_id';
}

export interface SetSessionConfigOptionResponse extends MetaObject {
  configOptions: SessionConfigOption[];
}

// =========================================================================
// 9. Prompt Turn & Cancellation
// =========================================================================

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | 'requires_action'
  | 'error'
  | (string & {});

export interface PromptRequest extends MetaObject {
  sessionId: SessionId;
  prompt: ContentBlock[];
  // Compatibility properties
  content?: any;
  userHint?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface PromptResponse extends MetaObject {
  stopReason: StopReason;
  // Compatibility properties
  sessionId?: string;
  status?: 'completed' | 'interrupted' | 'error' | 'blocked';
  summary?: string;
  content?: Array<{ type: string; text: string; [key: string]: any }>;
  metrics?: any;
}

export type SessionPromptParams = PromptRequest;
export type SessionPromptResult = PromptResponse;

export interface CancelNotification extends MetaObject {
  sessionId: SessionId;
  // Compatibility property
  reason?: string;
}

export type SessionCancelParams = CancelNotification;
export interface SessionCancelResult {
  sessionId: string;
  cancelled: boolean;
}

export interface CancelRequestNotification extends MetaObject {
  id: JsonRpcId;
}
export type CancelRequestParams = CancelRequestNotification;

// =========================================================================
// 10. Tools, Plans, and Session Updates (session/update)
// =========================================================================

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ToolCallLocation extends MetaObject {
  path: string;
  line?: number | null;
}

export interface ToolCallDiff extends MetaObject {
  type: 'diff';
  path: string;
  newText: string;
  oldText?: string | null;
}

export interface ToolCallTerminal extends MetaObject {
  type: 'terminal';
  terminalId: string;
}

export interface ToolCallBlockContent extends MetaObject {
  type: 'content';
  content: ContentBlock;
}

export type ToolCallContent = ToolCallBlockContent | ToolCallDiff | ToolCallTerminal;

export type ToolCallId = string;

export interface ToolCallUpdate extends MetaObject {
  toolCallId: ToolCallId;
  title?: string | null;
  name?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: any;
  rawOutput?: any;
  content?: ToolCallContent[] | null;
  arguments?: Record<string, any>;
}

export type PlanEntryPriority = 'high' | 'medium' | 'low';
export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanEntry extends MetaObject {
  content: string;
  priority: PlanEntryPriority;
  status: PlanEntryStatus;
}

export interface Plan extends MetaObject {
  entries: PlanEntry[];
}

export interface AvailableCommandInput extends MetaObject {
  hint: string;
}

export interface AvailableCommand extends MetaObject {
  name: string;
  description: string;
  input?: AvailableCommandInput | null;
}

// Discriminator Union for SessionUpdate
export interface UserMessageChunkUpdate extends MetaObject {
  sessionUpdate: 'user_message_chunk';
  content: ContentBlock;
  messageId?: string | null;
}

export interface AgentMessageChunkUpdate extends MetaObject {
  sessionUpdate: 'agent_message_chunk';
  content: ContentBlock;
  messageId?: string | null;
}

export interface AgentThoughtChunkUpdate extends MetaObject {
  sessionUpdate: 'agent_thought_chunk';
  content: ContentBlock;
}

export interface ToolCallUpdateNotification extends MetaObject {
  sessionUpdate: 'tool_call';
  toolCallId: ToolCallId;
  title: string;
  name?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: any;
  rawOutput?: any;
  content?: ToolCallContent[] | null;
}

export interface ToolCallPatchNotification extends MetaObject {
  sessionUpdate: 'tool_call_update';
  toolCallId: ToolCallId;
  title?: string | null;
  name?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: any;
  rawOutput?: any;
  content?: ToolCallContent[] | null;
}

export interface PlanNotificationUpdate extends MetaObject {
  sessionUpdate: 'plan';
  entries: PlanEntry[];
}

export interface AvailableCommandsNotificationUpdate extends MetaObject {
  sessionUpdate: 'available_commands_update';
  availableCommands: AvailableCommand[];
}

export interface CurrentModeNotificationUpdate extends MetaObject {
  sessionUpdate: 'current_mode_update';
  currentModeId?: SessionModeId;
  modeId?: SessionModeId;
}

export interface ConfigOptionNotificationUpdate extends MetaObject {
  sessionUpdate: 'config_option_update';
  configOptions?: SessionConfigOption[];
  configOptionId?: string;
  value?: any;
}

export interface SessionInfoNotificationUpdate extends MetaObject {
  sessionUpdate: 'session_info_update';
  title?: string | null;
  updatedAt?: string | null;
}

export interface UsageUpdate {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  used?: number;
  size?: number;
  cost?: Cost | null;
}

export interface UsageNotificationUpdate extends MetaObject {
  sessionUpdate: 'usage_update';
  used?: number;
  size?: number;
  cost?: Cost | null;
  usage?: UsageUpdate;
}

export type SessionUpdate =
  | UserMessageChunkUpdate
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | ToolCallUpdateNotification
  | ToolCallPatchNotification
  | PlanNotificationUpdate
  | AvailableCommandsNotificationUpdate
  | CurrentModeNotificationUpdate
  | ConfigOptionNotificationUpdate
  | SessionInfoNotificationUpdate
  | UsageNotificationUpdate;

export interface SessionNotification extends MetaObject {
  sessionId: SessionId;
  update: SessionUpdate;
  updateType?: SessionUpdateType | string;
  sessionUpdate?: string;
  timestamp?: number;
  data?: any;
  content?: any;
}

// Backward-compatible alias for existing callers
export type SessionUpdateType =
  | 'state_changed'
  | 'plan_generated'
  | 'turn_started'
  | 'turn_finished'
  | 'step_started'
  | 'step_delta'
  | 'step_finished'
  | 'milestone_updated'
  | 'blocked_need_user'
  | 'agent_message_chunk'
  | 'AgentMessageChunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | string;

export interface SessionUpdateNotification extends MetaObject {
  sessionId: string;
  updateType?: SessionUpdateType | string;
  sessionUpdate?: string;
  timestamp?: number;
  data?: any;
  content?: any;
  update?: SessionUpdate | any;
}

// =========================================================================
// 11. Client Methods: Permissions, FileSystem, Terminals, Elicitation
// =========================================================================

export type PermissionOptionId = string;
export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption extends MetaObject {
  optionId: PermissionOptionId;
  name: string;
  kind: PermissionOptionKind;
}

export interface RequestPermissionRequest extends MetaObject {
  sessionId: SessionId;
  toolCall: ToolCallUpdate | any;
  options?: PermissionOption[];
  toolCallId?: string;
  requestId?: string;
  turnId?: string;
  stepId?: string;
  riskLevel?: any;
  description?: string;
}

export type RequestPermissionOutcome =
  | { outcome: 'cancelled'; _meta?: Record<string, any> | null }
  | { outcome: 'selected'; optionId: PermissionOptionId; _meta?: Record<string, any> | null }
  | { outcome: 'accepted'; optionId?: PermissionOptionId; _meta?: Record<string, any> | null };

export interface RequestPermissionResponse extends MetaObject {
  outcome: RequestPermissionOutcome;
  // Backward-compatible aliases
  decision?: PermissionDecision;
  reason?: string;
}

export type SessionRequestPermissionParams = RequestPermissionRequest & {
  toolCallId?: string;
  requestId?: string;
  turnId?: string;
  stepId?: string;
  riskLevel?: any;
  description?: string;
};
export type SessionRequestPermissionResult = RequestPermissionResponse;
export type PermissionDecision =
  | 'approved'
  | 'rejected'
  | 'approved_always'
  | 'APPROVED'
  | 'REJECTED'
  | 'APPROVED_ALWAYS';

// Client Method: fs/read_text_file
export interface ReadTextFileRequest extends MetaObject {
  sessionId: SessionId;
  path: string;
  line?: number | null;
  limit?: number | null;
}

export interface ReadTextFileResponse extends MetaObject {
  content: string;
}

// Client Method: fs/write_text_file
export interface WriteTextFileRequest extends MetaObject {
  sessionId: SessionId;
  path: string;
  content: string;
}

export interface WriteTextFileResponse extends MetaObject {}

// Client Methods: terminal/*
export type TerminalId = string;

export interface CreateTerminalRequest extends MetaObject {
  sessionId: SessionId;
  command: string;
  args?: string[];
  env?: EnvVariable[];
  cwd?: string | null;
  outputByteLimit?: number | null;
}

export interface CreateTerminalResponse extends MetaObject {
  terminalId: TerminalId;
}

export interface TerminalOutputRequest extends MetaObject {
  sessionId: SessionId;
  terminalId: TerminalId;
}

export interface TerminalExitStatus extends MetaObject {
  exitCode?: number | null;
  signal?: string | null;
}

export interface TerminalOutputResponse extends MetaObject {
  output: string;
  truncated: boolean;
  exitStatus?: TerminalExitStatus | null;
}

export interface WaitForTerminalExitRequest extends MetaObject {
  sessionId: SessionId;
  terminalId: TerminalId;
}

export interface WaitForTerminalExitResponse extends MetaObject {
  exitCode?: number | null;
  signal?: string | null;
}

export interface KillTerminalRequest extends MetaObject {
  sessionId: SessionId;
  terminalId: TerminalId;
}

export interface KillTerminalResponse extends MetaObject {}

export interface ReleaseTerminalRequest extends MetaObject {
  sessionId: SessionId;
  terminalId: TerminalId;
}

export interface ReleaseTerminalResponse extends MetaObject {}

// Client Method: elicitation/create & Notification: elicitation/complete
export type ElicitationId = string;

export interface ElicitationSchema extends MetaObject {
  type: 'object';
  properties?: Record<string, any>;
  required?: string[];
}

export interface CreateElicitationFormRequest extends MetaObject {
  mode: 'form';
  message: string;
  requestedSchema: ElicitationSchema;
  sessionId?: SessionId;
  toolCallId?: ToolCallId;
  requestId?: JsonRpcId;
}

export interface CreateElicitationUrlRequest extends MetaObject {
  mode: 'url';
  message: string;
  elicitationId: ElicitationId;
  url: string;
  sessionId?: SessionId;
  toolCallId?: ToolCallId;
  requestId?: JsonRpcId;
}

export type CreateElicitationRequest = CreateElicitationFormRequest | CreateElicitationUrlRequest;

export interface CreateElicitationResponse extends MetaObject {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, any> | null;
}

export interface CompleteElicitationNotification extends MetaObject {
  elicitationId: ElicitationId;
}

// =========================================================================
// 12. Legacy Task-Centric / Event Aliases
// =========================================================================

export type PermissionRiskLevel =
  | 'read_only'
  | 'workspace_write'
  | 'high_risk_exec'
  | 'network'
  | 'READ_ONLY'
  | 'WORKSPACE_WRITE'
  | 'HIGH_RISK_EXEC'
  | 'NETWORK';

export interface TaskStartParams {
  taskId?: string;
  prompt: string;
  workspacePath?: string;
  userHints?: string;
}

export interface TaskStartResult {
  threadId: string;
  status: string;
}

export interface TaskResumeParams {
  threadId: string;
  userHint?: string;
  targetMilestoneId?: string;
}

export interface TaskResumeResult {
  threadId: string;
  status: string;
  resumedFromMilestoneId?: string;
}

export interface AcpEventPayload {
  threadId: string;
  turnId?: string;
  stepId?: string;
  type: string;
  timestamp: number;
  data: any;
}

