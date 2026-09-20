import { ToolRegistry, AgentTool } from '../tools/tool-registry.js';
import { ToolSchema } from '../provider/types.js';

export type StageType = 'planning' | 'worker' | 'verification' | 'summary';

export interface ToolRoutingMetadata {
  name: string;
  category: 'core' | 'stage_plan' | 'stage_worker' | 'stage_qa' | 'deferred';
  description?: string;
}

export class ToolRouter {
  // Pre-configured stage tool mapping
  private stagePresets: Record<StageType, string[]> = {
    planning: ['read', 'glob', 'grep', 'todowrite', 'question', 'skill'],
    worker: ['read', 'edit', 'write', 'patch', 'bash', 'glob', 'grep', 'todowrite', 'question', 'skill', 'invoke_subagent'],
    verification: ['bash', 'read', 'grep', 'glob', 'todowrite', 'question', 'skill'],
    summary: ['read', 'todowrite', 'question'],
  };

  // Fine-grained tool presets by worker role / skill to minimize schema token overhead
  private skillPresets: Record<string, string[]> = {
    explore: ['read', 'glob', 'grep', 'question', 'skill'],
    analyst: ['read', 'glob', 'grep', 'question', 'skill', 'invoke_subagent'],
    coder: ['read', 'edit', 'write', 'patch', 'glob', 'grep', 'question', 'skill'],
    developer: ['read', 'edit', 'write', 'patch', 'bash', 'glob', 'grep', 'todowrite', 'question', 'skill', 'invoke_subagent'],
    qa: ['bash', 'read', 'grep', 'glob', 'todowrite', 'question', 'skill'],
  };

  // Turn-specific dynamically activated tools
  private turnActivatedTools = new Map<string, Set<string>>();

  // Explicit tool classifications
  private deferredToolNames = new Set<string>();

  constructor(private readonly registry: ToolRegistry) {
    this.registerMetaTools();
  }

  /**
   * Register a tool as deferred (not exposed to LLM by default, loaded on-demand)
   */
  public markAsDeferred(toolName: string): void {
    this.deferredToolNames.add(toolName);
  }

  public isDeferred(toolName: string): boolean {
    if (this.deferredToolNames.has(toolName)) return true;
    // By default, MCP tools (mcp__*) are treated as deferred unless explicitly staged
    return toolName.startsWith('mcp__');
  }

  /**
   * Activate a deferred or MCP tool for a specific turn
   */
  public activateToolForTurn(turnId: string, toolName: string): boolean {
    if (!this.registry.hasTool(toolName)) {
      return false;
    }
    let set = this.turnActivatedTools.get(turnId);
    if (!set) {
      set = new Set();
      this.turnActivatedTools.set(turnId, set);
    }
    set.add(toolName);
    return true;
  }

  /**
   * Deactivate a tool for a specific turn
   */
  public deactivateToolForTurn(turnId: string, toolName: string): boolean {
    const set = this.turnActivatedTools.get(turnId);
    if (!set) return false;
    return set.delete(toolName);
  }

  /**
   * Clear all dynamically activated tools for a turn when it finishes
   */
  public clearTurnTools(turnId: string): void {
    this.turnActivatedTools.delete(turnId);
  }

  /**
   * Get the list of all currently deferred / available-on-demand tools
   */
  public listDeferredTools(): Array<{ name: string; description: string }> {
    const all = this.registry.getAllTools();
    return all
      .filter((t) => this.isDeferred(t.name) && t.name !== 'search_tools' && t.name !== 'activate_tool')
      .map((t) => ({ name: t.name, description: t.description }));
  }

  /**
   * Get active tool schemas for the current step/turn, combining:
   * 1. Stage preset tools or skill-specific tools (filtered to registered ones)
   * 2. Turn-specifically activated tools (e.g. dynamically requested MCP tools)
   * 3. Meta-tools (search_tools, activate_tool)
   */
  public getActiveToolSchemas(turnId?: string, stage: StageType = 'worker', assignedSkill?: string): ToolSchema[] {
    const activeNames = new Set<string>();

    // 1. Add stage base tools or skill-tailored tools
    let preset = this.stagePresets[stage] || this.stagePresets.worker;
    if (stage === 'worker' && assignedSkill && this.skillPresets[assignedSkill]) {
      preset = this.skillPresets[assignedSkill];
    }

    for (const name of preset) {
      if (this.registry.hasTool(name) && !this.isDeferred(name)) {
        activeNames.add(name);
      }
    }

    // 2. Add turn-activated tools
    if (turnId) {
      const turnSet = this.turnActivatedTools.get(turnId);
      if (turnSet) {
        for (const name of turnSet) {
          if (this.registry.hasTool(name)) {
            activeNames.add(name);
          }
        }
      }
    }

    // 3. Always include meta-tools if deferred tools exist
    if (this.listDeferredTools().length > 0) {
      activeNames.add('search_tools');
      activeNames.add('activate_tool');
    }

    return this.registry.getSchemas(Array.from(activeNames));
  }

  /**
   * Meta-tools: allow the LLM to discover and activate deferred tools on-demand
   */
  private registerMetaTools(): void {
    const searchToolsTool: AgentTool<{ query?: string }> = {
      name: 'search_tools',
      description: 'Search available deferred tools (such as MCP tools) that are not currently exposed in the active toolset.',
      riskLevel: 'READ_ONLY',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional keyword to search tool names and descriptions' },
        },
      },
      execute: async (params) => {
        const deferred = this.listDeferredTools();
        if (deferred.length === 0) {
          return 'No deferred tools available in registry.';
        }
        const query = (params.query || '').toLowerCase();
        const matched = query
          ? deferred.filter((t) => t.name.toLowerCase().includes(query) || t.description.toLowerCase().includes(query))
          : deferred;

        if (matched.length === 0) {
          return `No deferred tools matched query "${query}". Total available: ${deferred.length}`;
        }

        return (
          `Available Deferred Tools (${matched.length}):\n` +
          matched.map((t) => `- ${t.name}: ${t.description}`).join('\n') +
          `\n\nCall 'activate_tool' with toolName to enable a tool for your current turn.`
        );
      },
    };

    const activateToolTool: AgentTool<{ toolName: string }> = {
      name: 'activate_tool',
      description: 'Activate a deferred tool (e.g. an MCP tool) into your active toolset for this turn.',
      riskLevel: 'READ_ONLY',
      parameters: {
        type: 'object',
        properties: {
          toolName: { type: 'string', description: 'Exact name of the tool to activate' },
        },
        required: ['toolName'],
      },
      execute: async (params, context) => {
        const turnId = context.turnId || 'current_turn';
        const success = this.activateToolForTurn(turnId, params.toolName);
        if (!success) {
          return `Failed to activate '${params.toolName}': Tool not found in registry.`;
        }
        return `Tool '${params.toolName}' activated successfully for turn '${turnId}'. You can now invoke it directly in your next step.`;
      },
    };

    this.registry.registerTool(searchToolsTool);
    this.registry.registerTool(activateToolTool);
  }
}
