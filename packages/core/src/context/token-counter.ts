/**
 * Token 估算器 — 基于字符比率的 token 数近似估算。
 *
 * 不依赖 tiktoken 或任何 tokenizer 库。通过 CJK/Latin/Code/Other 字符分类 +
 * 经验比率估算 token 数。每种字符类型有不同的 chars-per-token 比率。
 *
 * 提供两种粒度的估算：
 * - estimateMessageTokens(): 精确估算（字符分类 + tool_calls 全量序列化）
 * - estimateMsgBudgetTokens(): 快速估算（chars/4 + overhead，用于尾部预算行走）
 */

import type { Message, ToolDefinition } from '../types/index.js';
import type { CharStats, TokenEstimate, TokenizerProfile } from './types.js';
import {
  LATIN_CHARS_PER_TOKEN,
  CJK_CHARS_PER_TOKEN,
  CODE_CHARS_PER_TOKEN,
  OTHER_CHARS_PER_TOKEN,
  MESSAGE_OVERHEAD_TOKENS,
  TOOL_CALL_STRUCTURE_OVERHEAD,
  DEEPSEEK_TOKENIZER_PROFILE,
} from './types.js';

// ===== 字符分类 =====

const CJK_RANGES: Array<[number, number]> = [
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0x3400, 0x4dbf], // CJK Extension A
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0x3000, 0x303f], // CJK Symbols and Punctuation
  [0xff00, 0xffef], // Halfwidth and Fullwidth Forms
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0xac00, 0xd7af], // Hangul Syllables
];

const CODE_SYMBOLS = new Set('{}[]()<>;:=+-*/&|^!.,?@#$%\'"\\`~');

function isCJK(cp: number): boolean {
  return CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function classifyChars(text: string): CharStats {
  let cjk = 0;
  let latin = 0;
  let code = 0;
  let other = 0;

  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;

    if (isCJK(cp)) {
      cjk++;
      continue;
    }

    if (CODE_SYMBOLS.has(ch)) {
      code++;
      continue;
    }

    // Basic Latin (printable) + whitespace
    if (
      (cp >= 0x0020 && cp <= 0x007e) ||
      cp === 0x0009 ||
      cp === 0x000a ||
      cp === 0x000d
    ) {
      latin++;
      continue;
    }

    // Extended Latin / accented / Cyrillic
    if (
      (cp >= 0x00a0 && cp <= 0x024f) ||
      (cp >= 0x0400 && cp <= 0x04ff) ||
      (cp >= 0x1e00 && cp <= 0x1eff)
    ) {
      latin++;
      continue;
    }

    other++;
  }

  return { cjk, latin, code, other };
}

// ===== Token 估算核心 =====

function estimateTextTokens(text: string, profile: TokenizerProfile): number {
  const stats = classifyChars(text);

  const tokens =
    stats.latin / profile.latinCharsPerToken +
    stats.cjk / profile.cjkCharsPerToken +
    stats.code / profile.codeCharsPerToken +
    stats.other / profile.otherCharsPerToken;

  // 每条消息至少计 1 token
  return Math.max(1, Math.ceil(tokens));
}

// ===== 单条消息估算 =====

/**
 * 精确估算单条消息的 token 数，包括 role/结构开销。
 *
 * 对 assistant 消息的 tool_calls 遍历所有字段（id、name、arguments）做全量估算，
 * 而非仅统计 arguments 字符串。
 */
export function estimateMessageTokens(
  message: Message,
  profile: TokenizerProfile = DEEPSEEK_TOKENIZER_PROFILE,
): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS;

  if (message.content) {
    tokens += estimateTextTokens(message.content, profile);
  }

  if (message.role === 'assistant' && 'toolCalls' in message && message.toolCalls) {
    for (const tc of message.toolCalls) {
      tokens += estimateTextTokens(tc.id, profile);
      tokens += estimateTextTokens(tc.function.name, profile);
      tokens += estimateTextTokens(tc.function.arguments, profile);
      tokens += TOOL_CALL_STRUCTURE_OVERHEAD;
    }
  }

  return tokens;
}

// ===== 消息列表估算 =====

export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

// ===== 工具定义估算 =====

/**
 * 估算工具定义的 token 数。
 * DeepSeek/OpenAI API 将 tools 序列化到 prompt 中，多工具场景可能占几千 tokens。
 */
export function estimateToolDefinitions(tools: ToolDefinition[]): number {
  if (!tools || tools.length === 0) return 0;
  const serialized = JSON.stringify(tools);
  return estimateTextTokens(serialized, DEEPSEEK_TOKENIZER_PROFILE);
}

// ===== 总估算 =====

export interface EstimateTotalOptions {
  safetyMarginRatio?: number;
  maxSafetyMargin?: number;
}

export function estimateTotal(
  messages: Message[],
  tools: ToolDefinition[],
  options: EstimateTotalOptions = {},
): TokenEstimate {
  const safetyMarginRatio = options.safetyMarginRatio ?? 0.1;
  const maxSafetyMargin = options.maxSafetyMargin ?? 16_384;

  const messageTokens = estimateMessagesTokens(messages);
  const toolTokens = estimateToolDefinitions(tools);
  const contentTokens = messageTokens + toolTokens;

  const safetyMargin = Math.min(
    Math.ceil(contentTokens * safetyMarginRatio),
    maxSafetyMargin,
  );

  return {
    messageTokens,
    toolTokens,
    safetyMargin,
    total: contentTokens + safetyMargin,
  };
}

// ===== 快速预算估算（用于尾部保护行走） =====

/**
 * 快速估算单条消息的 token 数，用于尾部保护 token 预算行走。
 *
 * 使用简化的 chars/4 比率（不分字符类型），但对 assistant 消息的
 * tool_calls 做全量序列化估算以避免严重低估并行多工具调用。
 */
export function estimateMsgBudgetTokens(message: Message): number {
  const contentLength =
    typeof message.content === 'string' ? message.content.length : 0;
  let tokens = Math.ceil(contentLength / 4) + MESSAGE_OVERHEAD_TOKENS;

  if (message.role === 'assistant' && 'toolCalls' in message && message.toolCalls) {
    for (const tc of message.toolCalls) {
      const tcLength =
        tc.id.length +
        tc.function.name.length +
        tc.function.arguments.length +
        50; // JSON 结构开销（chars）
      tokens += Math.ceil(tcLength / 4);
    }
  }

  return tokens;
}
