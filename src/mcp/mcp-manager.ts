import * as fs from 'node:fs';
import { ToolRegistry, AgentTool } from '../tools/tool-registry.js';
import { PermissionRiskLevel } from '../protocol/types.js';
import { McpClient } from './mcp-client.js';
import {
  McpServerConfig,
  McpServerInfo,
  McpConfigFile,
} from './types.js';

interface ActiveServer {
  config: McpServerConfig;
  client: McpClient;
  toolNames: string[];
  status: 'connected' | 'disconnected' | 'error';
  error?: string;
}

export class McpManager {
  private servers = new Map<string, ActiveServer>();

  constructor(private readonly toolRegistry: ToolRegistry) {}

  /**
   * Dynamically mount an external MCP server, discover its tools,
   * and inject them into the ToolRegistry with namespacing.
   */
  public async mountServer(config: McpServerConfig): Promise<McpServerInfo> {
    if (this.servers.has(config.id)) {
      await this.unmountServer(config.id);
    }

    const client = new McpClient(config);
    try {
      await client.connect();
      const tools = await client.listTools();

      const registeredNames: string[] = [];

      for (const mcpTool of tools) {
        // Namespaced tool name to avoid collisions across multiple MCP servers
        const namespacedName = `mcp__${config.id}__${mcpTool.name}`;
        const riskLevel = this.inferRiskLevel(mcpTool.name, mcpTool.description);

        const agentTool: AgentTool = {
          name: namespacedName,
          description: `[MCP Server: ${config.id}] ${mcpTool.description || mcpTool.name}`,
          riskLevel,
          parameters: mcpTool.inputSchema || { type: 'object', properties: {} },
          async execute(params: any) {
            const res = await client.callTool(mcpTool.name, params || {});
            if (res.isError) {
              const errText = res.content
                ?.map((c) => c.text)
                .filter(Boolean)
                .join('\n') || 'Unknown MCP tool error';
              throw new Error(`MCP Tool Error: ${errText}`);
            }

            const output = res.content
              ?.map((c) => {
                if (c.type === 'text') return c.text;
                if (c.type === 'resource') return `[Resource: ${c.data || c.text}]`;
                return JSON.stringify(c);
              })
              .join('\n');

            return output ?? 'Success (empty response)';
          },
        };

        this.toolRegistry.registerTool(agentTool);
        registeredNames.push(namespacedName);
      }

      const active: ActiveServer = {
        config,
        client,
        toolNames: registeredNames,
        status: 'connected',
      };
      this.servers.set(config.id, active);

      return {
        id: config.id,
        name: config.name || config.id,
        transport: config.transport || 'stdio',
        status: 'connected',
        tools: registeredNames,
      };
    } catch (err: any) {
      await client.close().catch(() => {});
      const info: McpServerInfo = {
        id: config.id,
        name: config.name || config.id,
        transport: config.transport || 'stdio',
        status: 'error',
        tools: [],
        error: err.message,
      };
      return info;
    }
  }

  /**
   * Unmount an MCP server and remove its registered tools.
   */
  public async unmountServer(serverId: string): Promise<boolean> {
    const active = this.servers.get(serverId);
    if (!active) {
      return false;
    }

    for (const toolName of active.toolNames) {
      this.toolRegistry.unregisterTool(toolName);
    }

    await active.client.close();
    this.servers.delete(serverId);
    return true;
  }

  public async unmountAll(): Promise<void> {
    const ids = Array.from(this.servers.keys());
    for (const id of ids) {
      await this.unmountServer(id);
    }
  }

  public listMountedServers(): McpServerInfo[] {
    return Array.from(this.servers.values()).map((s) => ({
      id: s.config.id,
      name: s.config.name || s.config.id,
      transport: s.config.transport || 'stdio',
      status: s.status,
      tools: s.toolNames,
      error: s.error,
    }));
  }

  public getServer(serverId: string): McpServerInfo | undefined {
    const s = this.servers.get(serverId);
    if (!s) return undefined;
    return {
      id: s.config.id,
      name: s.config.name || s.config.id,
      transport: s.config.transport || 'stdio',
      status: s.status,
      tools: s.toolNames,
      error: s.error,
    };
  }

  /**
   * Load MCP configuration from a JSON file (e.g. .agent/mcp.json or claude_desktop_config format).
   */
  public async loadConfigFile(filePath: string): Promise<McpServerInfo[]> {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const raw = await fs.promises.readFile(filePath, 'utf8');
    const config = JSON.parse(raw) as McpConfigFile;
    const results: McpServerInfo[] = [];

    if (config.mcpServers) {
      for (const [id, srv] of Object.entries(config.mcpServers)) {
        const serverConfig: McpServerConfig = {
          id,
          name: id,
          command: srv.command,
          args: srv.args,
          env: srv.env,
          url: srv.url,
          transport: srv.transport || (srv.url ? 'http' : 'stdio'),
        };
        const info = await this.mountServer(serverConfig);
        results.push(info);
      }
    }

    return results;
  }

  private inferRiskLevel(toolName: string, description?: string): PermissionRiskLevel {
    const lower = `${toolName} ${description || ''}`.toLowerCase();
    if (lower.includes('exec') || lower.includes('shell') || lower.includes('run') || lower.includes('delete') || lower.includes('kill')) {
      return 'HIGH_RISK_EXEC';
    }
    if (lower.includes('write') || lower.includes('edit') || lower.includes('create') || lower.includes('update') || lower.includes('patch')) {
      return 'WORKSPACE_WRITE';
    }
    if (lower.includes('http') || lower.includes('fetch') || lower.includes('request') || lower.includes('api')) {
      return 'NETWORK';
    }
    return 'READ_ONLY';
  }
}
