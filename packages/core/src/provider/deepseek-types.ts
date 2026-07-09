/**
 * DeepSeek API 请求/响应类型（内部使用，不对外暴露）。
 *
 * 这些类型按 DeepSeek API 文档原样映射，字段名使用 snake_case 以匹配 API 格式。
 * 对外的 camelCase 类型定义在 core/src/types/provider.ts 中。
 */

export interface DeepSeekRequestBody {
  model: string;
  messages: DeepSeekMessage[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: DeepSeekToolDefinition[];
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  thinking?: { type: 'enabled' | 'disabled'; reasoning_effort?: 'high' | 'max' };
  response_format?: { type: 'text' | 'json_object' };
  stop?: string | string[];
  user_id?: string;
}

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: DeepSeekToolCall[];
  tool_call_id?: string;
}

export interface DeepSeekToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface DeepSeekToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface DeepSeekResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string;
      tool_calls?: DeepSeekToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    completion_tokens_details?: { reasoning_tokens: number };
  };
}

export interface DeepSeekStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'insufficient_system_resource';
