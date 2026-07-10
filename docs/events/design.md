# Events — 事件系统设计

## 对外接口

事件系统基于 `AgentEventEmitter` 接口，由 `AgentLoop` 发射，外部消费者接收。

### AgentEventEmitter

```ts
interface AgentEventEmitter {
  emit<K extends keyof AgentEventMap>(type: K, payload: AgentEventMap[K]): void;
}
```

泛型签名确保每个事件类型与其 payload 精确对应。

### 完整事件映射

| 事件 | Payload | 发射者 | 消费者 | 频率 |
|------|---------|--------|--------|------|
| `agent:turn:start` | `{ messages }` | `AgentLoop.run()` | 外部 | 每 Turn 1 次 |
| `agent:step:start` | `{ step }` | `AgentLoop.run()` | 外部 | 每 Step 1 次 |
| `agent:thinking` | `{ step }` | `AgentLoop.run()` | 外部 | 每 Step 1 次 |
| `agent:stream:delta` | `{ content }` | `AgentLoop.processStream()` | UI | 每 text delta |
| `agent:tool_calls` | `{ toolCalls }` | `AgentLoop.run()` | 外部 | 每 tool_calls |
| `agent:executing` | `{ toolCalls }` | `AgentLoop.run()` | 外部 | 每 tool_calls |
| `agent:tool_result` | `ToolResult` | `AgentLoop.executeTools()` | 外部 | 每 tool result |
| `agent:response` | `{ content }` | `AgentLoop.run()` | 外部 | 每 stop |
| `agent:abort` | `{}` | `AgentLoop.finish()` | 外部 | 最多 1 次 |
| `agent:error` | `{ error }` | `AgentLoop.finish()` | 外部 | 最多 1 次 |
| `agent:turn:end` | `{ messages, steps, status, finishReason? }` | `AgentLoop.finish()` | 外部 | 每 Turn 1 次 |

## 跨模块不变量

1. **每 Turn 恰好一次** `turn:start` 和 `turn:end`
2. **abort/error 不重复发射**：所有终态事件由 `finish()` 方法集中发射
3. **reasoning 不在 `agent:stream:delta` 中**：reasoning 由 Agent Loop 内部累积，不转发 UI
4. **executeTools 不直接发射 abort/error**：只返回 `'aborted' | 'error'`，由 `run()` 调用 `finish()`

## 每 Turn 合法事件序列

```
turn:start
  → step:start (1+)
    → thinking
    → stream:delta (0+)
    → [tool_calls → executing → tool_result (0+)]  (0+)
  → [response]
  → [abort] (最多 1 次)
  → [error] (最多 1 次)
  → turn:end
```

## 错误与终态

- `agent:abort`：信号触发、用户取消、流 abort
- `agent:error`：Provider 错误、工具基础设施错误、死循环检测
- `agent:turn:end`：所有终态都必须经过此事件

## 状态所有权与生命周期

- `AgentEventEmitter` 由应用层注入
- `createConsoleEmitter()` 提供 CLI 调试用简单实现
- 一个 `AgentLoop` 实例同一时间只能运行一个 Turn（single-flight）

## 当前限制

- `createConsoleEmitter()` 使用类型转换适配泛型签名
- 不实现事件持久化或重放

## 测试证据

- `src/agent/__tests__/loop.test.ts` — 事件发射验证
- 验证命令：`pnpm --filter @pure-agent/core test`
