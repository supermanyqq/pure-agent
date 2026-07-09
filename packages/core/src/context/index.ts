/**
 * Context Management — 上下文窗口管理模块。
 *
 * 提供消息历史的 token 估算、Turn 分组、工具结果预裁剪、LLM 摘要和压缩编排。
 *
 * 使用方式：
 * ```typescript
 * import { createContextManager } from '@pure-agent/core';
 * const ctx = createContextManager({ provider });
 * const result = await ctx.fitToWindow(messages, tools, { signal });
 * ```
 */

// 核心 API
export { createContextManager } from './trimmer.js';

// 脱敏
export { redactSensitiveText } from './redactor.js';

// Token 估算
export {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateToolDefinitions,
  estimateTotal,
  estimateMsgBudgetTokens,
  countMessageTokensExact,
  countMessagesTokensExact,
  countTokensBest,
} from './token-counter.js';

// 历史管理
export {
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
} from './history-manager.js';

// 工具预裁剪
export { pruneOldToolResults, pruneOldToolResults as pruneToolResults } from './tool-pruner.js';

// 摘要
export {
  SUMMARY_PREFIX,
  SUMMARY_END_MARKER,
  COMPRESSION_NOTE,
  SUMMARY_TEMPLATE_SECTIONS,
  COMPRESSED_SUMMARY_METADATA_KEY,
  formatSummary,
  stripSummaryPrefix,
  isContextSummaryContent,
  buildSummaryPrompt,
  serializeForSummary,
  computeSummaryBudget,
  buildFallbackSummary,
  createSummarizer,
} from './summarizer.js';

// 常量
export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_COMPLETION_RESERVE,
  DEEPSEEK_TOKENIZER_PROFILE,
} from './types.js';
