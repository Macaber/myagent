import { AcpTransport, MessageHandler } from '../protocol/transport.js';
import { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from '../protocol/types.js';

type RpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export class MemoryTransport implements AcpTransport {
  private peer?: MemoryTransport;
  private messageHandlers: MessageHandler[] = [];
  private closed = false;

  public setPeer(peer: MemoryTransport): void {
    this.peer = peer;
  }

  public onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  public send(message: RpcMessage): void {
    if (this.closed || !this.peer) return;
    const cloned = JSON.parse(JSON.stringify(message));
    queueMicrotask(() => {
      if (!this.peer || this.peer.closed) return;
      this.peer.dispatchIncoming(cloned);
    });
  }

  public dispatchIncoming(message: RpcMessage): void {
    if (this.closed) return;
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (err) {
        console.error('[MemoryTransport] Handler error:', err);
      }
    }
  }

  public close(): void {
    this.closed = true;
    this.messageHandlers = [];
  }
}

export function createMemoryTransportPair(): {
  clientTransport: MemoryTransport;
  serverTransport: MemoryTransport;
} {
  const clientTransport = new MemoryTransport();
  const serverTransport = new MemoryTransport();

  clientTransport.setPeer(serverTransport);
  serverTransport.setPeer(clientTransport);

  return { clientTransport, serverTransport };
}
