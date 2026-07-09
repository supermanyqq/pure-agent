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

### Agent Turn（轮次）

一次 **Turn** = 一次完整的"用户输入 → 最终回复"过程。一个 Turn 可能包含多次 LLM 调用（Step），因为 LLM 可能需要调用多个工具才能完成任务。

```
Turn 开始
  │
  ├─ Step 1: LLM 返回 tool_calls（需要读取文件）
  ├─ Step 2: 执行工具，LLM 返回 tool_calls（需要执行 shell）
  ├─ Step 3: 执行工具，LLM 返回文本回复
  │
Turn 结束
```

### Step（步）

一次 **Step** = 一次 LLM API 调用 + 可能的工具执行。在 Agent Loop 中，Step 是循环的基本单位。

每步做的事情：
1. 检查 abort 信号，如果已中断则停止
2. StepBuilder 构建请求（含裁剪超窗口消息）
3. 调用 Provider 的流式接口
4. 解析流式响应：
   - 文本 delta：直接转发给 UI
   - tool_calls delta：在内存中累积
5. 流结束后根据 finish_reason 判断：
   - `stop`：Turn 结束，把文本返回给用户
   - `tool_calls`：执行工具，把结果加入 messages，进入下一步

### 终止条件

Agent Loop 在以下情况停止：

| 条件 | 说明 |
|---|---|
| LLM 返回 `finish_reason: "stop"` | 正常结束，LLM 认为任务完成 |
| 达到 `maxSteps` 上限 | 防止无限循环，默认值见 config |
| 用户主动 abort | 用户点击停止按钮或 Ctrl+C，通过 AbortSignal 传入 |
| 连续相同 tool_calls（3 次） | LLM 陷入死循环，LoopDetector 检测到连续 3 次相同调用后强制终止 |
| Token 超出窗口且无法裁剪 | 消息历史超出模型上下文窗口，裁剪后仍然超限 |

---

## 子模块划分

Agent Loop 拆分为三个子模块，对应三个实施阶段：

```
agent/
├── step-builder.ts    # 阶段1：请求构建
├── loop.ts            # 阶段2：核心循环
└── tool-executor.ts   # 阶段3：工具执行调度
```

### Step Builder（请求构建）

**职责**：将当前状态（消息历史 + 工具列表 + 配置）组装为一次 LLM API 调用所需的完整 payload。

核心问题：给定 `Message[]`，如何构建发给 DeepSeek API 的请求体？

输入：
- `messages: Message[]` — 完整的消息历史（包括 system、user、assistant、tool 消息）
- `tools: ToolDefinition[]` — 可用工具的定义列表
- `options: AgentOptions` — 模型、温度、maxTokens 等参数

输出：
- 符合 OpenAI Chat Completions 格式的请求对象

关键逻辑：
- System prompt 放在 `messages[0]`（role: "system"）
- 工具定义按名称排序后序列化为 OpenAI tool 格式（保证 DeepSeek Context Caching 前缀稳定）
- 流式开关始终为 `true`（Agent Loop 只用流式路径）
- **每个 Step 调用 `contextManager.fitToWindow()` 裁剪超窗口消息**——因为每个 Step 会追加 assistant 和 tool 消息，可能让消息量从"刚好不超"变成"刚好超了"
- 裁剪是 StepBuilder 的内部细节，Loop 不感知
- **Prompt Caching 优化**：验证 system 消息不被裁剪修改、工具定义顺序稳定、消息前缀不变（保证 DeepSeek Context Caching 10x 成本降低 + 20x 延迟降低）

> 详见 [phase-1-step-builder.md](./phase-1-step-builder.md)

### Core Loop（核心循环）

**职责**：驱动整个 Turn 的 while 循环，管理状态转换，发射生命周期事件。

这是 Agent Loop 的心脏——一个状态机（5 个对外状态 + 状态图中 parsing 合并进 thinking）：

```
                 ┌──────────┐
                 │  idle    │
                 └────┬─────┘
                      │ run(messages, options, signal)
                      ▼
                 ┌──────────┐
            ┌───▶│ thinking │──────────────┐
            │    └────┬─────┘              │
            │         │ call provider      │ finish_reason: "stop"
            │         │ (流式接收 + 解析)    │ 或 maxSteps/abort
            │         ▼                    │
            │    ┌──────────────┐         │
            │    │  executing   │         │
            │    └──────┬───────┘         │
            │         │ finish_reason:    │
            │         │ "tool_calls"      │
            │         ▼                   │
            │    tools done               │
            │    → add results            │
            │    → loopDetector.add()     │
            │    → 检查死循环              │
            └──── 未检测到循环 ────────────┘
                                           ▼
                                      ┌──────────┐
                                      │ stopped  │
                                      └──────────┘

异常路径:
  any → error（Provider 异常、工具系统崩溃等不可恢复错误）
```

状态说明：
- **idle**：初始状态，等待用户输入
- **thinking**：正在调用 LLM + 解析流式响应（parsing 是对外不可见的内部子步骤）
- **executing**：正在执行 tool_calls
- **stopped**：正常结束
- **error**：发生不可恢复的错误

核心算法（类 + 流式路径）：

```typescript
class AgentLoop {
  private loopDetector: LoopDetector;
  private stepBuilder: StepBuilder;

  constructor(
    private provider: ChatProvider,
    private toolRegistry: ToolRegistry,
    private contextManager: ContextManager,
  ) {
    this.loopDetector = new LoopDetector();
    this.stepBuilder = new StepBuilder(this.contextManager);
  }

  async run(
    messages: Message[],
    options: AgentOptions,
    signal: AbortSignal,
  ): Promise<TurnOutput> {
    this.loopDetector.reset();
    let steps = 0;

    emit('agent:turn:start', { messages });

    while (steps < options.maxSteps) {
      // 0. 检查 abort 信号
      if (signal.aborted) {
        emit('agent:abort');
        return { messages, steps, status: 'aborted' };
      }

      steps++;
      emit('agent:step:start', { step: steps });

      // 1. StepBuilder 构建请求（内部调用 fitToWindow，fitToWindow 可能触发摘要 LLM 调用，因此是 async）
      const request = await this.stepBuilder.build(
        messages,
        this.toolRegistry.getDefinitions(),
        options,
        signal,
      );

      // 2. 调用 LLM（流式），收集文本和 tool_calls
      emit('agent:thinking', { step: steps });
      let textContent = '';
      let finishReason = '';
      const toolCallAccumulator = new ToolCallAccumulator();

      try {
        const stream = this.provider.chatStream(request, signal);
        for await (const event of stream) {
          if (signal.aborted) {
            emit('agent:abort');
            return { messages, steps, status: 'aborted' };
          }

          if (event.type === 'delta') {
            // 文本 delta → 直接转发 UI
            if (event.delta.content) {
              textContent += event.delta.content;
              emit('agent:stream:delta', { content: event.delta.content });
            }
            // tool_calls delta → 内存中累积（不暴露给 UI）
            if (event.delta.tool_calls) {
              toolCallAccumulator.merge(event.delta.tool_calls);
            }
          }

          if (event.type === 'done') {
            finishReason = event.finish_reason;
          }
        }
      } catch (err) {
        // 区分用户主动 abort（AbortError）和真正的网络/解析错误
        if (err instanceof DOMException && err.name === 'AbortError') {
          emit('agent:abort');
          return { messages, steps, status: 'aborted' };
        }
        emit('agent:error', { error: err });
        return { messages, steps, status: 'error', error: err as Error };
      }

      // 3. 流结束后根据 finish_reason 判断

      if (finishReason === 'stop') {
        // LLM 给出最终文本回复
        messages.push({
          role: 'assistant',
          content: textContent,
        });
        emit('agent:response', { content: textContent });
        emit('agent:turn:end', { messages, steps });
        return { messages, steps, status: 'completed' };
      }

      if (finishReason === 'tool_calls') {
        const toolCalls = toolCallAccumulator.getToolCalls();

        // 构建 assistant 消息（含 tool_calls）
        messages.push({
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        });

        emit('agent:tool_calls', { toolCalls });

        // 4. 执行工具
        const results = await toolExecutor.executeAll(
          toolCalls,
          this.toolRegistry,
          signal,
        );

        // 5. 工具结果加入消息历史
        for (const result of results) {
          messages.push({
            role: 'tool',
            toolCallId: result.toolCallId,
            content: result.error
              ? `Error: ${result.error}\n\n${result.content}`
              : result.content,
          });
          emit('agent:tool_result', result);
        }

        // 6. 检测死循环
        this.loopDetector.addToolCalls(toolCalls);
        if (this.loopDetector.isLooping()) {
          emit('agent:error', {
            error: new Error('检测到连续 3 次重复的工具调用，判定为死循环'),
          });
          return {
            messages,
            steps,
            status: 'error',
            error: new Error('LOOP_DETECTED: 连续重复的工具调用'),
          };
        }

        continue; // 回到循环开头
      }

      // 其他 finish_reason（length, content_filter 等）
      if (textContent) {
        messages.push({ role: 'assistant', content: textContent });
      }
      emit('agent:turn:end', { messages, steps });
      return { messages, steps, status: 'completed' };
    }

    // maxSteps 到达
    emit('agent:turn:end', { messages, steps });
    return { messages, steps, status: 'max_steps' };
  }
}
```

> 详见 [phase-2-loop.md](./phase-2-loop.md)

### Tool Executor（工具执行调度）

**职责**：接收 LLM 返回的 tool_calls 数组，调度执行，收集结果。

核心问题：多个 tool_calls 如何执行？

设计要点：
- **并行执行**：多个 tool_calls 之间没有数据依赖时，用 `Promise.all` 并发执行
- **参数解析**：`ToolCall.function.arguments` 是 JSON 字符串，执行前需要 `JSON.parse`
- **超时控制**：每个工具调用有独立的超时时间（由工具定义提供默认值）
- **错误隔离**：一个工具失败不影响其他工具——`Promise.allSettled` 语义
- **结果格式化**：统一工具执行结果为 `{ toolCallId, content, error? }` 格式

```typescript
async function executeAll(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  signal: AbortSignal,
): Promise<ToolResult[]> {
  return Promise.all(
    toolCalls.map(async (tc) => {
      if (signal.aborted) {
        return { toolCallId: tc.id, content: '', error: 'Aborted' };
      }
      try {
        const args = JSON.parse(tc.function.arguments);
        const content = await registry.execute(tc.function.name, args);
        return { toolCallId: tc.id, content };
      } catch (err) {
        return {
          toolCallId: tc.id,
          content: '',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}
```

> 详见 [phase-3-tool-executor.md](./phase-3-tool-executor.md)

---

## 跨模块共享类型

以下类型被多个模块使用，统一放在 `packages/core/src/types/` 下，属于架构中最底层的 types 模块：

```typescript
// ===== 消息类型 =====
type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

interface Message {
  role: MessageRole;
  content: string | null;
  toolCalls?: ToolCall[];        // assistant 消息可选
  toolCallId?: string;           // tool 消息专用
  name?: string;                 // 可选的工具名
}

// ===== 工具调用（OpenAI 格式）=====
interface ToolCall {
  id: string;                    // 如 "call_abc123"，由 API 生成
  type: 'function';
  function: {
    name: string;                // 如 "read_file"
    arguments: string;           // JSON 字符串，如 '{"path":"package.json"}'
  };
}

// ===== 工具定义 =====
interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;      // JSON Schema 对象
  };
}

// ===== 工具执行结果（内部格式）=====
interface ToolResult {
  toolCallId: string;
  content: string;               // 工具执行结果（序列化为字符串）
  error?: string;                // 如果执行失败，包含错误信息
}

// ===== Provider 请求/响应 =====
interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stream: boolean;               // Agent Loop 始终为 true
}

type ChatStreamEvent =
  | { type: 'delta'; delta: { content?: string; tool_calls?: ToolCallDelta[] } }
  | { type: 'done'; finish_reason: string };

interface ToolCallDelta {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}
```

---

## 与其他模块的协作

### 与 Provider 的协作

Agent Loop 不关心 Provider 内部实现，只依赖一个抽象接口：

```typescript
interface ChatProvider {
  chatStream(
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatStreamEvent>;
}
```

Agent Loop **只走流式路径**，不存在非流式分支：
- 始终调用 `chatStream`
- 文本 delta 实时转发给 UI（`agent:stream:delta` 事件）
- tool_calls delta 在内存中累积，流结束后统一处理
- `signal` 同时传递给 Provider 层，支持网络层面的 abort

### 与 Tool System 的协作

Agent Loop 通过 Tool Registry 执行工具：

```typescript
interface ToolRegistry {
  execute(name: string, args: Record<string, unknown>): Promise<string>;
  getDefinitions(): ToolDefinition[];
}
```

- Loop 不直接知道有哪些工具，只从 Registry 获取定义列表传给 LLM
- Tool Executor 负责 `JSON.parse(toolCall.function.arguments)`，然后把解析后的对象传给 `registry.execute()`
- LLM 决定调用哪个工具、传什么参数

### 与 Context Management 的协作

StepBuilder 在每个 Step 构建请求前调用 Context 模块检查窗口：

```typescript
interface ContextManager {
  fitToWindow(
    messages: Message[],
    tools: ToolDefinition[],
    options?: TrimOptions,
  ): Promise<TrimResult>;
  estimateTokens(messages: Message[]): number;
}
```

- **调用时机**：每个 Step 之前都调用（因为每步新增的 assistant + tool 消息可能超出窗口）
- **调用方**：StepBuilder 内部通过 `await` 调用（因为摘要可能需要 LLM 调用），Loop 不感知裁剪逻辑
- `fitToWindow` 返回 `TrimResult`（含裁剪后的 messages + 统计信息），StepBuilder 可记录裁剪日志
- 如果裁剪后仍然超限（含截断 tool 消息后），StepBuilder 抛出 `ContextWindowError`，Loop 捕获后终止

### 与 Events 的协作

Agent Loop 通过事件系统向外广播状态变化，UI 层订阅这些事件来更新界面：

```
agent:turn:start    → 新的一轮对话开始
agent:step:start    → 新一轮 LLM 调用开始
agent:thinking      → 正在等待 LLM 响应
agent:stream:delta  → 流式文本增量（逐 token 转发给 UI）
agent:tool_calls    → LLM 要求调用工具（工具列表）
agent:executing     → 开始执行工具（进入 executing 状态）
agent:tool_result   → 单个工具执行完成
agent:response      → LLM 给出最终文本回复（finish_reason: "stop"）
agent:turn:end      → 本轮对话结束
agent:error         → 发生错误（含死循环检测）
agent:abort         → 用户中止
```

---

## 关键类型定义（Agent Loop 内部）

```typescript
// ===== Agent 状态 =====
type AgentStatus =
  | 'idle'
  | 'thinking'     // 包含流式解析（parsing 是对外不可见的子步骤）
  | 'executing'
  | 'stopped'
  | 'error';

// ===== Agent 配置 =====
interface AgentOptions {
  model: string;           // 模型名，如 "deepseek-chat"
  maxSteps: number;        // 最大步数，默认 10
  temperature?: number;    // 温度参数
  maxTokens?: number;      // 最大输出 token（传给 API）
  systemPrompt?: string;   // 系统提示词
}

// ===== Turn 输出 =====
interface TurnOutput {
  messages: Message[];     // 本轮产生的所有消息（含工具调用和最终回复）
  steps: number;           // 实际执行的步数
  status: 'completed' | 'max_steps' | 'aborted' | 'error';
  error?: Error;
}

// ===== 循环检测器（Agent Loop 内部使用）=====
class LoopDetector {
  private previousToolCalls: ToolCall[] | null = null;
  private repeatCount = 0;
  private readonly THRESHOLD = 3;

  addToolCalls(toolCalls: ToolCall[]): void {
    if (this.previousToolCalls && this.isSame(this.previousToolCalls, toolCalls)) {
      this.repeatCount++;
    } else {
      this.repeatCount = 1;
    }
    this.previousToolCalls = toolCalls;
  }

  isLooping(): boolean {
    return this.repeatCount >= this.THRESHOLD;
  }

  reset(): void {
    this.previousToolCalls = null;
    this.repeatCount = 0;
  }

  private isSame(a: ToolCall[], b: ToolCall[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((tc, i) =>
      tc.function.name === b[i].function.name &&
      tc.function.arguments === b[i].function.arguments
    );
  }
}
```

---

## 设计决策记录

### 1. 为什么状态机用 while 循环而不是递归？

**选择：while 循环。**

原因：
- 调试友好：状态在变量中一目了然，可以直接打印 steps 计数
- 栈安全：递归实现可能在某些极端场景（LLM 反复调用工具）导致栈溢出
- abort 处理简单：在 while 条件中检查 signal 即可
- 教学清晰：while 循环是每个程序员都理解的控制流，比 Generator/递归更容易追踪

### 2. 为什么 tool_calls 不做流式执行？

**选择：收集完所有 tool_calls 后再统一执行。**

原因：
- DeepSeek 的 tool_calls 通过 SSE delta 增量返回，每个 chunk 只包含部分 JSON 片段
- 在没收集完所有 arguments 之前无法调用 `JSON.parse`
- 即使单个 tool_call 收完了，也可能后续 chunk 追加新的 tool_call（由 `index` 字段区分）
- 所以必须等到 `finish_reason` 到达，确认 tool_calls 数组完整后再执行

### 3. 并行 vs 串行执行工具？

**选择：并行执行（`Promise.all`），错误隔离用 `Promise.allSettled` 语义。**

原因：
- LLM 返回的多个 tool_calls 之间通常没有数据依赖（读两个独立文件、执行两个独立命令）
- 并行执行显著减少工具阶段的耗时
- 一个工具失败不应阻塞其他工具——在 `executeAll` 内部 try/catch 每个工具调用
- 如果以后需要支持依赖关系（工具 A 的输出是工具 B 的输入），可以在 ToolCall 上加 `depends_on` 字段，不影响现有设计

### 4. 工具执行错误如何反馈？

**选择：错误信息作为 tool 消息的 content 返回给 LLM。**

原因：
- 这是 OpenAI Function Calling 协议的标准做法
- LLM 看到错误后可以调整策略（换一个工具、修正参数、向用户解释）
- 不应该直接 abort，因为 LLM 有能力从错误中恢复

示例：
```json
{
  "role": "tool",
  "tool_call_id": "call_abc",
  "content": "Error: ENOENT: no such file or directory\n\n"
}
```

### 5. 如何防止 LLM 死循环？

**三层防御：**

1. **maxSteps 硬限制**：到达上限后强制终止，返回 `status: 'max_steps'`
2. **LoopDetector 连续重复检测**：连续 3 次返回相同的 tool_calls（函数名相同 + arguments 字符串相同），判定为死循环，终止。阈值设为 3 而非 2，给 LLM 一次"自我纠正"的机会（某些场景下连续 2 次相同调用可能是因为第一次的结果不够详细）
3. **用户 abort**：通过 `AbortSignal` 传入，每个 Step 开始前、流式迭代中、工具执行前都检查信号

### 6. 为什么只用流式路径，不做非流式？

**选择：Agent Loop 始终调用 `chatStream`，不存在 `chat()` 调用。**

原因：
- 流式可以同时覆盖"仅文本"和"tool_calls"两种场景——文本逐 token 转发 UI，tool_calls 在内存中累积
- 非流式接口是流式的子集（等全部数据到达后一次性返回），不需要维护两套代码路径
- 教学上，理解 SSE 流式解析比理解非流式 JSON 响应更有价值
- 减少分支意味着更少的测试矩阵

### 7. Loop 是有状态还是无状态？

**选择：Loop 对消息历史无状态，对死循环检测有状态。**

- 消息历史由调用方（CLI/Desktop）管理。`run(messages)` 吃进去完整消息数组，吐出本轮新增的消息。调用方负责把 Turn1 的输出拼到 Turn2 的输入。
- 原因：调用方本来就有消息列表用于渲染 UI；纯函数更容易测试；支持"回溯到某个历史点重新生成"
- LoopDetector 的状态（上一次 tool_calls 记录）是 Loop 实例的内部状态，每个 Turn 开始前 reset

### 8. AbortSignal 如何传递？

**选择：通过 `run()` 参数传入 `AbortSignal`，同时下传给 Provider。**

- 遵循 Web 标准模式（`fetch(url, { signal })`）
- 调用方持有 `AbortController`，想停止时调 `controller.abort()`
- Loop 在每个 Step 开始前、流式迭代中、工具执行前检查 `signal.aborted`
- `signal` 同时传给 `provider.chatStream()`，让网络层也能 abort
- **已知局限**：当前 `ToolRegistry.execute()` 不接收 signal，长时间运行的工具（如 `shell_exec` 30s）无法中途 abort。这留到 Tool System 模块后续迭代中解决——届时 `execute()` 签名扩展为 `execute(name, args, signal?)`

---

## 流式响应处理细节

这是 Agent Loop 中最复杂的部分——流式响应中文本和 tool_calls 的处理方式不同。

```
Provider 返回 SSE 流
        │
        ▼
   ┌─────────────────────────────────────┐
   │      ChatStreamEvent "delta"         │
   │                                     │
   │  delta.content  →  emit 给 UI 展示  │
   │  delta.tool_calls → ToolCallAccumulator.merge() │
   │                                     │
   └─────────────────────────────────────┘
        │
        ▼ (流结束，ChatStreamEvent "done")
        │
   ┌────┴────────────────────────────────┐
   │  finish_reason === "stop"           │
   │    → Turn 结束，UI 展示完整回复      │
   │                                     │
   │  finish_reason === "tool_calls"     │
   │    → ToolCallAccumulator.getToolCalls() │
   │    → 提交 Tool Executor 执行        │
   │    → 工具执行结果加入 messages       │
   │    → 进入下一个 Step                 │
   └─────────────────────────────────────┘
```

**ToolCallAccumulator 说明**：负责将增量的 `ToolCallDelta[]` 合并为完整的 `ToolCall[]`。

```typescript
class ToolCallAccumulator {
  private toolCalls: Map<number, ToolCall> = new Map();

  merge(deltas: ToolCallDelta[]): void {
    for (const delta of deltas) {
      const existing = this.toolCalls.get(delta.index);
      if (existing) {
        // 追加 arguments 片段
        if (delta.function?.arguments) {
          existing.function.arguments += delta.function.arguments;
        }
      } else {
        // 首次出现：创建新的 ToolCall
        this.toolCalls.set(delta.index, {
          id: delta.id || '',
          type: 'function',
          function: {
            name: delta.function?.name || '',
            arguments: delta.function?.arguments || '',
          },
        });
      }
    }
  }

  getToolCalls(): ToolCall[] {
    return Array.from(this.toolCalls.values());
  }
}
```

- OpenAI 流式格式中，tool_calls 按 `index` 字段分组，同一 index 的 delta 属于同一个 ToolCall
- `id` 和 `function.name` 在第一个 delta 中给出
- `function.arguments` 跨多个 delta 累积拼接（每个 delta 的 arguments 是 JSON 片段）
- `finish_reason` 在流的 `done` 事件中给出，不属于 Accumulator 的职责

要点：
- 文本 delta 直接转发给 UI（为了让用户看到 LLM 逐字输出）
- tool_calls delta 只在内存中累积（不应该暴露未完成的 JSON 片段给用户）
- 在 tool_calls 场景下，LLM 通常不会同时返回文本和 tool_calls，但协议上允许，要做好文本 + tool_calls 同时存在的兼容

---

## 测试策略

| 层级 | 测试内容 | 工具 |
|---|---|---|
| 单元测试 | StepBuilder 构建请求的正确性（含 fitToWindow 模拟） | vitest |
| 单元测试 | ToolExecutor 并行/错误处理/超时 | vitest |
| 单元测试 | LoopDetector 连续重复检测逻辑 | vitest |
| 单元测试 | ToolCallAccumulator delta 合并逻辑 | vitest |
| 集成测试 | Mock Provider 流式事件下的完整 Loop 流程 | vitest + mock |
| 集成测试 | 真实 DeepSeek API 端到端工具调用 | vitest + 真实 API Key |
| 边界测试 | maxSteps 触发、abort 中断（各阶段）、工具执行中 abort、连续重复检测 | vitest |

---

## 实施计划

按依赖关系分三个阶段，每个阶段产出独立的、可测试的模块：

| 阶段 | 文件 | 可验证产出 | 核心知识点 |
|---|---|---|---|
| **1** | `step-builder.ts` | 单元测试：给定 messages + tools，输出符合 OpenAI 格式的请求体；验证 fitToWindow 调用 | OpenAI Chat Completions 请求格式、tool 定义序列化、消息裁剪集成 |
| **2** | `loop.ts` + `tool-call-accumulator.ts` | 集成测试：Mock Provider 流式事件下完整跑通"询问 → tool_calls → 执行 → 回复" | 状态机设计、流式迭代、abort 处理、ToolCall delta 合并 |
| **3** | `tool-executor.ts` + `loop-detector.ts` | 单元测试：并行执行、错误隔离、超时控制；循环检测逻辑 | Promise 错误处理模式、死循环检测算法 |

---

## 参考资料

- [OpenAI Chat Completions API — Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [DeepSeek API 文档 — Function Calling](https://api-docs.deepseek.com/guides/function_calling)
- [DeepSeek API 文档 — Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)
- [architecture.md](../architecture.md) — 项目整体架构
