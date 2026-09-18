import { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './types.js';

export type MessageHandler = (message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification) => void;

export interface AcpTransport {
  onMessage(handler: MessageHandler): void;
  send(message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): void;
  close?(): void | Promise<void>;
}
