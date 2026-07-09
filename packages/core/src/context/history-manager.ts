/**
 * History Manager — 消息历史的分组和管理工具。
 *
 * 纯函数集合，不持有状态。提供按 Turn 分组、裁剪、查询的功能。
 *
 * Turn 边界识别规则：
 * - 如果第一条消息是 system，单独作为 Turn 0
 * - 每个 user 消息标志着一个新 Turn 的开始
 * - system prompt 不是必须的，没有则没有 Turn 0
 *
 * Turn 是原子裁剪单位 — 一个 Turn 内的消息必须完整保留或完整移除。
 */

import type { Message } from '../types/index.js';
import type { Turn } from './types.js';

// ===== Turn 分组 =====

export function groupByTurns(messages: Message[]): Turn[] {
  if (messages.length === 0) return [];

  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;
  let turnIndex = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // system 消息作为 Turn 0（仅限首位）
    if (i === 0 && msg.role === 'system') {
      turns.push({
        index: 0,
        messages: [msg],
        startOffset: 0,
        endOffset: 1,
      });
      continue;
    }

    // user 消息开始新 Turn
    if (msg.role === 'user') {
      if (currentTurn) {
        currentTurn.endOffset = i;
        turns.push(currentTurn);
      }
      turnIndex++;
      currentTurn = {
        index: turnIndex,
        messages: [msg],
        startOffset: i,
        endOffset: i + 1,
      };
      continue;
    }

    // 非 user 消息追加到当前 Turn
    if (currentTurn) {
      currentTurn.messages.push(msg);
      currentTurn.endOffset = i + 1;
    } else {
      // 在 system Turn 之后、第一个 user 之前不应有消息
      // 但如果有（如 coding session 的自动 tool 调用），创建 Turn 1
      turnIndex = 1;
      currentTurn = {
        index: turnIndex,
        messages: [msg],
        startOffset: i,
        endOffset: i + 1,
      };
    }
  }

  // 添加最后一个 Turn
  if (currentTurn) {
    currentTurn.endOffset = messages.length;
    turns.push(currentTurn);
  }

  return turns;
}

// ===== Turn 查询 =====

export function getRecentTurns(messages: Message[], n: number): Turn[] {
  const turns = groupByTurns(messages);
  const normalTurns = turns.filter((t) => t.index > 0);
  return normalTurns.slice(-n);
}

export function getTurnCount(messages: Message[]): number {
  const turns = groupByTurns(messages);
  return turns.filter((t) => t.index > 0).length;
}

// ===== Turn 操作 =====

export interface RemoveResult {
  kept: Message[];
  removed: Message[];
}

export function removeOldestTurns(messages: Message[], n: number): RemoveResult {
  if (n <= 0) return { kept: [...messages], removed: [] };

  const turns = groupByTurns(messages);
  const hasSystem = turns.length > 0 && turns[0].index === 0;
  const normalTurns = hasSystem ? turns.slice(1) : turns;

  if (n >= normalTurns.length) {
    const systemTurn = hasSystem ? turns[0] : null;
    return {
      kept: systemTurn ? [...systemTurn.messages] : [],
      removed: normalTurns.flatMap((t) => t.messages),
    };
  }

  const removed = normalTurns.slice(0, n).flatMap((t) => t.messages);
  const keptTurns = normalTurns.slice(n);
  const systemTurn = hasSystem ? turns[0] : null;

  return {
    kept: [
      ...(systemTurn ? systemTurn.messages : []),
      ...keptTurns.flatMap((t) => t.messages),
    ],
    removed,
  };
}

// ===== System prompt 查询 =====

export function getSystemTurn(messages: Message[]): Turn | null {
  const turns = groupByTurns(messages);
  if (turns.length > 0 && turns[0].index === 0) {
    return turns[0];
  }
  return null;
}

export function hasSystemPrompt(messages: Message[]): boolean {
  return messages.length > 0 && messages[0].role === 'system';
}

// ===== 边界对齐 =====

/**
 * 从指定索引向后对齐到 Turn 边界，跳过孤立的 tool 消息。
 * 当裁剪起点落在 tool 消息上时，向后滑动到下一个非 tool 消息。
 */
export function alignBoundaryForward(messages: Message[], startIdx: number): number {
  let idx = startIdx;
  while (idx < messages.length && messages[idx].role === 'tool') {
    idx++;
  }
  return idx;
}

/**
 * 从指定索引向前对齐到 Turn 边界，避免分割 tool_call/result 组。
 * 如果裁剪终点落在 tool 消息组中，向前走到包含它们的 assistant 消息前。
 */
export function alignBoundaryBackward(messages: Message[], endIdx: number): number {
  if (endIdx <= 0) return 0;
  if (endIdx >= messages.length) return Math.min(endIdx, messages.length);

  // 向前走，跳过连续的 tool 消息
  let check = endIdx - 1;
  while (check >= 0 && messages[check].role === 'tool') {
    check--;
  }

  // 如果落在了带 tool_calls 的 assistant 消息上，把整组包含进来
  if (check >= 0) {
    const msg = messages[check];
    if (
      msg.role === 'assistant' &&
      'toolCalls' in msg &&
      msg.toolCalls !== undefined &&
      msg.toolCalls.length > 0
    ) {
      return check;
    }
  }

  return endIdx;
}

// ===== 消息定位 =====

/**
 * 找到消息列表中最后一个真实 user 消息的索引。
 * 跳过 context summary 消息（以 SUMMARY_PREFIX 开头的内容）。
 */
export function findLastUserMessageIdx(
  messages: Message[],
  headEnd: number,
  isSummaryContent?: (content: string) => boolean,
): number {
  for (let i = messages.length - 1; i >= headEnd; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;

    // 如果提供了摘要检测函数，跳过摘要消息
    if (isSummaryContent && msg.content && isSummaryContent(msg.content)) {
      continue;
    }

    return i;
  }
  return -1;
}

/**
 * 找到消息列表中最后一个有可见文本的 assistant 消息索引。
 * 跳过仅含 tool_calls 无文本的 assistant 消息（用户看不到它们）。
 */
export function findLastAssistantMessageIdx(
  messages: Message[],
  headEnd: number,
): number {
  let lastAny = -1;
  for (let i = messages.length - 1; i >= headEnd; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    if (lastAny < 0) lastAny = i;
    if (msg.content && msg.content.trim()) return i;
  }
  return lastAny;
}

/**
 * 返回从 user_idx 开始的完整 turn-pair 的结束位置（exclusive）。
 * turn-pair = user → assistant → [tool results...]
 * 用于 Causal Coupling 守卫：当 user 无法拉入尾部时，
 * 将整个 pair 送入压缩区以保证语义完整性。
 */
export function findTurnPairEnd(messages: Message[], userIdx: number): number {
  const n = messages.length;
  let idx = userIdx + 1;
  if (idx >= n) return idx;
  if (messages[idx].role !== 'assistant') return idx;
  idx++;
  while (idx < n && messages[idx].role === 'tool') {
    idx++;
  }
  return idx;
}
