import { AcpTransport } from './transport.js';
import {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcId,
  ACP_ERROR_CODES,
  AcpEventPayload,
  SessionUpdateNotification,
  CancelRequestParams,
} from './types.js';

export type RpcMethodHandler<TParams = any, TResult = any> = (
  params: TParams
) => Promise<TResult> | TResult;

export class RpcDispatcher {
  private methodHandlers = new Map<string, RpcMethodHandler>();
  private pendingClientRequests = new Map<
    JsonRpcId,
    { resolve: (val: any) => void; reject: (err: any) => void; timer?: NodeJS.Timeout }
  >();
  private activeIncomingRequests = new Map<JsonRpcId, AbortController>();
  private nextRequestId = 1;

  constructor(private readonly transport: AcpTransport) {
    this.transport.onMessage((msg) => this.handleIncomingMessage(msg));

    // Built-in standard JSON-RPC cancellation handler: $/cancel_request
    this.registerMethod<CancelRequestParams, void>('$/cancel_request', (params) => {
      if (params && params.id) {
        const controller = this.activeIncomingRequests.get(params.id);
        if (controller) {
          controller.abort();
          this.activeIncomingRequests.delete(params.id);
        }
      }
    });
  }

  public registerMethod<TParams, TResult>(
    method: string,
    handler: RpcMethodHandler<TParams, TResult>
  ): void {
    this.methodHandlers.set(method, handler);
  }

  public emitNotification(method: string, params: any): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.transport.send(notification);
  }

  /**
   * Official ACP real-time update notification
   */
  public emitSessionUpdate(payload: SessionUpdateNotification): void {
    this.emitNotification('session/update', payload);
  }

  /**
   * Task-centric event notification (backward compatibility alias)
   */
  public emitTaskEvent(payload: AcpEventPayload): void {
    this.emitNotification('task/event', payload);
  }

  /**
   * Agent sends a request to Client (e.g. session/request_permission) and awaits response
   */
  public async requestClient<TParams = any, TResult = any>(
    method: string,
    params: TParams,
    timeoutMs: number = 300000 // 5 minutes default for human approvals
  ): Promise<TResult> {
    const id = `agent_req_${this.nextRequestId++}`;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<TResult>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pendingClientRequests.delete(id);
          reject(new Error(`ACP request '${method}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.pendingClientRequests.set(id, { resolve, reject, timer });
      this.transport.send(request);
    });
  }

  private async handleIncomingMessage(
    message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification
  ): Promise<void> {
    // 1. If it's a response to a request the Agent sent to the Client
    if ('id' in message && ('result' !== undefined || 'error' !== undefined) && !('method' in message)) {
      const response = message as JsonRpcResponse;
      const pending = this.pendingClientRequests.get(response.id);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingClientRequests.delete(response.id);
        if (response.error) {
          pending.reject(new Error(`RPC Error [${response.error.code}]: ${response.error.message}`));
        } else {
          pending.resolve(response.result);
        }
      }
      return;
    }

    // 2. If it's an incoming Request from the Client
    if ('method' in message && 'id' in message) {
      const request = message as JsonRpcRequest;
      const handler = this.methodHandlers.get(request.method);
      if (!handler) {
        this.transport.send({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: ACP_ERROR_CODES.METHOD_NOT_FOUND,
            message: `Method '${request.method}' not found`,
          },
        });
        return;
      }

      const abortController = new AbortController();
      this.activeIncomingRequests.set(request.id, abortController);

      try {
        const result = await handler(request.params);
        this.transport.send({
          jsonrpc: '2.0',
          id: request.id,
          result: result ?? null,
        });
      } catch (err: any) {
        this.transport.send({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: err.code || ACP_ERROR_CODES.INTERNAL_ERROR,
            message: err.message || 'Internal error occurred',
            data: err.data,
          },
        });
      } finally {
        this.activeIncomingRequests.delete(request.id);
      }
      return;
    }

    // 3. If it's an incoming Notification
    if ('method' in message && !('id' in message)) {
      const notification = message as JsonRpcNotification;
      const handler = this.methodHandlers.get(notification.method);
      if (handler) {
        try {
          await handler(notification.params);
        } catch (err) {
          console.error(`[RpcDispatcher] Error handling notification '${notification.method}':`, err);
        }
      }
    }
  }
}
