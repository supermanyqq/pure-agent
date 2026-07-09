# 生产级 Agent 能力体系

本文档以 [hermes-agent](https://github.com/NousResearch/hermes-agent)（Nous Research 开源的跨平台 AI Agent 框架）为参考，梳理一个生产级 Agent 需要具备的核心能力、各能力之间的关系、以及 Pure Agent 项目的实现规划。

---

## 一、能力全景图

```
                              ┌──────────────────────┐
                              │    Entry Points       │
                              │  CLI / IDE / Gateway  │
                              └──────────┬───────────┘
                                         │
                              ┌──────────▼───────────┐
                              │     Agent Loop        │  ← 核心编排引擎
                              │  run_conversation()   │
                              └──┬───────┬──────┬────┘
                                 │       │      │
              ┌──────────────────┼───────┼──────┼──────────────────┐
              │                  │       │      │                  │
    ┌─────────▼──────┐  ┌───────▼──┐ ┌──▼──────▼──┐  ┌───────────▼──────┐
    │ Prompt System  │  │ Provider │ │ Tool System │  │ Context Management│
    │ 系统 Prompt    │  │ 模型接入  │ │  工具系统    │  │   上下文窗口管理   │
    └────────────────┘  └──────────┘ └──────┬──────┘  └──────────────────┘
                                           │
                              ┌────────────┼────────────┐
                              │            │            │
                    ┌─────────▼───┐ ┌─────▼─────┐ ┌───▼──────────┐
                    │ 内置工具     │ │ MCP 工具  │ │ 插件工具      │
                    │ ~30 tools   │ │ 动态发现   │ │ 用户自定义    │
                    └─────────────┘ └───────────┘ └──────────────┘

                              ┌──────────────────────┐
                              │    Persistence        │
                              │  Session DB + Memory  │
                              └──────────────────────┘
```

---

## 二、核心能力详解

### 1. Agent Loop（核心编排引擎）

Agent Loop 是 Agent 系统的中枢神经。它回答三个问题：**什么时候调用 LLM、LLM 说要用工具时怎么做、什么时候停下来**。

**关键职责**：
- 驱动多轮 LLM 调用 + 工具执行的 while 循环
- 管理状态机转换（idle → thinking → executing → stopped/error）
- 协调 Provider、Tool System、Context Management 之间的数据流
- 发射生命周期事件供 UI 层订阅

**与 hermes-agent 的对应**：
- `run_agent.py` 中的 `AIAgent.run_conversation()` 是唯一的编排入口
- 支持三种 API 模式（OpenAI Chat Completions / Anthropic Messages / Codex Responses），Pure Agent 当前实现 OpenAI 兼容模式
- 工具执行支持并行（`ThreadPoolExecutor`）和串行两种模式

**设计约束**：
- 核心循环应为同步或单 async 循环——不过度分散到多个异步任务中
- 所有 abort/cancel 信号在每个 Step 开始前、流式迭代中、工具执行前检查
- 事件系统贯穿整个生命周期，UI 层只订阅事件不参与决策

**Pure Agent 现状**：已完整实现（`agent/loop.ts`），支持流式路径、5 状态机、4 个 abort 检查点、LoopDetector 死循环检测。

---

### 2. Provider Layer（模型接入层）

Provider 层是 Agent 与 LLM 服务之间的翻译层。它将内部的通用请求格式转换为特定 LLM Provider 的 API 格式，并将 API 返回转换为内部通用格式。

**关键职责**：
- 屏蔽不同 LLM Provider 的 API 差异（OpenAI 格式 vs Anthropic 格式 vs 其他）
- 处理 HTTP 传输、重试、超时、限流
- 解析 SSE 流式响应，聚合 tool_calls 增量片段
- 提供统一的流式接口供 Agent Loop 和 UI 消费

**与 hermes-agent 的对应**：
- `agent/transports/` 目录下定义 `ProviderTransport` 抽象接口
- 支持 18+ Provider，通过 `(provider, model)` → `(api_mode, api_key, base_url)` 解析
- Anthropic 模式下自动启用 Prompt Caching（节省 ~75% 输入成本）

**设计约束**：
- Agent Loop 只依赖抽象接口（`ChatProvider`），不感知具体 Provider
- 流式调用是唯一路径——Agent Loop 和 UI 走同一条流
- 新增 Provider 只需新增一个 transport/client 实现

**Pure Agent 现状**：已实现 DeepSeek Provider（OpenAI 兼容格式），架构预留了 Anthropic 扩展点。

---

### 3. Tool System（工具系统）

工具系统是 Agent 的**能力边界**。LLM 通过 Function Calling 协议选择工具，Agent Loop 通过 Tool Registry 调度执行。

**关键职责**：
- 工具注册、注销、发现
- 工具定义（JSON Schema）的管理和序列化
- 工具执行调度（并行/串行、超时、错误隔离）
- 工具结果格式化和返回

**与 hermes-agent 的对应**：
- **自注册模式**：`tools/*.py` 中的每个工具文件在 import 时自动调用 `registry.register()`，新增工具只需添加文件，零配置
- **四层架构**：Tool Implementation → Registry → Orchestration → Toolset Grouping
- 70+ 内置工具，分组为 ~28 个 Toolset（`web`, `debugging`, `safe`, `hermes-cli` 等）
- `check_fn` + 30s TTL 缓存：运行时过滤不可用工具（如 Docker 未安装时隐藏 Docker 工具）
- 参数类型矫正（`coerce_tool_args`）：LLM 返回的参数类型错误时自动修正（如 `"42"` → `42`）

**设计约束**：
- 工具定义与执行逻辑分离：传给 LLM 的只是 name + description + JSON Schema，永远不暴露执行代码
- 工具结果统一为字符串，错误不抛异常而是返回错误字符串让 LLM 看到后自我修正
- 工具定义按名称排序输出（保证 Prompt Caching 前缀稳定）
- 并行执行无依赖的工具，错误隔离（`Promise.allSettled` 语义）

**Pure Agent 现状**：接口已定义（`ToolRegistry` + `Tool`），内置工具待实现。

---

### 4. Context Management（上下文窗口管理）

Context Management 是 Agent 的**记忆管家**。LLM 的上下文窗口有限（DeepSeek V3: 1M tokens，但实际有效窗口需减去 completion reserve 和安全余量），长对话必须压缩旧消息。

**关键职责**：
- Token 估算（字符比率近似法 或 精确 BPE 计数）
- 多阶段渐进压缩（廉价预裁剪 → 边界确定 → LLM 结构化摘要 → 组装清理）
- 反注入保护（SUMMARY_PREFIX / SUMMARY_END_MARKER）
- 反抖动保护（连续无效压缩自动跳过）
- 会话持久化和跨会话记忆

**与 hermes-agent 的对应**：
- `context_compressor.py`（3083 行 Python）：四阶段压缩管线，Pure Agent 已移植其核心设计
- **Session Lineage**：每次压缩创建子会话，保留 parent_session_id 链（hermes 独有特性）
- **Memory System**：持久化记忆写入 `MEMORY.md`，通过 `session_search` 工具检索历史会话
- **Read/Re-Read Loop Prevention**：上下文压缩后注入已读文件列表，防止 Agent 忘记已读内容而反复读取

**设计约束**：
- 压缩以 Turn 为单位（不切割 tool_call/result pair）
- System prompt 永不被裁剪（最高优先级保留 + Prompt Caching 兼容）
- 摘要追加到 system prompt 后面（不影响前缀稳定性）
- LLM 摘要失败必须降级到确定性回退摘要，不能丢弃上下文

**Pure Agent 现状**：已完整实现四阶段压缩（tool-pruner → boundary-finder → summarizer → trimmer），含反注入前缀体系。

---

### 5. Prompt System（系统 Prompt 组装）

系统 Prompt 决定了 Agent 的行为模式、可用工具、安全约束和工作方式。

**关键职责**：
- 分层组装：稳定层（身份/工具指引）→ 上下文层（项目文件）→ 易变层（记忆/时间戳）
- Prompt Caching 优化：稳定前缀不随对话变化而失效
- 上下文文件发现：自动读取 `AGENTS.md`、`CLAUDE.md`、`.cursorrules` 等项目文件
- Chat Template：将 Message[] 序列化为 LLM 可接受的格式（含特殊 token）

**与 hermes-agent 的对应**：
- `prompt_builder.py`：三层 Prompt 结构（Stable / Context / Volatile）
- 对 Anthropic 模型自动启用 `system_and_3` 缓存策略
- 确定性 `call_id` 生成（SHA256 替代 UUID，保证缓存命中）

**Pure Agent 现状**：基础实现（`system-prompt.ts`），Prompt Caching 优化已规划。

---

### 6. Persistence（持久化与记忆）

持久化层保存会话历史，使 Agent 在重启后仍能"记住"之前的内容。

**关键职责**：
- 会话存储（消息历史、元数据、压缩血统）
- 全文检索（FTS5）- 跨会话搜索
- 持久化记忆（`MEMORY.md`）
- 会话隔离（按平台/用户/profile）

**与 hermes-agent 的对应**：
- SQLite + FTS5：WAL 模式支持并发读写
- Session Lineage：压缩时创建子会话，保留 parent_session_id 链
- 平台隔离：Gateway 场景下不同 chat_id 独立会话

**Pure Agent 现状**：待实现。

---

### 7. Entry Points（入口层）

入口层决定用户如何与 Agent 交互。

**hermes-agent 支持四种入口**：
- **CLI**（`cli.py`）：交互式终端 UI
- **Gateway**（`gateway/run.py`）：长驻消息网关，20+ 平台适配（Telegram、Discord、Slack、WhatsApp、微信等）
- **ACP Adapter**：JSON-RPC 接口，IDE 集成（VS Code、Zed、JetBrains）
- **Batch Runner + Python Library**：批量任务和程序化调用

**设计原则**：所有入口共享同一个 `AIAgent` 类，平台差异仅限入口层。

**Pure Agent 现状**：CLI（ink + commander）已基础实现，Desktop（Electron）已规划。

---

### 8. Plugin & Extension System（插件系统）

插件系统允许在不修改核心代码的情况下扩展 Agent 能力。

**与 hermes-agent 的对应**：
- 三种发现来源：用户插件（`~/.hermes/plugins/`）、项目插件（`.hermes/plugins/`）、pip entry points
- 两种专用单例插件：Memory Provider（记忆实现）、Context Engine（上下文压缩策略）
- Hook 系统：`pre_llm_call`、`post_llm_call`、`on_session_start`、`on_session_end`

**Pure Agent 现状**：架构预留，待实现。

---

## 三、能力依赖关系

```
                        Entry Points (CLI / Desktop / Gateway)
                              │
                              │ 依赖
                              ▼
                        Agent Loop (编排引擎)
                              │
           ┌──────────────────┼──────────────────┐
           │                  │                  │
           ▼                  ▼                  ▼
     Prompt System      Provider Layer    Tool System
     (系统 Prompt)      (LLM 接入)        (工具执行)
           │                  │                  │
           │                  │                  │
           └──────────────────┼──────────────────┘
                              │
                              ▼
                    Context Management
                    (上下文窗口管理)
                              │
                              ▼
                         Persistence
                    (会话持久化 + 记忆)
```

依赖方向是单向的：**上层依赖下层，下层不感知上层**。

- **Entry Points** 在最外层，只依赖 Agent Loop 的公共接口
- **Agent Loop** 依赖 Provider + Tool System + Context Management，但不关心具体实现
- **Prompt System** 为 Agent Loop 提供系统 Prompt 组装能力
- **Provider Layer** 为 Agent Loop 提供 LLM 调用能力，屏蔽 Provider 差异
- **Tool System** 为 Agent Loop 提供工具执行能力，屏蔽工具差异
- **Context Management** 为 Agent Loop 提供上下文窗口管理能力，透明的消息裁剪
- **Persistence** 为 Context Management 提供会话存储，为记忆系统提供持久化

---

## 四、紧急程度与实施顺序

按依赖关系分层，每层可独立开发、测试、理解：

| 阶段 | 能力 | 为何此时做 | Pure Agent 状态 |
|------|------|-----------|----------------|
| **1** | Types + Events + Config | 所有模块的类型契约和配置基础 | ✅ 已完成 |
| **2** | Provider Layer | Agent 和 LLM 之间的桥梁，后续所有模块都依赖它 | ✅ 已完成 |
| **3** | Agent Loop | 核心编排引擎，没有它 Agent 不能工作 | ✅ 已完成 |
| **4** | Tool System | Agent 需要工具才能完成任务 | ⚠️ 接口就绪，内置工具待实现 |
| **5** | Context Management | 长对话必须压缩旧消息 | ✅ 已完成 |
| **6** | Tokenizer | 精确 token 计数，替换字符比率估算 | ✅ 已完成 |
| **7** | CLI | 有了完整的 Core 引擎后，CLI 是最简单的入口 | ⚠️ 基础实现 |
| **8** | Desktop (Electron) | 桌面端是更复杂的入口，需要 IPC 和进程管理 | 📋 已规划 |
| **9** | Persistence | 会话历史保存和跨会话记忆 | 📋 已规划 |
| **10** | Plugin System | 允许用户自定义工具和记忆实现 | 📋 已规划 |
| **11** | Gateway | 多平台消息接入，需要稳定的 Core 和 Persistence | 📋 已规划 |

---

## 五、与 hermes-agent 的关键设计差异

Pure Agent 以 hermes-agent 为参考，但在以下方面做了简化：

| 特性 | hermes-agent | Pure Agent | 原因 |
|------|-------------|-----------|------|
| **语言** | Python | TypeScript (strict) | 前后统一语言，核心代码 100% 复用 |
| **工具注册** | import-time 自注册 + AST 发现 | 显式 `registry.register()` | 更清晰的控制流，适合教学 |
| **API 模式** | 3 种（OpenAI / Anthropic / Codex） | 1 种（OpenAI 兼容，当前） | 逐步扩展 |
| **会话血统** | SQLite + parent_session_id 链 | 内存实现（无持久化） | 简化，后续增加 |
| **并行工具执行** | ThreadPoolExecutor | Promise.all | Node.js 事件循环模型 |
| **Gateway** | 20+ 平台适配器 | 无 | 专注单机 Agent |
| **Prompt Caching** | Anthropic 专用 + 确定性 call_id | DeepSeek Context Caching | Provider 适配 |
| **插件系统** | pip entry points + 文件发现 | 架构预留 | 后续支持 |

---

## 六、参考资料

- [hermes-agent 官方架构文档](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)
- [hermes-agent GitHub](https://github.com/NousResearch/hermes-agent)
- [hermes-agent Context Compressor](https://github.com/NousResearch/hermes-agent) — `context_compressor.py`（3083 行，Pure Agent Context Management 的参考实现）
- [DeepSeek API 文档](https://api-docs.deepseek.com/)
- [OpenAI Function Calling Guide](https://platform.openai.com/docs/guides/function-calling)
