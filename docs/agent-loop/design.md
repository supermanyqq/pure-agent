# Agent Loop — 总体设计

## 模块定位

Agent Loop 是 Pure Agent 的**核心决策引擎**。它负责在收到用户输入后，驱动 LLM 完成多轮工具调用的完整闭环——构建请求、调用 Provider、解析响应、执行工具、将结果反馈给 LLM，直到 LLM 给出最终文本回复或达到终止条件。

一句话：**Agent Loop 回答"什么时候调用 LLM，LLM 说要用工具时怎么做，什么时候停下来"这三个问题。**

---

## 在整体架构中的位置

```
User Input
    │
    ▼
┌─────────────────────────────────────────────┐
│              Agent Loop (本模块)              │
│                                              │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐ │
│  │  Step     │   │  Core    │   │  Tool    │ │
│  │  Builder  │──▶│  Loop    │──▶│  Executor│ │
│  └──────────┘   └──────────┘   └──────────┘ │
│       │              │               │       │
└───────┼──────────────┼───────────────┼───────┘
        │              │               │
        ▼              ▼               ▼
   ┌────────┐   ┌──────────┐   ┌──────────┐
   │provider│   │  events  │   │  tools   │
   └────────┘   └──────────┘   └──────────┘
```

Agent Loop 位于 provider 和 tools 之上，events 贯穿其中。它不直接处理 HTTP 或 UI，只关心决策逻辑。

---

## 核心概念

### Turn（轮次）与 Step（步）

- **Turn**：一次完整的"用户输入 → 最终回复"过程。一个 Turn 可能包含多次 LLM 调用。
- **Step**：一次 LLM API 调用 + 可能的工具执行。Step 是循环的基本单位。

```
Turn 开始
  ├─ Step 1: LLM 返回 tool_calls → 执行工具
  ├─ Step 2: LLM 返回 tool_calls → 执行工具
  ├─ Step 3: LLM 返回文本回复
Turn 结束
```

### 终止条件

Agent Loop 在以下情况停止：

| 条件 | 说明 |
|---|---|
| LLM 返回 `finish_reason: "stop"` | 正常结束，LLM 认为任务完成 |
| 达到 `maxSteps` 上限 | 防止无限循环 |
| 用户主动 abort | 通过 `AbortSignal` 传入 |
| 连续相同 tool_calls（3 次） | LoopDetector 检测到死循环后强制终止 |
| Token 超出窗口且无法裁剪 | Context Management 裁剪后仍然超限 |

---

## 子模块划分

Agent Loop 拆分为三个子模块，对应三个实施阶段：

```
agent/
├── step-builder.ts    # 请求构建
├── loop.ts            # 核心循环
└── tool-executor.ts   # 工具执行调度
```

### Step Builder（请求构建）

**职责**：将当前状态（消息历史 + 工具列表 + 配置）组装为一次 LLM API 调用所需的完整 payload。

核心逻辑：
- System prompt 确保存在（优先 messages 中已有的，其次 options.systemPrompt）
- **调用 `contextManager.fitToWindow()` 裁剪超窗口消息**——每个 Step 前都调用，因为每步新增的 assistant + tool 消息可能超出窗口
- 工具定义按名称排序后序列化（保证 DeepSeek Context Caching 前缀稳定）
- 流式开关始终为 `true`

> 详见 [phase-1-step-builder.md](./phase-1-step-builder.md)

### Core Loop（核心循环）

**职责**：驱动整个 Turn 的 while 循环，管理状态转换，发射生命周期事件。

状态机（5 个对外状态）：

```
                 ┌──────────┐
                 │  idle    │
                 └────┬─────┘
                      │ run()
                      ▼
                 ┌──────────┐
            ┌───▶│ thinking │──────────────┐
            │    └────┬─────┘              │
            │         │ call provider      │ finish_reason: "stop"
            │         ▼                    │ 或 maxSteps/abort
            │    ┌──────────────┐         │
            │    │  executing   │         │
            │    └──────┬───────┘         │
            │         │ tool_calls        │
            │         ▼                   │
            │    tools done               │
            │    → add results            │
            │    → check loop             │
            └──── 未检测到循环 ────────────┘
                                           ▼
                                      ┌──────────┐
                                      │ stopped  │
                                      └──────────┘
```

核心循环每步做的事情：
1. 检查 abort 信号
2. StepBuilder 构建请求（内部调用 fitToWindow）
3. 调用 Provider 流式接口，文本 delta 转发 UI，tool_calls delta 在 ToolCallAccumulator 中累积
4. 流结束后根据 finish_reason 判断：
   - `stop`：Turn 结束，返回文本
   - `tool_calls`：执行工具，结果加入 messages，LoopDetector 检测死循环，进入下一步

> 详见 [phase-2-loop.md](./phase-2-loop.md)

### Tool Executor（工具执行调度）

**职责**：接收 LLM 返回的 tool_calls 数组，调度执行，收集结果。

设计要点：
- **并行执行**：多个 tool_calls 之间没有数据依赖时，`Promise.all` 并发执行
- **参数解析**：`ToolCall.function.arguments` 是 JSON 字符串，执行前需 `JSON.parse`
- **错误隔离**：一个工具失败不影响其他工具（`Promise.allSettled` 语义）
- **结果格式化**：统一为 `{ toolCallId, content, error? }` 格式

> 详见 [phase-3-tool-executor.md](./phase-3-tool-executor.md)

---

## 设计决策

### 1. 为什么状态机用 while 循环而不是递归？

- 调试友好：状态在变量中一目了然，可以直接打印 steps 计数
- 栈安全：递归可能在某些极端场景（LLM 反复调用工具）导致栈溢出
- abort 处理简单：在 while 条件中检查 signal 即可

### 2. 为什么 tool_calls 不做流式执行？

DeepSeek 的 tool_calls 通过 SSE delta 增量返回，每个 chunk 只包含部分 JSON 片段。在没收集完所有 arguments 之前无法 `JSON.parse`。即使单个 tool_call 收完了，后续 chunk 也可能追加新的 tool_call。所以必须等到 `finish_reason` 到达，确认 tool_calls 数组完整后再执行。

### 3. 并行 vs 串行执行工具？

**选择：并行执行（`Promise.all`），错误隔离用 `Promise.allSettled` 语义。**

LLM 返回的多个 tool_calls 通常没有数据依赖（读两个独立文件、执行两个独立命令），并行执行显著减少工具阶段的耗时。一个工具失败不应阻塞其他工具。

### 4. 工具执行错误如何反馈？

错误信息作为 tool 消息的 content 返回给 LLM，LLM 看到错误后可以调整策略（换工具、修正参数、向用户解释）。不应该直接 abort，因为 LLM 有能力从错误中恢复。

### 5. 如何防止 LLM 死循环？

三层防御：
1. **maxSteps 硬限制**：到达上限后强制终止
2. **LoopDetector 连续重复检测**：连续 3 次返回相同的 tool_calls（函数名相同 + arguments 字符串相同），判定为死循环。阈值设为 3 而非 2，给 LLM 一次自我纠正的机会
3. **用户 abort**：通过 `AbortSignal` 传入，每个 Step 开始前、流式迭代中、工具执行前都检查

### 6. 为什么只用流式路径？

- 流式可以同时覆盖"仅文本"和"tool_calls"两种场景
- 非流式接口是流式的子集，不需要维护两套代码路径
- 减少分支意味着更少的测试矩阵

### 7. Loop 是有状态还是无状态？

**Loop 对消息历史无状态，对死循环检测有状态。**

消息历史由调用方（CLI/Desktop）管理。`run(messages)` 吃进去完整消息数组，直接 mutate 追加本轮新增消息。调用方本来就持有消息列表用于渲染 UI；纯函数风格更容易测试；支持"回溯到某个历史点重新生成"。

### 8. AbortSignal 如何传递？

通过 `run()` 参数传入 `AbortSignal`，同时下传给 Provider。遵循 Web 标准模式（`fetch(url, { signal })`）。Loop 在 4 个检查点检查 `signal.aborted`：while 循环顶部、流式迭代中、工具执行前、每个工具结果处理后。

---

## 事件系统

Agent Loop 通过事件系统向外广播状态变化，UI 层订阅这些事件来更新界面：

| 事件 | 发射时机 |
|---|---|
| `agent:turn:start` | 新一轮对话开始 |
| `agent:step:start` | 新一轮 LLM 调用开始 |
| `agent:thinking` | 正在等待 LLM 响应 |
| `agent:stream:delta` | 流式文本增量（逐 token 转发 UI） |
| `agent:tool_calls` | LLM 要求调用工具 |
| `agent:executing` | 开始执行工具 |
| `agent:tool_result` | 单个工具执行完成 |
| `agent:response` | LLM 给出最终文本回复 |
| `agent:turn:end` | 本轮对话结束 |
| `agent:error` | 发生错误（含死循环检测） |
| `agent:abort` | 用户中止 |

---

## 与其他模块的协作

- **Provider**：Agent Loop 通过 `ChatProvider` 抽象接口调用 LLM，不关心 HTTP/SSE 细节
- **Tool System**：Agent Loop 通过 `ToolRegistry` 接口获取工具定义并执行，不直接知道有哪些工具
- **Context Management**：StepBuilder 在每个 Step 前调用 `fitToWindow()`，Loop 不感知裁剪逻辑
- **Events**：所有状态变化通过事件系统广播，UI 订阅事件来更新界面

---

## 测试策略

| 层级 | 测试内容 | 工具 |
|---|---|---|
| 单元测试 | StepBuilder 请求构建正确性 | vitest + mock ContextManager |
| 单元测试 | ToolExecutor 并行/错误处理 | vitest + mock ToolRegistry |
| 单元测试 | LoopDetector 连续重复检测 | vitest |
| 单元测试 | ToolCallAccumulator delta 合并 | vitest |
| 集成测试 | Mock Provider 流式事件下的完整 Loop 流程 | vitest + mock Provider |
| 集成测试 | 真实 DeepSeek API 端到端工具调用 | vitest + 真实 API Key |

---

## 参考资料

- [OpenAI Chat Completions API — Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [DeepSeek API 文档 — Function Calling](https://api-docs.deepseek.com/guides/function_calling)
- [architecture.md](../architecture.md) — 项目整体架构
