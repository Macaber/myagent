import { AcpTransport } from './transport.js';
import {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcId,
  ACP_ERROR_CODES,
  AcpEventPayload,
  SessionNotification,
  SessionUpdateNotification,
  CancelRequestNotification,
  CompleteElicitationNotification,
} from './types.js';

export interface RpcContext {
  signal: AbortSignal;
}

export type RpcMethodHandler<TParams = any, TResult = any> = (
  params: TParams,
  context?: RpcContext
) => Promise<TResult> | TResult;

export type RpcNotificationHandler<TParams = any> = (
  params: TParams
) => Promise<void> | void;

export class RpcDispatcher {
  private methodHandlers = new Map<string, RpcMethodHandler>();
  private notificationHandlers = new Map<string, RpcNotificationHandler>();
  private pendingClientRequests = new Map<
    JsonRpcId,
    { resolve: (val: any) => void; reject: (err: any) => void; timer?: NodeJS.Timeout }
  >();
  private activeIncomingRequests = new Map<JsonRpcId, AbortController>();
  private nextRequestId = 1;

  constructor(private readonly transport: AcpTransport) {
    this.transport.onMessage((msg) => {
      this.handleIncomingMessage(msg).catch((err) => {
        console.error('[RpcDispatcher] Unhandled incoming message error:', err);
      });
    });

    // Built-in standard JSON-RPC cancellation notification: $/cancel_request
    this.registerNotification<CancelRequestNotification>('$/cancel_request', (params) => {
      if (params && params.id !== undefined) {
        const controller = this.activeIncomingRequests.get(params.id);
        if (controller) {
          controller.abort();
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

  public async callMethod<TParams = any, TResult = any>(
    method: string,
    params: TParams
  ): Promise<TResult> {
    const handler = this.methodHandlers.get(method);
    if (!handler) {
      throw new Error(`Method '${method}' not found`);
    }
    return handler(params);
  }

  public registerNotification<TParams>(
    method: string,
    handler: RpcNotificationHandler<TParams>
  ): void {
    this.notificationHandlers.set(method, handler);
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
   * Official ACP real-time update notification (session/update)
   */
  public emitSessionUpdate(payload: SessionNotification | SessionUpdateNotification): void {
    this.emitNotification('session/update', payload);
  }

  /**
   * Official ACP elicitation completion notification (elicitation/complete)
   */
  public emitCompleteElicitation(payload: CompleteElicitationNotification): void {
    this.emitNotification('elicitation/complete', payload);
  }

  /**
   * Protocol-level request cancellation notification ($/cancel_request)
   */
  public cancelPeerRequest(id: JsonRpcId): void {
    this.emitNotification('$/cancel_request', { id });
  }

  /**
   * Task-centric event notification (backward compatibility alias)
   */
  public emitTaskEvent(payload: AcpEventPayload): void {
    this.emitNotification('task/event', payload);
  }

  /**
   * Send a request to peer (e.g. session/request_permission, fs/*, terminal/*, elicitation/*) and await response
   */
  public async requestClient<TParams = any, TResult = any>(
    method: string,
    params: TParams,
    timeoutMs: number = 300000 // 5 minutes default for human approvals / file / terminal actions
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
        (timer as any)?.unref?.();
      }

      this.pendingClientRequests.set(id, { resolve, reject, timer });
      try {
        this.transport.send(request);
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pendingClientRequests.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Reject all pending client requests (transport close / shutdown).
   */
  public closePendingRequests(reason = 'Dispatcher closed'): void {
    for (const [id, pending] of this.pendingClientRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      try {
        pending.reject(new Error(reason));
      } catch {}
      this.pendingClientRequests.delete(id);
    }
    for (const [, controller] of this.activeIncomingRequests) {
      try {
        controller.abort();
      } catch {}
    }
    this.activeIncomingRequests.clear();
  }

  private async handleIncomingMessage(
    message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification
  ): Promise<void> {
    // 1. If it's a response to a request we sent to the peer
    if ('id' in message && ('result' in message || 'error' in message) && !('method' in message)) {
      const response = message as JsonRpcResponse;
      const pending = this.pendingClientRequests.get(response.id);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingClientRequests.delete(response.id);
        if (response.error) {
          const err: any = new Error(
            `RPC Error [${response.error.code}]: ${response.error.message}`
          );
          err.code = response.error.code;
          err.data = response.error.data;
          pending.reject(err);
        } else {
          pending.resolve(response.result);
        }
      } else {
        console.warn(`[RpcDispatcher] Unknown response id '${String(response.id)}' (no pending request)`);
      }
      return;
    }

    // 2. If it's an incoming Request from the peer
    if ('method' in message && 'id' in message) {
      const request = message as JsonRpcRequest;
      if ((request as any).jsonrpc !== undefined && (request as any).jsonrpc !== '2.0') {
        this.transport.send({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: ACP_ERROR_CODES.INVALID_REQUEST,
            message: `Unsupported jsonrpc version '${(request as any).jsonrpc}'`,
          },
        });
        return;
      }
      if (this.activeIncomingRequests.has(request.id)) {
        this.transport.send({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: ACP_ERROR_CODES.INVALID_REQUEST,
            message: `Duplicate request id '${String(request.id)}' is already in flight`,
          },
        });
        return;
      }
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
        const result = await handler(request.params, { signal: abortController.signal });
        this.transport.send({
          jsonrpc: '2.0',
          id: request.id,
          result: result ?? {},
        });
      } catch (err: any) {
        const isCancelled = abortController.signal.aborted || err?.name === 'AbortError';
        const code = isCancelled
          ? ACP_ERROR_CODES.REQUEST_CANCELLED
          : (err?.code ?? ACP_ERROR_CODES.INTERNAL_ERROR);
        const message = isCancelled
          ? 'Request cancelled'
          : err?.message || 'Internal error occurred';

        this.transport.send({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code,
            message,
            ...(err?.data !== undefined ? { data: err.data } : {}),
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
      const notifHandler = this.notificationHandlers.get(notification.method);
      if (notifHandler) {
        try {
          await notifHandler(notification.params);
        } catch (err) {
          console.error(`[RpcDispatcher] Error handling notification '${notification.method}':`, err);
        }
        return;
      }

      // Fallback: also check methodHandlers in case notification was registered as method
      const methodHandler = this.methodHandlers.get(notification.method);
      if (methodHandler) {
        try {
          await methodHandler(notification.params);
        } catch (err) {
          console.error(`[RpcDispatcher] Error handling notification '${notification.method}':`, err);
        }
      }
    }
  }
}

