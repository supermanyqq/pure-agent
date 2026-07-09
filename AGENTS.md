# AGENTS.md

本项目编码规范。只写项目特有的约定，通用 Clean Code 原则不重复。

---

## 命名

| 类型 | 风格 | 示例 |
|---|---|---|
| 文件 | kebab-case | `http-client.ts`、`sse-parser.ts` |
| 类 / 接口 | PascalCase | `DeepSeekClient`、`StreamEvent` |
| 函数 / 变量 | camelCase | `buildRequestBody`、`toolCalls` |
| 常量 | SCREAMING_SNAKE_CASE | `DEFAULT_TIMEOUT_MS`、`SSE_DATA_PREFIX` |

## 魔法数字

项目中出现的所有字面量必须提取为命名常量：

```ts
// ✗ 禁止
const res = await ky.post(url, { timeout: 120000, retry: { limit: 3 } })

// ✓ 必须
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_RETRIES = 3
const res = await ky.post(url, { timeout: DEFAULT_TIMEOUT_MS, retry: { limit: DEFAULT_MAX_RETRIES } })
```

## TypeScript

- **禁止 `any`**。特殊情况需要时加注释说明原因，优先用 `unknown`
- **用联合类型，不用 enum**：`type AgentState = 'idle' | 'thinking'` 而非 `enum AgentState { ... }`
- **类型本身就是文档**：能用类型表达的不写注释

```ts
// ✗ 避免
/** @param status HTTP status code */
function handle(status: any) { ... }

// ✓ 优先
function handle(status: number): void { ... }
```

## 模块结构

- 一个文件只做一件事。当前模块划分：
  ```
  provider/
  ├── http-client.ts       # 只负责 HTTP 传输（ky 封装）
  ├── sse-parser.ts        # 只负责 SSE 协议解析
  ├── deepseek-client.ts   # 只负责 DeepSeek API 格式翻译 + 流聚合
  └── errors.ts            # 只负责错误类型定义
  ```
- 模块间只通过接口通信（`DeepSeekClient`），不跨层访问内部实现
- Provider 层**只有流式调用**（`streamMessage`），无非流式的 `sendMessage`

## 函数

- 参数超过 3 个时封装为对象：

```ts
// ✗ 避免
function createClient(apiKey: string, baseUrl: string, model: string, maxTokens: number, temperature: number)

// ✓ 正确
function createClient(config: ProviderConfig)
```

## 注释

- 公共 API 用 JSDoc 描述接口契约
- 非显而易见的设计决策写注释（为什么选 A 不选 B）
- 禁止被注释掉的代码——用 git 历史追溯
