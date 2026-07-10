# Tokenizer Phase 2: Context 集成

## 目标

将实验性 BPE tokenizer 集成到 Context Management 模块，提供诊断和校准能力。

## 实现文件

- `packages/core/src/context/token-counter.ts` — `setBpeCounter()`, `countTokensBestEffort()`

## 关键实现细节

### setBpeCounter

```ts
function setBpeCounter(counter: (text: string) => number): void
```

由 `initTokenizer()` 自动调用，将 `countTokensBpe` 注入到 token-counter 模块。

### countTokensBestEffort

```ts
function countTokensBestEffort(messages: Message[], tools?: ToolDefinition[]): number
```

- 优先使用 BPE tokenizer（已注入时）
- 不可用时回退字符比率估算
- 用于诊断/校准场景

### 向后兼容

旧名称通过别名保留：
- `countTokensExact` → `countTokensBpe`
- `setExactCounter` → `setBpeCounter`

## Context Trimmer 热路径

Context Trimmer 的窗口裁剪热路径**不使用** BPE tokenizer：

- `estimateTotal()` 使用字符比率估算 + 10% safety margin
- `estimateMsgBudgetTokens()` 使用简化的 `chars/4` 比率
- 在通过官方 golden vectors 验证之前，BPE 不承担强契约

## 当前限制

- BPE 仅用于诊断和校准
- `countTokensBestEffort` 在 BPE 不可用时回退估算
- 非精确状态已在 API 命名中明确
