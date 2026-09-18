import { Readable, Writable } from 'node:stream';
import { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './types.js';
import { AcpTransport, MessageHandler } from './transport.js';

export { MessageHandler };

/**
 * StdioTransport handles newline-delimited JSON-RPC messages over Readable and Writable streams.
 */
export class StdioTransport implements AcpTransport {
  private buffer = '';
  private isClosed = false;
  private messageHandler?: MessageHandler;

  constructor(
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout
  ) {
    this.setupInputListener();
  }

  public onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  public send(message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): void {
    if (this.isClosed) {
      return;
    }
    const payload = JSON.stringify(message) + '\n';
    try {
      this.output.write(payload);
    } catch {
      this.isClosed = true;
    }
  }

  public close(): void {
    this.isClosed = true;
    try {
      (this.input as any).pause?.();
      (this.input as any).removeAllListeners?.('data');
      (this.input as any).unref?.();
    } catch {}
  }

  private setupInputListener(): void {
    if (this.input === process.stdin) {
      try {
        process.stdin.resume?.();
      } catch {}
    }
    this.input.setEncoding('utf8');
    this.input.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          try {
            const parsed = JSON.parse(line);
            this.messageHandler?.(parsed);
          } catch (err) {
            console.error('[StdioTransport] Failed to parse JSON-RPC line:', line, err);
          }
        }
      }
    });

    this.input.on('end', () => {
      this.close();
    });
  }
}
