import { AcpTransport, MessageHandler } from '../protocol/transport.js';
import { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from '../protocol/types.js';

export class HttpAcpClientTransport implements AcpTransport {
  private messageHandlers: MessageHandler[] = [];
  private abortController = new AbortController();
  private isClosed = false;

  constructor(private readonly baseUrl: string) {}

  public onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  public send(message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): void {
    if (this.isClosed) return;
    const rpcUrl = new URL('/rpc', this.baseUrl).toString();

    fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: this.abortController.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP RPC failed with status ${res.status}`);
        }
        // If it's a request, the server responds directly with the JSON-RPC result/error
        if ('id' in message && message.id !== undefined && !('result' in message || 'error' in message)) {
          const json = await res.json();
          this.dispatchIncoming(json);
        }
      })
      .catch((err) => {
        if (!this.isClosed) {
          console.error('[HttpAcpClientTransport] send error:', err);
        }
      });
  }

  public async connect(): Promise<void> {
    const sseUrl = new URL('/events', this.baseUrl).toString();

    try {
      const response = await fetch(sseUrl, {
        headers: { Accept: 'text/event-stream' },
        signal: this.abortController.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`SSE connection failed with status ${response.status}`);
      }

      this.readSseStream(response.body);
    } catch (err) {
      if (!this.isClosed) {
        throw new Error(`Failed to connect to remote ACP agent at ${sseUrl}: ${err}`);
      }
    }
  }

  private async readSseStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (!this.isClosed) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) {
            const data = trimmed.slice(5).trim();
            if (data && data !== ': connected') {
              try {
                const parsed = JSON.parse(data);
                this.dispatchIncoming(parsed);
              } catch (e) {
                console.error('[HttpAcpClientTransport] JSON parse error in SSE stream:', e);
              }
            }
          }
        }
      }
    } catch (err) {
      if (!this.isClosed) {
        console.error('[HttpAcpClientTransport] SSE stream read error:', err);
      }
    }
  }

  private dispatchIncoming(message: any): void {
    if (this.isClosed || !message) return;
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (err) {
        console.error('[HttpAcpClientTransport] Handler error:', err);
      }
    }
  }

  public close(): void {
    this.isClosed = true;
    this.abortController.abort();
    this.messageHandlers = [];
  }
}
