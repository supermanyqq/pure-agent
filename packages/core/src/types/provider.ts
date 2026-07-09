import type { Message, ToolCall, ToolDefinition, StreamEvent } from './index';

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'insufficient_system_resource';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SendMessageParams {
  model?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  thinking?: {
    type: 'enabled' | 'disabled';
    reasoning_effort?: 'high' | 'max';
  };
}

export interface SendMessageResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: TokenUsage;
}

export interface DeepSeekClient {
  streamMessage(params: SendMessageParams): AsyncGenerator<StreamEvent>;
}
