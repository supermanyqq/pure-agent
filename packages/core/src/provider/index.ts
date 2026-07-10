export { createDeepSeekClient, collectStreamResponse } from './deepseek-client.js';
export type { DeepSeekClient, SendMessageParams, SendMessageResult, FinishReason, TokenUsage } from '../types/provider.js';
export type { StreamEvent } from '../types/index.js';
export { ProviderError, HttpError, HttpAbortError, SSEParseError, IncompleteStreamError, ApiError } from './errors.js';
