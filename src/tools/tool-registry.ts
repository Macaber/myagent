import { PermissionRiskLevel } from '../protocol/types.js';
import { ToolSchema } from '../provider/types.js';
import { ApprovalGate } from '../security/approval-gate.js';
import { WorkspaceJail } from '../security/workspace-jail.js';
import { MemoryCompactor } from '../context/memory-compactor.js';
import { Blackboard } from '../context/blackboard.js';

export interface ToolExecutionContext {
  threadId: string;
  prompt?: string;
  turnId?: string;
  stepId?: string;
  workspaceJail: WorkspaceJail;
  blackboard: Blackboard;
  abortSignal?: AbortSignal;
}

export interface AgentTool<TParams = any> {
  name: string;
  description: string;
  riskLevel: PermissionRiskLevel;
  parameters: Record<string, any>; // JSON Schema format
  execute(params: TParams, context: ToolExecutionContext): Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, AgentTool>();

  constructor(
    private readonly approvalGate?: ApprovalGate,
    private readonly memoryCompactor: MemoryCompactor = new MemoryCompactor()
  ) {}

  public registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  public unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  public hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  public getTool(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  public getAllTools(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  public getSchemas(allowedToolNames?: string[]): ToolSchema[] {
    const list = allowedToolNames
      ? this.getAllTools().filter((t) => allowedToolNames.includes(t.name))
      : this.getAllTools();

    return list.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  public async executeTool(
    name: string,
    rawParams: any,
    context: ToolExecutionContext
  ): Promise<{ output: string; isTruncated: boolean; error?: string }> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' is not registered`);
    }

    // 1. HITL & Security Gate Check
    if (this.approvalGate) {
      await this.approvalGate.checkAndRequestApproval({
        threadId: context.threadId,
        turnId: context.turnId,
        stepId: context.stepId,
        toolName: tool.name,
        riskLevel: tool.riskLevel,
        description: `Execute tool '${tool.name}'`,
        filePath: rawParams.filePath || rawParams.path,
        command: rawParams.command,
        metadata: rawParams,
      });
    }

    // 2. Execute Tool
    try {
      const rawOutput = await tool.execute(rawParams, context);
      const truncated = this.memoryCompactor.truncateToolOutput(rawOutput, {
        toolName: name,
        stepId: context.stepId,
      });
      return {
        output: truncated.text,
        isTruncated: truncated.isTruncated,
      };
    } catch (err: any) {
      return {
        output: `Error executing ${name}: ${err.message}`,
        isTruncated: false,
        error: err.message,
      };
    }
  }
}
