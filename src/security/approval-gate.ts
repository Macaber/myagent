import { RpcDispatcher } from '../protocol/rpc-dispatcher.js';
import {
  PermissionRiskLevel,
  SessionRequestPermissionParams,
  SessionRequestPermissionResult,
} from '../protocol/types.js';
import { PolicyEngine } from './policy-engine.js';

export class PermissionDeniedByUserError extends Error {
  constructor(toolName: string, reason?: string) {
    super(`Permission denied by user for tool '${toolName}'. ${reason || ''}`.trim());
    this.name = 'PermissionDeniedByUserError';
  }
}

export class ApprovalGate {
  // Scoped by session + tool + args hash: one `allow_always bash(ls)` must not
  // blanket-approve later `bash(rm -rf /)`. Entries expire after 1h.
  private alwaysApproved = new Map<string, number>();
  private static readonly ALWAYS_TTL_MS = 60 * 60 * 1000;
  private requestIdCounter = 1;

  private static fnv1a(str: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  private approvalKey(params: {
    threadId: string;
    toolName: string;
    command?: string;
    filePath?: string;
    metadata?: Record<string, any>;
  }): string {
    const cmd = params.command ?? '';
    const file = params.filePath ?? '';
    let meta = '';
    try {
      meta = JSON.stringify(params.metadata ?? {});
    } catch {
      meta = String(params.metadata);
    }
    return `${params.threadId}:${params.toolName}:${ApprovalGate.fnv1a(cmd + '|' + file + '|' + meta)}`;
  }

  private isAlwaysApproved(key: string): boolean {
    const at = this.alwaysApproved.get(key);
    if (at === undefined) return false;
    if (Date.now() - at > ApprovalGate.ALWAYS_TTL_MS) {
      this.alwaysApproved.delete(key);
      return false;
    }
    return true;
  }

  constructor(
    private readonly policyEngine: PolicyEngine,
    private readonly dispatcher?: RpcDispatcher
  ) {}

  public async checkAndRequestApproval(params: {
    threadId: string;
    turnId?: string;
    stepId?: string;
    toolName: string;
    riskLevel: PermissionRiskLevel;
    description: string;
    filePath?: string;
    command?: string;
    metadata?: Record<string, any>;
  }): Promise<void> {
    // 1. Check if this exact (session, tool, args) was permanently approved
    if (this.isAlwaysApproved(this.approvalKey(params))) {
      return;
    }

    // 2. Evaluate with Policy Engine
    const evaluation = this.policyEngine.evaluateToolCall({
      toolName: params.toolName,
      riskLevel: params.riskLevel,
      filePath: params.filePath,
      command: params.command,
    });

    if (!evaluation.requiresApproval) {
      return;
    }

    // 3. If no dispatcher (e.g. headless without ACP client), default policy:
    if (!this.dispatcher) {
      if (params.riskLevel === 'READ_ONLY' || params.riskLevel === 'WORKSPACE_WRITE') {
        return;
      }
      throw new PermissionDeniedByUserError(
        params.toolName,
        'No interactive ACP client connected to approve high-risk action'
      );
    }

    // 4. Send official canonical session/request_permission over ACP
    const requestId = `perm_req_${this.requestIdCounter++}`;
    const toolCallId = params.stepId || requestId;
    const requestPayload: SessionRequestPermissionParams = {
      sessionId: params.threadId,
      toolCallId,
      requestId,
      turnId: params.turnId,
      stepId: params.stepId,
      toolCall: {
        toolCallId,
        name: params.toolName,
        title: `Execute tool '${params.toolName}'`,
        arguments: params.metadata || {},
        rawInput: params.metadata || {},
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: `${params.description} (Reason: ${evaluation.reason || 'High risk operation'})`,
            },
          },
        ],
      },
      options: [
        {
          optionId: 'allow_once',
          name: 'Allow Once',
          kind: 'allow_once',
        },
        {
          optionId: 'allow_always',
          name: 'Always Allow',
          kind: 'allow_always',
        },
        {
          optionId: 'reject_once',
          name: 'Reject',
          kind: 'reject_once',
        },
      ],
      riskLevel: params.riskLevel,
      description: `${params.description} (Reason: ${evaluation.reason || 'High risk operation'})`,
    };

    const response = await this.dispatcher.requestClient<
      SessionRequestPermissionParams,
      SessionRequestPermissionResult
    >('session/request_permission', requestPayload);

    const outcome =
      (response.outcome && 'optionId' in response.outcome
        ? response.outcome.optionId
        : response.outcome?.outcome) ||
      response.decision ||
      '';
    const decision = String(outcome).trim().toLowerCase();
    const isReject = decision === 'reject_once' || decision === 'reject_always'
      || decision === 'rejected' || decision === 'cancelled' || decision === 'cancel'
      || decision === 'decline' || decision === 'declined';
    const isAlways = decision === 'allow_always' || decision === 'approved_always' || decision === 'always';
    const isOnce = decision === 'allow_once' || decision === 'approved_once' || decision === 'approved'
      || decision === 'accept' || decision === 'accepted';

    if (isReject) {
      throw new PermissionDeniedByUserError(
        params.toolName,
        response.reason || 'Operation rejected by user'
      );
    }

    if (isAlways) {
      this.alwaysApproved.set(this.approvalKey(params), Date.now());
      return;
    }

    if (!isOnce) {
      // Unknown outcome — fail closed rather than treating as approval.
      throw new PermissionDeniedByUserError(
        params.toolName,
        `Unknown permission outcome '${outcome}' — treating as rejection`
      );
    }
  }
}
