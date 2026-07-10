import type { Message, ToolCall, ToolDefinition, StreamEvent, FinishReason, TokenUsage } from './index';

// 重新导出共享类型，保持向后兼容
export type { FinishReason, TokenUsage };

export interface SendMessageParams {
  model?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  timeout?: number;
  maxRetries?: number;
  thinking?: { type: 'enabled' | 'disabled' };
  reasoningEffort?: 'high' | 'max';
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
