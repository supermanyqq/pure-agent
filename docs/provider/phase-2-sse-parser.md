# Phase 2：SSE 流解析器（sse-parser.ts）

## 前置依赖

- Phase 1 的 `http-client.ts`（提供 `HttpResponse.body: ReadableStream` 作为输入——但 sse-parser 本身不 import http-client，它只依赖 `ReadableStream` 接口）
- Phase 2 还需要创建 `deepseek-types.ts`（定义 `DeepSeekStreamChunk` 类型），因为这个类型是 sse-parser 的输出

## 目标

实现 `parseSSEStream()`——把 `text/event-stream` 格式的 HTTP 响应体转换为结构化的事件流 `AsyncGenerator<DeepSeekStreamChunk>`。

**不做的事**：
- 不拼接 tool_calls 的 arguments JSON 片段（那是 Phase 3 deepseek-client 的事）
- 不过滤 reasoning_content（Phase 3 的事）
- 只做一件事：**SSE 协议格式 → 解析好的 JSON 对象**

## 产出文件

```
core/src/provider/
├── http-client.ts     # Phase 1（已完成）
├── errors.ts          # Phase 1（已完成）
├── sse-parser.ts      # 本期实现
├── deepseek-types.ts  # 本期实现（DeepSeekStreamChunk 类型）
├── deepseek-client.ts # Phase 3
└── index.ts           # Phase 3
```

---

## 背景知识：SSE 协议格式

DeepSeek 流式响应的 raw bytes：

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"你"},"index":0}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"好"},"index":0}]}

data: [DONE]
```

关键特征：
- 每条消息以 `data: ` 开头（注意后面有一个空格）
- 消息体是 JSON 字符串
- 双换行 `\n\n` 分隔消息
- `data: [DONE]` 是结束标记
- **消息可能跨 TCP chunk 边界**——一个 `data:` 行的 JSON 可能被切成两半落在两个 chunk 中

---

## 实施步骤

### Step 1: 创建 deepseek-types.ts

```ts
// core/src/provider/deepseek-types.ts
// 这些类型按 DeepSeek API 文档原样映射，不对外暴露

export interface DeepSeekRequestBody {
  model: string
  messages: DeepSeekMessage[]
  stream?: boolean
  stream_options?: { include_usage: boolean }
  max_tokens?: number
  temperature?: number
  top_p?: number
  tools?: DeepSeekToolDefinition[]
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } }
  thinking?: { type: 'enabled' | 'disabled'; reasoning_effort?: 'high' | 'max' }
  response_format?: { type: 'text' | 'json_object' }
  stop?: string | string[]
  user_id?: string
}

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  name?: string
  tool_calls?: DeepSeekToolCall[]
  tool_call_id?: string
}

export interface DeepSeekToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface DeepSeekToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface DeepSeekResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  system_fingerprint?: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      reasoning_content?: string
      tool_calls?: DeepSeekToolCall[]
    }
    finish_reason: FinishReason
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    completion_tokens_details?: { reasoning_tokens: number }
  }
}

export interface DeepSeekStreamChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  system_fingerprint?: string
  choices: Array<{
    index: number
    delta: {
      role?: 'assistant'
      content?: string
      reasoning_content?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: FinishReason | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'insufficient_system_resource'
```

### Step 2: 实现 sse-parser.ts

```ts
// core/src/provider/sse-parser.ts
import type { DeepSeekStreamChunk } from './deepseek-types'

const SSE_DATA_PREFIX = 'data: '

/**
 * 解析 SSE (Server-Sent Events) 流。
 *
 * 接收 HTTP 响应的 body（ReadableStream），逐 chunk 读取二进制字节，
 * 按 SSE 帧格式解析，yield 每个解析好的 DeepSeekStreamChunk。
 *
 * 粘包/拆包处理：
 *   - Chunk 边界不一定对齐 SSE 帧边界
 *   - 维护一个字符串 buffer，每次追加新 chunk 的文本
 *   - 从 buffer 中提取完整的 SSE 帧（以 \n\n 分隔）
 *   - 不完整的帧留在 buffer 中，等下一个 chunk
 *
 * 错误策略：
 *   - 单行 JSON 解析失败 → 容错，跳过该行，继续后续行
 *   - 流整体不是有效 SSE 格式 → 抛 SSEParseError
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<DeepSeekStreamChunk> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        // 流结束，处理 buffer 中剩余的最后一个帧
        if (buffer.trim()) {
          const chunk = tryExtractChunk(buffer.trimEnd())
          if (chunk) yield chunk
        }
        return
      }

      // 1. 二进制 → 文本
      buffer += decoder.decode(value, { stream: true })

      // 2. 从 buffer 中提取完整帧（\n\n 分隔的）
      const lines = buffer.split('\n\n')
      // 最后一段可能不完整，留在 buffer 中
      buffer = lines.pop() ?? ''

      // 3. 处理每个完整帧
      for (const line of lines) {
        const chunk = tryExtractChunk(line)
        if (chunk) yield chunk
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * 从一帧 SSE 文本中提取 DeepSeekStreamChunk。
 * 帧格式：`data: <JSON>` 或 `data: [DONE]`。
 * 返回 null 表示该帧应跳过（`[DONE]` 标记 或 非 data 行 或 JSON 解析失败）。
 */
function tryExtractChunk(frameText: string): DeepSeekStreamChunk | null {
  // 按行分割帧（一个帧可能包含多条 data 行，但 DeepSeek 总是单条）
  const dataLines = frameText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith(SSE_DATA_PREFIX))

  // 没有 data 行 → 跳过（可能是一行空的 event: 或 comment:）
  if (dataLines.length === 0) return null

  // 取第一条 data 行（DeepSeek 总是单条 data 行）
  const jsonStr = dataLines[0].slice(SSE_DATA_PREFIX.length)

  // [DONE] 标记 → 流结束，不产生 chunk
  if (jsonStr === '[DONE]') return null

  try {
    return JSON.parse(jsonStr) as DeepSeekStreamChunk
  } catch {
    // 单行 JSON 解析失败 → 容错，跳过（不抛异常，不阻断流）
    console.warn('[sse-parser] Skipped malformed JSON line:', jsonStr.slice(0, 80))
    return null
  }
}
```

---

## 验证

### 测试 1：基本 SSE 解析

```ts
// core/src/provider/__tests__/sse-parser.test.ts
import { parseSSEStream } from '../sse-parser'

/** 将字符串转为 ReadableStream<Uint8Array> 以便测试 */
function stringToStream(s: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(s))
      controller.close()
    },
  })
}

describe('parseSSEStream', () => {
  it('parses a simple text delta chunk', async () => {
    const sseData = `data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"你好"}}]}\n\n`

    const gen = parseSSEStream(stringToStream(sseData))
    const results: any[] = []
    for await (const chunk of gen) {
      results.push(chunk)
    }

    expect(results).toHaveLength(1)
    expect(results[0].choices[0].delta.content).toBe('你好')
  })

  it('stops on [DONE]', async () => {
    const sseData = [
      `data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"x"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join('')

    const gen = parseSSEStream(stringToStream(sseData))
    const results: any[] = []
    for await (const chunk of gen) {
      results.push(chunk)
    }

    expect(results).toHaveLength(1) // [DONE] 不产生 chunk
  })

  it('handles partial chunk (cross-chunk boundary)', async () => {
    // 模拟跨 chunk 的 data 行：JSON 被切成两半
    const encoder = new TextEncoder()
    const full = `data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"你好世界"}}]}\n\n`
    const splitPoint = 50 // 在 JSON 中间切开

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(full.slice(0, splitPoint)))
        controller.enqueue(encoder.encode(full.slice(splitPoint)))
        controller.close()
      },
    })

    const gen = parseSSEStream(stream)
    const results: any[] = []
    for await (const chunk of gen) {
      results.push(chunk)
    }

    expect(results).toHaveLength(1)
    expect(results[0].choices[0].delta.content).toBe('你好世界')
  })

  it('handles multiple chunks in one TCP frame', async () => {
    // 同一个 TCP 帧中包含多个完整的 SSE 帧
    const sseData = [
      `data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"A"}}]}\n\n`,
      `data: {"id":"2","object":"chat.completion.chunk","created":2,"model":"test","choices":[{"index":0,"delta":{"content":"B"}}]}\n\n`,
      `data: {"id":"3","object":"chat.completion.chunk","created":3,"model":"test","choices":[{"index":0,"delta":{"content":"C"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join('')

    const gen = parseSSEStream(stringToStream(sseData))
    const results: any[] = []
    for await (const chunk of gen) {
      results.push(chunk)
    }

    expect(results).toHaveLength(3)
    expect(results.map((r: any) => r.choices[0].delta.content)).toEqual(['A', 'B', 'C'])
  })

  it('skips malformed JSON gracefully', async () => {
    const sseData = [
      `data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"good"}}]}\n\n`,
      `data: {this is not valid json}\n\n`,
      `data: {"id":"3","object":"chat.completion.chunk","created":3,"model":"test","choices":[{"index":0,"delta":{"content":"also good"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join('')

    const gen = parseSSEStream(stringToStream(sseData))
    const results: any[] = []
    for await (const chunk of gen) {
      results.push(chunk)
    }

    // 中间的无效行被跳过
    expect(results).toHaveLength(2)
    expect(results[0].choices[0].delta.content).toBe('good')
    expect(results[1].choices[0].delta.content).toBe('also good')
  })

  it('handles empty stream', async () => {
    const gen = parseSSEStream(stringToStream(''))
    const results: any[] = []
    for await (const chunk of gen) {
      results.push(chunk)
    }
    expect(results).toHaveLength(0)
  })
})
```

### 测试 2：用真实 DeepSeek 流式 API 验证

```ts
// 手动脚本：验证 sse-parser 能解析真实 DeepSeek 流
import ky from 'ky'
import { parseSSEStream } from './sse-parser'

const res = await ky.post('https://api.deepseek.com/v1/chat/completions', {
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
  },
  body: JSON.stringify({
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: '说"你好世界"' }],
    stream: true,
  }),
})

const gen = parseSSEStream(res.body!)
let chunkCount = 0
for await (const chunk of gen) {
  chunkCount++
  const delta = chunk.choices[0]?.delta
  if (delta?.content) console.log('TEXT:', delta.content)
}
console.log(`Total chunks: ${chunkCount}`)
// 期望：多个 chunk，最后一个之后是 [DONE]
```

### 测试 3：用真实 DeepSeek 验证 tool_calls 流式输出

```ts
// 手动脚本：验证 tool_calls 的 SSE 解析
import ky from 'ky'
import { parseSSEStream } from './sse-parser'

const res = await ky.post('https://api.deepseek.com/v1/chat/completions', {
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
  },
  body: JSON.stringify({
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: '用 read_file 工具读一下 /tmp/test.txt' }],
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
    stream: true,
  }),
})

const gen = parseSSEStream(res.body!)
for await (const chunk of gen) {
  const delta = chunk.choices[0]?.delta
  if (delta?.tool_calls) {
    console.log('TOOL_CALL:', JSON.stringify(delta.tool_calls, null, 2))
  }
}
// 期望：看到 tool_calls delta，arguments 分多次推送
```

---

## 验收标准

- [ ] 单帧解析正确（text delta 产出正确的 chunk 对象）
- [ ] 多帧并包解析正确（同一 TCP 帧中的多个 SSE 帧各产出独立 chunk）
- [ ] 跨 chunk 拆包解析正确（JSON 被切成两半仍能正确解析）
- [ ] `[DONE]` 不产生 chunk
- [ ] 无效 JSON 行不阻断流，跳过继续
- [ ] 真实 DeepSeek 流式 API 端到端验证通过（text + tool_calls）

## 下一步

Phase 2 完成后，`parseSSEStream()` 可以解析任何 OpenAI 兼容格式的 SSE 流。Phase 3 用它的 `DeepSeekStreamChunk` 做语义聚合（拼接 tool_calls arguments、过滤 reasoning_content、产生 StreamEvent）。
