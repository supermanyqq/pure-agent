/**
 * Trimmer — 上下文窗口裁剪与摘要引擎。
 *
 * 有状态类，实现 ContextManager 接口。编排 Phase 1-4 的完整压缩管线。
 *
 * 持有状态：
 * - compressionCount / lastSavingsPercent / ineffectiveCompressionCount（反抖动）
 * - previousSummary（迭代摘要）
 * - summaryFailureCooldownUntil（cooldown）
 * - effectiveProtectFirstN（衰减）
 * - compressionInProgress（重入检测）
 */

import type { Message, ToolDefinition, ToolCall } from '../types/index.js';
import type { ContextManager, TrimResult, TrimOptions, CompressionStats, Summarizer } from '../types/index.js';
import { ContextWindowError } from '../types/index.js';
import type { ContextConfig } from './types.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_COMPLETION_RESERVE,
  DEFAULT_SAFETY_MARGIN_RATIO,
  DEFAULT_MAX_SAFETY_MARGIN,
  DEFAULT_PROTECT_FIRST_N,
  DEFAULT_PROTECT_LAST_N,
  DEFAULT_TAIL_BUDGET_RATIO,
  DEFAULT_MAX_SUMMARY_TOKENS,
  MAX_INEFFECTIVE_COMPRESSIONS,
  MIN_SAVINGS_PERCENT,
  SUMMARY_FAILURE_COOLDOWN_MS,
  MIN_EFFECTIVE_WINDOW_TOKENS,
  TOOL_CONTENT_TRUNCATE_HEAD_CHARS,
  TAIL_SOFT_CEILING_MULTIPLIER,
  TAIL_MIN_MESSAGE_FLOOR,
  MAX_TAIL_MESSAGE_FLOOR,
} from './types.js';
import { estimateTotal, estimateMessagesTokens, estimateMsgBudgetTokens } from './token-counter.js';
import {
  groupByTurns,
  getSystemTurn,
  alignBoundaryForward,
  alignBoundaryBackward,
  findLastUserMessageIdx,
  findLastAssistantMessageIdx,
  findTurnPairEnd,
} from './history-manager.js';
import { pruneOldToolResults } from './tool-pruner.js';
import {
  serializeForSummary,
  buildSummaryPrompt,
  computeSummaryBudget,
  formatSummary,
  stripSummaryPrefix,
  isContextSummaryContent,
  buildFallbackSummary,
  COMPRESSION_NOTE,
  MERGED_PRIOR_CONTEXT_HEADER,
  MERGED_SUMMARY_DELIMITER,
  SUMMARY_END_MARKER,
  COMPRESSED_SUMMARY_METADATA_KEY,
  createSummarizer,
} from './summarizer.js';
import type { ChatProvider } from '../types/index.js';

const SUMMARY_EMPTY_CONTENT_COOLDOWN_MS = 60_000;

// ===== 工厂函数 =====

export interface CreateContextManagerOptions {
  summarizer?: Summarizer;
  provider?: ChatProvider;
  config?: Partial<ContextConfig>;
}

export function createContextManager(options: CreateContextManagerOptions = {}): ContextManager {
  const summarizer = options.summarizer ?? (
    options.provider ? createSummarizer(options.provider) : undefined
  );
  return new Trimmer(summarizer, options.config);
}

// ===== ContextConfig 默认值 =====

function defaultConfig(): ContextConfig {
  return {
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    safetyMarginRatio: DEFAULT_SAFETY_MARGIN_RATIO,
    maxSafetyMargin: DEFAULT_MAX_SAFETY_MARGIN,
    enableSummarization: true,
    abortOnSummaryFailure: false,
    minTurns: 1,
    tailTokenBudget: Math.ceil(DEFAULT_CONTEXT_WINDOW * DEFAULT_TAIL_BUDGET_RATIO),
    maxSummaryTokens: DEFAULT_MAX_SUMMARY_TOKENS,
  };
}

// ===== Trimmer 实现 =====

class Trimmer implements ContextManager {
  private readonly config: ContextConfig;
  private compressionCount = 0;
  private lastSavingsPercent = 100;
  private ineffectiveCompressionCount = 0;
  private lastCompressAborted = false;

  private previousSummary: string | undefined;
  private summaryFailureCooldownUntil = 0;
  private effectiveProtectFirstN: number;
  private lastSummaryError: string | undefined;
  private compressionInProgress = false;

  constructor(
    private readonly summarizer?: Summarizer,
    configOverride?: Partial<ContextConfig>,
  ) {
    this.config = { ...defaultConfig(), ...configOverride };
    this.effectiveProtectFirstN = DEFAULT_PROTECT_FIRST_N;
  }

  // ===== 公共 API =====

  async fitToWindow(
    messages: Message[],
    tools: ToolDefinition[],
    options: TrimOptions = {},
  ): Promise<TrimResult> {
    const {
      completionReserve = DEFAULT_COMPLETION_RESERVE,
      enableSummarization = this.config.enableSummarization,
      signal,
      force = false,
    } = options;

    // 重入检测：如果已有压缩进行中，返回原消息
    if (this.compressionInProgress) {
      return this.unchangedResult(messages);
    }

    // force 参数绕过 cooldown（手动 /compress）
    if (force) {
      this.summaryFailureCooldownUntil = 0;
      this.ineffectiveCompressionCount = 0;
    }

    // 1. 计算有效窗口
    const rawEffective = messages.length > 0
      ? this.config.contextWindow - completionReserve -
        Math.min(
          Math.ceil(estimateMessagesTokens(messages) * this.config.safetyMarginRatio),
          this.config.maxSafetyMargin,
        )
      : this.config.contextWindow - completionReserve;

    // 有效窗口为负时回退到 contextWindow * 0.5
    const effectiveWindow = rawEffective > 0
      ? rawEffective
      : Math.max(MIN_EFFECTIVE_WINDOW_TOKENS, Math.ceil(this.config.contextWindow * 0.5));

    // 2. 空消息快速返回
    if (messages.length === 0) {
      return this.makeResult(messages, 0, 0, false, 0, 'unchanged');
    }

    // 3. 估算当前 token
    const currentEstimate = estimateTotal(messages, tools);

    // 4. 未超限，直接返回
    if (currentEstimate.total <= effectiveWindow) {
      return this.makeResult(
        messages, 0, 0, false,
        currentEstimate.total, 'unchanged',
      );
    }

    // 5. 检查 system prompt 是否就超限
    const systemTurn = getSystemTurn(messages);
    if (systemTurn) {
      const systemTokens = estimateMessagesTokens(systemTurn.messages);
      if (systemTokens > effectiveWindow) {
        throw new ContextWindowError(
          `System prompt alone (${systemTokens} tokens) exceeds context window (${effectiveWindow} tokens)`,
          systemTokens,
          effectiveWindow,
        );
      }
    }

    // 6. 检查最小消息数
    const headSize = this.protectHeadSize(messages);
    const minForCompress = headSize + 4;
    if (messages.length <= minForCompress) {
      const truncated = this.truncateOversizedToolMessages(messages, effectiveWindow, tools);
      const newEstimate = estimateTotal(truncated, tools);
      return this.makeResult(
        truncated, 0, 0, false,
        newEstimate.total,
        truncated.length < messages.length ? 'pruned_only' : 'unchanged',
      );
    }

    // 7. 反抖动检查
    if (this.ineffectiveCompressionCount >= MAX_INEFFECTIVE_COMPRESSIONS) {
      return this.makeResult(
        messages, 0, 0, false,
        currentEstimate.total, 'skipped_thrashing',
        'Compression skipped — last 2 compressions saved <10% each. Consider /new or /compress <topic>.',
      );
    }

    // ===== Phase 1: 工具结果预裁剪 =====
    const { messages: prunedMessages, prunedCount } = pruneOldToolResults(messages, {
      protectTailCount: DEFAULT_PROTECT_LAST_N,
      protectTailTokens: this.config.tailTokenBudget,
    });

    let workingMessages = prunedMessages;

    // ===== Phase 2: 确定裁剪边界 =====
    const compressStart = alignBoundaryForward(workingMessages, headSize);
    const compressEnd = this.findTailCutByTokens(workingMessages, compressStart);

    // 无可压缩区域 — 不计入反抖动（未执行压缩，只是边界收缩）
    if (compressStart >= compressEnd) {
      this.lastSavingsPercent = 0;
      const newEstimate = estimateTotal(workingMessages, tools);
      return this.makeResult(
        workingMessages, 0, prunedCount, false,
        newEstimate.total,
        prunedCount > 0 ? 'pruned_only' : 'unchanged',
      );
    }

    const turnsToSummarize = workingMessages.slice(compressStart, compressEnd);

    // ===== Phase 3: LLM 摘要 =====
    let summary: string | undefined;
    let summarized = false;
    let trimStatus: TrimResult['status'] = 'summarized';

    if (enableSummarization && this.summarizer) {
      const now = Date.now();
      if (now < this.summaryFailureCooldownUntil) {
        // 在 cooldown 中，使用回退摘要
        summary = buildFallbackSummary(turnsToSummarize, 'summary LLM in cooldown');
        summarized = true;
        trimStatus = 'fallback_summary';
      } else {
        // 标记压缩进行中（重入检测）
        this.compressionInProgress = true;
        try {
          if (signal?.aborted) {
            // abort 时不丢弃 turn — 使用回退摘要
            summary = buildFallbackSummary(turnsToSummarize, 'aborted by user');
            summarized = true;
            trimStatus = 'fallback_summary';
          } else {
            const serialized = serializeForSummary(turnsToSummarize);
            const budget = computeSummaryBudget(
              estimateMessagesTokens(turnsToSummarize),
              this.config.maxSummaryTokens,
            );

            const prompt = buildSummaryPrompt({
              contentToSummarize: serialized,
              summaryBudget: budget,
              previousSummary: this.previousSummary,
              focusTopic: options.focusTopic,
            });

            const summaryBody = await this.summarizer.summarize(
              [{ role: 'user', content: prompt }],
              { signal, previousSummary: this.previousSummary, summaryBudget: budget },
            );

            if (summaryBody.summary && summaryBody.summary.trim()) {
              summary = formatSummary(summaryBody.summary);
              this.previousSummary = stripSummaryPrefix(summaryBody.summary);
              summarized = true;
              this.summaryFailureCooldownUntil = 0;
              this.lastSummaryError = undefined;
            } else {
              // 空内容 → 视为失败
              summary = buildFallbackSummary(turnsToSummarize, 'LLM returned empty summary');
              summarized = true;
              trimStatus = 'fallback_summary';
              this.summaryFailureCooldownUntil = Date.now() + SUMMARY_EMPTY_CONTENT_COOLDOWN_MS;
              this.lastSummaryError = 'LLM returned empty summary';
            }
          }
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            // abort 时不丢弃 — 使用回退摘要
            summary = buildFallbackSummary(turnsToSummarize, 'aborted');
            summarized = true;
            trimStatus = 'fallback_summary';
          } else if (this.isAuthError(err)) {
            // Auth 失败 → 中止压缩，保留原始消息
            this.lastCompressAborted = true;
            this.lastSummaryError = String(err);
            this.compressionInProgress = false;
            return this.makeResult(
              messages, 0, 0, false,
              currentEstimate.total, 'aborted_auth_error',
              'Summary generation failed with auth error — check credentials.',
            );
          } else if (this.isNetworkError(err)) {
            // Network 失败 → 中止压缩
            this.lastCompressAborted = true;
            this.lastSummaryError = String(err);
            this.compressionInProgress = false;
            return this.makeResult(
              messages, 0, 0, false,
              currentEstimate.total, 'aborted_network_error',
              'Summary generation failed with network error — retry with /compress.',
            );
          } else {
            // 其他错误 → cooldown + 回退摘要
            const reason = err instanceof Error ? err.message : String(err);
            summary = buildFallbackSummary(turnsToSummarize, reason);
            summarized = true;
            trimStatus = 'fallback_summary';
            this.summaryFailureCooldownUntil = Date.now() + SUMMARY_FAILURE_COOLDOWN_MS;
            this.lastSummaryError = reason;
          }
        } finally {
          this.compressionInProgress = false;
        }
      }
    }

    // ===== Phase 4: 组装压缩后消息列表 =====
    const compressed = this.assembleCompressedMessages(
      workingMessages,
      compressStart,
      compressEnd,
      summary,
      summarized,
    );

    // 清理孤立 tool pair
    const sanitized = this.sanitizeToolPairs(compressed);

    // 更新统计
    this.compressionCount++;
    this.effectiveProtectFirstN = 0; // 首次压缩后衰减

    const newEstimate = estimateTotal(sanitized, tools);
    const tokensSaved = currentEstimate.total - newEstimate.total;
    const savingsPercent =
      currentEstimate.total > 0
        ? (tokensSaved / currentEstimate.total) * 100
        : 0;

    this.lastSavingsPercent = savingsPercent;

    if (savingsPercent < MIN_SAVINGS_PERCENT) {
      this.ineffectiveCompressionCount++;
    } else {
      this.ineffectiveCompressionCount = 0;
    }

    return {
      messages: sanitized,
      removedTurns: groupByTurns(turnsToSummarize).length,
      removedMessageCount: turnsToSummarize.length,
      summarized: summarized && !!summary,
      summary,
      estimatedTokens: newEstimate.total,
      tokensSaved,
      status: trimStatus,
    };
  }

  estimateTokens(messages: Message[], tools?: ToolDefinition[]): number {
    if (tools && tools.length > 0) {
      return estimateTotal(messages, tools).total;
    }
    return estimateMessagesTokens(messages);
  }

  getCompressionStats(): CompressionStats {
    return {
      compressionCount: this.compressionCount,
      lastSavingsPercent: this.lastSavingsPercent,
      ineffectiveCompressionCount: this.ineffectiveCompressionCount,
      lastCompressAborted: this.lastCompressAborted,
      summaryInCooldown: Date.now() < this.summaryFailureCooldownUntil,
    };
  }

  reset(): void {
    this.compressionCount = 0;
    this.lastSavingsPercent = 100;
    this.ineffectiveCompressionCount = 0;
    this.lastCompressAborted = false;
    this.previousSummary = undefined;
    this.summaryFailureCooldownUntil = 0;
    this.effectiveProtectFirstN = DEFAULT_PROTECT_FIRST_N;
    this.lastSummaryError = undefined;
  }

  /** 模型切换时更新上下文长度并清除追踪状态 */
  updateModel(_model: string, contextLength: number): void {
    this.config.contextWindow = contextLength;
    this.config.tailTokenBudget = Math.ceil(contextLength * DEFAULT_TAIL_BUDGET_RATIO);
    this.ineffectiveCompressionCount = 0;
    this.lastSavingsPercent = 100;
  }

  // ===== 内部方法 =====

  private protectHeadSize(messages: Message[]): number {
    let head = 0;
    if (messages.length > 0 && messages[0].role === 'system') {
      head = 1;
    }
    return head + this.effectiveProtectFirstN;
  }

  private findTailCutByTokens(messages: Message[], headEnd: number): number {
    const tokenBudget = this.config.tailTokenBudget;
    const n = messages.length;

    const availableTail = Math.max(0, n - headEnd - 1);
    const minTailFloor = Math.max(TAIL_MIN_MESSAGE_FLOOR, Math.min(DEFAULT_PROTECT_LAST_N, MAX_TAIL_MESSAGE_FLOOR));
    const compressibleTailCap = Math.max(3, availableTail - 2);
    const minTail =
      availableTail > 1
        ? Math.min(minTailFloor, compressibleTailCap, availableTail)
        : 0;

    const softCeiling = Math.ceil(tokenBudget * TAIL_SOFT_CEILING_MULTIPLIER);
    let accumulated = 0;
    let cutIdx = n;

    for (let i = n - 1; i >= headEnd; i--) {
      const msgTokens = estimateMsgBudgetTokens(messages[i]);
      if (accumulated + msgTokens > softCeiling && n - i >= minTail) {
        break;
      }
      accumulated += msgTokens;
      cutIdx = i;
    }

    // 整个可压缩区域在 soft ceiling 内 → 用原始预算重走
    if (cutIdx <= headEnd && accumulated <= softCeiling && accumulated > 0) {
      let rawAccumulated = 0;
      for (let j = n - 1; j >= headEnd; j--) {
        const rawTokens = estimateMsgBudgetTokens(messages[j]);
        if (rawAccumulated + rawTokens > tokenBudget && n - j >= minTail) {
          cutIdx = j;
          break;
        }
        rawAccumulated += rawTokens;
        cutIdx = j;
      }
    }

    // 确保至少保留 minTail 条消息
    const fallbackCut = n - minTail;
    cutIdx = Math.min(cutIdx, fallbackCut);

    if (cutIdx <= headEnd) {
      cutIdx = Math.max(fallbackCut, headEnd + 1);
    }

    // 对齐：不切割 tool_call/result 组
    cutIdx = alignBoundaryBackward(messages, cutIdx);

    // Causal Coupling：确保最后 user 消息在尾部
    cutIdx = this.ensureLastUserMessageInTail(messages, cutIdx, headEnd);

    // 确保最后 assistant 消息在尾部
    cutIdx = this.ensureLastAssistantMessageInTail(messages, cutIdx, headEnd);

    return Math.max(cutIdx, headEnd + 1);
  }

  /**
   * Causal Coupling 守卫（hermes-agent #22523）。
   * 当最后 user 消息恰好位于 headEnd 边界时，将整个 turn-pair 送入压缩区。
   */
  private ensureLastUserMessageInTail(
    messages: Message[],
    cutIdx: number,
    headEnd: number,
  ): number {
    const lastUserIdx = findLastUserMessageIdx(
      messages, headEnd, isContextSummaryContent,
    );
    if (lastUserIdx < 0) return cutIdx;
    if (lastUserIdx >= cutIdx) return cutIdx;

    const adjusted = Math.max(lastUserIdx, headEnd + 1);
    if (adjusted > lastUserIdx) {
      // user 在 head 内 → 整个 pair 送入压缩区
      const pairEnd = findTurnPairEnd(messages, lastUserIdx);
      return Math.max(pairEnd, headEnd + 1);
    }
    return adjusted;
  }

  /**
   * 确保最后可见 assistant 消息在尾部（hermes-agent #29824）。
   */
  private ensureLastAssistantMessageInTail(
    messages: Message[],
    cutIdx: number,
    headEnd: number,
  ): number {
    const lastAsstIdx = findLastAssistantMessageIdx(messages, headEnd);
    if (lastAsstIdx < 0) return cutIdx;
    if (lastAsstIdx >= cutIdx) return cutIdx;

    const newCut = alignBoundaryBackward(messages, lastAsstIdx);
    return Math.max(newCut, headEnd + 1);
  }

  /**
   * 组装压缩后的消息列表。包含摘要 role 选择逻辑。
   */
  private assembleCompressedMessages(
    messages: Message[],
    compressStart: number,
    compressEnd: number,
    summary: string | undefined,
    summarized: boolean,
  ): Message[] {
    const n = messages.length;
    const compressed: Message[] = [];

    // 头部消息：扫描整个 head 区域找 system 消息（不假设一定在 index 0）
    let summaryMerged = false;
    for (let i = 0; i < compressStart; i++) {
      const msg = { ...messages[i] };
      if (!summaryMerged && msg.role === 'system' && summary && summarized) {
        const existing = msg.content;
        if (!existing.includes(COMPRESSION_NOTE)) {
          msg.content = existing
            ? `${existing}\n\n${COMPRESSION_NOTE}\n\n${summary}`
            : `${COMPRESSION_NOTE}\n\n${summary}`;
        }
        summaryMerged = true;
      }
      compressed.push(msg);
    }

    if (summary && summarized) {
      // 摘要 role 选择
      const lastHeadRole =
        compressStart > 0 ? messages[compressStart - 1].role : 'user';
      const firstTailRole =
        compressEnd < n ? messages[compressEnd].role : 'user';

      // 当头部只有 system 时，摘要必须为 user
      const forceUserLeading = lastHeadRole === 'system';

      // Zero-user-turn guard：检查 head + tail 中是否有 user
      let userSurvives = forceUserLeading;
      if (!userSurvives) {
        userSurvives =
          messages.slice(0, compressStart).some((m) => m.role === 'user') ||
          messages.slice(compressEnd).some((m) => m.role === 'user');
      }

      let summaryRole: 'user' | 'assistant' = forceUserLeading || !userSurvives
        ? 'user'
        : lastHeadRole === 'assistant' || lastHeadRole === 'tool'
          ? 'user'
          : 'assistant';

      let mergeIntoFirstTail = false;

      // 如果 role 与 tail 第一条撞了
      if (summaryRole === firstTailRole) {
        const flipped: 'user' | 'assistant' =
          summaryRole === 'user' ? 'assistant' : 'user';
        if (flipped !== lastHeadRole && !forceUserLeading) {
          summaryRole = flipped;
        } else {
          mergeIntoFirstTail = true;
        }
      }

      if (mergeIntoFirstTail) {
        // 摘要合并到第一条 tail 消息
        const tailMsg = { ...messages[compressEnd] };
        const oldContent = typeof tailMsg.content === 'string' ? tailMsg.content : '';
        tailMsg.content =
          MERGED_PRIOR_CONTEXT_HEADER + '\n' +
          oldContent + '\n\n' +
          MERGED_SUMMARY_DELIMITER + '\n\n' +
          summary + '\n\n' +
          SUMMARY_END_MARKER;
        (tailMsg as Record<string, unknown>)[COMPRESSED_SUMMARY_METADATA_KEY] = true;
        compressed.push(tailMsg);

        // 添加剩余尾部消息（跳过第一条）
        for (let i = compressEnd + 1; i < n; i++) {
          compressed.push({ ...messages[i] });
        }
      } else {
        // 独立摘要消息
        compressed.push({
          role: summaryRole,
          content: summary + '\n\n' + SUMMARY_END_MARKER,
          [COMPRESSED_SUMMARY_METADATA_KEY]: true,
        } as unknown as Message);

        // 尾部消息
        for (let i = compressEnd; i < n; i++) {
          compressed.push({ ...messages[i] });
        }
      }
    } else {
      // 无摘要 — 直接追加尾部
      for (let i = compressEnd; i < n; i++) {
        compressed.push({ ...messages[i] });
      }
    }

    return compressed;
  }

  /**
   * 修复压缩后产生的孤立 tool_call / tool_result 对。
   */
  private sanitizeToolPairs(messages: Message[]): Message[] {
    const survivingCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && 'toolCalls' in msg && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (tc.id) survivingCallIds.add(tc.id);
        }
      }
    }

    const resultCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolCallId) {
        resultCallIds.add(msg.toolCallId);
      }
    }

    // 移除没有对应 assistant tool_call 的孤立 tool result
    const orphanedResults = new Set(
      [...resultCallIds].filter((id) => !survivingCallIds.has(id)),
    );

    let result = messages;
    if (orphanedResults.size > 0) {
      result = result.filter(
        (m) => !(m.role === 'tool' && orphanedResults.has(m.toolCallId)),
      );
    }

    // 从 assistant 消息中移除没有对应 tool result 的孤立 tool_call
    const missingResults = new Set(
      [...survivingCallIds].filter((id) => !resultCallIds.has(id)),
    );

    if (missingResults.size > 0) {
      result = result.map((msg) => {
        if (msg.role !== 'assistant' || !('toolCalls' in msg) || !msg.toolCalls) {
          return msg;
        }
        const kept = msg.toolCalls.filter((tc) => !missingResults.has(tc.id));
        if (kept.length === msg.toolCalls.length) return msg;

        if (kept.length > 0) {
          return { ...msg, toolCalls: kept };
        }
        // 所有 tool_calls 被移除
        const { toolCalls: _, ...rest } = msg as Message & { toolCalls?: ToolCall[] };
        if (
          !rest.content ||
          (typeof rest.content === 'string' && !rest.content.trim())
        ) {
          (rest as { content: string }).content = '(tool call removed)';
        }
        return rest as Message;
      });
    }

    return result;
  }

  /**
   * 当只剩 system + 1 Turn 仍超限时，截断超长 tool 消息 content。
   */
  private truncateOversizedToolMessages(
    messages: Message[],
    availableTokens: number,
    tools: ToolDefinition[],
  ): Message[] {
    const result = messages.map((m) => ({ ...m }));

    for (const msg of result) {
      if (estimateTotal(result, tools).total <= availableTokens) break;
      if (msg.role !== 'tool') continue;

      const content = msg.content;
      if (content.length <= TOOL_CONTENT_TRUNCATE_HEAD_CHARS) continue;

      const marker = `\n\n[Result truncated, original length: ${content.length.toLocaleString()} chars, tail content omitted]`;
      msg.content = content.slice(0, TOOL_CONTENT_TRUNCATE_HEAD_CHARS) + marker;
    }

    return result;
  }

  // ===== 错误分类 =====

  private isAuthError(err: unknown): boolean {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      // 兼容 Python SDK 的 snake_case 和 JS SDK 的 camelCase
      const errObj = err as unknown as Record<string, unknown>;
      const status = (errObj.status_code ?? errObj.status ?? errObj.statusCode) as number | undefined;
      if (status === 401 || status === 403) return true;
      return (
        msg.includes('unauthorized') ||
        msg.includes('forbidden') ||
        msg.includes('authentication') ||
        msg.includes('invalid api key') ||
        msg.includes('invalid x-api-key') ||
        msg.includes('api-key')
      );
    }
    return false;
  }

  private isNetworkError(err: unknown): boolean {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      return (
        msg.includes('fetch failed') ||
        msg.includes('network') ||
        msg.includes('connection') ||
        msg.includes('econnrefused') ||
        msg.includes('etimedout') ||
        msg.includes('enotfound') ||
        msg.includes('econnreset') ||
        msg.includes('econnaborted') ||
        msg.includes('socket hang up') ||
        msg.includes('incomplete chunked read') ||
        msg.includes('peer closed connection') ||
        msg.includes('timeout') ||
        msg.includes('timed out') ||
        msg.includes('certificate') ||
        msg.includes('tls') ||
        msg.includes('ssl') ||
        msg.includes('unable to verify') ||
        msg.includes('eai_again')
      );
    }
    return false;
  }

  // ===== Helpers =====

  private makeResult(
    messages: Message[],
    removedTurns: number,
    removedMessageCount: number,
    summarized: boolean,
    estimatedTokens: number,
    status: TrimResult['status'],
    warning?: string,
  ): TrimResult {
    return {
      messages,
      removedTurns,
      removedMessageCount,
      summarized,
      estimatedTokens,
      tokensSaved: 0,
      status,
      warning,
    };
  }

  private unchangedResult(messages: Message[]): TrimResult {
    return this.makeResult(messages, 0, 0, false,
      estimateMessagesTokens(messages), 'unchanged',
    );
  }
}
