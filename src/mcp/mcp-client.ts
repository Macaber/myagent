import { spawn, ChildProcess } from 'node:child_process';
import {
  McpServerConfig,
  McpToolSchema,
  McpToolCallResult,
} from './types.js';

export class McpClient {
  private childProcess?: ChildProcess;
  private nextRequestId = 1;
  private pendingRequests = new Map<
    string | number,
    { resolve: (val: any) => void; reject: (err: any) => void; timer?: NodeJS.Timeout }
  >();
  private buffer = '';
  private isConnected = false;

  constructor(public readonly config: McpServerConfig) {}

  public async connect(timeoutMs: number = 15000): Promise<void> {
    if (this.config.transport === 'http' || this.config.url) {
      // HTTP/SSE endpoint connection
      this.isConnected = true;
      return;
    }

    if (!this.config.command) {
      throw new Error(`MCP Server '${this.config.id}' requires a 'command' for stdio transport`);
    }

    const env = { ...process.env, ...(this.config.env || {}) };
    this.childProcess = spawn(this.config.command, this.config.args || [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.setupProcessListeners();

    // 1. Send MCP initialize handshake
    const initResult = await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {
          roots: { listChanged: true },
          sampling: {},
        },
        clientInfo: {
          name: 'myagent',
          version: '0.1.0',
        },
      },
      timeoutMs
    );

    // 2. Send initialized notification
    this.notify('notifications/initialized', {});
    this.isConnected = true;
  }

  public async listTools(timeoutMs: number = 10000): Promise<McpToolSchema[]> {
    if (this.config.transport === 'http' && this.config.url) {
      return this.httpListTools();
    }

    const response = await this.request('tools/list', {}, timeoutMs);
    return (response?.tools as McpToolSchema[]) || [];
  }

  public async callTool(
    name: string,
    args: Record<string, any>,
    timeoutMs: number = 60000
  ): Promise<McpToolCallResult> {
    if (this.config.transport === 'http' && this.config.url) {
      return this.httpCallTool(name, args);
    }

    const response = await this.request(
      'tools/call',
      {
        name,
        arguments: args,
      },
      timeoutMs
    );

    return response as McpToolCallResult;
  }

  public async close(): Promise<void> {
    this.isConnected = false;
    for (const [id, pending] of this.pendingRequests.entries()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error('McpClient is closing'));
    }
    this.pendingRequests.clear();

    if (this.childProcess) {
      try {
        this.childProcess.stdin?.destroy();
        this.childProcess.stdout?.destroy();
        this.childProcess.stderr?.destroy();
        this.childProcess.kill('SIGKILL');
        this.childProcess.unref?.();
      } catch {
        // ignore already dead process
      }
      this.childProcess = undefined;
    }
  }

  private request(method: string, params: any, timeoutMs: number): Promise<any> {
    const id = this.nextRequestId++;
    const message = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.sendPayload(message);
    });
  }

  private notify(method: string, params: any): void {
    const message = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.sendPayload(message);
  }

  private sendPayload(payload: any): void {
    if (!this.childProcess || !this.childProcess.stdin) {
      throw new Error(`MCP Client for '${this.config.id}' is not connected`);
    }
    this.childProcess.stdin.write(JSON.stringify(payload) + '\n');
  }

  private setupProcessListeners(): void {
    if (!this.childProcess) return;

    this.childProcess.stdout?.setEncoding('utf8');
    this.childProcess.stdout?.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newlineIdx: number;
      while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim();
        this.buffer = this.buffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          this.handleIncomingLine(line);
        }
      }
    });

    this.childProcess.stderr?.setEncoding('utf8');
    this.childProcess.stderr?.on('data', (chunk: string) => {
      // Stderr can be used for MCP logging or diagnostics
      // Suppress or log in debug mode
    });

    this.childProcess.on('exit', (code) => {
      this.isConnected = false;
      for (const [id, pending] of this.pendingRequests.entries()) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new Error(`MCP process exited unexpectedly with code ${code}`));
      }
      this.pendingRequests.clear();
    });
  }

  private handleIncomingLine(line: string): void {
    try {
      const msg = JSON.parse(line);
      if ('id' in msg && ('result' !== undefined || 'error' !== undefined)) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          if (pending.timer) clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(`MCP error [${msg.error.code}]: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    } catch {
      // Ignore unparseable lines
    }
  }

  private async httpListTools(): Promise<McpToolSchema[]> {
    if (!this.config.url) return [];
    const res = await fetch(`${this.config.url}/tools`, {
      headers: this.config.headers,
    });
    if (!res.ok) throw new Error(`HTTP error ${res.status} fetching tools`);
    const data: any = await res.json();
    return data.tools || [];
  }

  private async httpCallTool(name: string, args: Record<string, any>): Promise<McpToolCallResult> {
    if (!this.config.url) throw new Error('No URL configured for HTTP MCP server');
    const res = await fetch(`${this.config.url}/tools/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.headers || {}),
      },
      body: JSON.stringify({ arguments: args }),
    });
    if (!res.ok) throw new Error(`HTTP error ${res.status} executing tool ${name}`);
    return (await res.json()) as McpToolCallResult;
  }
}
