# AGENTS.md

## 项目定位

Pure Agent 是一个**生产级 Agent 项目**，同时具备**教学目的**。

**生产级**意味着：
- 核心逻辑全部手写（Provider 协议层、Agent Loop、工具系统、上下文管理），不依赖任何 LLM 框架
- 完整的工程实践：TypeScript strict 模式、单元测试覆盖、类型契约、错误处理分层
- 支持真实的多轮工具调用、流式响应、上下文窗口管理和 token 精确计算

**教学目的**意味着：
- `docs/` 目录按功能模块组织，每个模块包含 `design.md`（设计思路）和 `phase-N-*.md`（按阶段拆分的实现细节）
- 任何人可以按 `docs/architecture.md` → 各模块 `design.md` → 各模块 `phase-*.md` 的顺序阅读，快速理解「怎么从零构建一个生产级 Agent」
- 关键技术决策（为什么选 A 不选 B）在 design.md 中明确记录

**目标读者**：希望深入理解 Agent 系统每一层（LLM API 交互、SSE 流解析、Function Calling 协议、Agent 决策循环、Context 管理）的开发者。

---

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

## docs 目录文档组织

- 每个功能模块需要在 `docs/` 下建独立目录存放相关文档
- 每个模块必须有一篇 `design.md`，只阐述设计思路和高层架构，不涉及具体实现细节。目标读者是想快速了解「这个功能是怎么做的」的人
- 具体实现细节按执行阶段拆分为多个 `phase-N-description.md` 文档，AI 按照这些拆分的文档逐步完成功能编码

示例结构：

```
docs/
├── architecture.md            # 全局架构（可选）
├── provider/
│   ├── design.md              # Provider 模块设计思路
│   ├── phase-1-http-client.md
│   ├── phase-2-sse-parser.md
│   └── phase-3-deepseek-client.md
└── agent-loop/
    ├── design.md              # Agent Loop 设计思路
    ├── phase-1-step-builder.md
    ├── phase-2-loop.md
    └── phase-3-tool-executor.md
```
