import { AgentTool, ToolExecutionContext } from './tool-registry.js';
import { SubagentManager } from '../runtime/subagent-manager.js';
import { ThreadContext } from '../runtime/thread-context.js';

export function createInvokeSubagentTool(
  subagentManager: SubagentManager,
  getThreadContext: (threadId: string) => ThreadContext | undefined
): AgentTool<{ role: string; taskDescription: string; skillId?: string }> {
  return {
    name: 'invoke_subagent',
    description:
      'Spawn an autonomous Sub-agent with an isolated context window to execute a focused subtask (e.g. deep research, code refactoring, test execution). Prevents context overflow in the master agent.',
    riskLevel: 'READ_ONLY',
    parameters: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description: 'Descriptive role of the subagent (e.g. "Documentation Researcher", "Component Refactorer")',
        },
        taskDescription: {
          type: 'string',
          description: 'Detailed, actionable instructions for the subagent to perform',
        },
        skillId: {
          type: 'string',
          enum: ['analyst', 'developer', 'qa'],
          description: 'Optional skill profile to equip the subagent with',
        },
      },
      required: ['role', 'taskDescription'],
    },
    async execute(params, context: ToolExecutionContext) {
      const parentThread = getThreadContext(context.threadId);
      if (!parentThread) {
        throw new Error(`Parent thread '${context.threadId}' not found for subagent invocation`);
      }

      const result = await subagentManager.runSubagent(parentThread, {
        role: params.role,
        taskDescription: params.taskDescription,
        skillId: params.skillId,
      });

      return (
        `[Sub-agent '${params.role}' (${result.subagentId}) Finished with status: ${result.status}]\n` +
        `Execution Duration: ${result.durationMs}ms | Tokens: ${result.tokens.totalTokens}\n` +
        `Summary of Findings & Results:\n${result.summary}`
      );
    },
  };
}
