# Phase 2 — Core Loop（核心循环）

## 目标

实现 `AgentLoop` 类：驱动 while 循环 + 流式响应解析 + 状态管理 + 事件发射。这是 Agent 系统的中枢神经。

同时实现 `ToolCallAccumulator`：将 SSE 流中增量的 `ToolCallDelta[]` 合并为完整的 `ToolCall[]`。

## 前置依赖

| 依赖 | 说明 |
|---|---|
| `types/` | `Message`, `ToolCall`, `ToolDefinition`, `ToolResult`, `ChatRequest`, `StreamEvent`, `TurnOutput`, `AgentOptions` |
| `provider/` | `ChatProvider` 接口，提供 `streamMessage(params): AsyncGenerator<StreamEvent>` |
| `tools/` | `ToolRegistry` 接口，提供 `execute(name, args)` 和 `getDefinitions()` |
| `context/` | `ContextManager` 接口（注入到 StepBuilder） |
| `agent/step-builder.ts` | Phase 1 产出，`StepBuilder` 类 |
| `agent/tool-executor.ts` | Phase 3 产出，`executeAll(toolCalls, registry, signal)` |
| `agent/loop-detector.ts` | Phase 3 产出，`LoopDetector` 类 |
| `events/` | 事件发射器 |

## StreamEvent 格式说明

`StreamEvent` 是 **Provider 层标准化后的格式**，不是原始 SSE 格式。Provider 负责：

1. 解析 SSE 数据块
2. 聚合 tool_calls 的增量 JSON 片段
3. 过滤 reasoning_content
4. 产出四种标准化事件：

```
原始 SSE:
  chunk 1: delta.content="Hello", finish_reason=null
  chunk 2: delta.content=" world", finish_reason=null
  chunk 3: delta.content="", finish_reason="stop"
  data: [DONE]

Provider 标准化后 (StreamEvent):
  event: { type: 'text', content: 'Hello' }
  event: { type: 'text', content: ' world' }
  event: { type: 'done', finishReason: 'stop' }
```

Tool calls 场景下：
```
  event: { type: 'text', content: '好的，让我读一下那个文件' }
  event: { type: 'tool_call_start', id: 'call_abc', name: 'read_file' }
  event: { type: 'tool_call_delta', id: 'call_abc', arguments: '{"path":"' }
  event: { type: 'tool_call_delta', id: 'call_abc', arguments: 'package.json"' }
  event: { type: 'tool_call_delta', id: 'call_abc', arguments: '}' }
  event: { type: 'done', finishReason: 'tool_calls' }
```

这样做的好处：
- Agent Loop 不关心 SSE 解析细节和 JSON 片段拼接，专注于决策逻辑
- `done` 事件是明确的"流结束"信号
- `tool_call_start` 和 `tool_call_delta` 分别对应 tool call 的发现和参数累积
- 后续扩展其他 Provider 时只需修改 Provider 层，Loop 不受影响

## 状态机

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
            │         │ (流式接收 + 解析)    │ 或 maxSteps/abort/error
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

5 个对外状态，`AgentStatus = 'idle' | 'thinking' | 'executing' | 'stopped' | 'error'`。

## AgentLoop 接口设计

```typescript
// packages/core/src/agent/loop.ts

class AgentLoop {
  private loopDetector: LoopDetector;
  private stepBuilder: StepBuilder;

  constructor(
    private provider: ChatProvider,
    private toolRegistry: ToolRegistry,
    private contextManager: ContextManager,
    private events: AgentEventEmitter,
  ) {
    this.loopDetector = new LoopDetector();
    this.stepBuilder = new StepBuilder(contextManager);
  }

  async run(
    messages: Message[],
    options: AgentOptions,
    signal: AbortSignal,
  ): Promise<TurnOutput>;
}
```

### 构造函数参数

| 参数 | 类型 | 用途 |
|---|---|---|
| `provider` | `ChatProvider` | 调用 LLM API（流式） |
| `toolRegistry` | `ToolRegistry` | 获取工具定义 + 执行工具 |
| `contextManager` | `ContextManager` | 注入到 StepBuilder，用于消息裁剪 |
| `events` | `AgentEventEmitter` | 发射生命周期事件给 UI |

### run() 参数

| 参数 | 说明 |
|---|---|
| `messages` | 完整的消息历史（调用方已追加 user 消息），至少包含 `[{role:"system"}, {role:"user"}]` |
| `options` | Agent 配置：`model`, `maxSteps`, `temperature?`, `maxTokens?`, `systemPrompt?` |
| `signal` | `AbortSignal`，用户点击停止时触发 |

### 返回值 `TurnOutput`

```typescript
interface TurnOutput {
  messages: Message[];    // 完整的消息历史（输入 + 本轮新增），与输入的 messages 是同一个数组引用
  steps: number;          // 实际执行的 LLM 调用次数
  status: 'completed' | 'max_steps' | 'aborted' | 'error';
  error?: Error;          // status === 'error' 时填充
}
```

> **关于 `messages` 的语义**：`run()` 会直接修改（mutate）传入的 `messages` 数组（push 新的 assistant/tool 消息）。返回值 `TurnOutput.messages` 是同一个数组引用，包含完整的对话历史。调用方不需要手动合并——传入的数组已包含本轮所有新增消息。

---

## 核心实现

### 完整代码

```typescript
// packages/core/src/agent/loop.ts

import type {
  Message,
  ToolCall,
  ChatRequest,
  AgentOptions,
  TurnOutput,
} from '../types/index.js';
import type { ChatProvider } from '../provider/index.js';
import type { ToolRegistry } from '../tools/index.js';
import type { ContextManager } from '../context/index.js';
import type { AgentEventEmitter } from '../events/index.js';
import { StepBuilder } from './step-builder.js';
import { ToolCallAccumulator } from './tool-call-accumulator.js';
import { executeAll } from './tool-executor.js';
import { LoopDetector } from './loop-detector.js';

// ===== 内部类型 =====

interface StreamSuccess {
  type: 'success';
  textContent: string;
  toolCalls: ToolCall[];
  finishReason: string;
}

interface StreamAborted {
  type: 'abort';
}

interface StreamError {
  type: 'error';
  error: Error;
}

type StreamResult = StreamSuccess | StreamAborted | StreamError;

// ===== AgentLoop =====

export class AgentLoop {
  private readonly loopDetector: LoopDetector;
  private readonly stepBuilder: StepBuilder;

  constructor(
    private readonly provider: ChatProvider,
    private readonly toolRegistry: ToolRegistry,
    contextManager: ContextManager,
    private readonly events: AgentEventEmitter,
  ) {
    this.loopDetector = new LoopDetector();
    this.stepBuilder = new StepBuilder(contextManager);
  }

  async run(
    messages: Message[],
    options: AgentOptions,
    signal: AbortSignal,
  ): Promise<TurnOutput> {
    this.loopDetector.reset();
    let steps = 0;

    this.emit('agent:turn:start', { messages });

    while (steps < options.maxSteps) {
      // ===== 检查点 1：每个 Step 开始前 =====
      if (signal.aborted) {
        return this.abort(messages, steps);
      }

      steps++;
      this.emit('agent:step:start', { step: steps });

      // ===== 阶段 A：构建请求 =====
      let request: ChatRequest;
      try {
        request = await this.stepBuilder.build(
          messages,
          this.toolRegistry.getDefinitions(),
          options,
          signal,
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return this.abort(messages, steps);
        }
        return this.errorEnd(messages, steps, err as Error);
      }

      // ===== 阶段 B：流式调用 LLM =====
      // thinking 在请求构建完成后才发射，表示"正在等待 LLM 响应"
      this.emit('agent:thinking', { step: steps });

      const streamResult = await this.processStream(request, signal);

      if (streamResult.type === 'abort') {
        return this.abort(messages, steps);
      }
      if (streamResult.type === 'error') {
        return this.errorEnd(messages, steps, streamResult.error);
      }

      const { textContent, toolCalls, finishReason } = streamResult;

      // ===== 阶段 C：判断 finish_reason =====

      // C1: 正常结束 → 保存文本回复
      if (finishReason === 'stop') {
        messages.push({
          role: 'assistant',
          content: textContent,
        });
        this.emit('agent:response', { content: textContent });
        return this.completed(messages, steps);
      }

      // C2: 工具调用
      if (finishReason === 'tool_calls') {
        // 防御：tool_calls 可能为空（API 不应返回此情况，但做保护）
        if (toolCalls.length === 0) {
          if (textContent) {
            messages.push({ role: 'assistant', content: textContent });
            this.emit('agent:response', { content: textContent });
          }
          return this.completed(messages, steps);
        }

        // 保存 assistant 消息（含 tool_calls）
        messages.push({
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        });

        this.emit('agent:tool_calls', { toolCalls });

        // ===== 阶段 D：执行工具 =====
        // 通知 UI 进入 executing 状态
        this.emit('agent:executing', { toolCalls });

        const execResult = await this.executeTools(
          toolCalls,
          signal,
          messages,
        );
        if (execResult === 'aborted') {
          return { messages, steps, status: 'aborted' };
        }

        // ===== 阶段 E：检测死循环 =====
        this.loopDetector.addToolCalls(toolCalls);
        if (this.loopDetector.isLooping()) {
          return this.errorEnd(
            messages,
            steps,
            new Error('LOOP_DETECTED: 连续 3 次重复的工具调用'),
          );
        }

        continue; // 回到循环开头
      }

      // C3: 其他 finish_reason（length, content_filter 等）
      // 注意：finish_reason === 'length' 时文本被截断，但如果 LLM 正在输出 tool_calls
      // 则 tool_calls JSON 可能不完整。当前版本保守处理：保存已有文本，不信任不完整的 tool_calls。
      if (textContent) {
        messages.push({ role: 'assistant', content: textContent });
      }
      return this.completed(messages, steps);
    }

    // while 循环结束 → maxSteps 到达
    this.emit('agent:turn:end', { messages, steps });
    return { messages, steps, status: 'max_steps' };
  }

  // ===== 私有方法 =====

  /**
   * 流式调用 LLM，文本 delta 转发 UI，tool_calls delta 在内存中累积。
   */
  private async processStream(
    request: ChatRequest,
    signal: AbortSignal,
  ): Promise<StreamResult> {
    let textContent = '';
    let finishReason = '';
    const accumulator = new ToolCallAccumulator();

    try {
      const stream = this.provider.streamMessage({
        model: request.model,
        messages: request.messages,
        tools: request.tools,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        signal,
      });

      for await (const event of stream) {
        if (signal.aborted) {
          return { type: 'abort' };
        }

        if (event.type === 'text') {
          textContent += event.content;
          this.emit('agent:stream:delta', { content: event.content });
        }

        if (event.type === 'tool_call_start') {
          accumulator.startToolCall(event.id, event.name);
        }

        if (event.type === 'tool_call_delta') {
          accumulator.appendArguments(event.id, event.arguments);
        }

        if (event.type === 'done') {
          finishReason = event.finishReason;
        }
      }

      return {
        type: 'success',
        textContent,
        toolCalls: accumulator.getToolCalls(),
        finishReason,
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { type: 'abort' };
      }
      return { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  /**
   * 执行工具调用，将结果追加到 messages。
   *
   * 副作用：直接修改传入的 messages 数组（push tool 消息）。
   */
  private async executeTools(
    toolCalls: ToolCall[],
    signal: AbortSignal,
    messages: Message[],
  ): Promise<'success' | 'aborted'> {
    // ===== 检查点 3：工具执行前 =====
    if (signal.aborted) {
      this.emit('agent:abort');
      return 'aborted';
    }

    const results = await executeAll(toolCalls, this.toolRegistry, signal);

    for (const result of results) {
      // ===== 检查点 4：每个工具结果处理前 =====
      if (signal.aborted) {
        this.emit('agent:abort');
        return 'aborted';
      }

      messages.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: result.error
          ? `Error: ${result.error}\n\n${result.content}`
          : result.content,
      });

      this.emit('agent:tool_result', result);
    }

    return 'success';
  }

  // ===== 终止辅助方法 =====

  /**
   * 正常结束。发射 turn:end 事件。
   */
  private completed(messages: Message[], steps: number): TurnOutput {
    this.emit('agent:turn:end', { messages, steps });
    return { messages, steps, status: 'completed' };
  }

  /**
   * 用户中止。发射 abort 事件。
   * 所有 abort 路径统一通过此方法处理事件发射。
   */
  private abort(messages: Message[], steps: number): TurnOutput {
    this.emit('agent:abort');
    return { messages, steps, status: 'aborted' };
  }

  /**
   * 不可恢复错误。发射 error 事件。
   */
  private errorEnd(
    messages: Message[],
    steps: number,
    error: Error,
  ): TurnOutput {
    this.emit('agent:error', { error });
    return { messages, steps, status: 'error', error };
  }

  private emit(type: string, payload?: Record<string, unknown>): void {
    this.events.emit(type, payload ?? {});
  }
}
```

---

## 设计要点说明

### 事件发射统一性

所有 `agent:abort` 事件发射统一通过 `this.abort()` 方法处理。`processStream()` 返回 `{ type: 'abort' }` 时**不发射事件**，由 `run()` 收到 abort result 后统一调用 `this.abort()`。这保证了：

- 无论用户在哪个检查点触发 abort，事件发射逻辑一致
- UI 总能收到 `agent:abort` 事件，不会漏掉

### thinking 事件时机

`agent:thinking` 在 `stepBuilder.build()` **之后**、`provider.chatStream()` **之前**发射。这确保"正在思考"指示器只在真正等待 LLM 响应时显示，不包含请求构建时间。

### executing 事件

`agent:executing` 事件在 `finish_reason === 'tool_calls'` 且工具执行之前发射。UI 可据此显示"正在执行工具"状态。这是 `AgentStatus.executing` 状态的事件表达。

### messages 数组的副作用

`run()` **直接修改**传入的 `messages` 数组（通过 `push` 追加 assistant/tool 消息）。这是有意的设计——调用方传入的数组在 `run()` 返回后已包含完整历史，无需手动合并。

---

## ToolCallAccumulator 实现

Provider 的 `StreamEvent` 已经完成了 tool_calls 的 JSON 片段聚合。`ToolCallAccumulator` 通过 ID 追踪 tool call 的发现和参数累积。

### 流式 tool_calls 事件序列

```
event: { type: 'tool_call_start', id: "call_abc", name: "read_file" }
event: { type: 'tool_call_delta', id: "call_abc", arguments: '{"path":"' }
event: { type: 'tool_call_delta', id: "call_abc", arguments: 'package.json"' }
event: { type: 'tool_call_delta', id: "call_abc", arguments: '}' }
                                                            ↑
event: { type: 'done', finishReason: 'tool_calls' }  ← 此时 tool_calls 完整
```

关键规则：
- `tool_call_start` 提供 id 和 name（只出现一次）
- `tool_call_delta` 提供 arguments 片段（可能多次，跨事件累积）
- 多个 tool_calls 时，每个有自己的 id

### 实现

```typescript
// packages/core/src/agent/tool-call-accumulator.ts

import type { ToolCall } from '../types/index.js';

export class ToolCallAccumulator {
  private toolCalls: Map<string, ToolCall> = new Map();
  private insertionOrder: string[] = [];

  startToolCall(id: string, name: string): void {
    if (!this.toolCalls.has(id)) {
      const tc: ToolCall = {
        id,
        type: 'function',
        function: { name, arguments: '' },
      };
      this.toolCalls.set(id, tc);
      this.insertionOrder.push(id);
    }
  }

  appendArguments(id: string, argumentsFragment: string): void {
    const tc = this.toolCalls.get(id);
    if (tc) {
      tc.function.arguments += argumentsFragment;
    }
  }

  getToolCalls(): ToolCall[] {
    return this.insertionOrder.map(id => this.toolCalls.get(id)!);
  }
}
```

### 边界情况

| 场景 | 行为 |
|---|---|
| 同一 id 的 startToolCall 多次调用 | 仅首次生效 |
| appendArguments 在 startToolCall 之前调用 | 忽略（id 未注册） |
| 多个 tool_calls 交叉到达 | Map 按 id 分组，不依赖到达顺序 |
| arguments 跨 5 个以上 delta 拼接 | 每次用 `+=` 拼接 |
| 流结束但从未收到 tool_call_start | `getToolCalls()` 返回 `[]` |

---

## 事件发射清单

Agent Loop 在以下时机发射事件（通过注入的 `AgentEventEmitter`）：

| 事件 | 发射时机 | 载荷 |
|---|---|---|
| `agent:turn:start` | `run()` 开始 | `{ messages }` |
| `agent:step:start` | 每个 Step 开始 | `{ step: number }` |
| `agent:thinking` | 请求构建完成，开始等待 LLM 响应 | `{ step: number }` |
| `agent:stream:delta` | 每个文本 delta | `{ content: string }` |
| `agent:tool_calls` | LLM 要求调用工具 | `{ toolCalls: ToolCall[] }` |
| `agent:executing` | 开始执行工具 | `{ toolCalls: ToolCall[] }` |
| `agent:tool_result` | 单个工具执行完成 | `ToolResult` |
| `agent:response` | LLM 最终文本回复 | `{ content: string }` |
| `agent:abort` | 用户中止（统一由 `this.abort()` 发射） | — |
| `agent:error` | 不可恢复的错误（含死循环检测） | `{ error: Error }` |
| `agent:turn:end` | Turn 正常结束（completed / maxSteps） | `{ messages, steps }` |

**UI 层的典型订阅行为**：

| 事件 | CLI 行为 | Desktop 行为 |
|---|---|---|
| `agent:stream:delta` | streammark 逐 token 渲染 | streamdown 逐 token 更新 |
| `agent:thinking` | 显示思考中动画 | 显示 ThinkingDot 组件 |
| `agent:executing` | 显示工具执行指示器 | 更新状态栏为"执行工具中" |
| `agent:tool_calls` | 显示工具调用卡片（名称+参数） | 显示 ToolCallCard 组件 |
| `agent:tool_result` | 更新工具卡片结果 | 更新 ToolCallCard 的 Collapse 内容 |
| `agent:response` | 最终渲染完整 Markdown | 渲染完整 streamdown |
| `agent:error` | 显示错误信息 | Modal / Toast 提示 |

---

## 4 个 Abort 检查点

abort 信号在 4 个位置被检查，确保用户随时可以中断：

```
                 run() 进入
                    │
            ┌───────┴────────┐
            │ 检查点 1       │ ← while 循环顶部，每个 Step 开始前
            │ signal.aborted?│    通过 this.abort() 统一发射事件
            └───────┬────────┘
                    │ 未 abort
                    ▼
            StepBuilder.build()
                    │
                    ▼
            provider.streamMessage()
                    │
            ┌───────┴────────┐
            │ 检查点 2       │ ← for await 每次迭代
            │ signal.aborted?│    processStream 返回 { type: 'abort' }
            └───────┬────────┘    run() 收到后调用 this.abort() 发射事件
                    │ 未 abort
                    ▼
            toolExecutor.executeAll()
                    │
            ┌───────┴────────┐
            │ 检查点 3       │ ← 工具执行前
            │ signal.aborted?│    executeTools 内部发射 agent:abort
            └───────┬────────┘
                    │ 未 abort
                    ▼
            for each tool result:
            ┌───────┴────────┐
            │ 检查点 4       │ ← 每个工具结果处理后
            │ signal.aborted?│    executeTools 内部发射 agent:abort
            └───────┬────────┘
                    │ 未 abort
                    ▼
            loopDetector 检查
                    │
                    ▼
            continue 下一 Step
```

**AbortError 处理**：Provider 的 `streamMessage` 可能因 signal abort 而抛出 `DOMException(name='AbortError')`。`processStream` 的 catch 块识别此异常并返回 `{ type: 'abort' }`，而非 `{ type: 'error' }`。

---

## 边界情况清单

| 场景 | 预期行为 |
|---|---|
| `messages` 只有 user 消息无 system | StepBuilder 处理（插入 systemPrompt 或不添加） |
| `toolCalls` 数组为空但 `finishReason === 'tool_calls'` | 防御处理：按 `stop` 逻辑返回 |
| 流式响应同时包含文本和 tool_calls | 正常：文本转发 UI，tool_calls 累积，最后执行工具 |
| 多个 tool_calls（index 0, 1, 2）| 按 index 分组，`getToolCalls()` 返回排序数组 |
| `finishReason === 'length'`（输出截断） | 保存已有文本，正常结束；此时 tool_calls JSON 可能不完整，不信任 |
| `finishReason === 'content_filter'`（内容过滤） | 保存已有文本（可能为空），正常结束 |
| 流式 `done` 事件未到达（网络中断） | for await 结束但 finishReason 为空 → 不匹配 stop 或 tool_calls → 按 C3 处理 |
| `maxSteps` 正好在第 N 步的 while 条件命中 | 不会执行第 N 步，直接返回 `maxSteps` |
| signal 在 `stepBuilder.build()` 期间 abort | `fitToWindow` 可能是 async，内部检查 signal 或 catch 中识别 AbortError |
| Provider 抛出非 AbortError 的异常 | catch 块 → `StreamResult.type === 'error'` → `errorEnd()` |
| `LoopDetector.isLooping()` 返回 true | `errorEnd()` 返回，包含描述性错误信息 |
| signal 在 `processStream` 中 abort（检查点 2）| 返回 `{ type: 'abort' }`，`run()` 调用 `this.abort()` 统一发射事件 |
| signal 在 `executeAll` 运行期间 abort（检查点 3/4）| `executeTools` 内部发射 `agent:abort` |

---

## 测试方案

### 测试层级

| 层级 | 内容 | Mock 策略 |
|---|---|---|
| **单元** | `ToolCallAccumulator.merge()` 和 `getToolCalls()` | 无需 mock |
| **单元** | `ToolCallAccumulator` 边界：空 delta、多 index、乱序到达 | 无需 mock |
| **集成** | `AgentLoop.run()` — 纯文本回复 | Mock Provider 返回 stop 流 |
| **集成** | `AgentLoop.run()` — 单次 tool_calls → 文本回复 | Mock Provider 返回 tool_calls 流 + stop 流 |
| **集成** | `AgentLoop.run()` — 多次 tool_calls | Mock Provider 返回多轮 tool_calls |
| **集成** | `AgentLoop.run()` — maxSteps 触发 | Mock Provider 始终返回 tool_calls |
| **集成** | `AgentLoop.run()` — 死循环检测 | Mock Provider 连续返回相同 tool_calls |
| **集成** | `AgentLoop.run()` — abort 中断（4 个检查点各自验证） | 在各阶段触发 signal；验证 `agent:abort` 事件被发射 |
| **集成** | `AgentLoop.run()` — Provider 异常 | Mock Provider 抛出错误 |
| **集成** | `AgentLoop.run()` — 文本 + tool_calls 混合 | Mock Provider 返回混合流 |

### Mock Provider

```typescript
function createMockProvider(
  events: ChatStreamEvent[][], // 每次 chatStream 调用返回一组事件
): ChatProvider {
  let callCount = 0;
  return {
    chatStream: async function* (_request: ChatRequest, signal: AbortSignal) {
      const currentEvents = events[callCount] ?? [
        { type: 'done', finish_reason: 'stop' },
      ];
      callCount++;
      for (const event of currentEvents) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        yield event;
      }
    },
  };
}
```

### Mock ToolRegistry

```typescript
function createMockRegistry(
  tools: ToolDefinition[] = [],
  executeImpl?: (name: string, args: Record<string, unknown>) => string,
): ToolRegistry {
  return {
    getDefinitions: () => tools,
    execute: async (name: string, args: Record<string, unknown>) => {
      if (executeImpl) return executeImpl(name, args);
      return JSON.stringify({ tool: name, args });
    },
  };
}
```

---

## 产出物

| 文件 | 说明 |
|---|---|
| `packages/core/src/agent/loop.ts` | `AgentLoop` 类 |
| `packages/core/src/agent/tool-call-accumulator.ts` | `ToolCallAccumulator` 类 |
| `packages/core/src/agent/__tests__/tool-call-accumulator.test.ts` | Accumulator 单元测试 |
| `packages/core/src/agent/__tests__/loop.test.ts` | AgentLoop 集成测试 |

---

## 与 Phase 1 和 Phase 3 的接口约定

```
Phase 1 (StepBuilder)
  │
  │ ChatRequest
  ▼
Phase 2 (AgentLoop) ── ChatRequest ──▶ Provider (chatStream)
  │                                       │
  │ ToolCall[]                            │ ChatStreamEvent[]
  ▼                                       ▼
Phase 3 (ToolExecutor + LoopDetector)
```

- AgentLoop 依赖 StepBuilder 产出 `ChatRequest`
- AgentLoop 依赖 `executeAll()`（Phase 3）执行工具
- AgentLoop 依赖 `LoopDetector`（Phase 3）检测死循环
- AgentLoop 内部维护 `ToolCallAccumulator` 处理流式合并
- `processStream()` 不直接发射 `agent:abort`，由 `run()` 统一通过 `this.abort()` 处理——确保事件发射一致性
