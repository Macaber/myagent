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
  // Composite key "transportIdx:id" — stdio id=1 and http id=1 must not collide.
  private requestOrigins = new Map<string, { transport: AcpTransport; id: JsonRpcId; addedAt: number }>();
  private transportIds = new WeakMap<AcpTransport, number>();
  private nextTransportId = 1;
  private static readonly ORIGIN_TTL_MS = 5 * 60 * 1000;

  constructor(private readonly transports: AcpTransport[]) {
    this.setupListeners();
  }

  public onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  public send(message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): void {
    // 1. If it's a response to a client request, route back to the originating transport only.
    // Unknown origins are dropped (never broadcast — responses may carry sensitive results).
    if ('id' in message && message.id !== undefined && !('method' in message)) {
      const key = this.findOriginKey(message.id);
      if (key) {
        const entry = this.requestOrigins.get(key)!;
        this.requestOrigins.delete(key);
        try {
          entry.transport.send(message);
        } catch (err) {
          console.error('[DualTransport] Error routing response to origin:', err);
        }
        return;
      }
      console.warn(`[DualTransport] Dropping response for unknown request id '${String(message.id)}'`);
      return;
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
    if (this.transports.includes(transport)) return;
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

  private transportIndex(transport: AcpTransport): number {
    let idx = this.transportIds.get(transport);
    if (idx === undefined) {
      idx = this.nextTransportId++;
      this.transportIds.set(transport, idx);
    }
    return idx;
  }

  private originKey(transport: AcpTransport, id: JsonRpcId): string {
    return `${this.transportIndex(transport)}:${String(id)}`;
  }

  private findOriginKey(id: JsonRpcId): string | undefined {
    const suffix = `:${String(id)}`;
    const matches: string[] = [];
    for (const key of this.requestOrigins.keys()) {
      if (key.endsWith(suffix)) matches.push(key);
    }
    if (matches.length > 1) {
      console.warn(`[DualTransport] Ambiguous response id '${String(id)}' across transports, dropping`);
      for (const k of matches) this.requestOrigins.delete(k);
      return undefined;
    }
    return matches[0];
  }

  private pruneOrigins(): void {
    const now = Date.now();
    for (const [key, entry] of this.requestOrigins) {
      if (now - entry.addedAt > DualTransport.ORIGIN_TTL_MS) {
        this.requestOrigins.delete(key);
      }
    }
    // Bound map size even under id flood
    if (this.requestOrigins.size > 1000) {
      const oldest = Array.from(this.requestOrigins.keys()).slice(0, this.requestOrigins.size - 1000);
      for (const k of oldest) this.requestOrigins.delete(k);
    }
  }

  private handleTransportMessage(
    transport: AcpTransport,
    message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification
  ): void {
    // If it's an incoming request from a client, remember its transport origin
    if ('id' in message && message.id !== undefined && 'method' in message) {
      this.pruneOrigins();
      this.requestOrigins.set(this.originKey(transport, message.id), {
        transport,
        id: message.id,
        addedAt: Date.now(),
      });
    }

    if (this.messageHandler) {
      this.messageHandler(message);
    }
  }
}
