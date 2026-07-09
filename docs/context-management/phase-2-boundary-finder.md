# Phase 2 — 边界确定（trimmer 中的 findTailCutByTokens）

## 目标

实现 `findTailCutByTokens()` 算法：在 LLM 摘要前确定哪些消息保留在尾部（tail）、哪些送入摘要（compress 区）。纯计算，无 LLM 调用。

## 前置依赖

| 依赖 | 说明 |
|---|---|
| `context/token-counter.ts` | `estimateMessagesTokens()`, `estimateMsgBudgetTokens()` |
| `context/history-manager.ts` | `groupByTurns()`, `alignBoundaryForward()`, `findLastUserMessageIdx()`, `findLastAssistantMessageIdx()` |
| `context/types.ts` | `TrimOptions`, `TokenEstimate` |

## 接口设计

```typescript
// packages/core/src/context/trimmer.ts（trimmer 的私有方法）

interface TailCutResult {
  compressStart: number;   // 压缩区起始索引（inclusive）
  compressEnd: number;     // 压缩区结束索引（exclusive）
  headMessages: Message[]; // 头部消息（永远不会被裁剪）
  tailMessages: Message[]; // 尾部消息（保留，不压缩）
}
```

核心约束：
- `messages[0]` 如果是 system → 永远在 head 中（永不被裁剪）
- `headMessages` 包含 system prompt + 受保护的头部消息
- `tailMessages` 包含足够多的最新消息，其 token 数接近 tailTokenBudget
- 压缩区 = head 和 tail 之间的消息

---

## 核心算法

```
findTailCutByTokens(messages, tools, options)
  │
  ├── 1. 保护头部
  │     system prompt → 永不移除
  │     前 N 条非 system 消息 → 首次压缩保护 3 条，之后衰减为 0
  │
  ├── 2. Token 预算驱动尾部保护
  │     从消息末尾反向行走
  │     累加每条消息的 token 估算
  │     直到累积 token 超过 tailTokenBudget
  │     soft_ceiling = budget × 1.5（防单条超大消息阻止切割）
  │
  ├── 3. 对齐 Turn 边界
  │     切割点必须在 Turn 边界上
  │     不能出现在 tool_call/result pair 中间
  │     对齐方向：向后（包含更多消息）
  │
  ├── 4. 确保最后 user 消息在尾部
  │     如果最后一条 user 消息恰好位于 headEnd 边界
  │     → Causal Coupling 守卫：整个 turn-pair 送入压缩区
  │
  └── 5. 确保最后 assistant 消息在尾部
        只考虑有文本 content 的 assistant
        纯 tool_calls 的 assistant 不算
```

---

## 详细实现

### Step 1: 确定 headStart 和 headEnd

```typescript
function determineHeadBoundary(
  messages: Message[],
  protectFirstN: number,
): { headStart: number; headEnd: number } {
  // headStart = 0（始终从头开始）
  // headEnd = 1（system prompt） + protectFirstN（非 system 消息）

  let headEnd = 0;

  // 第 1 条是 system prompt → 放入 head
  if (messages.length > 0 && messages[0].role === 'system') {
    headEnd = 1;
  }

  // 保护前 N 条非 system 消息（首次压缩 protectFirstN=3，之后衰减为 0）
  headEnd += protectFirstN;

  // 但不超过消息总数
  headEnd = Math.min(headEnd, messages.length);

  return { headStart: 0, headEnd };
}
```

**protectFirstN 衰减规则**：
- 首次压缩：`protectFirstN = 3`（保护早期 Turn 的上下文）
- 首次压缩后：`protectFirstN = 0`（早期 Turn 已进入摘要，无需重复保护）

### Step 2: 反向行走确定 tailStart

```typescript
function findTailStartByTokens(
  messages: Message[],
  headEnd: number,
  tailTokenBudget: number,
): number {
  let accumulatedTokens = 0;
  const softCeiling = tailTokenBudget * 1.5;

  // 从消息末尾反向行走
  for (let i = messages.length - 1; i >= headEnd; i--) {
    const msg = messages[i];
    const msgTokens = estimateMsgBudgetTokens(msg);

    // 如果加入这条消息会超过软上限 → 停止
    if (accumulatedTokens + msgTokens > softCeiling) {
      // 但至少要保留 3 条（硬下限）
      const tailCount = messages.length - i - 1;
      if (tailCount >= 3) {
        return i + 1; // 这条消息不放入 tail
      }
    }

    accumulatedTokens += msgTokens;

    // 已达到预算 → 停止
    if (accumulatedTokens >= tailTokenBudget) {
      return i; // 这条消息放入 tail
    }
  }

  // 走到 headEnd → 所有消息都在 tail
  return headEnd;
}
```

关键设计：
- `tailTokenBudget` 默认 = `contextWindow * 0.20`（20% 窗口给尾部）
- `softCeiling = budget * 1.5` 防止单条超大消息阻止切割（如 50K 的 tool 结果）
- **硬下限**：至少保留 3 条消息在 tail 中
- `estimateMsgBudgetTokens()` 是快速预算估算，比精确估算更轻量

### Step 3: 对齐 Turn 边界

```typescript
function alignToTurnBoundary(
  messages: Message[],
  cutIndex: number,
): number {
  // 向后对齐：如果 cutIndex 切在了 tool 消息上
  // 往前找到对应的 assistant(tool_calls)，让整个 pair 留在压缩区

  // 向前对齐：如果 cutIndex 切在了 assistant(tool_calls) 上
  // 往后找到最后一个 tool result，让整个 pair 进入 tail

  // 向前对齐（更安全：宁可多保留，不切断 pair）
  const turns = groupByTurns(messages);
  // 找到 cutIndex 所在的 Turn
  // 如果 cutIndex 在 Turn 中间 → 前移到 Turn 开始位置
  return alignBoundaryForward(messages, cutIndex);
}
```

核心约束：**绝对不能**切割以下 pair：
- assistant(tool_calls) 和其后的 tool result(s)
- 切在 pair 中间 → API 400 错误（tool 消息无对应 tool_call）

### Step 4: Causal Coupling 守卫

```typescript
function ensureUserMessageInTail(
  messages: Message[],
  headEnd: number,
  tailStart: number,
): { headEnd: number; tailStart: number } {
  const lastUserIdx = findLastUserMessageIdx(messages);

  // 情况 1：最后 user 消息在 tail 中 → OK
  if (lastUserIdx >= tailStart) {
    return { headEnd, tailStart };
  }

  // 情况 2：最后 user 消息在 head 保护区内 → 不能硬拉入 tail
  if (lastUserIdx < headEnd) {
    // 将整个 turn-pair（user + assistant + tools）标记为可压缩区
    // 确保摘要将此 pair 标记为"已完成"
    const newTailStart = findTurnEndAfter(messages, lastUserIdx);
    return { headEnd: lastUserIdx, tailStart: newTailStart };
  }

  // 情况 3：最后 user 消息在压缩区内 → 前移 tailStart 包含它
  return { headEnd, tailStart: lastUserIdx };
}
```

### Step 5: 确保最后 assistant 消息在尾部

```typescript
function ensureAssistantMessageInTail(
  messages: Message[],
  tailStart: number,
): number {
  const lastAssistantIdx = findLastAssistantMessageIdx(messages);

  // 只考虑有文本 content 的 assistant（tool_calls-only 不算）
  // 用户真正看到的文本回复才需要锚定在尾部

  if (lastAssistantIdx < tailStart) {
    // assistant 不在 tail → 前移 tailStart
    return lastAssistantIdx;
  }

  return tailStart;
}
```

---

## 完整流程

```typescript
function findTailCutByTokens(
  messages: Message[],
  tools: ToolDefinition[],
  options: {
    effectiveWindow: number;
    tailTokenBudget: number;
    protectFirstN: number;
  },
): TailCutResult {
  const totalTokens = estimateTotal(messages, tools);

  // 未超限 → 什么也不做
  if (totalTokens <= options.effectiveWindow) {
    return {
      compressStart: 0,
      compressEnd: 0, // 空压缩区
      headMessages: [],
      tailMessages: messages,
    };
  }

  // 1. 确定头部边界
  const { headStart, headEnd } = determineHeadBoundary(
    messages,
    options.protectFirstN,
  );

  // 2. 反向行走确定尾部起始
  let tailStart = findTailStartByTokens(
    messages,
    headEnd,
    options.tailTokenBudget,
  );

  // 3. 对齐 Turn 边界
  tailStart = alignToTurnBoundary(messages, tailStart);

  // 4. Causal Coupling 守卫
  const adjusted = ensureUserMessageInTail(messages, headEnd, tailStart);
  headEnd_updated = adjusted.headEnd;
  tailStart = adjusted.tailStart;

  // 5. 确保最后 assistant 在尾部
  tailStart = ensureAssistantMessageInTail(messages, tailStart);

  // 防止 headEnd 和 tailStart 重叠
  tailStart = Math.max(tailStart, headEnd);

  return {
    compressStart: headEnd,
    compressEnd: tailStart,
    headMessages: messages.slice(0, headEnd),
    tailMessages: messages.slice(tailStart),
  };
}
```

---

## 边界情况

| 场景 | 行为 |
|---|---|
| 消息未超限 | 返回空压缩区，tail 包含所有消息 |
| 有效窗口为负 | 回退到 `contextWindow * 0.5`，记录 warning |
| system prompt 本身超限 | 抛 `ContextWindowError` |
| 最后 user 消息在 head 边界 | Causal Coupling 守卫：整对送入压缩区 |
| 压缩后 head+tail 中零 user 消息 | 由 Phase 4 的 zero-user-turn guard 处理 |
| tailTokenBudget 非常小 | 至少保留 3 条消息（硬下限） |
| 所有消息 < headEnd | 压缩区为空，不做摘要 |

---

## 测试方案

```typescript
describe('findTailCutByTokens', () => {
  // 基本
  it('未超限时返回空压缩区');
  it('超限时正确确定 headEnd 和 tailStart');

  // 头部保护
  it('system prompt 永远在 head 中');
  it('首次压缩 protectFirstN=3，之后衰减为 0');

  // 尾部保护
  it('反向行走在 budget 耗尽时停止');
  it('至少保留 3 条消息在 tail（硬下限）');
  it('soft_ceiling 防止单条超大消息阻止切割');

  // Turn 对齐
  it('切割点对齐到 Turn 边界');
  it('不切割 tool_call/result pair');

  // Causal Coupling
  it('最后 user 在 head 边界时整对送入压缩区');
  it('最后 assistant（有文本）锚定在尾部');
  it('纯 tool_calls assistant 不锚定');
});
```

---

## 产出物

本 Phase 的代码集成在 `trimmer.ts` 中，作为 `Trimmer` 类的私有方法。不单独产出文件。

关键方法：
- `determineHeadBoundary()`
- `findTailStartByTokens()`
- `alignToTurnBoundary()`（调用 history-manager）
- `ensureUserMessageInTail()`
- `ensureAssistantMessageInTail()`
