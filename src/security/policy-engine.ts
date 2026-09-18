import { PermissionRiskLevel } from '../protocol/types.js';
import { WorkspaceJail } from './workspace-jail.js';

export interface SecurityPolicyConfig {
  autoApproveReadOnly?: boolean;
  autoApproveWorkspaceWrite?: boolean;
  strictMode?: boolean; // If true, even workspace write requires approval
}

export class PolicyEngine {
  constructor(
    private readonly jail: WorkspaceJail,
    private readonly config: SecurityPolicyConfig = {
      autoApproveReadOnly: true,
      autoApproveWorkspaceWrite: true,
      strictMode: false,
    }
  ) {}

  public evaluateToolCall(params: {
    toolName: string;
    riskLevel: PermissionRiskLevel;
    filePath?: string;
    command?: string;
  }): { requiresApproval: boolean; reason?: string } {
    const { riskLevel, filePath } = params;

    // 1. Verify workspace jail if path is provided
    if (filePath) {
      try {
        this.jail.resolvePath(filePath);
      } catch (err: any) {
        return {
          requiresApproval: true,
          reason: `Path check failed: ${err.message}`,
        };
      }
    }

    // 2. Evaluate based on risk tier
    switch (riskLevel) {
      case 'READ_ONLY':
        return { requiresApproval: false };

      case 'WORKSPACE_WRITE':
        if (this.config.strictMode) {
          return {
            requiresApproval: true,
            reason: 'Strict mode enabled: workspace file modifications require confirmation.',
          };
        }
        return { requiresApproval: false };

      case 'HIGH_RISK_EXEC':
        return {
          requiresApproval: true,
          reason: `Command/script execution requires human approval: ${params.command || params.toolName}`,
        };

      case 'NETWORK':
        return {
          requiresApproval: true,
          reason: `Outbound network access requested by tool '${params.toolName}'`,
        };

      default:
        return { requiresApproval: true, reason: 'Unknown risk tier' };
    }
  }
}
