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
  private static readonly MAX_LINE_BYTES = 4 * 1024 * 1024;
  private static readonly MAX_BUFFER_BYTES = 8 * 1024 * 1024;

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
      if (this.input === process.stdin) {
        try {
          process.stdin.pause?.();
        } catch {}
      }
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
    this.input.on('data', (chunk: any) => {
      const text = typeof chunk === 'string' ? chunk : String(chunk);
      this.buffer += text;
      if (this.buffer.length > StdioTransport.MAX_BUFFER_BYTES) {
        console.error('[StdioTransport] Buffer overflow without newline, dropping buffer');
        this.buffer = '';
        return;
      }
      let newlineIndex: number;
      while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
        const raw = this.buffer.slice(0, newlineIndex);
        const line = raw.trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          if (line.length > StdioTransport.MAX_LINE_BYTES) {
            console.error('[StdioTransport] Oversized line dropped');
            continue;
          }
          try {
            const parsed = JSON.parse(line);
            this.messageHandler?.(parsed);
          } catch (err) {
            // Best-effort PARSE_ERROR reply when an id can be recovered
            try {
              const idMatch = line.match(/"id"\s*:\s*("([^"]*)"|(\d+)|null)/);
              let id: any = null;
              if (idMatch) {
                if (idMatch[2] !== undefined) id = idMatch[2];
                else if (idMatch[3] !== undefined) id = Number(idMatch[3]);
              }
              this.send({ jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } } as any);
            } catch {}
            console.error('[StdioTransport] Failed to parse JSON-RPC line:', line.slice(0, 200));
          }
        }
      }
    });

    this.input.on('end', () => {
      this.close();
    });
  }
}
