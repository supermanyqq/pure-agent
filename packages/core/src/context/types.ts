import type { Message, ToolDefinition } from '../types/index.js';

// ===== Turn =====

/** 一个完整的问答循环，是裁剪的原子单位 */
export interface Turn {
  /** Turn 在历史中的序号（从 1 开始，system Turn 为 0） */
  index: number;
  /** 属于这个 Turn 的消息 */
  messages: Message[];
  /** Turn 在完整历史中的起始偏移 */
  startOffset: number;
  /** Turn 在完整历史中的结束偏移（exclusive） */
  endOffset: number;
}

// ===== Token 估算 =====

export interface CharStats {
  cjk: number;
  latin: number;
  code: number;
  other: number;
}

export interface TokenizerProfile {
  latinCharsPerToken: number;
  cjkCharsPerToken: number;
  codeCharsPerToken: number;
  otherCharsPerToken: number;
}

export interface TokenEstimate {
  messageTokens: number;
  toolTokens: number;
  safetyMargin: number;
  total: number;
}

// ===== 工具裁剪 =====

export interface ToolPruneResult {
  messages: Message[];
  prunedCount: number;
  tokensSaved: number;
  duplicatesRemoved: number;
  summarizedCount: number;
}

// ===== ContextConfig =====

export interface ContextConfig {
  contextWindow: number;
  safetyMarginRatio: number;
  maxSafetyMargin: number;
  enableSummarization: boolean;
  abortOnSummaryFailure: boolean;
  minTurns: number;
  tailTokenBudget: number;
  maxSummaryTokens: number;
}

// ===== 常量 =====

export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const DEFAULT_COMPLETION_RESERVE = 4_096;
export const DEFAULT_SAFETY_MARGIN_RATIO = 0.1;
export const DEFAULT_MAX_SAFETY_MARGIN = 16_384;
export const DEFAULT_MIN_TURNS = 1;
export const DEFAULT_TAIL_BUDGET_RATIO = 0.2;
export const DEFAULT_MAX_SUMMARY_TOKENS = 12_000;
export const DEFAULT_PROTECT_FIRST_N = 3;
export const DEFAULT_PROTECT_LAST_N = 8;
export const DEFAULT_SUMMARY_TARGET_RATIO = 0.2;
export const MAX_INEFFECTIVE_COMPRESSIONS = 2;
export const MIN_SAVINGS_PERCENT = 10;
export const SUMMARY_FAILURE_COOLDOWN_MS = 600_000;

// Token 估算常量
export const LATIN_CHARS_PER_TOKEN = 4.0;
export const CJK_CHARS_PER_TOKEN = 1.5;
export const CODE_CHARS_PER_TOKEN = 3.0;
export const OTHER_CHARS_PER_TOKEN = 3.5;
export const MESSAGE_OVERHEAD_TOKENS = 4;
export const TOOL_CALL_STRUCTURE_OVERHEAD = 6;

// 工具裁剪常量
export const TOOL_CONTENT_TRUNCATE_HEAD_CHARS = 8_000;
export const MIN_TOOL_CONTENT_PRUNE_CHARS = 200;
export const MIN_TOOL_ARGS_TRUNCATE_CHARS = 500;

// 摘要常量
export const MIN_SUMMARY_TOKENS = 2_000;
export const SUMMARY_RATIO = 0.2;
export const SUMMARY_TOKENS_CEILING = 12_000;

// 尾部保护常量
export const TAIL_SOFT_CEILING_MULTIPLIER = 1.5;
export const TAIL_MIN_MESSAGE_FLOOR = 3;
export const MAX_TAIL_MESSAGE_FLOOR = 8;

// 回退摘要常量
export const FALLBACK_TURN_MAX_CHARS = 700;
export const FALLBACK_SUMMARY_MAX_CHARS = 8_000;

// 有效窗口常量
export const MIN_EFFECTIVE_WINDOW_TOKENS = 100;

// DeepSeek Profile
export const DEEPSEEK_TOKENIZER_PROFILE: TokenizerProfile = {
  latinCharsPerToken: LATIN_CHARS_PER_TOKEN,
  cjkCharsPerToken: CJK_CHARS_PER_TOKEN,
  codeCharsPerToken: CODE_CHARS_PER_TOKEN,
  otherCharsPerToken: OTHER_CHARS_PER_TOKEN,
};
