import { AgentTool, ToolExecutionContext } from './tool-registry.js';
import { SubagentManager } from '../runtime/subagent-manager.js';
import { ThreadContext } from '../runtime/thread-context.js';

export interface SubagentTaskSpec {
  role: string;
  taskDescription: string;
  skillId?: string;
  maxSteps?: number;
}

export interface InvokeSubagentParams {
  role?: string;
  taskDescription?: string;
  skillId?: string;
  maxSteps?: number;
  subagents?: SubagentTaskSpec[];
}

export function createInvokeSubagentTool(
  subagentManager: SubagentManager,
  getThreadContext: (threadId: string) => ThreadContext | undefined
): AgentTool<InvokeSubagentParams> {
  return {
    name: 'invoke_subagent',
    description:
      'Spawn one or more autonomous specialized subagents (e.g. "explore" for read-only codebase search, "coder" for editing, "qa" for tests). ' +
      'Subagents run in isolated child threads with private contexts, preventing master context explosion. ' +
      'Use the "subagents" array to dispatch multiple subagents concurrently in parallel. ' +
      'NOTE: subagents may write files and run commands — treat as privileged.',
    riskLevel: 'HIGH_RISK_EXEC',
    parameters: {
      type: 'object',
      properties: {
        subagents: {
          type: 'array',
          description:
            'Dispatch multiple specialized subagents in parallel (e.g. parallel codebase exploration of different directories). Runs concurrently via Promise.all.',
          items: {
            type: 'object',
            properties: {
              role: {
                type: 'string',
                enum: ['explore', 'coder', 'qa', 'analyst', 'developer'],
                description:
                  'Specialized role: "explore" (strictly read-only codebase search/read), "coder" (code editing & writing), "qa" (test execution & diagnosis)',
              },
              taskDescription: {
                type: 'string',
                description: 'Clear, actionable instructions for the subagent',
              },
              maxSteps: {
                type: 'number',
                description: 'Optional step limit (default 8 for explore, 10 for coder)',
              },
            },
            required: ['role', 'taskDescription'],
          },
        },
        role: {
          type: 'string',
          description: 'Single subagent role (e.g. "explore", "coder", "qa")',
        },
        taskDescription: {
          type: 'string',
          description: 'Single subagent task instructions',
        },
        maxSteps: {
          type: 'number',
          description: 'Optional step limit for single subagent',
        },
      },
    },
    async execute(params, context: ToolExecutionContext) {
      const parentThread = getThreadContext(context.threadId);
      if (!parentThread) {
        throw new Error(`Parent thread '${context.threadId}' not found for subagent invocation`);
      }

      const tasks: SubagentTaskSpec[] = [];

      if (params.subagents && Array.isArray(params.subagents) && params.subagents.length > 0) {
        for (const s of params.subagents) {
          tasks.push({
            role: s.role || 'explore',
            taskDescription: s.taskDescription,
            skillId: s.skillId,
            maxSteps: s.maxSteps,
          });
        }
      } else if (params.role && params.taskDescription) {
        tasks.push({
          role: params.role,
          taskDescription: params.taskDescription,
          skillId: params.skillId,
          maxSteps: params.maxSteps,
        });
      } else {
        throw new Error('invoke_subagent requires either "subagents" array or "role" and "taskDescription"');
      }

      const results = await subagentManager.runSubagentsBatch(parentThread, tasks, {
        abortSignal: context.abortSignal,
      });
      return SubagentManager.formatSubagentResults(results);
    },
  };
}
