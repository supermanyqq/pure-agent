export { createDeepSeekClient, collectStreamResponse } from './provider/index.js';
export type { DeepSeekClient, SendMessageParams, SendMessageResult, FinishReason, TokenUsage } from './types/provider.js';
export type { Message, ToolCall, ToolDefinition, AgentStatus, ToolResult, AgentOptions, TurnOutput, TurnStatus, ChatRequest, ChatProvider, ToolRegistry, ContextManager, AgentEventEmitter, AgentEventMap, StreamEvent } from './types/index.js';
export type { TrimResult, TrimOptions, TrimStatus, CompressionStats, Summarizer } from './types/index.js';
// Agent Loop 模块导出
export { AgentLoop } from './agent/loop.js';
export { StepBuilder, ContextWindowError } from './agent/step-builder.js';
export { ToolCallAccumulator } from './agent/tool-call-accumulator.js';
export { executeAll } from './agent/tool-executor.js';
export { LoopDetector } from './agent/loop-detector.js';

// Context Management 模块导出
export {
  createContextManager,
  redactSensitiveText,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateToolDefinitions,
  estimateTotal,
  estimateMsgBudgetTokens,
  countMessageTokensBpe,
  countMessagesTokensBpe,
  countTokensBestEffort,
  // 向后兼容别名
  countMessageTokensBpe as countMessageTokensExact,
  countMessagesTokensBpe as countMessagesTokensExact,
  countTokensBestEffort as countTokensBest,
  groupByTurns,
  getRecentTurns,
  getTurnCount,
  removeOldestTurns,
  getSystemTurn,
  hasSystemPrompt,
  alignBoundaryForward,
  alignBoundaryBackward,
  findLastUserMessageIdx,
  findLastAssistantMessageIdx,
  findTurnPairEnd,
  pruneOldToolResults,
  SUMMARY_PREFIX,
  SUMMARY_END_MARKER,
  COMPRESSION_NOTE,
  SUMMARY_TEMPLATE_SECTIONS,
  formatSummary,
  stripSummaryPrefix,
  isContextSummaryContent,
  buildSummaryPrompt,
  serializeForSummary,
  computeSummaryBudget,
  buildFallbackSummary,
  createSummarizer,
} from './context/index.js';

// Config
export type {
  CliConfig,
  ConfigFileOptions,
  ProviderConfig,
  ReasoningEffort,
  StoredConfig,
  StoredConfigSection,
} from './config/types.js';
export {
  getConfigFilePath,
  loadCliConfig,
  loadProviderConfig,
  readStoredConfig,
  redactApiKey,
  saveApiKey,
} from './config/loader.js';

// Tools
export { createEmptyToolRegistry } from './tools/empty-registry.js';

// Events
export { createConsoleEmitter } from './events/emitter.js';

// System Prompt
export { DEFAULT_SYSTEM_PROMPT, formatSystemPrompt } from './system-prompt.js';

// Tokenizer (DeepSeek V3 BPE — 实验性本地 BPE，未经官方 golden vectors 验证)
export {
  initTokenizer,
  encode,
  countTokens as countTokensBpe,
  decode,
  isInitialized as isTokenizerInitialized,
  loadTokenizerData,
} from './tokenizer/deepseek-tokenizer.js';
export { loadTokenizerFromFile } from './tokenizer/index.js';
export type { TokenizerData, BPEConfig } from './tokenizer/types.js';
