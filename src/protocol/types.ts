/**
 * Agent Client Protocol (ACP) - Canonical Specification Types
 * Fully aligned with official ACP standard (Zed / agentclientprotocol.com)
 */

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
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  REQUEST_CANCELLED: -32800,
  SESSION_NOT_FOUND: -32001,
  PERMISSION_DENIED: -32002,
  SESSION_BLOCKED: -32003,
} as const;

// =================== 1. Lifecycle: initialize ===================

export interface ClientInfo {
  name: string;
  version: string;
}

export interface AgentInfo {
  name: string;
  version: string;
}

export interface ClientCapabilities {
  terminal?: boolean;
  fs?: boolean;
  permissions?: boolean;
  streaming?: boolean;
  modelSelector?: boolean;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  prompt?: boolean;
  streaming?: boolean;
  tools?: string[];
  skills?: string[];
}

export interface InitializeParams {
  protocolVersion: string;
  clientInfo?: ClientInfo;
  clientCapabilities?: ClientCapabilities;
  roots?: string[]; // Workspace root directories
  workspacePath?: string; // Legacy/convenience alias
  _meta?: Record<string, any>;
}

export interface InitializeResult {
  protocolVersion: string;
  agentInfo: AgentInfo;
  agentCapabilities: AgentCapabilities;
  capabilities?: any; // Compatibility alias
  _meta?: Record<string, any>;
}

// =================== 2. Session Lifecycle: session/new ===================

export interface SessionNewParams {
  sessionId?: string;
  roots?: string[];
  systemPrompt?: string;
  workspacePath?: string; // Compatibility alias
  _meta?: Record<string, any>;
}

export interface SessionNewResult {
  sessionId: string;
  _meta?: Record<string, any>;
}

// =================== 3. Session Interaction: session/prompt ===================

export interface SessionPromptParams {
  sessionId: string;
  prompt?: string | any[];
  content?: string | any[];
  userHint?: string;
  maxTokens?: number;
  timeoutMs?: number;
  _meta?: Record<string, any>;
}

export interface SessionPromptResult {
  sessionId: string;
  stopReason?: 'end_turn' | 'requires_action' | 'cancelled' | 'error' | string;
  status: 'completed' | 'interrupted' | 'error' | 'blocked';
  summary?: string;
  content?: Array<{ type: string; text: string; [key: string]: any }>;
  metrics?: any;
  _meta?: Record<string, any>;
}

// =================== 4. Session Persistence: session/load ===================

export interface SessionLoadParams {
  sessionId: string;
  userHint?: string;
  targetMilestoneId?: string;
  _meta?: Record<string, any>;
}

export interface SessionLoadResult {
  sessionId: string;
  status: string;
  resumedFromMilestoneId?: string;
  metrics?: any;
  _meta?: Record<string, any>;
}

// =================== 5. Session Cancellation: session/cancel ===================

export interface SessionCancelParams {
  sessionId: string;
  reason?: string;
  _meta?: Record<string, any>;
}

export interface SessionCancelResult {
  sessionId: string;
  cancelled: boolean;
}

// =================== 6. HITL Security: session/request_permission ===================

export type PermissionRiskLevel = 'read_only' | 'workspace_write' | 'high_risk_exec' | 'network' | 'READ_ONLY' | 'WORKSPACE_WRITE' | 'HIGH_RISK_EXEC' | 'NETWORK';

export interface SessionRequestPermissionParams {
  sessionId: string;
  requestId: string;
  turnId?: string;
  stepId?: string;
  toolCall: {
    name: string;
    arguments: Record<string, any>;
  };
  riskLevel: PermissionRiskLevel;
  description: string;
  _meta?: Record<string, any>;
}

export type PermissionDecision = 'approved' | 'rejected' | 'approved_always' | 'APPROVED' | 'REJECTED' | 'APPROVED_ALWAYS';

export interface SessionRequestPermissionResult {
  decision: PermissionDecision;
  reason?: string;
  _meta?: Record<string, any>;
}

// =================== 7. Real-time Streaming: session/update ===================

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
  | 'tool_call_update';

export interface SessionUpdateNotification {
  sessionId: string;
  updateType?: SessionUpdateType | string;
  sessionUpdate?: string;
  timestamp: number;
  data?: any;
  content?: { type: string; text?: string; [key: string]: any };
  update?: any;
  _meta?: Record<string, any>;
}

// =================== 8. Standard JSON-RPC Cancellation ===================

export interface CancelRequestParams {
  id: JsonRpcId;
}

// =================== 9. Legacy / Task-centric Aliases ===================

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

export interface PermissionRequestParams {
  threadId: string;
  turnId?: string;
  stepId?: string;
  requestId: string;
  toolName: string;
  riskLevel: PermissionRiskLevel;
  description: string;
  metadata?: Record<string, any>;
}

export interface PermissionResponseParams {
  requestId: string;
  decision: PermissionDecision;
  reason?: string;
}

export interface AcpEventPayload {
  threadId: string;
  turnId?: string;
  stepId?: string;
  type: string;
  timestamp: number;
  data: any;
}
