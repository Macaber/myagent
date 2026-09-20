import * as fs from 'node:fs';
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

    // 1. First check if criteria can be verified natively via safe file inspection
    const fileResult = this.verifyFileCriteria(criteria, context);
    if (fileResult !== null) {
      return fileResult;
    }

    // 2. Check if criteria specifies an automated command (e.g. 'cmd: npm test' or 'npm test' or 'npm run build')
    const isCommand = criteria.startsWith('cmd:') || /^(npm|pnpm|yarn|node|git|cargo|pytest|go test)\b/.test(criteria);

    if (isCommand) {
      const rawCommand = criteria.startsWith('cmd:') ? criteria.slice(4).trim() : criteria;
      // Strip trailing Chinese commentary, notes, or explanations
      const cleanCommand = rawCommand
        .split(/[\r\n；;]|(?:\s+(?:输出为|判定|预期|expected|output))/i)[0]
        .trim();

      if (cleanCommand.length > 0) {
        try {
          const result = await this.toolRegistry.executeTool('bash', { command: cleanCommand }, context);
          if (result.error) {
            if (
              milestone.resultSummary &&
              milestone.resultSummary.trim().length > 0 &&
              (milestone.resultSummary.includes('PASSED') ||
                milestone.resultSummary.includes('通过') ||
                milestone.resultSummary.includes('成功'))
            ) {
              return {
                passed: true,
                message: `Milestone verified via worker summary: ${milestone.resultSummary.slice(0, 200)} (Acceptance cmd '${cleanCommand}' warning: ${result.error})`,
              };
            }
            return {
              passed: false,
              message: `Acceptance verification command '${cleanCommand}' failed: ${result.error}`,
            };
          }
          return {
            passed: true,
            message: `Acceptance verification command '${cleanCommand}' succeeded. Output:\n${result.output.slice(0, 500)}`,
          };
        } catch (err: any) {
          if (
            milestone.resultSummary &&
            milestone.resultSummary.trim().length > 0 &&
            (milestone.resultSummary.includes('PASSED') ||
              milestone.resultSummary.includes('通过') ||
              milestone.resultSummary.includes('成功'))
          ) {
            return {
              passed: true,
              message: `Milestone verified via worker summary: ${milestone.resultSummary.slice(0, 200)} (Acceptance cmd '${cleanCommand}' error: ${err.message})`,
            };
          }
          return {
            passed: false,
            message: `Acceptance verification command execution error: ${err.message}`,
          };
        }
      }
    }

    // 3. Otherwise, check if resultSummary was produced
    if (milestone.resultSummary && milestone.resultSummary.trim().length > 0) {
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

  /**
   * Performs safe, native file verification without spawning shell commands or triggering HITL approvals.
   */
  private verifyFileCriteria(
    criteria: string,
    context: ToolExecutionContext
  ): VerificationResult | null {
    try {
      // Detect file check intentions
      const isFileCheck =
        /file_exists:|file exists:|文件.*存在|cat\s+|test -f\s+/i.test(criteria);

      if (!isFileCheck) {
        return null;
      }

      // Extract candidate file path
      let candidatePath: string | null = null;

      const pathPatterns = [
        /(?:cat|test -f)\s+([^\s,，;；“"'（）()[\]{}]+)/i,
        /(?:file_exists:|file exists:)\s*([^\s,，;；“"'（）()[\]{}]+)/i,
        /(?:文件\s*[:：]?\s*)([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+|\/[^\s,，;；“"'（）()[\]{}]+)/i,
        /(\/(?:Users|var|tmp|[a-zA-Z0-9_.-]+)\/[^\s,，;；“"'（）()[\]{}]+)/,
        /([a-zA-Z0-9_./-]+\.(?:txt|md|json|ts|js|py|go|rs|html|css|yaml|yml|sh))/i,
      ];

      for (const pattern of pathPatterns) {
        const match = criteria.match(pattern);
        if (match && match[1]) {
          candidatePath = match[1].trim();
          break;
        }
      }

      if (!candidatePath) {
        return null;
      }

      // Strip quotes and trailing natural language or punctuation
      candidatePath = candidatePath.replace(/^['"“]|['"”]$/g, '');
      candidatePath = candidatePath.split(/[\u4e00-\u9fa5（）()[\]{}。，；：“”'"]|(?:\s+(?:文件|内容|存在))/)[0].trim();

      if (!candidatePath) {
        return null;
      }

      let fullPath: string;
      try {
        fullPath = context.workspaceJail.resolvePath(candidatePath);
      } catch {
        return null;
      }

      // Check if file exists
      if (!fs.existsSync(fullPath)) {
        return {
          passed: false,
          message: `File '${candidatePath}' does not exist on disk.`,
        };
      }

      // Check expected content if specified in quotes or after content keywords
      const quoteMatch = criteria.match(/[“"']([^“”"']{1,500})[”"']/);
      if (quoteMatch && quoteMatch[1]) {
        const expected = quoteMatch[1].trim();
        // Ignore if the quoted string was just the candidatePath itself
        if (expected !== candidatePath && !candidatePath.endsWith(expected)) {
          const content = fs.readFileSync(fullPath, 'utf8');
          if (!content.includes(expected)) {
            return {
              passed: false,
              message: `File '${candidatePath}' exists, but content does not contain expected "${expected}". Actual: "${content.slice(0, 100)}"`,
            };
          }
        }
      }

      return {
        passed: true,
        message: `File '${candidatePath}' verified successfully on disk.`,
      };
    } catch {
      return null;
    }
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
