# Phase 1：HTTP 客户端封装（http-client.ts）

## 前置依赖

- `core/src/types/` —— 无直接依赖。（errors.ts 中 `HttpError` 的定义在 Phase 1 一起完成）

## 目标

实现一个 `httpRequest()` 函数，基于 [ky](https://github.com/sindresorhus/ky) 封装，提供统一的 HTTP POST 请求能力。ky 内置超时、指数退避重试、429 自动遵守 `Retry-After`——这些不需要我们写。

http-client.ts 的职责只有两个：
1. 把参数统一收敛到 `HttpRequest` / `HttpResponse` 接口
2. 把 ky 的异常转换为 Provider 层的 `HttpError`

## 产出文件

```
core/src/provider/
├── http-client.ts    # 本期实现
├── errors.ts         # 本期实现（HttpError）
└── sse-parser.ts     # Phase 2
└── deepseek-client.ts # Phase 3
└── deepseek-types.ts  # Phase 2
└── index.ts           # Phase 3
```

---

## 实施步骤

### Step 1: 安装 ky

```bash
cd packages/core
pnpm add ky
```

ky 是一个 ES module 包，零额外依赖，体积 ~5KB。

### Step 2: 实现 errors.ts

创建 `core/src/provider/errors.ts`：

```ts
/**
 * Provider 层错误基类。
 * retryable 标记由 http-client 设置，供上层（Agent Loop）决定是否重试整个请求。
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

/** HTTP 传输层错误（网络/超时/状态码），由 http-client 抛出 */
export class HttpError extends ProviderError {
  constructor(
    public readonly status: number,  // HTTP 状态码，网络错误时 = 0
    retryable: boolean
  ) {
    const prefix = status === 0 ? 'Network error' : `HTTP ${status}`
    super(`${prefix}: request failed`, 'HTTP_ERROR', retryable)
    this.name = 'HttpError'
  }
}

/** 用户主动取消请求（AbortController.abort()），由 http-client 抛出 */
export class HttpAbortError extends HttpError {
  constructor() {
    super(0, false)
    this.name = 'HttpAbortError'
  }
}

/** SSE 流整体无效时抛出（Phase 2 实现 sse-parser 时使用） */
export class SSEParseError extends ProviderError {
  constructor(message: string) {
    super(message, 'SSE_PARSE_ERROR', false)
    this.name = 'SSEParseError'
  }
}

/** DeepSeek API 返回的业务错误（余额不足、模型不存在等），由 deepseek-client 抛出 */
export class ApiError extends ProviderError {
  constructor(message: string, retryable = false) {
    super(message, 'API_ERROR', retryable)
    this.name = 'ApiError'
  }
}
```

### Step 3: 实现 http-client.ts

```ts
import ky from 'ky'
import { HttpError, HttpAbortError } from './errors'

export interface HttpRequest {
  /** 完整 URL，如 'https://api.deepseek.com/v1/chat/completions' */
  url: string
  method: 'POST'
  headers: Record<string, string>
  /** JSON 字符串，由调用方（deepseek-client）负责序列化 */
  body: string
  signal?: AbortSignal
  /** 毫秒，默认 120000（2 分钟，适应 DeepSeek 长推理） */
  timeout?: number
  /** 最大重试次数，默认 3 */
  maxRetries?: number
}

export interface HttpResponse {
  status: number
  headers: Headers
  /** ReadableStream，ky 保证 DeepSeek 这类 API 的非 204 响应一定有 body */
  body: ReadableStream<Uint8Array>
}

/**
 * 发送 HTTP POST 请求。
 *
 * ky 内置行为（我们零代码获得）：
 * - 超时后自动 Abort
 * - 指数退避重试（默认 1s→2s→4s，上限 backoffLimit）
 * - 429 自动读 Retry-After 头，按指示等待后重试
 * - 网络错误（ECONNREFUSED 等）自动重试
 * - 非 2xx 抛 ky.HTTPError（我们转为 HttpError）
 */
export async function httpRequest(req: HttpRequest): Promise<HttpResponse> {
  try {
    const res = await ky.post(req.url, {
      headers: req.headers,
      body: req.body,
      timeout: req.timeout ?? 120_000,
      retry: {
        limit: req.maxRetries ?? 3,
        backoffLimit: 8_000,  // 最大退避 8 秒
        // 只重试这些状态码 + 网络错误
        statusCodes: [408, 429, 500, 502, 503, 504],  // 不含 413：请求过大重试不会变小
      },
      signal: req.signal,
      // 默认 behavior: throwOnHttpError = true，非 2xx 抛 HTTPError
    })

    return {
      status: res.status,
      headers: res.headers,
      // ky 的 Response 实现了 Body 接口，body 是 ReadableStream<Uint8Array> | null
      // DeepSeek 的非 204 响应一定有 body，这里用 non-null assertion
      body: res.body!,
    }
  } catch (e: unknown) {
    throw mapKyError(e)
  }
}

/**
 * 将 ky 的异常映射为 Provider 层的 HttpError。
 *
 * 映射规则：
 * ┌──────────────────────┬───────────┬──────────────────────────┐
 * │ 原始异常              │ HttpError │ 说明                     │
 * ├──────────────────────┼───────────┼──────────────────────────┤
 * │ ky.HTTPError (5xx)   │ retryable │ 服务端临时故障            │
 * │ ky.HTTPError (429)   │ retryable │ 限流（但 ky 通常已处理）  │
 * │ ky.HTTPError (4xx)   │ !retryable│ 请求错误，重试不会好       │
 * │ ky.TimeoutError      │ retryable │ 超时可能是临时的           │
 * │ AbortError           │ !retryable│ 用户主动取消               │
 * │ 其他网络错误          │ retryable │ 网络抖动                  │
 * └──────────────────────┴───────────┴──────────────────────────┘
 */
function mapKyError(e: unknown): HttpError {
  if (e instanceof ky.HTTPError) {
    const status = e.response.status
    const retryable = status >= 500 || status === 429
    return new HttpError(status, retryable)
  }
  if (e instanceof ky.TimeoutError) {
    return new HttpError(0, true)
  }
  // 注意：Node.js 20+ 中 AbortError 可能以 DOMException 出现
  if (e instanceof DOMException && e.name === 'AbortError') {
    return new HttpAbortError()
  }
  // 其他 Error（TypeError 网络不可达等）
  if (e instanceof Error) {
    return new HttpError(0, true)
  }
  // 极端情况：throw 了一个非 Error 对象
  return new HttpError(0, true)
}
```

---

## 验证

### 测试 1：正常请求（用 nock 模拟）

```bash
pnpm add -D nock
```

```ts
// core/src/provider/__tests__/http-client.test.ts
import nock from 'nock'
import { httpRequest } from '../http-client'
import { HttpError } from '../errors'

const API_URL = 'https://api.deepseek.com/v1/chat/completions'

describe('httpRequest', () => {
  it('returns status and body stream on success', async () => {
    nock('https://api.deepseek.com')
      .post('/v1/chat/completions')
      .reply(200, { choices: [] })

    const res = await httpRequest({
      url: API_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [] }),
    })

    expect(res.status).toBe(200)
    expect(res.body).toBeDefined()
  })

  it('throws HttpError(retryable=false) on 401', async () => {
    nock('https://api.deepseek.com')
      .post('/v1/chat/completions')
      .reply(401, { error: { message: 'Invalid API Key' } })

    await expect(
      httpRequest({
        url: API_URL,
        method: 'POST',
        headers: {},
        body: '{}',
      })
    ).rejects.toThrow(HttpError)

    // 验证 retryable 标记
    try {
      await httpRequest({ url: API_URL, method: 'POST', headers: {}, body: '{}' })
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError)
      expect((e as HttpError).status).toBe(401)
      expect((e as HttpError).retryable).toBe(false)
    }
  })

  it('throws HttpError(retryable=true) on 500', async () => {
    nock('https://api.deepseek.com')
      .post('/v1/chat/completions')
      .reply(500)

    try {
      await httpRequest({ url: API_URL, method: 'POST', headers: {}, body: '{}' })
    } catch (e) {
      expect((e as HttpError).retryable).toBe(true)
    }
  })

  // 注意：超时和重试行为由 ky 内部保证，不需要我们测试 ky 自身的功能。
  // 我们只验证错误映射是否正确。
})
```

### 测试 2：用真实 DeepSeek API 验证连通性

```ts
// 手动运行脚本（不在 CI 中执行，需要 API key）
import { httpRequest } from './http-client'

const res = await httpRequest({
  url: 'https://api.deepseek.com/v1/chat/completions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
  },
  body: JSON.stringify({
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 10,
  }),
})

console.log('Status:', res.status)  // 期望 200

// 验证 body 是可读流
const reader = res.body.getReader()
const { value } = await reader.read()
console.log('First bytes:', new TextDecoder().decode(value))  // 期望 JSON
```

## 验收标准

- [ ] `tsc --noEmit` 通过
- [ ] nock 模拟的 2xx/4xx/5xx 测试通过
- [ ] 用真实 API key 运行手动验证脚本，200 状态码 + 可读 body
- [ ] 用无效 API key 测试，得到 `HttpError(status=401, retryable=false)`

---

## 下一步

Phase 1 完成后，`httpRequest()` 可以用来发任何 HTTP POST 请求。Phase 2 用它的 `HttpResponse.body`（ReadableStream）作为 sse-parser 的输入。
