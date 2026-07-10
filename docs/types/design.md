# Types — 共享类型系统设计

## 对外接口

Pure Agent 的类型系统定义在 `packages/core/src/types/index.ts`，分为以下几层：

### 消息类型

```ts
type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; reasoningContent?: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string };
```

- `reasoningContent` 仅在 tool-call assistant 消息中保留，用于下一轮请求回放
- camelCase 内部字段 vs snake_case Provider wire 字段的边界在 Provider 层处理（`mapMessageToDeepSeek`）

### StreamEvent

```ts
type StreamEvent =
  | { type: 'reasoning'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; arguments: string }
  | { type: 'done'; finishReason: FinishReason; usage?: TokenUsage }
  | { type: 'aborted' };
```

- `reasoning` 事件由 Agent Loop 累积但不转发 UI
- `aborted` 是显式终态，不是静默返回
- `done.finishReason` 使用 `FinishReason` 联合类型

### TrimResult（可判别联合）

```ts
type TrimResult =
  | (TrimBase & { ok: true; status: TrimSuccessStatus })
  | (TrimBase & { ok: false; status: TrimFailureStatus; reason: string });
```

- `ok: true` 时保证 `estimatedTokens <= effectiveWindow`
- `ok: false` 时 StepBuilder 必须抛出 `ContextWindowError`

### AgentEventMap

```ts
interface AgentEventMap {
  'agent:turn:start': { messages: Message[] };
  'agent:step:start': { step: number };
  'agent:thinking': { step: number };
  'agent:stream:delta': { content: string };
  'agent:tool_calls': { toolCalls: ToolCall[] };
  'agent:executing': { toolCalls: ToolCall[] };
  'agent:tool_result': ToolResult;
  'agent:response': { content: string };
  'agent:abort': Record<string, never>;
  'agent:error': { error: Error };
  'agent:turn:end': { messages: Message[]; steps: number; status: TurnStatus; finishReason?: FinishReason };
}
```

### TurnStatus

```ts
type TurnStatus = 'completed' | 'max_steps' | 'aborted' | 'truncated' | 'content_filtered' | 'error';
```

### FinishReason（共享 Provider 类型）

```ts
type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'insufficient_system_resource';
```

## 跨模块不变量

| 类型 | 生产者 | 消费者 | 不变量 |
|------|--------|--------|--------|
| `Message` | Agent Loop | Provider, Context | `reasoningContent` 仅在 tool-call assistant 消息存在 |
| `StreamEvent` | Provider | Agent Loop | 每个流必须以 `done` 或 `aborted` 结束 |
| `TrimResult` | ContextManager | StepBuilder | `ok: true` → `estimatedTokens <= effectiveWindow` |
| `SummaryResult` | Summarizer | Trimmer | `body` 为未格式化正文 |
| `AgentEventMap` | Agent Loop | 外部 Emitter | 每 Turn 恰好一次 `turn:start`/`turn:end` |
| `TurnOutput` | Agent Loop | Entry Point | `status` 唯一确定终态 |

## 错误与终态

- `ContextWindowError`：窗口超限，由 StepBuilder 或 Trimmer 抛出
- `TurnStatus` 覆盖所有合法终态：completed, max_steps, aborted, truncated, content_filtered, error
- `finishReason` 可选字段允许调用方区分非正常终止

## 状态所有权与生命周期

- `Message[]` 由 Agent Loop 拥有，通过 `TurnOutput.messages` 返回
- `TrimResult` 由 ContextManager 产生，StepBuilder 消费后不应修改
- `SummaryResult` 由 Summarizer 产生，Trimmer 负责格式化和插入
- `AgentEventMap` 各事件由 Agent Loop 的 `finish()` 方法集中发射

## 当前限制

- `ToolResult` 有 index signature `[key: string]: unknown` 以满足泛型 emitter 约束
- `TrimBase` 未导出，通过 `TrimResult` 可判别联合使用
- 类型定义在单一文件 `types/index.ts` 中，Provider 专用类型在 `types/provider.ts`

## 测试证据

- `src/agent/__tests__/loop.test.ts` — TurnStatus, StreamEvent 消费
- `src/context/__tests__/trimmer.test.ts` — TrimResult
- `src/provider/__tests__/deepseek-client.test.ts` — StreamEvent 生产
- 验证命令：`pnpm --filter @pure-agent/core test`
