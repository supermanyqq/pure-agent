# Pure Agent — 整体架构设计

## 项目定位

一个**生产级**的 Agent 项目，包含终端 CLI 和 Electron 桌面端两个版本。目标是理解 Agent 系统的每一层：LLM API 交互、SSE 流解析、Function Calling 协议、Agent 决策循环、Context 管理。核心逻辑（Provider 协议层 + Agent Loop + 工具系统）全部手写，不依赖任何 LLM 框架。HTTP 传输层使用成熟的 `ky` 库（网络重试/超时不是 Agent 的知识点）。

首个版本接入 **DeepSeek**（OpenAI 兼容 API），后续扩展其他 provider 时通过抽象层切换。

---

## 技术选型

| 层 | 选择 | 原因 |
|---|---|---|
| 语言 | TypeScript (strict) | 前后统一语言，核心代码 100% 复用 |
| 运行时 | Node.js 20+ | 稳定、ESM、内置 fetch |
| 包管理 | pnpm workspace | 轻量 monorepo |
| 构建 | tsc + esbuild | 简单透明，无黑盒 |
| LLM Provider | [DeepSeek](https://api-docs.deepseek.com/) | OpenAI 兼容 API，当前模型：`deepseek-v4-pro`、`deepseek-v4-flash` |
| LLM 调用 | 手写 SSE 解析 + API 协议层，HTTP 传输用 [ky](https://github.com/sindresorhus/ky) | 不依赖任何 LLM SDK，ky 只负责网络传输 |
| CLI 终端框架 | [ink](https://github.com/vadimdemedes/ink) | React 渲染终端 UI，组件化开发 TUI |
| CLI 参数解析 | commander | 轻量，社区标准 |
| CLI 流式 Markdown | [streammark](https://www.npmjs.com/package/streammark) | 零依赖，专为 LLM 流式输出设计，自动缓冲未闭合语法 |
| 桌面框架 | Electron | 成熟稳定，生态最好 |
| 桌面构建 | Vite | 快，HMR 开箱即用 |
| 桌面 UI | React + Ant Design + Tailwind CSS | React 组件化 + 成熟设计系统 + 原子化样式 |
| 桌面流式 Markdown | [streamdown](https://github.com/vercel/streamdown) | 处理 AI 逐 token 输出时的未闭合 Markdown，drop-in 替代 react-markdown |

### 两端流式 Markdown 方案说明

Provider 层输出的 `llm:stream:text` 事件是纯文本，两端各自用不同的库渲染 Markdown：

| 端 | 库 | 原因 |
|---|---|---|
| Desktop | streamdown | 基于 DOM，在浏览器环境中处理未闭合 Markdown |
| CLI | streammark | 零依赖，输出 ANSI 字符串，在 ink 组件中直接使用 |

两者都解决了同一个核心问题：AI 逐 token 输出时 Markdown 语法可能不完整（未闭合的代码块、表格、列表等），需要渲染器能缓冲和容错。

---

## Monorepo 结构

```
pure-agent/
├── docs/                        # 所有文档
│   ├── architecture.md          # 本文档：整体架构设计 + 技术选型
│   │
│   ├── provider/                # Provider 层文档
│   │   ├── design.md            #   总体设计
│   │   ├── phase-1-http-client.md   #   阶段1：HTTP 客户端封装
│   │   ├── phase-2-sse-parser.md    #   阶段2：SSE 流解析器
│   │   └── phase-3-deepseek-client.md # 阶段3：DeepSeek API 封装
│   │
│   ├── agent-loop/              # Agent Loop 文档
│   │   ├── design.md            #   总体设计
│   │   ├── phase-1-step-builder.md  #   阶段1：请求构建
│   │   ├── phase-2-loop.md          #   阶段2：核心循环
│   │   └── phase-3-tool-executor.md #   阶段3：工具执行调度
│   │
│   ├── tool-system/             # 工具系统文档
│   │   ├── design.md            #   总体设计
│   │   ├── phase-1-registry.md      #   阶段1：工具注册表
│   │   └── phase-2-builtin-tools.md #   阶段2：内置工具实现
│   │
│   └── context-management/      # 上下文管理文档
│       ├── design.md            #   总体设计
│       ├── phase-1-history.md       #   阶段1：消息历史管理
│       ├── phase-2-token-count.md   #   阶段2：Token 估算
│       └── phase-3-trimmer.md       #   阶段3：裁剪与摘要
│
├── packages/
│   ├── core/                    # Agent 引擎（被 CLI 和 Desktop 共享）
│   │   └── src/
│   │       ├── types/           # 共享类型定义
│   │       ├── provider/        # LLM Provider 层（手写 HTTP + SSE + DeepSeek）
│   │       ├── agent/           # Agent Loop 核心决策循环
│   │       ├── tools/           # 工具系统（注册、执行、内置工具）
│   │       ├── context/         # 上下文管理（历史、Token 估算、裁剪）
│   │       ├── events/          # Agent 生命周期事件系统
│   │       ├── config/          # 配置加载与管理
│   │       └── index.ts
│   │
│   ├── cli/                     # 终端 CLI 应用
│   │   └── src/
│   │       ├── commands/        # run / repl / config 命令
│   │       ├── components/      # Ink 终端 UI 组件
│   │       ├── hooks/           # Agent 状态 Hook
│   │       └── index.ts
│   │
│   └── desktop/                 # Electron 桌面应用
│       └── src/
│           ├── main/            # Electron 主进程（运行 core）
│           ├── preload/         # Context bridge（安全 IPC）
│           ├── renderer/        # React 渲染进程（Vite + Antd + Tailwind）
│           └── shared/          # IPC 通道常量
│
├── package.json                 # workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── turbo.json
```

---

## Core 引擎 — 模块总览

Core 包是纯 TypeScript 逻辑，不依赖任何 UI 框架。七个模块按依赖关系分层：

```
config ───────────────────────────────────────┐
                                              │
events ──────────────────────────────────────┤
                                              │
context ─────────────────────────────────────┤
                                              │
tools ───────────────────────────────────────┤
                                              │
provider ───► agent ───► (CLI / Desktop)
                                              │
types ───────────────────────────────────────┘
```

| 模块 | 职责 | 详细文档 |
|---|---|---|
| **types** | 定义 Message、Tool、AgentState、Provider 请求/响应、Event 等共享类型 | — |
| **provider** | 手写 HTTP 客户端 + SSE 解析器 + DeepSeek API 封装（OpenAI 兼容格式） | [provider/design.md](./provider/design.md) |
| **agent** | Agent Loop 核心循环、请求构建、工具执行调度、终止判断 | [agent-loop/design.md](./agent-loop/design.md) |
| **tools** | Tool 接口定义、注册表、执行器、内置工具（文件读写、Shell、搜索等） | [tool-system/design.md](./tool-system/design.md) |
| **context** | 消息历史管理、Token 估算、上下文窗口裁剪、旧消息摘要 | [context-management/design.md](./context-management/design.md) |
| **events** | 基于 EventEmitter 的生命周期事件系统（agent:* / llm:* / tool:*） | — |
| **config** | 配置加载（命令行 > 环境变量 > 配置文件 > 默认值） | — |

### 模块间的核心数据流

```
CLI / Desktop（用户输入）
  │
  ▼
Agent Loop ──streamMessage(params)──► Provider ──HTTP POST──► DeepSeek API
  │                                      │
  │  collectStreamResponse()             │  SSE 流
  │  重建 SendMessageResult              │  (text delta / tool_calls delta / finish_reason)
  │    .text / .toolCalls /              │
  │    .finishReason / .usage            │
  │                                      │
  ├── finishReason === 'stop' ──► 返回最终文本给用户
  │
  └── finishReason === 'tool_calls'
        │
        ▼
      Tool Executor ──► Tool Registry
        │                  (read_file, write_file,
        │                   shell_exec, web_search,
        │                   web_fetch)
        │
        ▼ tool_result 消息插入对话历史
        │
        └──► Agent Loop 下一轮（带上 tool 结果）
```

**Agent Loop 和 CLI/Desktop 使用同一条流式路径**：

| 使用者 | 调用方式 | 消费方式 |
|---|---|---|
| Agent Loop | `client.streamMessage()` | `collectStreamResponse(stream)` → 重建 `SendMessageResult`，进入下一轮决策 |
| CLI / Desktop | `client.streamMessage()` | 直接 `for-await` 消费，逐事件渲染 UI |

区别只在于消费方式：Agent Loop 需要完整结果做决策，CLI/Desktop 需要逐字渲染给用户看。

---

### 共享类型定义

以下类型跨越多个模块，定义在 `core/src/types/` 中，是所有模块的类型契约基础：

```ts
// ─── Message ───

/** 一条对话消息，贯穿 Provider / Agent / Context 三个模块 */
type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string }

// 说明：
// - assistant 消息：content 为 null 时表示只有 tool_calls 没有文本
// - tool 消息：toolCallId 关联到之前的 assistant.toolCalls[].id

// ─── ToolCall ───

/** Provider 解析出的工具调用，Agent Loop 消费 */
interface ToolCall {
  id: string              // DeepSeek 生成的唯一 ID
  type: 'function'
  function: {
    name: string          // 工具名称
    arguments: string     // JSON 字符串，Tool Executor 负责解析
  }
}

// ─── ToolDefinition ───

/** Agent Loop 传给 Provider 的工具定义（序列化格式，不含 execute 函数） */
interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>  // JSON Schema 对象
  }
}

// ─── Agent 状态 ───

type AgentState = 'idle' | 'thinking' | 'executing' | 'done' | 'error' | 'stopped'

// ─── 事件类型 ───

type AgentEventName =
  | 'agent:start'         // Agent 开始运行
  | 'agent:thinking'      // 开始调用 LLM
  | 'agent:executing'     // 开始执行工具
  | 'agent:step'          // 一轮 think+act 完成
  | 'agent:done'          // 正常结束
  | 'agent:error'         // 异常结束
  | 'agent:stopped'       // 达到最大步数
  | 'tool:execute:start'  // 单个工具开始执行
  | 'tool:execute:end'    // 单个工具执行完成
```

---

### 配置管理补充说明

```
配置加载优先级：命令行参数 > 环境变量 > 配置文件 > 默认值
配置文件位置：  ~/.pure-agent/config.json
环境变量前缀：  PURE_AGENT_*（如 PURE_AGENT_API_KEY）
```

`config.json` 格式：

```json
{
  "provider": {
    "apiKey": "sk-xxx",
    "baseUrl": "https://api.deepseek.com/v1",
    "defaultModel": "deepseek-v4-pro"
  },
  "agent": {
    "maxTokens": 4096,
    "maxSteps": 25,
    "temperature": 0.7
  }
}
```

### Provider 层说明

DeepSeek API 兼容 OpenAI 的 Chat Completions 格式。截至 2026 年 7 月，可用模型：

| 模型 | 状态 | 说明 |
|---|---|---|
| `deepseek-v4-pro` | ✅ 当前推荐 | 能力最强，支持 thinking + tool calling |
| `deepseek-v4-flash` | ✅ 当前可用 | 速度优先，支持 thinking + tool calling |
| `deepseek-chat` | ⚠️ 2026/07/24 弃用 | 等同于 v4-flash 的非思考模式，需迁移 |
| `deepseek-reasoner` | ⚠️ 2026/07/24 弃用 | 等同于 v4-flash 的思考模式，需迁移 |

**与旧版的差异**：

| 新增 / 变更 | 说明 |
|---|---|
| `thinking` 参数 | 替代旧版的模型名区分。`{ type: "enabled" }` 开启思维链，`{ type: "disabled" }` 关闭 |
| `reasoning_content` | 两个模型都支持。思考模式下，推理过程在 `content` 之前流式输出 |
| `stream_options.include_usage` | 流式最后一个 chunk 可包含 token 用量 |
| Tool Calling | 两个模型都支持（旧版 reasoner 不支持） |
| `frequency_penalty` / `presence_penalty` | 已弃用，传了无效 |

Provider 层的核心差异（DeepSeek vs 后期 Anthropic）：

| 对比 | DeepSeek (OpenAI 格式) | Anthropic 格式（后期扩展） |
|---|---|---|
| 端点 | `POST /v1/chat/completions` | `POST /v1/messages` |
| 认证 | `Authorization: Bearer <key>` | `x-api-key: <key>` |
| 工具调用 | `tool_calls` 数组在 message 中 | `tool_use` content block |
| System Prompt | `messages[0]` role=system | 顶层 `system` 字段 |
| 流式事件 | `delta.tool_calls` 增量 | `content_block_start/delta` 事件 |

Provider 层的 `deepseek-client.ts` 封装这些细节，对外暴露统一的内部接口，后续扩展其他 provider 时只需新增对应的 client 实现。

---

## CLI Package

### 技术栈

| 依赖 | 用途 |
|---|---|
| `ink` + `react` | React 组件渲染终端 UI |
| `commander` | CLI 参数解析 |
| `streammark` | 流式 Markdown → ANSI 终端字符串 |
| `@pure-agent/core` | Agent 引擎 |

### 命令

```bash
pure-agent run "帮我分析代码"                  # 单次查询
pure-agent run --model deepseek-v4-pro "..."     # 指定模型
pure-agent repl                                  # 交互式 REPL
pure-agent config show                         # 查看配置
pure-agent config set api-key sk-xxx           # 设置 API Key
```

### Ink 组件树

```
<App>
  ├─ <Header />            # 版本 / 模型信息
  ├─ <ChatView>            # 对话列表
  │   ├─ <UserMessage />
  │   └─ <AssistantMessage>
  │       ├─ <Thinking>    # 思考中动画
  │       ├─ <MarkdownText> # streammark 渲染流式 Markdown
  │       └─ <ToolCall>    # 工具调用（名称 + 参数 + 结果）
  └─ <Input />             # 用户输入行
```

---

## Desktop Package

### 技术栈

| 依赖 | 用途 |
|---|---|
| `electron` | 桌面壳 |
| `react` + `react-dom` | UI 框架 |
| `antd` | 组件库（布局、表单、设置面板等） |
| `vite` | 构建工具 |
| `tailwindcss` | 原子化样式 |
| `streamdown` + `@streamdown/code` | 流式 Markdown 渲染 + 代码高亮 |
| `@pure-agent/core` | Agent 引擎（在主进程中运行） |

### 进程模型

```
Main Process                         Renderer Process
─────────────                        ────────────────
@pure-agent/core                    React App (Vite HMR)
  Provider / Agent / Tools            ├─ Ant Design (Layout, Form, Modal)
  ↓                                   ├─ Tailwind CSS (原子化样式)
IPC Handlers                          ├─ streamdown (流式 Markdown)
  ↓                                   └─ 订阅事件 → 逐 token 更新 UI
contextBridge ◄──────────────────── window.electronAPI
(preload.ts)       .runAgent()
                   .stopAgent()
                   .onAgentEvent()
```

### 核心组件

| 组件 | 功能 | 使用的库 |
|---|---|---|
| `Sidebar` | 会话列表、新建会话 | `Menu`, `Button` |
| `ChatView` | 聊天消息流 | `Layout` |
| `MessageBubble` | 消息气泡，assistant 用 `<Streamdown>` 渲染 | `Card`, `streamdown` |
| `ToolCallCard` | 工具调用卡片（可展开查看参数/结果） | `Collapse`, `Tag`, `Spin` |
| `ThinkingDot` | 思考中跳动圆点 | CSS animation |
| `InputBox` | 输入 + 发送 + 停止 | `Input.TextArea`, `Button` |
| `Header` | 当前模型 / 会话标题 | `Layout.Header` |
| `SettingsModal` | API Key、模型选择等 | `Modal`, `Form`, `Select` |

---

## 实施顺序

按依赖关系分层实现，每层可独立理解、测试：

| 阶段 | 模块 | 可验证产出 | 核心知识点 |
|---|---|---|---|
| **1** | 项目骨架 + Types + Events + Config | `tsc --noEmit` 通过，事件系统可触发 | Monorepo 搭建、TS 类型设计、事件驱动、配置加载 |
| **2** | Provider: http-client + sse-parser | 调用 DeepSeek API 拿到流式响应 | HTTP/SSE 协议、ReadableStream |
| **3** | Provider: deepseek-client | 发送消息拿到文本回复，验证 tool_calls 流式聚合 | DeepSeek API（OpenAI 兼容格式）、增量 JSON 拼接 |
| **4** | Tool System | 注册 + 执行内置工具 | 工具抽象、并行执行 |
| **5** | Agent Loop | Agent 用 tool 完成任务（"读 package.json 告诉我项目名"） | Agent 决策循环、function calling 协议 |
| **6** | Context Management | Agent 处理长对话不超窗口 | Token 估算、裁剪策略 |
| **7** | CLI (ink + streammark) | `pnpm cli repl` 交互对话 | React TUI、终端流式 Markdown |
| **8** | Desktop (Electron + Vite + streamdown) | `pnpm desktop:dev` 桌面窗口对话 | Electron IPC、流式 UI |

---

## 不引入的依赖

教学目的明确**不用**的库，以及替代方案：

| 不用的依赖 | 替代方案 |
|---|---|
| `openai` SDK | 手写 HTTP + SSE + deepseek-client |
| `@anthropic-ai/sdk` | 后期扩展时手写 anthropic-client |
| `langchain` / `@langchain/*` | 手写 agent-loop |
| `ai` (Vercel AI SDK) | 手写 provider 层 |
| `tiktoken` / `js-tiktoken` | 手写字符比率近似算法 |
| `react-markdown` | streamdown（桌面端）/ streammark（CLI） |
