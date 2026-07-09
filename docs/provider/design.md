# Provider 层 — 总体设计

## 模块定位

Provider 层是 Agent 引擎与 LLM 服务之间的**翻译层**。它只做一件事：把内部的通用请求格式变成 DeepSeek API 能理解的 HTTP 请求，然后把 API 的返回变成内部通用的响应格式。

```
                      Provider 层
外部依赖               内部（纯 TS）             Agent 层依赖
────────              ─────────────             ────────────
DeepSeek API  ←────→  provider/          ←────→  agent/
  HTTP + SSE            暴露 streamMessage()       只知道这个接口
  JSON 协议             屏蔽 HTTP / SSE / JSON
```

Agent 层不知道 HTTP 长什么样，不知道 SSE 怎么解析，不知道 DeepSeek 的 endpoint 是什么。Provider 层不知道 Agent Loop 的逻辑，不知道 Tool 怎么执行。

---

## 模块结构

```
core/src/provider/
├── http-client.ts         # HTTP 客户端（ky 薄封装，提供重试/超时/429 处理）
├── sse-parser.ts          # SSE 事件流解析器（ReadableStream → AsyncGenerator）
├── deepseek-client.ts     # DeepSeek API 封装（拼请求体、解析响应、统一接口）
├── deepseek-types.ts      # DeepSeek 请求/响应类型（映射 DeepSeek API 文档）
├── errors.ts              # Provider 层错误类型
└── index.ts               # 统一导出
```

依赖方向：

```
http-client.ts ←── deepseek-client.ts
sse-parser.ts  ←── deepseek-client.ts
deepseek-types.ts ←── deepseek-client.ts
errors.ts       ←── http-client.ts, sse-parser.ts, deepseek-client.ts
```

---

## 对外接口

Provider 层只支持流式调用。对外暴露一个工厂函数、一个核心方法、以及配套类型：

```ts
// 工厂函数
function createDeepSeekClient(config: ProviderConfig): DeepSeekClient

// 核心接口
interface DeepSeekClient {
  streamMessage(params: SendMessageParams): AsyncGenerator<StreamEvent>
}

// 辅助函数：从 StreamEvent 流重建完整结果（Agent Loop 用）
function collectStreamResponse(stream: AsyncGenerator<StreamEvent>): Promise<SendMessageResult>
```

`StreamEvent` 屏蔽了 DeepSeek 的具体 chunk 结构，只暴露四种统一事件：

```ts
type StreamEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; arguments: string }
  | { type: 'done'; finishReason: FinishReason; usage?: TokenUsage }
```

**Agent Loop 和 CLI/Desktop 使用同一条流式路径**，区别只在消费方式：
- Agent Loop 通过 `collectStreamResponse()` 消费流，重建 `SendMessageResult` 做决策
- CLI/Desktop 直接 `for-await` 消费，逐事件渲染 UI

---

## 设计决策

### 1. 为什么分三层？

三层各司其职，每层可独立理解、测试、替换：

| 层 | 模块 | 输入 | 输出 | 实现方式 |
|---|---|---|---|---|
| 1 | http-client.ts | url + headers + body | `HttpResponse`（含 ReadableStream） | ky 封装 |
| 2 | sse-parser.ts | `ReadableStream<Uint8Array>` | `AsyncGenerator<DeepSeekStreamChunk>` | 手写 |
| 3 | deepseek-client.ts | `SendMessageParams`（通用格式） | `AsyncGenerator<StreamEvent>` | 手写 |

后续扩展其他 provider（如 Anthropic）时，只需新增第 3 层，第 1、2 层可直接复用。

### 2. 为什么 http-client 用 ky 而不是手写？

HTTP 重试/超时/退避是网络工程问题，不是 Agent 的知识点。ky 内置超时、指数退避重试、429 自动遵守 `Retry-After`——省掉的 ~80 行样板代码不影响对 Agent 系统任何一层的理解。

http-client.ts 只做两件事：收敛 ky 的配置到统一的 `HttpRequest` 类型，以及把 ky 的异常转换为 Provider 层的错误类型。

### 3. 为什么只用流式调用？

- 流式可以同时覆盖"仅文本"和"tool_calls"两种场景——文本逐 token 转发 UI，tool_calls 在内存中累积
- 非流式接口是流式的子集，不需要维护两套代码路径
- 减少分支意味着更少的测试矩阵
- DeepSeek API 的 `stream: true` 始终开启，`stream_options.include_usage` 让最后一个 chunk 携带 token 用量

### 4. sse-parser 与 deepseek-client 的职责分界

| 层 | 做什么 | 不做什么 |
|---|---|---|
| sse-parser.ts | 解析 SSE 协议帧 → 输出 `DeepSeekStreamChunk` | 不拼接 JSON 片段、不过滤 reasoning_content |
| deepseek-client.ts | 聚合片段、拼接 tool_calls arguments、过滤 reasoning_content、产出 StreamEvent | 不处理网络/协议 |

sse-parser 只做 SSE 协议解析，独立于 DeepSeek——OpenAI 及其他兼容 API 的 SSE 格式相同，可直接复用。

### 5. 流式聚合状态机

deepseek-client.ts 中最核心的部分。逐 chunk 消费 SSE 流，维护状态机：

- `reasoning_content` delta → 跳过（不暴露到 StreamEvent）
- `content` delta → 产出 `{ type: 'text' }` 事件
- `tool_calls` delta → 按 index 累积 arguments，产出 `tool_call_start` / `tool_call_delta`
- `finish_reason` + `usage` → 产出 `{ type: 'done' }` 事件

> 详细实现见 [phase-3-deepseek-client.md](./phase-3-deepseek-client.md)

### 6. Abort 与错误处理策略

**Abort 行为**：调用方 abort 时，`streamMessage` 通过结束 AsyncGenerator 来表示取消（不抛异常），调用方的 `for-await` 循环自然退出。

**错误分类**：

| 错误类型 | 处理方式 |
|---|---|
| HTTP 网络/超时/5xx | `HttpError(retryable=true)`，http-client 内部重试 |
| HTTP 4xx（401/403 等） | `HttpError(retryable=false)`，直接抛给调用方 |
| SSE 单行 JSON 解析失败 | 容错跳过，继续解析后续行 |
| tool_calls arguments JSON 拼接失败 | 容错跳过该 tool call，记录 warning |

HTTP 失败用异常表达（整个请求无效，必须重试），流中局部错误容错跳过（网络抖动不影响后续有效行）。

### 7. 请求体大小

Provider 层不负责裁剪消息——这是 Context Management 层的职责。Provider 层的合同是：Context Management 保证传入的 `messages` 总 token 数不超过模型的 context window，Provider 层原样发送。如果 API 返回 400（请求体过大），Provider 层抛出 `ApiError`，由 Agent Loop 决定重试或终止。

### 8. 模型适配

当前使用 DeepSeek v4 系列（`deepseek-v4-pro` / `deepseek-v4-flash`）。Provider 层在构建请求体时将 `SendMessageParams.thinking` 原样映射到 API 的 `thinking` 字段，支持思考模式开关。

> ⚠️ `deepseek-chat` 和 `deepseek-reasoner` 将于 2026/07/24 弃用，新项目只用两个 v4 模型名。

---

## 与 Agent 层的接口契约

Provider 只暴露 `DeepSeekClient` 接口和 `collectStreamResponse` 辅助函数。这样的契约意味着：**未来对接其他 LLM Provider 时，只需新增对应的 client 实现同样的接口，Agent 层零改动**。

---

## 测试策略

| 模块 | 难点 | 测试方式 |
|---|---|---|
| http-client | 重试、超时、错误分类 | 用 nock 模拟 HTTP 429/5xx，验证错误映射 |
| sse-parser | 粘包、拆包、截断 JSON | 构造原始字节流，验证解析出的 chunk 序列 |
| deepseek-client | tool_calls 增量聚合 | 用需要 tool call 的 prompt 发真实请求，验证聚合正确性 |
| collectStreamResponse | 流事件→SendMessageResult 重建 | 消费 streamMessage 流，验证重建的 text/toolCalls/usage |

---

## 参考资料

- [DeepSeek API 文档](https://api-docs.deepseek.com/)
- [ky — HTTP client](https://github.com/sindresorhus/ky)
- [SSE 协议规范](https://html.spec.whatwg.org/multipage/server-sent-events.html)
