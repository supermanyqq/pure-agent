# Phase 1 — Step Builder（请求构建）

## 目标

实现 `StepBuilder` 类：将消息历史、工具列表、Agent 配置组装为一次 LLM API 调用所需的完整请求 payload（OpenAI Chat Completions 格式）。

## 前置依赖

| 依赖 | 说明 |
|---|---|
| `types/` 模块 | `Message`, `ToolDefinition`, `ChatRequest`, `AgentOptions` 等类型已定义 |
| `context/` 模块 | `ContextManager` 接口，提供 `fitToWindow()` 和 `estimateTokens()` |
| Provider 层 | 无需真实 Provider，仅需知道 `ChatRequest` 的结构 |

## 接口设计

```typescript
// packages/core/src/agent/step-builder.ts

import type { Message, ToolDefinition, ChatRequest, AgentOptions } from '../types/index.js';
import type { ContextManager } from '../context/index.js';

class StepBuilder {
  constructor(private contextManager: ContextManager) {}

  async build(
    messages: Message[],
    tools: ToolDefinition[],
    options: AgentOptions,
    signal: AbortSignal,
  ): Promise<ChatRequest> {
    // ...
  }
}
```

### 参数说明

| 参数 | 类型 | 说明 |
|---|---|---|
| `messages` | `Message[]` | 完整的消息历史，至少包含 `[{role: "system"}, {role: "user"}]` |
| `tools` | `ToolDefinition[]` | 可用工具定义列表，可为空数组（纯对话场景） |
| `options` | `AgentOptions` | 包含 `model`, `maxSteps`, `temperature?`, `maxTokens?`, `systemPrompt?` |
| `signal` | `AbortSignal` | 用于中断可能的长时间操作（如 `fitToWindow` 触发的摘要 LLM 调用） |

### 返回值

```typescript
interface ChatRequest {
  model: string;             // 来自 options.model
  messages: Message[];      // 裁剪后的消息数组
  tools?: ToolDefinition[]; // 序列化后的工具定义（tools 为空时不传）
  temperature?: number;     // 来自 options.temperature
  max_tokens?: number;      // 来自 options.maxTokens
  stream: true;             // 始终为 true
}
```

---

## 核心流程

```
build(messages, tools, options, signal)
  │
  ├─ 1. 确保 system prompt 存在
  │     messages[0].role === 'system' ? 保留 : 在前面插入
  │
  ├─ 2. 调用 contextManager.fitToWindow(messages, tools)
  │     检查消息是否超出模型上下文窗口
  │     如果超出 → 裁剪旧消息、摘要压缩
  │     如果裁剪后仍超限 → 抛出 ContextWindowError
  │
  ├─ 3. 序列化工具定义
  │     tools.length > 0 ? 传入 ToolDefinition[] : 不传 tools 字段
  │
  ├─ 4. 组装 ChatRequest 对象
  │     { model, messages, tools?, temperature?, max_tokens?, stream: true }
  │
  └─ 5. 返回 ChatRequest
```

---

## 详细实现

### 步骤 1：System Prompt 处理

System prompt 的来源有两种：
- 调用方在传入的 `messages` 中已包含 `{role: "system", content: "..."}` 作为第一条消息
- 调用方通过 `options.systemPrompt` 传入，此时 messages 中没有 system 消息

处理逻辑：

```typescript
function ensureSystemPrompt(
  messages: Message[],
  systemPrompt?: string,
): Message[] {
  // 情况 A：messages 已有 system 消息 → 不修改
  if (messages.length > 0 && messages[0].role === 'system') {
    return messages;
  }

  // 情况 B：options 提供了 systemPrompt → 在前面插入
  if (systemPrompt) {
    return [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];
  }

  // 情况 C：都没有 → 不添加 system 消息（非必须，但 LLM 行为可能不稳定）
  return messages;
}
```

边界情况：
- `messages` 为空数组 + 无 `systemPrompt` → 返回空数组（后续调用方应保证至少有 user 消息）
- `messages[0]` 不是 system 但 `options.systemPrompt` 存在 → 插入 system 消息到最前面
- `messages` 中 system 在非首位（格式错误）→ 不做重排，保持原样

### 步骤 2：调用 fitToWindow

```typescript
// fitToWindow 裁剪消息历史以适应模型的上下文窗口
// ContextManager 负责具体策略：滑动窗口、旧消息摘要、token 估算
const trimmedMessages = await this.contextManager.fitToWindow(
  messagesWithSystem,
  tools,
);

// fitToWindow 可能因为需要生成摘要而发起 LLM 调用（通过 provider）
// 此时需要 signal 支持中断
```

**fitToWindow 可能抛出的异常**：

| 异常 | 触发条件 | StepBuilder 的处理 |
|---|---|---|
| `ContextWindowError` | 裁剪后仍然超限（system + 最后一条 user 消息本身超过窗口） | 透传给调用方（Loop），Loop 终止 Turn 并返回 error |
| `AbortError` | 用户在摘要生成过程中 abort | 透传给调用方（Loop） |

> **已知局限**：当前 `ContextManager.fitToWindow()` 接口不接受 `AbortSignal` 参数。如果 `fitToWindow` 内部发起 LLM 摘要调用，无法在中途 abort——只能等摘要完成后再检查 signal。这是 Context 模块的待改进项，StepBuilder 在调用后立即检查 `signal.aborted` 作为补偿。

### 步骤 3：工具定义排序与序列化

`ToolDefinition` 接口已经匹配 OpenAI/DeepSeek 格式，直接透传即可。但有一个关键步骤：**按名称排序**。

```typescript
function prepareTools(tools: ToolDefinition[]): ToolDefinition[] | undefined {
  if (tools.length === 0) return undefined;

  // 按工具名排序，确保每次请求中工具定义的顺序一致
  // 这对 prompt caching 至关重要——顺序变化会导致缓存前缀不匹配
  return [...tools].sort((a, b) =>
    a.function.name.localeCompare(b.function.name)
  );
}
```

为什么空数组时传 `undefined` 而非 `[]`？
- DeepSeek API 在 `tools: []` 时行为与不传 `tools` 字段可能不同
- 空数组可能被解读为「有工具但列表为空」
- 不传 `tools` 字段明确表示这是纯对话请求，避免歧义

为什么排序？
- DeepSeek Context Caching 基于**前缀完全匹配**：请求的整个 body（含 tools 数组）从第一个字节开始比较
- 如果 tools 顺序在不同请求间不同（如注册顺序变化），缓存前缀不匹配 → cache miss
- 排序是零成本操作（通常 <10 个工具），换来 10x 成本节省和 ~20x 延迟降低

### 步骤 4：组装 ChatRequest

```typescript
const request: ChatRequest = {
  model: options.model,
  messages: trimmedMessages,
  stream: true,
};

// 只有 tools 非空时才传入（已排序）
const sortedTools = prepareTools(tools);
if (sortedTools) {
  request.tools = sortedTools;
}

// 可选参数按需传入（temperature 为 0 是有效值，不能用 || 判断）
if (options.temperature !== undefined) {
  request.temperature = options.temperature;
}

if (options.maxTokens !== undefined) {
  request.max_tokens = options.maxTokens;
}
```

---

## 完整实现

```typescript
// packages/core/src/agent/step-builder.ts

import type { Message, ToolDefinition, ChatRequest, AgentOptions } from '../types/index.js';
import type { ContextManager } from '../context/index.js';

export class ContextWindowError extends Error {
  constructor(
    message: string,
    public readonly currentTokens: number,
    public readonly maxTokens: number,
  ) {
    super(message);
    this.name = 'ContextWindowError';
  }
}

export class StepBuilder {
  constructor(private readonly contextManager: ContextManager) {}

  async build(
    messages: Message[],
    tools: ToolDefinition[],
    options: AgentOptions,
    signal: AbortSignal,
  ): Promise<ChatRequest> {
    // 1. 确保 system prompt 存在
    const messagesWithSystem = this.ensureSystemPrompt(messages, options.systemPrompt);

    // 2. 裁剪超窗口消息（可能触发 LLM 摘要调用，需要 signal）
    const trimmedMessages = await this.contextManager.fitToWindow(
      messagesWithSystem,
      tools,
    );

    // 2a. 验证 system 消息未被裁剪修改（prompt caching 关键条件）
    this.validateSystemPrompt(messagesWithSystem, trimmedMessages);

    // 如果裁剪时需要 abort
    if (signal.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }

    // 3. 准备工具定义（排序 + 序列化）
    const preparedTools = this.prepareTools(tools);

    // 4. 组装请求
    return this.assembleRequest(trimmedMessages, preparedTools, options);
  }

  /**
   * 验证 system 消息在 fitToWindow 后未被修改。
   * system 消息变化会导致 prompt caching 前缀不匹配，所有后续请求 cache miss。
   */
  private validateSystemPrompt(
    original: Message[],
    trimmed: Message[],
  ): void {
    if (trimmed.length === 0) return;

    const originalSystem = original[0];
    const trimmedSystem = trimmed[0];

    // 同一引用或内容相同 → 验证通过
    if (
      originalSystem === trimmedSystem ||
      (originalSystem?.role === 'system' &&
       trimmedSystem?.role === 'system' &&
       originalSystem?.content === trimmedSystem?.content)
    ) {
      return;
    }

    // system 消息被修改 → 警告
    console.warn(
      '[StepBuilder] System prompt was modified or removed during fitToWindow. ' +
      'This will cause prompt cache misses for all subsequent steps in this turn.',
    );
  }

  /**
   * 准备工具定义：按名称排序后返回。
   * 排序确保每次请求中工具定义顺序一致，满足 DeepSeek Context Caching 的前缀匹配要求。
   */
  private prepareTools(tools: ToolDefinition[]): ToolDefinition[] | undefined {
    if (tools.length === 0) return undefined;

    return [...tools].sort((a, b) =>
      a.function.name.localeCompare(b.function.name),
    );
  }

  /**
   * 确保消息历史中存在 system prompt。
   *
   * 优先级：
   * 1. messages 中已有的 system 消息（第一条 role === 'system'）
   * 2. options.systemPrompt（在前面插入）
   * 3. 都没有则不添加
   */
  private ensureSystemPrompt(
    messages: Message[],
    systemPrompt?: string,
  ): Message[] {
    // 已有 system 消息
    if (messages.length > 0 && messages[0].role === 'system') {
      return messages;
    }

    // 用 options.systemPrompt 插入
    if (systemPrompt) {
      return [
        { role: 'system', content: systemPrompt },
        ...messages,
      ];
    }

    // 都没有，返回原样
    return messages;
  }

  /**
   * 组装最终的 ChatRequest 对象。
   * 只在有值时传入可选字段（temperature、max_tokens、tools）。
   */
  private assembleRequest(
    messages: Message[],
    tools: ToolDefinition[] | undefined,
    options: AgentOptions,
  ): ChatRequest {
    const request: ChatRequest = {
      model: options.model,
      messages,
      stream: true,
    };

    if (tools && tools.length > 0) {
      request.tools = tools;
    }

    // 可选参数按需传入
    if (options.temperature !== undefined) {
      request.temperature = options.temperature;
    }

    if (options.maxTokens !== undefined) {
      request.max_tokens = options.maxTokens;
    }

    return request;
  }
}
```

---

## 边界情况与错误处理

| 场景 | 行为 |
|---|---|
| `messages` 为空数组 | `ensureSystemPrompt` 可能插入 system 消息或返回空数组；后续 `fitToWindow` 可能报错（取决于实现） |
| `tools` 为空数组 | `tools` 字段不传入 `ChatRequest`，纯对话模式 |
| `systemPrompt` 未设置且 messages 无 system | 不添加 system 消息，LLM 无系统指令 |
| `messages[0]` 是 system 且 `options.systemPrompt` 也设置了 | 优先使用 messages 中已有的 system 消息 |
| `fitToWindow` 抛出 `ContextWindowError` | 透传给调用方，Loop 应终止 Turn |
| `signal.aborted` 在 `fitToWindow` 返回后为 true | 抛出 `AbortError` |
| `temperature` 为 0 | 正常传入 `{temperature: 0}`（0 是有效值，不能用 `||` 判断） |
| `maxTokens` 未设置 | 不传入，由 API 使用默认值 |

---

## Prompt Caching 优化策略

### 背景

DeepSeek 从 2024 年 8 月起支持 **Context Caching on Disk**，默认开启，无需申请。缓存命中时：

| 指标 | 未命中 | 命中 |
|---|---|---|
| 输入价格（每百万 token） | $0.14 | **$0.014**（10x 降低） |
| 1M prompt 延迟 | ~13s | **~500ms**（~20x 降低） |

Reference: [DeepSeek Context Caching Guide](https://api-docs.deepseek.com/guides/kv_cache)

### 缓存机制

DeepSeek 在三种情况下创建缓存前缀单元：

1. **请求边界处**：每个请求的用户输入结束位置和模型输出结束位置
2. **公共前缀检测**：多个请求共享的公共前缀被单独持久化
3. **固定 token 间隔**：长输入按固定间距切分

关键是：后续请求必须**完全匹配**某个缓存前缀单元（从 token 0 开始逐字节相同），部分匹配不会命中。

### 多轮对话中的缓存行为

以一次含 tool_calls 的 Turn 为例：

```
Step 1 请求: [system, user_msg]
             → 创建缓存单元 C1 = [system, user_msg]
Step 2 请求: [system, user_msg, assistant(tool_calls), tool_result]
             → 前缀 [system, user_msg] 完全匹配 C1 → 命中！
             → 创建缓存单元 C2 = [system, user_msg, assistant, tool_result]
Step 3 请求: [system, user_msg, assistant, tool_result, assistant, tool_result_2]
             → 前缀 [system, user_msg, assistant, tool_result] 完全匹配 C2 → 命中！
```

**结论：只要不修改已有消息，每个新 Step 自动命中上一个 Step 创建的缓存单元。**

### StepBuilder 中保证缓存命中率的三个措施

#### 措施 1：工具定义按名称排序

```typescript
// ❌ 不稳定的顺序（取决于注册顺序）
const tools = registry.getDefinitions();

// ✅ 稳定顺序（按名称排序）
const tools = [...registry.getDefinitions()]
  .sort((a, b) => a.function.name.localeCompare(b.function.name));
```

原因：tools 数组是请求 body 的一部分，顺序变化会导致前缀不匹配。即使两次请求的 tools 集合完全相同，顺序不同也会 cache miss。

#### 措施 2：保持 System Prompt 完全不变

- 始终使用完全相同的 system 消息字符串（包括末尾空格、换行符）
- 从 `options.systemPrompt` 创建 system 消息后，所有后续 Step 复用 `messages[0]`
- **禁止**在 Step 之间修改 system 消息

#### 措施 3：对 fitToWindow 的缓存友好约束

`fitToWindow` 是缓存命中率最大的变量——如果它修改了前缀中的任何消息，后续 Step 全部 cache miss。

StepBuilder 层面的约束：
- 裁剪只应移除/压缩**中间或末尾**的消息，**不动 system 消息（messages[0]）**
- 优先使用摘要压缩旧消息（内容变化但位置保留），而非删除旧消息（位置前移导致前缀断裂）
- StepBuilder 在调用 `fitToWindow` 后验证 `result[0]` 仍为原始 system 消息（同一引用或内容相同）

```typescript
const trimmed = await this.contextManager.fitToWindow(messagesWithSystem, tools);

// 验证 system 消息未被修改（缓存安全的关键条件）
const originalSystem = messagesWithSystem[0];
if (trimmed[0] !== originalSystem && trimmed[0]?.content !== originalSystem?.content) {
  // system 消息被修改 → 警告：缓存将失效
  console.warn('[StepBuilder] System prompt was modified during fitToWindow. ' +
    'This will cause prompt cache misses for subsequent steps.');
}
```

### 缓存效果监控

API 响应中的 `usage` 字段包含缓存命中信息（由 Phase 2 的 Provider 层解析）：

```json
{
  "usage": {
    "prompt_tokens": 1500,
    "completion_tokens": 200,
    "prompt_cache_hit_tokens": 1200,
    "prompt_cache_miss_tokens": 300
  }
}
```

- `prompt_cache_hit_tokens = 1200`：前 1200 个 token 命中缓存
- `prompt_cache_miss_tokens = 300`：后 300 个 token 未命中（新增的 tool 结果等）
- 理想情况下，每个 Step 的命中率逐步提高（前缀越来越长）

---

## 测试方案

### 单元测试用例

```typescript
describe('StepBuilder', () => {
  // ===== System Prompt 处理 =====
  it('应该保留 messages 中已有的 system 消息');
  it('当 messages 无 system 时，应该用 options.systemPrompt 插入');
  it('当两者都没有时，不添加 system 消息');
  it('system 消息不在首位时，不应修改');

  // ===== 工具序列化 =====
  it('tools 为空数组时，ChatRequest 不应包含 tools 字段');
  it('tools 非空时，应原样传入 ChatRequest');
  it('tools 应按名称字母排序（保证缓存前缀稳定）');
  it('单个工具的 ToolDefinition 应正确传递');

  // ===== fitToWindow 集成 =====
  it('应该在 build 时调用 contextManager.fitToWindow');
  it('应该将 system 消息插入后再传给 fitToWindow');
  it('fitToWindow 抛出 ContextWindowError 时应透传');
  it('signal.aborted 时应在 fitToWindow 后抛出 AbortError');
  it('fitToWindow 修改 system 消息时，应输出警告日志');

  // ===== 请求组装 =====
  it('应该设置 stream: true');
  it('temperature 为 0 时应正常传入');
  it('temperature 为 undefined 时不传入');
  it('maxTokens 为 undefined 时不传入');
  it('model 应来自 options.model');

  // ===== Prompt Caching =====
  it('连续两次 build 调用，system 消息应保持不变');
  it('连续两次 build 调用，tools 顺序应相同');
  it('应保持 messages 数组前缀不变（只追加，不修改已有消息）');
});
```

### Mock ContextManager

```typescript
function createMockContextManager(
  behavior?: 'passthrough' | 'throw',
): ContextManager {
  return {
    fitToWindow: async (msgs: Message[], _tools: ToolDefinition[]) => {
      if (behavior === 'throw') {
        throw new ContextWindowError('窗口超限', 200000, 1_000_000);
      }
      return msgs; // passthrough: 原样返回
    },
    estimateTokens: (msgs: Message[]) => msgs.reduce((sum, m) => sum + (m.content?.length ?? 0), 0),
  };
}
```

### 测试数据工厂

```typescript
function createTestMessages(): Message[] {
  return [
    { role: 'user', content: 'Hello' },
  ];
}

function createTestTools(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
          },
          required: ['path'],
        },
      },
    },
  ];
}

function createTestOptions(overrides?: Partial<AgentOptions>): AgentOptions {
  return {
    model: 'deepseek-chat',
    maxSteps: 10,
    ...overrides,
  };
}
```

---

## 产出物

| 文件 | 说明 |
|---|---|
| `packages/core/src/agent/step-builder.ts` | StepBuilder 类实现 |
| `packages/core/src/agent/__tests__/step-builder.test.ts` | 单元测试 |

---

## 与后续阶段的接口约定

StepBuilder 产出的 `ChatRequest` 是 Phase 2（Core Loop）的输入，Loop 将其传给 Provider：

```
StepBuilder.build() → ChatRequest → provider.streamMessage(request, signal)
```

StepBuilder 对 Loop 的承诺：
1. 返回的 `ChatRequest.messages` 不超过模型上下文窗口（已由 `fitToWindow` 保证，或抛出异常）
2. `stream` 始终为 `true`
3. 所有必填字段（`model`, `messages`, `stream`）已填充
4. 如果调用中途 `signal` 被 abort，抛出 `AbortError`
