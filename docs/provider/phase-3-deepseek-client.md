# Phase 3：DeepSeek API 封装（deepseek-client.ts）

## 前置依赖

- Phase 1：`http-client.ts`（`httpRequest()` 函数）
- Phase 2：`sse-parser.ts`（`parseSSEStream()` 函数）、`deepseek-types.ts`（类型定义）
- 共享类型：`core/src/types/` 中的 `Message`、`ToolCall`、`ToolDefinition`（见 [architecture.md](../architecture.md#共享类型定义)）

## 目标

实现 `createDeepSeekClient()` 工厂函数和 `collectStreamResponse()` 辅助函数。Provider 层只有流式调用：

```ts
interface DeepSeekClient {
  streamMessage(params: SendMessageParams): AsyncGenerator<StreamEvent>
}

// 辅助函数：从 StreamEvent 流重建 SendMessageResult
function collectStreamResponse(stream: AsyncGenerator<StreamEvent>): Promise<SendMessageResult>
```

这是 Provider 层三层中的最后一层——把 Phase 1 和 Phase 2 的通用能力组合成 DeepSeek 专用的流式 API 封装。

## 产出文件

```
core/src/provider/
├── http-client.ts        # Phase 1（已完成）
├── errors.ts             # Phase 1（已完成）
├── sse-parser.ts         # Phase 2（已完成）
├── deepseek-types.ts     # Phase 2（已完成）
├── deepseek-client.ts    # 本期实现
└── index.ts              # 本期实现（统一导出）
```

---

## 数据流全景

```
                          deepseek-client.ts
                          ───────────────────
streamMessage()
  │
  ├─► buildRequestBody()          翻译：SendMessageParams → DeepSeekRequestBody
  │     ├ messages 直接映射                + stream: true（始终流式）
  │     ├ tools → tools[].function         + stream_options: { include_usage: true }
  │     ├ tool_choice: 'auto'
  │     └ thinking → 原样映射
  │
  ├─► httpRequest()               发 HTTP POST（Phase 1）
  │     └ ReadableStream
  │
  ├─► parseSSEStream()            SSE → AsyncGenerator<DeepSeekStreamChunk>（Phase 2）
  │
  └─► aggregateStream()           聚合：DeepSeekStreamChunk → StreamEvent
        ├ reasoning_content → 跳过
        ├ content delta → { type: 'text', content }
        ├ tool_calls delta → 按 index 累积 → tool_call_start / tool_call_delta
        └ finish_reason + usage → { type: 'done', finishReason, usage }

collectStreamResponse()
  │
  └─► 消费 StreamEvent 流，重建 SendMessageResult
        ├ 累积 text 片段 → result.text
        ├ 收集 tool_call_start/delta → result.toolCalls（完整 ToolCall[]）
        └ 提取 done 事件 → result.finishReason + result.usage
```

---

## 实施步骤

### Step 1: 实现 buildRequestBody()

```ts
// core/src/provider/deepseek-client.ts

import type { Message } from '../types/message'
import type { ToolDefinition } from '../types/tool'
import type { DeepSeekRequestBody, DeepSeekToolDefinition } from './deepseek-types'

/**
 * 将内部通用格式翻译为 DeepSeek API 请求体。
 *
 * 核心转换：
 *   1. Message[] → DeepSeek API messages 格式（字段名一致，直接映射）
 *   2. ToolDefinition[] → DeepSeek tools 格式
 *   3. tool_choice: 'auto'（有 tools 时）或省略（无 tools 时）
 *   4. thinking 参数原样映射
 */
function buildRequestBody(params: {
  model: string
  messages: Message[]
  tools?: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  thinking?: { type: 'enabled' | 'disabled'; reasoning_effort?: 'high' | 'max' }
}): { body: DeepSeekRequestBody } {
  const body: DeepSeekRequestBody = {
    model: params.model,
    messages: params.messages.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.role === 'assistant' && 'toolCalls' in m && m.toolCalls
        ? { tool_calls: m.toolCalls.map(tc => ({
            id: tc.id,
            type: tc.type,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          }))
        }
        : {}),
      ...(m.role === 'tool' && 'toolCallId' in m
        ? { tool_call_id: m.toolCallId }
        : {}),
    })),
  }

  // Tools
  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }))
    body.tool_choice = 'auto'
  }

  // 始终流式
  body.stream = true
  body.stream_options = { include_usage: true }

  // Optional params
  if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens
  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.thinking) body.thinking = params.thinking

  return { body }
}
```

**注意事项**：
- `Message[]` 中有 `role: 'tool'` 的消息时，必须带 `tool_call_id`（关联回 assistant 消息的 tool_calls[].id）
- `Message[]` 中有 `role: 'assistant'` 且包含 `toolCalls` 时，需要把内部 `ToolCall` 格式映射为 DeepSeek API 的 `tool_calls` 格式
- `input_schema` 在旧版 DeepSeek API 中叫这个名字，但新版使用 `parameters`。查了当前 API 文档确认：DeepSeek 兼容 OpenAI 格式，工具定义使用 `function.parameters` 字段

### Step 2: 实现 aggregateStream()——流式聚合状态机

这是整个 Provider 层最复杂的一段代码。需要维护两个状态：

1. **每个 tool call index → 累积的 arguments 片段**，以及该 tool call 的 id/name（在第一次出现时记录）
2. **当前正在构建的 text 内容**（不需要累积，直接逐片段 yield）

```ts
// core/src/provider/deepseek-client.ts

import { parseSSEStream } from './sse-parser'
import type { DeepSeekStreamChunk } from './deepseek-types'

/**
 * StreamEvent —— 对外暴露的流式事件。
 * 屏蔽 DeepSeek 的 chunk 结构，只暴露统一的事件类型。
 */
export type StreamEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; arguments: string }
  | { type: 'done'; finishReason: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }

interface ToolCallAccumulator {
  id: string
  name: string
  argumentsFragments: string[]
}

async function* aggregateStream(
  chunks: AsyncGenerator<DeepSeekStreamChunk>
): AsyncGenerator<StreamEvent> {
  const toolCallAccumulators = new Map<number, ToolCallAccumulator>()
  let finalFinishReason = 'stop'
  let finalUsage: StreamEvent['usage'] | undefined

  for await (const chunk of chunks) {
    const choice = chunk.choices[0]
    if (!choice) continue

    const delta = choice.delta
    const finishReason = choice.finish_reason

    // --- Reasoning content delta（跳过，不暴露） ---
    // delta.reasoning_content 在 thinking.enabled 模式下会出现，位于 content 之前。
    // 这里不处理 reasoning_content —— 既不过滤也不 yield —— 所以它被自动丢弃。
    // reasoning_content 只出现在 delta 中，不通过其他字段暴露。

    // --- Text delta ---
    if (delta.content) {
      yield { type: 'text', content: delta.content }
    }

    // --- Tool calls delta (streaming JSON fragments) ---
    if (delta.tool_calls) {
      for (const tcDelta of delta.tool_calls) {
        const index = tcDelta.index

        // 初始化 accumulator
        if (!toolCallAccumulators.has(index)) {
          toolCallAccumulators.set(index, {
            id: '',
            name: '',
            argumentsFragments: [],
          })
        }
        const acc = toolCallAccumulators.get(index)!

        // 第一次出现 id → yield tool_call_start
        if (tcDelta.id) {
          acc.id = tcDelta.id
        }
        // 第一次出现 function.name → yield tool_call_start
        if (tcDelta.function?.name && !acc.name) {
          acc.name = tcDelta.function.name
          yield { type: 'tool_call_start', id: acc.id, name: acc.name }
        }

        // 累积 arguments 片段
        if (tcDelta.function?.arguments) {
          acc.argumentsFragments.push(tcDelta.function.arguments)
          yield {
            type: 'tool_call_delta',
            id: acc.id,
            arguments: tcDelta.function.arguments,
          }
        }

        // finish_reason 出现 → 后续 stream 结束时会 yield done 事件
        // tool call arguments 的完整拼接由 collectStreamResponse() 负责
        if (finishReason) {
          // 不需要在此处拼接完整 arguments
        }
      }
    }

    // --- Finish reason ---
    if (finishReason) {
      finalFinishReason = finishReason
    }

    // --- Usage (最后一个 chunk) ---
    if (chunk.usage) {
      finalUsage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
      }
    }
  }

  // 流结束时产生 done 事件
  yield {
    type: 'done',
    finishReason: finalFinishReason,
    usage: finalUsage,
  }
}
```

### Step 3: 实现 streamMessage()

```ts
async function* streamMessage(
  apiKey: string,
  baseUrl: string,
  params: SendMessageParams
): AsyncGenerator<StreamEvent> {
  const { body } = buildRequestBody({
    model: params.model,
    messages: params.messages,
    tools: params.tools,
    maxTokens: params.maxTokens,
    temperature: params.temperature,
    thinking: params.thinking,
  })

  try {
    const res = await httpRequest({
      url: `${baseUrl}/chat/completions`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: params.signal,
    })

    const chunks = parseSSEStream(res.body)
    yield* aggregateStream(chunks)

  } catch (e) {
    // 用户主动取消（AbortController.abort()）→ 正常结束 AsyncGenerator
    if (e instanceof HttpAbortError) {
      return  // for-await 自然退出
    }
    // 其他错误（网络/超时/服务端）→ 抛给调用方处理
    throw e
  }
}
```

### Step 4: 实现 collectStreamResponse()

从 `StreamEvent` 流重建 `SendMessageResult`。Agent Loop 用这个函数消费流，拿到完整响应做决策。

```ts
import type { SendMessageResult, StreamEvent, ToolCall, TokenUsage } from '../types'

/**
 * 消费 StreamEvent 流，重建完整的 SendMessageResult。
 *
 * 内部逻辑：
 *   1. 遍历流事件，累积 text 片段
 *   2. 按 tool call id 收集 tool_call_start + tool_call_delta，重建 ToolCall[]
 *   3. 从 done 事件提取 finishReason 和 usage
 */
async function collectStreamResponse(
  stream: AsyncGenerator<StreamEvent>
): Promise<SendMessageResult> {
  let text = ''
  const toolCallsMap = new Map<string, { name: string; argumentsStr: string }>()
  let finishReason = 'stop' as string
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

  for await (const event of stream) {
    switch (event.type) {
      case 'text':
        text += event.content
        break

      case 'tool_call_start':
        toolCallsMap.set(event.id, { name: event.name, argumentsStr: '' })
        break

      case 'tool_call_delta':
        if (toolCallsMap.has(event.id)) {
          toolCallsMap.get(event.id)!.argumentsStr += event.arguments
        }
        break

      case 'done':
        finishReason = event.finishReason
        if (event.usage) usage = event.usage
        break
    }
  }

  const toolCalls: ToolCall[] = Array.from(toolCallsMap.entries()).map(([id, tc]) => ({
    id,
    type: 'function' as const,
    function: {
      name: tc.name,
      arguments: tc.argumentsStr,
    },
  }))

  return { text, toolCalls, finishReason, usage }
}
```

### Step 5: 实现 createDeepSeekClient() 工厂函数 + index.ts

```ts
// core/src/provider/deepseek-client.ts

import type { DeepSeekClient, SendMessageParams } from '../types/provider'
import type { ProviderConfig } from '../config/types'

export function createDeepSeekClient(config: ProviderConfig): DeepSeekClient {
  const apiKey = config.apiKey
  const baseUrl = config.baseUrl.replace(/\/$/, '')

  return {
    streamMessage: (params: SendMessageParams) =>
      streamMessage(apiKey, baseUrl, {
        ...params,
        model: params.model || config.defaultModel,
        maxTokens: params.maxTokens ?? config.maxTokens,
        temperature: params.temperature ?? config.temperature,
      }),
  }
}
```

```ts
// core/src/provider/index.ts —— 统一导出
export { createDeepSeekClient, collectStreamResponse } from './deepseek-client'
export type {
  DeepSeekClient,
  SendMessageParams,
  SendMessageResult,
  StreamEvent,
  FinishReason,
  TokenUsage,
} from '../types/provider'
```
```

---

## 类型文件补充

Phase 3 需要在 `core/src/types/` 中创建 Provider 相关的共享类型。

**文件位置约定**：
- `StreamEvent` 定义在 `core/src/provider/deepseek-client.ts` 中（和聚合逻辑紧耦合），从 `index.ts` 重新导出
- `DeepSeekClient`、`SendMessageParams`、`SendMessageResult`、`FinishReason`、`TokenUsage` 定义在 `core/src/types/provider.ts` 中
- `collectStreamResponse` 定义并导出在 `core/src/provider/deepseek-client.ts`
- `ProviderConfig` 定义在 `core/src/config/types.ts` 中（Phase 1 已创建）

```ts
// core/src/types/provider.ts
import type { Message, ToolCall, ToolDefinition } from './index'

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'insufficient_system_resource'
// ⚠️ 必须与 deepseek-types.ts 中的 FinishReason 保持一致。
//    两个定义相同但分属不同模块：deepseek-types.ts 描述 API 格式，provider.ts 描述内部类型。

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface SendMessageParams {
  model?: string
  messages: Message[]
  tools?: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  thinking?: { type: 'enabled' | 'disabled'; reasoning_effort?: 'high' | 'max' }
}

export interface SendMessageResult {
  text: string
  toolCalls: ToolCall[]
  finishReason: FinishReason
  usage: TokenUsage
}

/** Agent 层依赖的接口——Provider 只要实现这个就行 */
export interface DeepSeekClient {
  streamMessage(params: SendMessageParams): AsyncGenerator<import('../provider/deepseek-client').StreamEvent>
}

// core/src/config/types.ts（Phase 1 已建，此处确认字段）
export interface ProviderConfig {
  apiKey: string
  baseUrl: string          // 默认 'https://api.deepseek.com/v1'
  defaultModel: string     // 默认 'deepseek-v4-pro'
  maxTokens: number        // 默认 4096
  temperature: number      // 默认 1
  timeout: number          // 默认 120000
  maxRetries: number       // 默认 3
}
```

---

## 验证

### 测试 1：streamMessage 流式文本

```ts
console.log('=== streamMessage text ===')
const stream = client.streamMessage({
  messages: [{ role: 'user', content: '用三句话介绍 TypeScript' }],
  maxTokens: 500,
})

for await (const event of stream) {
  if (event.type === 'text') {
    process.stdout.write(event.content)  // 逐字输出
  } else if (event.type === 'done') {
    console.log('\n---')
    console.log('Done:', event.finishReason, event.usage)
  }
}
```

### 测试 2：collectStreamResponse 重建 SendMessageResult

```ts
import { createDeepSeekClient, collectStreamResponse } from './deepseek-client'

const client = createDeepSeekClient({ /* config */ })

const stream = client.streamMessage({
  messages: [{ role: 'user', content: '说"你好世界"然后停下来' }],
  maxTokens: 200,
})

const result = await collectStreamResponse(stream)

console.log('text:', result.text)            // "你好世界"
console.log('toolCalls:', result.toolCalls)  // []
console.log('finishReason:', result.finishReason)  // 'stop'
console.log('usage:', result.usage)          // { promptTokens: N, completionTokens: N, totalTokens: N }
```

**带 tool call 的测试**：

```ts
const stream2 = client.streamMessage({
  messages: [{ role: 'user', content: '帮我读 /tmp/test.txt' }],
  tools: [{
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from disk',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  }],
})

const result2 = await collectStreamResponse(stream2)
// result2.toolCalls[0].function.name === 'read_file'
// JSON.parse(result2.toolCalls[0].function.arguments).path 包含文件路径
```

### 测试 3：streamMessage 直接消费（不用 collectStreamResponse）

```ts
console.log('=== streamMessage tool calls ===')
const stream = client.streamMessage({
  messages: [
    { role: 'user', content: '帮我读 /tmp/test.txt' }
  ],
  tools: [{
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from disk',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path' } },
        required: ['path'],
      },
    },
  }],
})

for await (const event of stream) {
  switch (event.type) {
    case 'text':
      process.stdout.write(event.content)
      break
    case 'tool_call_start':
      console.log(`\n🔧 Calling: ${event.name}`)
      break
    case 'tool_call_delta':
      process.stdout.write(event.arguments)
      break
    case 'done':
      console.log(`\nDone: ${event.finishReason}`)
      break
  }
}
```

### 测试 4：验证 Abort 行为

```ts
const controller = new AbortController()

const stream = client.streamMessage({
  messages: [{ role: 'user', content: '写一首很长的诗...' }],
  signal: controller.signal,
})

// 500ms 后取消
setTimeout(() => {
  console.log('\nAborting...')
  controller.abort()
}, 500)

let count = 0
for await (const event of stream) {
  count++
  console.log(count, event.type)
}
console.log(`Stream ended after ${count} events (expect < 20 or so)`)
// 期望：abort 后 for-await 正常退出，不抛异常
```

### 测试 5：验证 thinking 模式（reasoning_content 被过滤）

```ts
const stream = client.streamMessage({
  model: 'deepseek-v4-pro',
  messages: [{ role: 'user', content: '1+1 等于几？请写出推理过程' }],
  thinking: { type: 'enabled' },
  maxTokens: 500,
})

let hasText = false
for await (const event of stream) {
  if (event.type === 'text') {
    hasText = true
    process.stdout.write(event.content)
  }
}
// 期望：hasText === true
// 期望：没有把 reasoning_content 混到 text 中输出
// 期望：输出的 content 直接是 "1+1=2" 这种正文，不是思维链
```

---

## 验收标准

- [ ] `streamMessage` 文本流：`{ type: 'text' }` 事件逐 token 产出
- [ ] `streamMessage` tool call 流：先产出 `tool_call_start`，再逐 fragment 产出 `tool_call_delta`
- [ ] `streamMessage` 最终产出 `{ type: 'done' }` 带 `finishReason` 和 `usage`
- [ ] `collectStreamResponse` 从流事件正确重建 `SendMessageResult`（text / toolCalls / usage 完整）
- [ ] `collectStreamResponse` 在 tool call 场景下 `toolCalls[].function.arguments` 是有效 JSON
- [ ] 携带 tool 历史继续对话：将之前的 tool_result 放回 `messages`，模型基于结果回复
- [ ] `thinking.enabled` 模式下，`reasoning_content` 被过滤，不暴露到 StreamEvent
- [ ] `signal.abort()` 后 `streamMessage` 的 for-await 正常退出，不抛异常
