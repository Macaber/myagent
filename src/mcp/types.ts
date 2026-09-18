export type McpTransportType = 'stdio' | 'sse' | 'http';

export interface McpServerConfig {
  id: string;
  name?: string;
  transport?: McpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, any>;
    required?: string[];
    [key: string]: any;
  };
}

export interface McpToolContentItem {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolCallResult {
  content: McpToolContentItem[];
  isError?: boolean;
}

export interface McpServerInfo {
  id: string;
  name: string;
  transport: McpTransportType;
  status: 'connected' | 'disconnected' | 'error';
  tools: string[];
  error?: string;
}

export interface McpConfigFile {
  mcpServers: Record<string, {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    transport?: McpTransportType;
  }>;
}
