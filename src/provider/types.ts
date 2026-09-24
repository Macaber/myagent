export interface FunctionCallDefinition {
  name: string;
  arguments: string; // JSON string
}

export interface ToolCallItem {
  id: string;
  type: 'function';
  function: FunctionCallDefinition;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCallItem[];
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StreamDeltaChunk {
  type: 'content' | 'thought' | 'tool_call_delta' | 'usage' | 'done';
  deltaText?: string;
  thoughtText?: string;
  finishReason?: string;
  toolCallDelta?: {
    index: number;
    id?: string;
    name?: string;
    argumentsChunk?: string;
  };
  usage?: CompletionUsage;
}

export interface CompletionResult {
  content: string | null;
  toolCalls?: ToolCallItem[];
  usage: CompletionUsage;
  finishReason?: string;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string; // Default: 'https://api.openai.com/v1'
  model?: string;   // Default: 'gpt-4o'
  fallbackModel?: string;
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number; // Default: 3
}
