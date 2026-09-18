import { AcpTransport, MessageHandler } from './transport.js';
import { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification, JsonRpcId } from './types.js';

/**
 * DualTransport combines multiple AcpTransports (e.g. Stdio + HTTP/SSE).
 * - Routes requests from any transport to RpcDispatcher.
 * - Tracks which transport originated each request to route responses back precisely.
 * - Broadcasts notifications and session updates to all active transports.
 */
export class DualTransport implements AcpTransport {
  private messageHandler?: MessageHandler;
  private requestOrigins = new Map<JsonRpcId, AcpTransport>();

  constructor(private readonly transports: AcpTransport[]) {
    this.setupListeners();
  }

  public onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  public send(message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): void {
    // 1. If it's a response to a client request, route back to the originating transport
    if ('id' in message && message.id !== undefined && !('method' in message)) {
      const origin = this.requestOrigins.get(message.id);
      if (origin) {
        this.requestOrigins.delete(message.id);
        origin.send(message);
        return;
      }
    }

    // 2. Otherwise (notifications like session/update, task/event, or broadcasts), send to ALL transports
    for (const transport of this.transports) {
      try {
        transport.send(message);
      } catch (err) {
        console.error('[DualTransport] Error broadcasting to transport:', err);
      }
    }
  }

  public async close(): Promise<void> {
    for (const transport of this.transports) {
      try {
        await transport.close?.();
      } catch (err) {
        console.error('[DualTransport] Error closing transport:', err);
      }
    }
    this.requestOrigins.clear();
  }

  public addTransport(transport: AcpTransport): void {
    this.transports.push(transport);
    transport.onMessage((msg) => this.handleTransportMessage(transport, msg));
  }

  public getTransports(): AcpTransport[] {
    return [...this.transports];
  }

  private setupListeners(): void {
    for (const transport of this.transports) {
      transport.onMessage((msg) => this.handleTransportMessage(transport, msg));
    }
  }

  private handleTransportMessage(
    transport: AcpTransport,
    message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification
  ): void {
    // If it's an incoming request from a client, remember its transport origin
    if ('id' in message && message.id !== undefined && 'method' in message) {
      this.requestOrigins.set(message.id, transport);
    }

    if (this.messageHandler) {
      this.messageHandler(message);
    }
  }
}
