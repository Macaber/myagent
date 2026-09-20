import * as http from 'node:http';
import { AcpTransport, MessageHandler } from './transport.js';
import { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification, ACP_ERROR_CODES } from './types.js';
import { handleDashboardHttpRequest } from '../dashboard/dashboard-router.js';

export interface HttpTransportOptions {
  port?: number;
  host?: string;
  cors?: boolean;
}

export class HttpTransport implements AcpTransport {
  private server?: http.Server;
  private messageHandler?: MessageHandler;
  private sseClients = new Set<http.ServerResponse>();
  private pendingHttpResponses = new Map<string | number, http.ServerResponse>();
  private actualPort = 0;
  private isClosed = false;

  constructor(private readonly options: HttpTransportOptions = {}) {}

  public onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  public send(message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): void {
    if (this.isClosed) return;

    // 1. If it's a response to an HTTP POST request
    if ('id' in message && message.id !== undefined && !('method' in message)) {
      const res = this.pendingHttpResponses.get(message.id);
      if (res) {
        this.pendingHttpResponses.delete(message.id);
        if (!res.headersSent) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            ...(this.options.cors !== false ? { 'Access-Control-Allow-Origin': '*' } : {}),
          });
        }
        res.end(JSON.stringify(message));
        return;
      }
    }

    // 2. If it's a notification or event broadcast (or unsolicited agent request), stream to SSE clients
    const ssePayload = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(ssePayload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  public async start(): Promise<number> {
    const port = this.options.port ?? 0;
    const host = this.options.host ?? '127.0.0.1';

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(port, host, () => {
        const address = this.server?.address();
        if (address && typeof address === 'object') {
          this.actualPort = address.port;
        }
        resolve(this.actualPort);
      });
    });
  }

  public getPort(): number {
    return this.actualPort;
  }

  public async close(): Promise<void> {
    this.isClosed = true;

    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {}
    }
    this.sseClients.clear();

    for (const [, res] of this.pendingHttpResponses) {
      try {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server closing' }));
      } catch {}
    }
    this.pendingHttpResponses.clear();

    if (this.server) {
      try {
        this.server.closeAllConnections?.();
        this.server.closeIdleConnections?.();
      } catch {}
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = undefined;
    }
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.options.cors !== false) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // Dashboard & Telemetry API
    if (handleDashboardHttpRequest(req, res, url)) {
      return;
    }

    // GET /health
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        transport: 'http',
        port: this.actualPort,
        activeSseClients: this.sseClients.size,
      }));
      return;
    }

    // GET /events (Server-Sent Events)
    if (req.method === 'GET' && (url.pathname === '/events' || url.pathname === '/sse')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(': connected\n\n');
      this.sseClients.add(res);

      req.on('close', () => {
        this.sseClients.delete(res);
      });
      return;
    }

    // POST /rpc or POST /message
    if (req.method === 'POST' && (url.pathname === '/rpc' || url.pathname === '/message')) {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });

      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);

          // If request has an ID, keep HTTP response open until send(response) is called
          if ('id' in parsed && parsed.id !== undefined) {
            this.pendingHttpResponses.set(parsed.id, res);

            // If client aborts before response is sent
            res.on('close', () => {
              if (!res.writableEnded) {
                this.pendingHttpResponses.delete(parsed.id);
              }
            });
          } else {
            // Notification: return 202 Accepted immediately
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', status: 'accepted' }));
          }

          if (this.messageHandler) {
            this.messageHandler(parsed);
          } else {
            this.pendingHttpResponses.delete(parsed.id);
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              error: { code: ACP_ERROR_CODES.INTERNAL_ERROR, message: 'No message handler registered' },
            }));
          }
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: ACP_ERROR_CODES.PARSE_ERROR, message: `Parse error: ${err.message}` },
          }));
        }
      });
      return;
    }

    // 404 for unknown endpoints
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found. Use POST /rpc or GET /events' }));
  }
}
