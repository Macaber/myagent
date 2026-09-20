import { PermissionRiskLevel } from '../protocol/types.js';

export type AgentRuntimeState = 'IDLE' | 'PENDING' | 'RUNNING' | 'BLOCKED' | 'SUSPENDED_INPUT' | 'COMPLETED' | 'FAILED';

export interface MilestoneItem {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
}

export interface PlanData {
  goal: string;
  milestones: MilestoneItem[];
}

export interface UIToolCall {
  id: string;
  name: string;
  argsSummary: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  durationMs?: number;
  outputPreview?: string;
  errorMessage?: string;
}

export interface UIMessage {
  id: string;
  type: 'user' | 'agent' | 'thought' | 'tool' | 'system';
  content?: string;
  toolCall?: UIToolCall;
  timestamp: number;
}

export interface PendingApproval {
  requestId: string;
  toolName: string;
  description: string;
  riskLevel: PermissionRiskLevel;
  arguments?: Record<string, any>;
  respond: (decision: 'approved' | 'approved_always' | 'rejected', reason?: string) => void;
}

export interface TelemetryStats {
  elapsedSeconds: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  toolCallsCount: number;
}
