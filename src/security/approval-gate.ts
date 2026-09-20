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
  private alwaysApprovedTools = new Set<string>();
  private requestIdCounter = 1;

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
    // 1. Check if tool is permanently approved for this session
    if (this.alwaysApprovedTools.has(params.toolName)) {
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
    const decisionLower = String(outcome).toLowerCase();

    if (decisionLower.includes('reject') || decisionLower.includes('cancel')) {
      throw new PermissionDeniedByUserError(
        params.toolName,
        response.reason || 'Operation rejected by user'
      );
    }

    if (decisionLower.includes('always')) {
      this.alwaysApprovedTools.add(params.toolName);
    }
  }
}
