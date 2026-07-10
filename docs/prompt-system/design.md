# Prompt System — 系统提示词管理

## 对外接口

### DEFAULT_SYSTEM_PROMPT

```ts
const DEFAULT_SYSTEM_PROMPT: string;
```

通用编程助手 prompt，包含 Capabilities、Guidelines 和 `{date}` 占位符。

### formatSystemPrompt

```ts
function formatSystemPrompt(template: string): string;
```

替换 `{date}` 为当前日期（YYYY-MM-DD 格式）。

## system prompt 优先级

1. messages 中已有的 system 消息（第一条 `role === 'system'`）
2. `AgentOptions.systemPrompt`（在前面插入）
3. 无 system prompt 时 StepBuilder 不添加

## 跨模块不变量

- **一个 Turn 内 system prompt 保持稳定**：满足 DeepSeek Context Caching 前缀匹配要求
- StepBuilder 的 `validateSystemPrompt()` 验证 fitToWindow 后 system 未被修改
- Context summary 由 ContextManager 追加为独立消息，不修改 system prompt 正文

## Prompt Caching 要求

- system prompt 变化会导致后续所有请求 cache miss
- StepBuilder 在 system 被修改或移除时抛出 `ContextWindowError`

## 错误与终态

- system prompt 被 fitToWindow 修改 → `ContextWindowError`

## 状态所有权与生命周期

- `DEFAULT_SYSTEM_PROMPT` 是模块级常量
- `formatSystemPrompt()` 每次调用返回新字符串
- 传入 `AgentOptions.systemPrompt` 的模板在 StepBuilder 构建时格式化

## 当前限制

- 仅支持 `{date}` 一个占位符
- 不支持多语言/多环境 prompt 变体
- system prompt 长度不受 ContextManager 限制（需调用方确保不超窗）

## 测试证据

- 验证命令：`pnpm --filter @pure-agent/core typecheck`
