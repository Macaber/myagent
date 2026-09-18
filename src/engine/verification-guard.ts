import { ToolRegistry } from '../tools/tool-registry.js';
import { ToolExecutionContext } from '../tools/tool-registry.js';
import { Milestone, ExecutionPlan } from './dag.js';

export interface VerificationResult {
  passed: boolean;
  message: string;
}

export class VerificationGuard {
  constructor(private readonly toolRegistry: ToolRegistry) {}

  public async verifyMilestone(
    milestone: Milestone,
    context: ToolExecutionContext
  ): Promise<VerificationResult> {
    if (!milestone.acceptanceCriteria || milestone.acceptanceCriteria.trim().length === 0) {
      // Default: passed based on worker result summary
      return {
        passed: true,
        message: milestone.resultSummary || 'Milestone self-verified successfully.',
      };
    }

    const criteria = milestone.acceptanceCriteria.trim();

    // Check if criteria specifies an automated command (e.g. 'cmd: npm test' or 'npm test' or 'npm run build')
    const isCommand = criteria.startsWith('cmd:') || /^(npm|pnpm|yarn|node|git|cargo|pytest|go test)\b/.test(criteria);
    const command = criteria.startsWith('cmd:') ? criteria.slice(4).trim() : criteria;

    if (isCommand) {
      try {
        const result = await this.toolRegistry.executeTool('bash', { command }, context);
        if (result.error) {
          return {
            passed: false,
            message: `Acceptance verification command '${command}' failed: ${result.error}`,
          };
        }
        return {
          passed: true,
          message: `Acceptance verification command '${command}' succeeded. Output:\n${result.output.slice(0, 500)}`,
        };
      } catch (err: any) {
        return {
          passed: false,
          message: `Acceptance verification command execution error: ${err.message}`,
        };
      }
    }

    // Otherwise, check if resultSummary was produced
    if (milestone.resultSummary && milestone.resultSummary.length > 20) {
      return {
        passed: true,
        message: `Milestone verified with criteria "${criteria}": ${milestone.resultSummary.slice(0, 200)}`,
      };
    }

    return {
      passed: false,
      message: `Acceptance criteria "${criteria}" could not be confirmed. Worker must provide explicit verification proof.`,
    };
  }

  public verifyDagCompletion(plan: ExecutionPlan): VerificationResult {
    if (plan.isAllCompleted()) {
      return { passed: true, message: 'All milestones in DAG completed successfully.' };
    }
    const failed = plan.getFailedMilestones();
    if (failed.length > 0) {
      return {
        passed: false,
        message: `DAG contains failed milestones: ${failed.map((f) => `${f.id} (${f.error || 'error'})`).join(', ')}`,
      };
    }
    return {
      passed: false,
      message: 'DAG execution is still in progress; not all milestones have succeeded.',
    };
  }
}
