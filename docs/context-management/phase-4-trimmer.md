# Phase 4 — 主编排器（trimmer.ts）

## 目标

实现 `trimmer.ts`：编排 Phase 1-4，实现完整的 `fitToWindow()` 算法。trimmer 是有状态类（`Trimmer implements ContextManager`），持有所有压缩相关状态。

## 前置依赖

| 依赖 | 说明 |
|---|---|
| `context/tool-pruner.ts` | Phase 1 — 工具结果预裁剪 |
| `context/history-manager.ts` | Phase 2 — 边界确定中的 Turn 操作 |
| `context/token-counter.ts` | Token 估算 |
| `context/summarizer.ts` | Phase 3 — LLM 摘要 |
| `context/types.ts` | `ContextManager` 接口、`TrimResult`、`TrimOptions` |
| `context/redactor.ts` | 敏感信息脱敏（摘要内容二次脱敏） |

## 接口设计

```typescript
// packages/core/src/context/trimmer.ts

class Trimmer implements ContextManager {
  constructor(config: ContextManagerConfig, summarizer: Summarizer);

  // 核心方法
  async fitToWindow(
    messages: Message[],
    tools: ToolDefinition[],
    options?: TrimOptions,
  ): Promise<TrimResult>;

  // 辅助方法
  estimateTokens(messages: Message[], tools?: ToolDefinition[]): number;
  getCompressionStats(): CompressionStats;
  reset(): void;
  updateModel(model: string, contextLength: number): void;
}
```

---

## 持有状态

```typescript
class Trimmer implements ContextManager {
  // 压缩计数
  private compressionCount = 0;
  private compressionStats: CompressionStats;

  // 反抖动
  private lastSavingsPercent = 0;
  private ineffectiveCompressionCount = 0;

  // 迭代摘要
  private previousSummary?: string;

  // 头部保护衰减
  private effectiveProtectFirstN: number;

  // Cooldown
  private summaryFailureCooldownUntil = 0;
  private lastSummaryError?: string;

  // 重入保护
  private compressionInProgress = false;
  private lastCompressAborted = false;
}
```

### 状态生命周期

| 事件 | 重置的状态 |
|---|---|
| `new Trimmer()` | 所有状态初始化为默认值 |
| `reset()` | 清除全部 per-session 状态（同构造） |
| 模型切换 (`updateModel()`) | 清除 token 追踪、反抖动计数 |
| `onSessionEnd()` | 清除全部 per-session 状态 |

---

## 核心算法：fitToWindow()

```typescript
async fitToWindow(
  messages: Message[],
  tools: ToolDefinition[],
  options?: TrimOptions,
): Promise<TrimResult> {
  // ===== 重入检测 =====
  if (this.compressionInProgress) {
    return this.unchanged(messages, 'Compression already in progress');
  }

  // ===== 计算有效窗口 =====
  const effectiveWindow = this.calculateEffectiveWindow(options);
  const tailTokenBudget = options?.tailTokenBudget ?? this.config.tailTokenBudget;

  // ===== Phase 1: 工具结果预裁剪（始终执行） =====
  const pruneResult = pruneToolResults(messages, {
    protectTailCount: this.config.protectLastN,
    protectTailTokens: tailTokenBudget,
  });

  // ===== 检查是否超限 =====
  const currentTokens = this.estimateTokens(pruneResult.messages, tools);
  if (currentTokens <= effectiveWindow) {
    if (pruneResult.prunedCount > 0) {
      return this.prunedOnly(pruneResult);
    }
    return this.unchanged(messages);
  }

  // ===== 反抖动检查 =====
  const savingsPercent = this.calculateSavingsPercent(pruneResult);
  if (this.ineffectiveCompressionCount >= 2) {
    return this.skippedThrashing(pruneResult.messages, currentTokens);
  }

  // ===== Cooldown 检查 =====
  if (Date.now() < this.summaryFailureCooldownUntil) {
    // 在 cooldown 期内，使用确定性回退摘要
    return this.compressWithFallback(
      pruneResult.messages,
      tools,
      options,
    );
  }

  // ===== Phase 2: 边界确定 =====
  const tailCut = this.findTailCutByTokens(pruneResult.messages, tools, {
    effectiveWindow,
    tailTokenBudget,
    protectFirstN: this.effectiveProtectFirstN,
  });

  // 无压缩区 → 无需摘要
  if (tailCut.compressStart >= tailCut.compressEnd) {
    return this.handleNoCompressZone(pruneResult.messages, currentTokens);
  }

  // ===== Phase 3: LLM 摘要 =====
  const compressMessages = pruneResult.messages.slice(
    tailCut.compressStart,
    tailCut.compressEnd,
  );

  this.compressionInProgress = true;
  try {
    const summaryResult = await this.summarizer.summarize(compressMessages, {
      previousSummary: this.previousSummary,
      signal: options?.signal,
      focusTopic: options?.focusTopic,
      force: options?.force,
    });

    // 更新迭代摘要
    if (summaryResult.method === 'llm') {
      this.previousSummary = summaryResult.summary;
    }

    // ===== Phase 4: 组装 + 清理 =====
    return this.assembleResult(
      tailCut.headMessages,
      summaryResult,
      tailCut.tailMessages,
      pruneResult,
      compressMessages.length,
    );
  } catch (err) {
    return this.handleSummaryError(
      err,
      pruneResult.messages,
      compressMessages,
      tailCut,
      pruneResult,
    );
  } finally {
    this.compressionInProgress = false;
    this.compressionCount++;
  }
}
```

---

## Phase 2: 边界确定（集成点）

Phase 2 的 `findTailCutByTokens()` 在 trimmer 中实现为私有方法：

```typescript
private findTailCutByTokens(
  messages: Message[],
  tools: ToolDefinition[],
  options: {
    effectiveWindow: number;
    tailTokenBudget: number;
    protectFirstN: number;
  },
): TailCutResult {
  // 1. 确定头部边界
  const headEnd = this.determineHeadBoundary(messages, options.protectFirstN);

  // 2. 反向行走确定尾部起始
  let tailStart = this.findTailStartByTokens(
    messages,
    headEnd,
    options.tailTokenBudget,
  );

  // 3. 对齐 Turn 边界
  tailStart = alignBoundaryForward(messages, tailStart);

  // 4. Causal Coupling 守卫
  const guarded = this.ensureUserMessageInTail(messages, headEnd, tailStart);

  // 5. 确保最后 assistant 在尾部
  tailStart = this.ensureAssistantMessageInTail(
    messages,
    guarded.tailStart,
  );

  return {
    compressStart: guarded.headEnd,
    compressEnd: tailStart,
    headMessages: messages.slice(0, guarded.headEnd),
    tailMessages: messages.slice(tailStart),
  };
}
```

> 详细算法见 [phase-2-boundary-finder.md](./phase-2-boundary-finder.md)

---

## Phase 4: 组装 + 清理

### 摘要插入位置：Role 选择逻辑

```typescript
function determineSummaryInsertion(
  headMessages: Message[],
  tailMessages: Message[],
  summary: string,
): { messages: Message[]; role: 'user' | 'assistant'; insertion: 'standalone' | 'merge' } {
  const lastHead = headMessages[headMessages.length - 1];
  const firstTail = tailMessages[0];

  // 1. 默认 role：避免与 head 最后一条消息撞 role
  let role: 'user' | 'assistant' = lastHead?.role === 'user' ? 'assistant' : 'user';

  // 2. force_user_leading：当 head 只有 system prompt 时，摘要必须为 user
  if (headMessages.length === 1 && headMessages[0].role === 'system') {
    role = 'user';
  }

  // 3. Zero-user-turn guard：
  //    压缩后 head + tail 中没有 role='user' 消息 → 强制摘要为 user
  const allMessages = [...headMessages, ...tailMessages];
  const hasUserMessage = allMessages.some(m => m.role === 'user');
  if (!hasUserMessage) {
    role = 'user';
  }

  // 4. Consecutive same-role 检测：
  //    如果 standalone 摘要与 tail 第一条撞 role → merge-into-tail
  if (firstTail && firstTail.role === role) {
    return {
      messages: mergeSummaryIntoTail(firstTail, summary),
      role,
      insertion: 'merge',
    };
  }

  return {
    messages: [{ role, content: summary }],
    role,
    insertion: 'standalone',
  };
}
```

### merge-into-tail

```typescript
const MERGED_PRIOR_CONTEXT_HEADER = '[PRIOR CONTEXT — for reference only, not a new message]';
const MERGED_SUMMARY_DELIMITER = '--- End of prior context. The message below is the real message ---';

function mergeSummaryIntoTail(
  tailFirst: Message,
  summary: string,
): Message {
  const mergedContent = [
    MERGED_PRIOR_CONTEXT_HEADER,
    summary,
    SUMMARY_END_MARKER,
    MERGED_SUMMARY_DELIMITER,
    tailFirst.content ?? '',
  ].join('\n\n');

  return {
    ...tailFirst,
    content: mergedContent,
  };
}
```

### 清理孤立 tool pair

```typescript
function sanitizeToolPairs(messages: Message[]): Message[] {
  // 收集所有 assistant tool_call 的 call_id
  const validCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        validCallIds.add(tc.id);
      }
    }
  }

  const result: Message[] = [];

  for (const msg of messages) {
    if (msg.role === 'tool') {
      // 孤立的 tool 消息 → 丢弃
      if (!validCallIds.has(msg.toolCallId)) {
        continue;
      }
    }

    if (msg.role === 'assistant' && msg.toolCalls) {
      // 过滤掉无效的 tool_calls
      const validCalls = msg.toolCalls.filter(tc => {
        // 检查后续是否有对应的 tool result
        return messages.some(
          m => m.role === 'tool' && m.toolCallId === tc.id,
        );
      });

      if (validCalls.length === 0) {
        // 所有 tool_calls 被移除且无 text content
        if (!msg.content || msg.content.trim() === '') {
          result.push({
            ...msg,
            content: '(tool call removed)',
            tool_calls: undefined,
          });
          continue;
        }
        // 有 text content → 保留文本，移除 tool_calls
        result.push({ ...msg, tool_calls: undefined });
        continue;
      }

      result.push({ ...msg, tool_calls: validCalls });
      continue;
    }

    result.push(msg);
  }

  return result;
}
```

### 反抖动更新

```typescript
function updateThrashingProtection(
  savingsPercent: number,
  currentCount: number,
): { shouldSkip: boolean; newCount: number } {
  if (savingsPercent < 0.10) {
    const newCount = currentCount + 1;
    return { shouldSkip: newCount >= 2, newCount };
  }
  // 节省 ≥ 10% → 重置计数
  return { shouldSkip: false, newCount: 0 };
}
```

---

## 错误处理：多级降级

```typescript
private async handleSummaryError(
  err: unknown,
  messages: Message[],
  compressMessages: Message[],
  tailCut: TailCutResult,
  pruneResult: PruneResult,
): Promise<TrimResult> {
  // Auth 失败 — 中止压缩
  if (err instanceof SummaryAuthError) {
    this.lastSummaryError = 'Authentication failed';
    return {
      messages,
      removedTurns: 0,
      removedMessageCount: 0,
      summarized: false,
      estimatedTokens: this.estimateTokens(messages),
      tokensSaved: 0,
      status: 'aborted_auth_error',
      warning: 'Summarization aborted due to authentication error. Check your API key.',
    };
  }

  // 网络错误 — 中止压缩
  if (err instanceof SummaryNetworkError) {
    this.lastSummaryError = 'Network error';
    return {
      messages,
      removedTurns: 0,
      removedMessageCount: 0,
      summarized: false,
      estimatedTokens: this.estimateTokens(messages),
      tokensSaved: 0,
      status: 'aborted_network_error',
      warning: 'Summarization aborted due to network error. Try again or use /compress.',
    };
  }

  // Transient 错误 — 回退确定性摘要 + cooldown
  this.summaryFailureCooldownUntil = Date.now() + 60_000; // 60s cooldown
  this.lastSummaryError = String(err);

  const fallbackSummary = buildFallbackSummary(compressMessages);

  return this.assembleResult(
    tailCut.headMessages,
    { summary: fallbackSummary, tokensUsed: 0, method: 'fallback' },
    tailCut.tailMessages,
    pruneResult,
    compressMessages.length,
  );
}
```

Cooldown 时长依据错误类型：
- 超时/限流 (408/429)：60s
- 空内容 / JSON 解析错误：30s
- 无 Provider 配置：600s（不太可能自愈）
- 其他未知错误：30s

---

## 摘要内容脱敏（Phase 4 集成点）

在 `assembleResult` 中，摘要内容追加到 system prompt 前需要二次脱敏：

```typescript
private assembleResult(
  headMessages: Message[],
  summaryResult: SummaryResult,
  tailMessages: Message[],
  pruneResult: PruneResult,
  compressedCount: number,
): TrimResult {
  // 摘要内容二次脱敏（纵深防御）
  const safeSummary = redactSensitiveText(summaryResult.summary);

  // 确定插入方式（standalone 或 merge-into-tail）
  const insertion = determineSummaryInsertion(
    headMessages,
    tailMessages,
    safeSummary,
  );

  // 组装消息
  let assemblyMessages: Message[];
  if (insertion.insertion === 'merge') {
    // merge 模式：摘要合并到 tail 第一条
    assemblyMessages = [
      ...headMessages,
      insertion.messages[0], // 已合并摘要的 tail 消息
      ...tailMessages.slice(1),
    ];
  } else {
    // standalone 模式：摘要作为独立消息插入
    const summaryMsg = insertion.messages[0];
    // 追加 SUMMARY_END_MARKER
    summaryMsg.content = safeSummary;
    assemblyMessages = [
      ...headMessages,
      summaryMsg,
      ...tailMessages,
    ];
  }

  // 追加到 system prompt（如果存在）
  if (assemblyMessages[0]?.role === 'system' && insertion.insertion === 'standalone') {
    // standalone 摘要追加到 system prompt 后面，作为独立消息
    // 这样不影响 system prompt 的前缀缓存
  }

  // 清理孤立 tool pair
  const sanitized = sanitizeToolPairs(assemblyMessages);

  // 压缩统计
  const estimatedTokens = this.estimateTokens(sanitized);
  const tokensSaved = pruneResult.tokensSaved + (summaryResult.tokensUsed > 0 ? compressedCount * 100 : 0);

  // 更新反抖动状态
  const savingsPercent = this.calculateSavingsPercentFromResult(
    sanitized,
    pruneResult,
  );
  const thrashing = updateThrashingProtection(
    savingsPercent,
    this.ineffectiveCompressionCount,
  );
  this.ineffectiveCompressionCount = thrashing.newCount;
  this.lastSavingsPercent = savingsPercent;

  // 头部保护衰减
  if (this.effectiveProtectFirstN > 0) {
    this.effectiveProtectFirstN = 0; // 首次压缩后衰减
  }

  // 摘要元数据标记
  const summaryMsg = sanitized.find(m =>
    m.content?.includes(SUMMARY_PREFIX),
  );
  if (summaryMsg) {
    (summaryMsg as any)._compressed_summary = true;
  }

  return {
    messages: sanitized,
    removedTurns: Math.ceil(compressedCount / 2), // 估算移除的 Turn 数
    removedMessageCount: compressedCount,
    summarized: summaryResult.method === 'llm',
    summary: safeSummary,
    estimatedTokens,
    tokensSaved: Math.max(0, tokensSaved),
    status: summaryResult.method === 'llm' ? 'summarized' : 'fallback_summary',
  };
}
```

---

## `_compressed_summary` 元数据标记

每个压缩生成的摘要消息携带 `_compressed_summary: true` 元数据。下划线前缀确保 wire sanitizer 在 API 调用前自动移除（兼容严格网关），前端/CLI 通过此标记区分压缩摘要与真实消息。

---

## 边界情况

| 场景 | 行为 |
|---|---|
| 空消息列表 | 返回空 TrimResult，status='unchanged' |
| 未超限 | 原样返回，status='unchanged' |
| system prompt 超限 | 抛 `ContextWindowError` |
| 有效窗口为负 | 回退到 `contextWindow * 0.5`，记录 warning |
| 连续无效压缩 | 反抖动：连续 2 次 < 10% → skip |
| 摘要 LLM auth 失败 | 中止压缩，status='aborted_auth_error' |
| 摘要 LLM 网络断连 | 中止压缩，status='aborted_network_error' |
| 摘要 LLM transient 失败 | 回退摘要 + cooldown |
| abort signal 触发（压缩进行中） | 重入检测 → 跳过压缩，返回原消息 |
| 并发调用 fitToWindow | 第二次调用返回原消息 |
| 压缩后 head+tail 中零 user 消息 | 强制摘要为 role='user' |
| 摘要 role 与 head 和 tail 都冲突 | merge-into-tail |
| 孤立 tool pair | sanitizeToolPairs 自动清理 |
| Causal Coupling：user 在 head 边界 | 整对送入压缩区 |
| 100+ Turn 长对话 | 迭代摘要 + 反抖动防退化 |
| 摘要追加到 system prompt 后 | 不影响前缀缓存 |

---

## 测试方案

```typescript
describe('Trimmer', () => {
  // fitToWindow 全流程
  it('未超限时原样返回，status=unchanged');
  it('Phase 1 裁剪足够时不进入 Phase 2+');
  it('Phase 1-4 完整流程：去重→边界→摘要→组装');
  it('迭代摘要：previousSummary 合并新 turn');

  // 反抖动
  it('连续 2 次 < 10% → 第 3 次 skip，status=skipped_thrashing');
  it('节省 ≥ 10% 时重置反抖动计数');

  // 错误降级
  it('auth 失败 → abort，status=aborted_auth_error');
  it('网络错误 → abort，status=aborted_network_error');
  it('transient 失败 → 回退摘要 + cooldown');
  it('cooldown 期内使用确定性回退');

  // 重入保护
  it('并发调用 → 第二次返回原消息');

  // 组装
  it('摘要追加到最后一条 system prompt 后面');
  it('standalone 摘要追加 SUMMARY_END_MARKER');
  it('merge-into-tail 用 MERGED_SUMMARY_DELIMITER 分隔');
  it('孤立的 tool 消息被移除');
  it('孤立的 tool_call 被移除，无文本时填充 placeholder');
  it('摘要消息带 _compressed_summary 标记');

  // 保护衰减
  it('首次压缩 protectFirstN=3，之后为 0');

  // Causal Coupling
  it('user 在 head 边界 → 整对送入压缩区');
});
```

---

## 产出物

| 文件 | 说明 |
|---|---|
| `packages/core/src/context/trimmer.ts` | `Trimmer` 类（`implements ContextManager`） |
| `packages/core/src/context/index.ts` | `createContextManager()` 工厂函数 |
| `packages/core/src/context/__tests__/trimmer.test.ts` | 集成测试 |

---

## 与 StepBuilder 的集成

```
StepBuilder.build(messages, tools, options, signal)
  │
  ├── ensureSystemPrompt()
  │
  ├── const trimmed = await contextManager.fitToWindow(
  │       messagesWithSystem, tools, {
  │         completionReserve: options.maxTokens,
  │         signal,
  │       })
  │
  ├── validateSystemPrompt(messagesWithSystem, trimmed.messages)
  │     // prompt caching 安全检查
  │
  └── assembleRequest(trimmed.messages, tools, options)
```

StepBuilder 不感知压缩细节（Phase 1-4），只关心 `TrimResult.messages` 和 `TrimResult.status`（用于 UI 警告/错误提示）。
