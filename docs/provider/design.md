# Provider 层 — 总体设计

## 职责边界

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

Provider 层只支持流式调用。对外暴露一个工厂函数、一个核心方法、以及配套类型。接口依赖的 `Message`、`ToolCall`、`ToolDefinition` 等共享类型定义在 `core/src/types/` 中（详见 [architecture.md](../architecture.md#共享类型定义)）。

```ts
// core/src/provider/index.ts —— 统一导出
export { createDeepSeekClient } from './deepseek-client'
export { collectStreamResponse } from './deepseek-client'
export type { DeepSeekClient, SendMessageParams, SendMessageResult, StreamEvent, FinishReason, TokenUsage }

// deepseek-client.ts 导出的核心接口

interface DeepSeekClient {
  /**
   * 流式发送消息到 DeepSeek API，返回 AsyncGenerator<StreamEvent>。
   * 这是 Provider 层唯一的调用方式——Agent Loop 和 CLI/Desktop 都用它。
   *
   * Agent Loop 使用 collectStreamResponse() 辅助函数将流事件重建为 SendMessageResult。
   * CLI/Desktop 直接消费流事件做逐字渲染。
   */
  streamMessage(params: SendMessageParams): AsyncGenerator<StreamEvent>
}

interface SendMessageParams {
  model?: string            // 'deepseek-v4-pro' | 'deepseek-v4-flash'，默认从 config 取
  messages: Message[]       // 完整的对话历史（含 system/user/assistant/tool）
  tools?: ToolDefinition[]  // 工具定义列表（OpenAI function 格式）
  maxTokens?: number        // 默认 4096
  temperature?: number      // 默认 1（DeepSeek v4 默认值）
  signal?: AbortSignal      // 取消请求
  thinking?: {              // 思考模式
    type: 'enabled' | 'disabled'
    reasoning_effort?: 'high' | 'max'
  }
}

interface SendMessageResult {
  text: string
  toolCalls: ToolCall[]
  finishReason: FinishReason
  usage: TokenUsage
}

type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'insufficient_system_resource'

interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}
```

### collectStreamResponse()

从 `StreamEvent` 流重建 `SendMessageResult`。Agent Loop 用这个函数来获得完整响应，方便进入下一轮决策：

```ts
async function collectStreamResponse(
  stream: AsyncGenerator<StreamEvent>
): Promise<SendMessageResult>
```

内部逻辑：遍历流事件，累积 `text` 片段，按 `id` 收集 `tool_call_start` / `tool_call_delta` 重建 `ToolCall[]`，从 `done` 事件提取 `finishReason` 和 `usage`。

Agent 层只依赖这三个返回字段，完全不需要关心 provider 的实现细节。

### 工厂函数

```ts
// core/src/provider/deepseek-client.ts
function createDeepSeekClient(config: ProviderConfig): DeepSeekClient
```

接收 `ProviderConfig`，返回已配置好 `apiKey`、`baseUrl`、默认模型和参数的 `DeepSeekClient` 实例。

### 模型适配

当前可用模型（截至 2026 年 7 月）：

| | deepseek-v4-pro | deepseek-v4-flash |
|---|---|---|
| **定位** | 能力最强 | 速度优先 |
| **Tool Calling** | ✅ | ✅ |
| **thinking 参数** | ✅ 支持 | ✅ 支持 |
| **reasoning_content** | thinking=enabled 时输出 | thinking=enabled 时输出 |

> ⚠️ `deepseek-chat` 和 `deepseek-reasoner` 将于 2026/07/24 弃用，分别为 v4-flash 的非思考/思考模式的别名。新项目只用两个 v4 模型名。

#### thinking 参数

替代旧版用模型名区分思考模式的做法。通过 `thinking.type` 控制：

```ts
// 非思考模式（等价旧 deepseek-chat）
{ model: 'deepseek-v4-flash', thinking: { type: 'disabled' } }

// 思考模式（等价旧 deepseek-reasoner）
{ model: 'deepseek-v4-flash', thinking: { type: 'enabled' } }
```

Provider 层在构建请求体时将 `SendMessageParams.thinking` 原样映射到 API 的 `thinking` 字段。

#### reasoning_content 处理

当 `thinking.type === 'enabled'` 时，DeepSeek 会在 `content` 之前先流式输出 `reasoning_content`（思维链）。`streamMessage` 的聚合状态机中，遇到 `delta.reasoning_content` 直接跳过，不暴露到 `StreamEvent`。首个 `content` chunk 到达时才开始产出 `{ type: 'text' }` 事件。

### 请求体大小

Provider 层不负责裁剪消息——这是 Context Management 层的职责。Provider 层的合同是：Context Management 保证传入的 `messages` 总 token 数不超过模型的 context window，Provider 层原样发送。如果 API 返回 400（请求体过大），Provider 层抛出 `ApiError`，由 Agent Loop 决定重试或终止。

---

## 各模块详细设计方向

### http-client.ts

**定位**：基于 [ky](https://github.com/sindresorhus/ky) 做薄封装。ky 是 fetch API 的扩展库，内置超时、指数退避重试、429 自动遵守 `Retry-After`。http-client.ts 只做两件事：收敛 ky 的配置到统一的 `HttpRequest` 类型，以及把 ky 的异常转换为 Provider 层的错误类型。

**为什么不用手写**：HTTP 重试/超时/退避是网络工程问题，不是 Agent 的知识点。ky 是 Sindre Sorhus（chalk、ora 的作者）维护的成熟库，2018 年至今 138 个版本，14k stars。用它省掉的 ~80 行样板代码不影响对 Agent 系统任何一层的理解。

导出函数签名：

```ts
interface HttpRequest {
  url: string                    // 完整 URL，如 'https://api.deepseek.com/v1/chat/completions'
  method: 'POST'
  headers: Record<string, string>
  body: string                   // JSON 字符串
  signal?: AbortSignal
  timeout?: number               // 毫秒，默认 120000
  maxRetries?: number            // 默认 3
}

interface HttpResponse {
  status: number
  body: ReadableStream<Uint8Array>  // ky 保证非空（非 204/304 响应）
}

function httpRequest(req: HttpRequest): Promise<HttpResponse>
```

**实现要点**（~15 行）：

```ts
import ky from 'ky'

async function httpRequest(req: HttpRequest): Promise<HttpResponse> {
  const res = await ky.post(req.url, {
    headers: req.headers,
    body: req.body,
    timeout: req.timeout ?? 120000,
    retry: {
      limit: req.maxRetries ?? 3,
      backoffLimit: 8000,  // 最大退避 8 秒
      statusCodes: [408, 413, 429, 500, 502, 503, 504],  // 仅这些状态码重试
    },
    signal: req.signal,
    // ky 默认行为：
    // - 429 自动读取 Retry-After 头，按指示等待
    // - 网络错误自动重试
    // - throwOnHttpError: true 时非 2xx 抛 HTTPError
  })
  return { status: res.status, body: res.body! }
}
```

**错误转换**：ky 抛出的 `HTTPError`（非 2xx 响应）和 `TimeoutError` 在 http-client 内部转换为 `HttpError`：

```ts
// http-client 内部捕获 ky 的异常，统一为 Provider 层错误类型
try {
  return await httpRequest(req)
} catch (e) {
  if (e instanceof ky.HTTPError) {
    const retryable = e.response.status >= 500 || e.response.status === 429
    throw new HttpError(e.response.status, retryable)
  }
  if (e instanceof ky.TimeoutError) {
    throw new HttpError(0, true)  // 超时可重试
  }
  if (e.name === 'AbortError') {
    throw new HttpError(0, false)  // 用户取消，不重试
  }
  throw new HttpError(0, true)    // 其他网络错误可重试
}

---

### sse-parser.ts

**定位**：把 `text/event-stream` 的 HTTP 响应体解析为结构化的事件流。

DeepSeek 流式响应是标准 SSE 格式，每个 chunk 一行 JSON：

```
data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"content":"你好"},"index":0}]}

data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"reasoning_content":"让我先分析..."},"index":0}]}

data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":"{\"path"}}]}}]}

data: [DONE]
```

| 维度 | 方案 |
|---|---|
| **输入** | `ReadableStream<Uint8Array>`（fetch response.body） |
| **输出** | `AsyncGenerator<DeepSeekStreamChunk>` |
| **分块处理** | 逐 chunk 读二进制 → TextDecoder 转字符串 → 按 `\n\n` 分割帧 → 解析行 |
| **粘包/拆包** | 维护行内 buffer，`data:` 行内容可能跨 chunk |
| **终止信号** | 遇到 `data: [DONE]` 结束迭代 |
| **错误处理** | `data:` 行 JSON 解析失败 → 容错跳过（或记录 warning） |

导出函数签名：

```ts
interface DeepSeekStreamChunk {
  id: string
  choices: Array<{
    index: number
    delta: {
      role?: 'assistant'
      content?: string
      reasoning_content?: string   // 思考模式下的思维链（deepseek-client 负责过滤）
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string  // 增量 JSON 片段
        }
      }>
    }
    finish_reason?: FinishReason | null
  }>
  usage?: TokenUsage
}

function parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<DeepSeekStreamChunk>
```

**设计理由**：
- 只做 SSE 协议解析，不做业务逻辑（不拼接 tool call 参数、不提取 role）
- 返回原始 chunk 结构，让 deepseek-client 做语义聚合
- 独立于 DeepSeek——OpenAI / 其他兼容 API 的 SSE 格式相同，可直接复用

---

### deepseek-client.ts

**定位**：实现 `DeepSeekClient` 接口——把内部通用格式翻译为 DeepSeek API 请求，流式发送，把 SSE 响应翻译回内部的 `StreamEvent` 流。这是三层中最"厚"的一层。

#### 流式调用（`streamMessage`）——唯一调用路径

```
输入: SendMessageParams
  │
  ▼
buildRequestBody(): DeepSeekRequestBody
  │  - messages 直接映射
  │  - tools → tools[].function （name + description + parameters）
  │  - tool_choice: 'auto'
  │  - thinking → 原样映射
  │  - stream: true（始终流式）
  │  - stream_options: { include_usage: true }
  │
  ▼
httpRequest() → body: ReadableStream
  │
  ▼
parseSSEStream() → AsyncGenerator<DeepSeekStreamChunk>
  │  跳过 reasoning_content delta
  │
  ▼
aggregateStream(): AsyncGenerator<StreamEvent>
  │  逐 chunk 消费，维护状态机：
  │    - reasoning_content delta → 跳过
  │    - content delta → { type: 'text', content }
  │    - tool_calls delta → 按 index 累积 arguments，产出 tool_call_start / tool_call_delta
  │    - finish_reason → { type: 'done', finishReason, usage }
  │
  ▼
输出: AsyncGenerator<StreamEvent>
```

Agent Loop 通过 `collectStreamResponse()` 消费流，重建 `SendMessageResult`。

`StreamEvent` 定义：

```ts
// 对外暴露的流式事件——屏蔽 DeepSeek 的具体 chunk 结构
type StreamEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; arguments: string }
  | { type: 'done'; finishReason: FinishReason; usage?: TokenUsage }
```

**聚合状态机**是 deepseek-client.ts 中最核心也最复杂的部分，需要单独拆分详细文档（见 phase-3-deepseek-client.md）。

#### 流式调用中的 Abort 与清理

当调用方 abort（`signal` 触发）时，取消链路为：

```
调用方 AbortController.abort()
  │
  ▼
httpRequest: fetch 收到 AbortError → 抛 HttpError(status=0, retryable=false)
  │  注意：不重试，因为取消是用户主动行为
  ▼
deepseek-client.streamMessage:
  捕获 AbortError → AsyncGenerator 直接 return（不抛异常，正常结束迭代）
  调用方消费 AsyncGenerator 时 for-await 正常退出
```

**关键设计决策**：`streamMessage` 不会在 abort 时抛出异常——它通过结束 AsyncGenerator 来表示取消，调用方的 `for-await` 循环自然退出。

#### 流式调用中的错误处理

`streamMessage` 的错误处理遵循"优先上报，其次容错"原则：

| 错误场景 | 行为 |
|---|---|
| HTTP 请求失败（网络/超时/4xx/5xx） | 抛 `HttpError`，在 `for-await` 创建 AsyncGenerator 时抛出（在第一次 `await` 之前） |
| SSE 行 JSON 解析失败 | 容错：跳过该行，不产生 `StreamEvent`，继续解析后续行 |
| `data:` 行不是 JSON 也不是 `[DONE]` | 容错：跳过 |
| tool_calls arguments JSON 拼接失败 | 容错：跳过该 tool call（不产生任何 StreamEvent），记录 warning 日志 |

注意：HTTP 失败总是在 stream 开始之前抛出（或第一个 `for-await` 迭代时抛出），而 SSE 解析和 JSON 拼接的局部失败是容错的。这样设计是因为：HTTP 失败意味着整个请求无效，必须重试；而流中个别行的解析失败可能是因为网络抖动，丢弃不影响后续有效行。

`StreamEvent` 删除了 `{ type: 'error' }` 变体——流中的局部容错直接跳过不产生事件，HTTP 失败用异常表达，两者都不需要 error 事件类型。

#### sse-parser 与 deepseek-client 的职责分界

| 层 | 做什么 | 不做什么 |
|---|---|---|
| sse-parser.ts | 解析 SSE 协议帧 → 输出 `DeepSeekStreamChunk` | 不拼接 JSON 片段 |
| deepseek-client.ts | 聚合片段、解析 JSON、维护 index 状态 | 不处理网络/协议 |

---

### deepseek-types.ts

**定位**：把 DeepSeek API 的请求/响应格式原样映射为 TypeScript 类型。作为 API 文档的类型级参考。

包括：
- `DeepSeekRequestBody` — 完整的请求体结构
- `DeepSeekResponse` — 完整的非流式响应体结构
- `DeepSeekStreamChunk` — 流式响应 chunk 结构
- `DeepSeekToolDefinition` — API 要求的 tool 格式
- `DeepSeekMessage` — API 要求的 message 格式（role + content + tool_calls）

这些类型是 `deepseek-client.ts` 的内部实现细节，不对外暴露。

---

### errors.ts

**定位**：Provider 层所有自定义错误的基类定义。

```ts
// 错误层级：ProviderError → HttpError / SSEParseError / ApiError
class ProviderError extends Error {
  code: string
  retryable: boolean
}

class HttpError extends ProviderError {
  status: number           // HTTP 状态码
  // 429 → retryable=true
  // 5xx → retryable=true
  // 4xx → retryable=false（401/403 是配置问题，重试无效）
}

class SSEParseError extends ProviderError {
  // 仅在 SSE 流整体无效时抛出（如 Content-Type 错误、首字节非 SSE 格式）
  // 流中的单行解析失败不抛异常，而是容错跳过
}

class ApiError extends ProviderError {
  // DeepSeek 返回的 API 级错误（余额不足、模型不存在等）
}
```

重试策略的决策链路：

```
fetch 失败 / 超时 → HttpError(retryable=true) → httpRequest 内部重试
HTTP 4xx          → HttpError(retryable=false) → 直接抛给调用方
HTTP 5xx          → HttpError(retryable=true) → httpRequest 内部重试
HTTP 429          → HttpError(retryable=true) → 等 Retry-After → 重试
SSE 解析失败      → SSEParseError → 直接抛
API 返回错误      → ApiError → 直接抛
```

---

## 配置

Provider 层需要的配置项：

```ts
interface ProviderConfig {
  apiKey: string           // DEEPSEEK_API_KEY，从环境变量读取
  baseUrl: string          // 默认 'https://api.deepseek.com/v1'
  defaultModel: string     // 默认 'deepseek-v4-pro'
  maxTokens: number        // 默认 4096
  temperature: number      // 默认 1（DeepSeek v4 默认值）
  timeout: number          // 默认 120000
  maxRetries: number       // 默认 3
}
```

配置加载优先级：环境变量 `DEEPSEEK_API_KEY` > `~/.pure-agent/config.json` > 硬编码默认值。`baseUrl` 默认值为 `https://api.deepseek.com/v1`，完整的 Chat Completions 端点为 `${baseUrl}/chat/completions`。

---

## 与 Agent 层的接口契约

Provider 只暴露 `DeepSeekClient` 接口和 `collectStreamResponse` 辅助函数。Agent 层使用 `collectStreamResponse` 消费流事件，重建完整的 `SendMessageResult`：

```ts
// core/src/provider/index.ts
export { createDeepSeekClient, collectStreamResponse } from './deepseek-client'
export type { DeepSeekClient, SendMessageParams, SendMessageResult, StreamEvent, FinishReason, TokenUsage }

// core/src/agent/loop.ts —— Agent 层的使用方式
import { collectStreamResponse, type DeepSeekClient } from '../provider'

class AgentLoop {
  constructor(private client: DeepSeekClient) {}

  async run(userMessage: string): Promise<void> {
    const stream = this.client.streamMessage({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: userMessage }],
      tools: this.getToolDefinitions(),
    })

    // collectStreamResponse 内部遍历流，重建 SendMessageResult
    const result = await collectStreamResponse(stream)
    // result.text  /  result.toolCalls  /  result.finishReason  /  result.usage
  }
}
```

这样的契约意味着：**未来对接 Anthropic API 时，只需新增 `anthropic-client.ts` 实现同样的 `DeepSeekClient` 接口（或者把接口重命名为通用的 `LlmClient`），Agent 层零改动**。

---

## 与 CLI / Desktop 的关系

CLI 和 Desktop 直接消费 `streamMessage` 做流式渲染：

```ts
const stream = client.streamMessage(params)
for await (const event of stream) {
  switch (event.type) {
    case 'text':
      // 累加文本 → 传给 streammark（CLI）或 streamdown（Desktop）
      renderChunk(event.content)
      break
    case 'tool_call_start':
      // 显示工具名称，开始动画
      showToolCall(event.name)
      break
    case 'tool_call_delta':
      // 更新工具参数（可选）
      break
    case 'done':
      // 停止动画，展示最终结果
      finish(event.finishReason)
      break
  }
}
```

Agent Loop 也使用 `streamMessage`，但通过 `collectStreamResponse()` 重建 `SendMessageResult` 后进入下一轮决策。两端走同一条路径，区别只在消费方式。

---

## 三层职责总结

| 层 | 模块 | 输入 | 输出 | 实现方式 |
|---|---|---|---|---|
| 1 | http-client.ts | url + headers + body | `HttpResponse`（含 ReadableStream） | ky 封装 |
| 2 | sse-parser.ts | `ReadableStream<Uint8Array>` | `AsyncGenerator<DeepSeekStreamChunk>` | 手写 |
| 3 | deepseek-client.ts | `SendMessageParams`（通用格式） | `AsyncGenerator<StreamEvent>` + `collectStreamResponse()` 辅助函数 | 手写 |

后续扩展其他 provider（如 Anthropic）时，只需新增第 3 层，第 1、2 层可直接复用。

---

## 测试策略

| 模块 | 难点 | 测试方式 |
|---|---|---|
| http-client | 重试、超时、错误分类 | 用 nock 模拟 HTTP 429/5xx，验证 ky 的重试行为 |
| sse-parser | 粘包、拆包、截断 JSON | 构造原始字节流，验证解析出的 chunk 序列 |
| deepseek-client (streamMessage) | tool_calls 增量聚合 | 用需要 tool call 的 prompt 发请求，验证聚合正确性 |
| deepseek-client (collectStreamResponse) | 流事件→SendMessageResult 重建 | 用 streamMessage 消费流，验证重建的 text/toolCalls/usage 正确 |
