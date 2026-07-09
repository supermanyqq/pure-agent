# Phase 3 — Tool Executor + Loop Detector（工具执行调度 + 死循环检测）

## 目标

实现两个独立组件：

1. **Tool Executor** (`executeAll`)：接收 LLM 返回的 `ToolCall[]`，并行执行工具，收集结果，错误隔离
2. **Loop Detector** (`LoopDetector`)：检测 LLM 是否陷入死循环（连续 3 次返回相同的工具调用）

## 前置依赖

| 依赖 | 说明 |
|---|---|
| `types/` | `ToolCall`, `ToolResult`, `ToolDefinition` |
| `tools/` | `ToolRegistry` 接口，提供 `execute(name, args): Promise<string>` |

---

# Part A — Tool Executor

## 接口设计

```typescript
// packages/core/src/agent/tool-executor.ts

import type { ToolCall, ToolResult } from '../types/index.js';
import type { ToolRegistry } from '../tools/index.js';

async function executeAll(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  signal: AbortSignal,
): Promise<ToolResult[]>;
```

### 参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `toolCalls` | `ToolCall[]` | LLM 返回的工具调用列表，至少 1 个 |
| `registry` | `ToolRegistry` | 工具注册表，负责查找和执行工具 |
| `signal` | `AbortSignal` | 用于在执行前检查是否已中止 |

### 返回值

```typescript
// 始终返回与 toolCalls 等长的数组，顺序对应
interface ToolResult {
  toolCallId: string;  // 对应 ToolCall.id
  content: string;     // 工具执行结果（JSON 序列化）或空字符串
  error?: string;      // 错误信息（如果执行失败）
}
```

---

## 核心流程

```
executeAll(toolCalls, registry, signal)
  │
  ├─ Promise.all(toolCalls.map(async (tc) => {
  │
  │    ├─ 0. 检查 signal.aborted  → 返回 aborted 结果
  │    │
  │    ├─ 1. JSON.parse(tc.function.arguments)
  │    │     将 JSON 字符串解析为 Record<string, unknown>
  │    │     解析失败 → 返回错误结果
  │    │
  │    ├─ 2. registry.execute(tc.function.name, parsedArgs)
  │    │     查找工具 → 执行 → 等待结果
  │    │     工具不存在 → 返回错误结果
  │    │     工具执行异常 → 返回错误结果
  │    │
  │    └─ 3. 返回 { toolCallId: tc.id, content: result }
  │
  │  }))
  │
  └─ 返回 ToolResult[]（与输入顺序一致）
```

**关键设计**：使用 `Promise.all` 但每个工具调用的错误在内部 try/catch——实现 `Promise.allSettled` 语义。一个工具的失败永远不影响其他工具。

---

## 详细实现

```typescript
// packages/core/src/agent/tool-executor.ts

import type { ToolCall, ToolResult } from '../types/index.js';
import type { ToolRegistry } from '../tools/index.js';

/**
 * 并行执行多个工具调用。
 *
 * 设计要点：
 * - 并发执行（Promise.all），无依赖关系的工具不互相阻塞
 * - 错误隔离：任一工具失败不影响其他工具
 * - 参数解析：ToolCall.function.arguments 从 JSON 字符串解析为对象
 * - Abort 感知：执行前和 abort 时正确处理
 */
export async function executeAll(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  signal: AbortSignal,
): Promise<ToolResult[]> {
  return Promise.all(
    toolCalls.map(async (tc): Promise<ToolResult> => {
      // 如果已被 abort，快速返回
      if (signal.aborted) {
        return {
          toolCallId: tc.id,
          content: '',
          error: 'Aborted by user',
        };
      }

      // 1. 解析 arguments
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch (parseError) {
        return {
          toolCallId: tc.id,
          content: '',
          error: `Invalid JSON arguments: ${(parseError as Error).message}`,
        };
      }

      // 2. 执行工具
      try {
        const content = await registry.execute(tc.function.name, args);
        return {
          toolCallId: tc.id,
          content,
        };
      } catch (execError) {
        const message =
          execError instanceof Error ? execError.message : String(execError);
        return {
          toolCallId: tc.id,
          content: '',
          error: message,
        };
      }
    }),
  );
}
```

---

## 错误分类

Tool Executor 对错误做两层分类：

| 错误阶段 | 示例 | 行为 |
|---|---|---|
| **参数解析失败** | `arguments: '{invalid json'` | 返回 `error: "Invalid JSON arguments: ..."` ，`content: ''` |
| **工具不存在** | LLM 调用 `unknown_tool` | 由 `registry.execute()` 决定：抛出异常或返回错误文本 |
| **工具执行异常** | `read_file` 文件不存在 | 返回 `error: "ENOENT: ..."` ，`content: ''` |
| **工具执行成功** | 正常执行 | `content` 为工具返回值 |

所有错误都不抛给调用方（AgentLoop），而是通过 `ToolResult.error` 字段返回。AgentLoop 将错误格式化后作为 tool 消息返回给 LLM，让 LLM 自行决定如何处理。

---

## 工具执行超时

当前设计中 `registry.execute()` **不支持超时和 abort 信号**。这是已知局限：

- 短期方案：工具自身负责设置超时（如 `shell_exec` 内部设置 30s 超时）
- 长期方案：`ToolRegistry.execute()` 签名扩展为 `execute(name, args, signal?)`，Tool Executor 将 signal 传递给每个工具

Tool Executor 本身不引入超时机制，因为不同工具的合理超时差异太大（`read_file` 通常 <100ms，`shell_exec` 可能数分钟）。

---

# Part B — Loop Detector

## 接口设计

```typescript
// packages/core/src/agent/loop-detector.ts

import type { ToolCall } from '../types/index.js';

class LoopDetector {
  addToolCalls(toolCalls: ToolCall[]): void;
  isLooping(): boolean;
  reset(): void;
}
```

### 工作原理

```
Step N:   toolCalls = [read_file("a.txt"), shell_exec("ls")]
Step N+1: toolCalls = [read_file("a.txt"), shell_exec("ls")]  ← 与 Step N 相同, repeatCount = 2
Step N+2: toolCalls = [read_file("a.txt"), shell_exec("ls")]  ← 又与上一步相同, repeatCount = 3 → isLooping() = true
```

- **只比较相邻的两次**（当前 Step 与上一个 Step），不比较更早的历史
- **比较粒度**：函数名 + arguments 字符串全等。不做深度 JSON 比较以避免复杂度
- **阈值**：连续 3 次相同 → 判定为死循环

### 为什么阈值是 3 而不是 2？

连续 2 次相同的工具调用不一定意味着死循环。两种典型场景：

1. **结果不够详细**：LLM 第一次调用 `read_file("config.json")` 得到的结果不够，第二次用相同的参数再调用一次以获取更完整的上下文。第三次还相同才说明确实陷入了无效循环。
2. **重试逻辑**：某些工具可能因为网络抖动失败，LLM 重试一次是合理的。第三次还重试才算异常。

3 次给 LLM 留了自我纠正的空间，同时不会让循环跑太久。

---

## 详细实现

```typescript
// packages/core/src/agent/loop-detector.ts

import type { ToolCall } from '../types/index.js';

/**
 * 检测 LLM 是否陷入死循环。
 *
 * 算法：比较当前 toolCalls 与上一个 Step 的 toolCalls。
 * 如果连续 THRESHOLD(3) 次相同 → 判定为死循环。
 */
export class LoopDetector {
  private readonly THRESHOLD = 3;

  private previousToolCalls: ToolCall[] | null = null;
  private repeatCount = 0;

  /**
   * 记录本次 Step 的工具调用，更新重复计数。
   */
  addToolCalls(toolCalls: ToolCall[]): void {
    if (
      this.previousToolCalls &&
      this.isSameCallSet(this.previousToolCalls, toolCalls)
    ) {
      this.repeatCount++;
    } else {
      // 不同 → 重置计数（从 1 开始，表示这是第 1 次出现）
      this.repeatCount = 1;
    }

    this.previousToolCalls = toolCalls;
  }

  /**
   * 是否已检测到死循环。
   */
  isLooping(): boolean {
    return this.repeatCount >= this.THRESHOLD;
  }

  /**
   * 每个新 Turn 开始时重置状态。
   */
  reset(): void {
    this.previousToolCalls = null;
    this.repeatCount = 0;
  }

  /**
   * 比较两组 ToolCall 是否相同。
   *
   * 相同判定：
   * 1. 数组长度相同
   * 2. 每个位置的 function.name 相同
   * 3. 每个位置的 function.arguments 相同（字符串比较，不做 JSON 深度解析）
   */
  private isSameCallSet(a: ToolCall[], b: ToolCall[]): boolean {
    if (a.length !== b.length) return false;

    return a.every((tc, i) => {
      const other = b[i];
      if (tc.function.name !== other.function.name) return false;
      if (tc.function.arguments !== other.function.arguments) return false;
      return true;
    });
  }
}
```

---

## 为什么不做深度 JSON 比较？

`arguments` 是 JSON 字符串。LLM 可能生成的两个等价 JSON 字符串在字符串层面不同（空格差异、key 顺序不同）：

```json
{"path": "a.txt", "mode": "read"}
{"mode": "read", "path": "a.txt"}
```

这两个在语义上等价但字符串比较不等。那为什么不解析后深度比较？

**原因**：
1. **LLM 通常生成一致的 JSON**：同一模型对同一意图的 tool_call 倾向于使用相同的 key 顺序和格式
2. **字符串比较更安全**：深度 JSON 比较可能隐藏真正的循环（不同顺序但相同语义 → LLM 确实在重复相同操作）
3. **简单优先**：先用字符串比较覆盖 90% 场景，如果有误判（LLM 换了 key 顺序但语义相同），后续可以升级为深度比较

---

## 边界情况

### Tool Executor

| 场景 | 行为 |
|---|---|
| `toolCalls` 为空数组 | `Promise.all([])` 返回 `[]` |
| `tc.function.arguments` 为空字符串 | `JSON.parse('')` 抛出异常 → 返回 `error` |
| `tc.function.arguments` 包含非法 JSON | 返回 `error: "Invalid JSON arguments: ..."` |
| `tc.id` 为空字符串 | 仍然返回结果，`toolCallId: ''`（LLM 应始终提供 id） |
| `registry.execute()` 返回非字符串 | 强制转换为字符串（`String(content)` 或由 registry 保证） |
| 工具执行耗时过长 | Tool Executor 不限制，等待完成 |
| `registry.execute()` 抛出非 Error 对象 | `String(execError)` 兜底 |
| `signal.aborted` 在 `Promise.all` 执行期间触发 | 已开始的工具不受影响（局限），未开始的工具在下一行检查到 |

### Loop Detector

| 场景 | 行为 |
|---|---|
| 第一个 Step | `previousToolCalls` 为 null，`repeatCount = 1` |
| 第二个 Step 与第一个不同 | `isSameCallSet` 返回 false，`repeatCount = 1`（重置） |
| 第二个 Step 与第一个相同 | `repeatCount = 2` |
| 第三个 Step 与第二个相同 | `repeatCount = 3`，`isLooping() = true` |
| 第三个 Step 与第二个不同 | `repeatCount = 1`（重置），循环检测重新开始 |
| tool_calls 数组长度不同 | `isSameCallSet` 立即返回 false |
| tool_calls 数组顺序不同（元素相同但排列不同） | `isSameCallSet` 返回 false（视为不同调用） |
| 两次调用间调用了 `reset()` | 状态清空，`previousToolCalls = null`, `repeatCount = 0` |

---

## 完整源码

### tool-executor.ts

```typescript
// packages/core/src/agent/tool-executor.ts

import type { ToolCall, ToolResult } from '../types/index.js';
import type { ToolRegistry } from '../tools/index.js';

/**
 * 并行执行多个工具调用，错误隔离。
 *
 * 每个工具调用独立的 try/catch，一个失败不影响其他。
 * 执行前将 ToolCall.function.arguments 从 JSON 字符串解析为对象。
 */
export async function executeAll(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  signal: AbortSignal,
): Promise<ToolResult[]> {
  return Promise.all(
    toolCalls.map(async (tc): Promise<ToolResult> => {
      // Abort 快速返回
      if (signal.aborted) {
        return {
          toolCallId: tc.id,
          content: '',
          error: 'Aborted by user',
        };
      }

      // 解析 JSON arguments
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch (parseError) {
        return {
          toolCallId: tc.id,
          content: '',
          error: `Invalid JSON arguments: ${(parseError as Error).message}`,
        };
      }

      // 执行工具
      try {
        const content = await registry.execute(tc.function.name, args);
        return { toolCallId: tc.id, content };
      } catch (execError) {
        const message =
          execError instanceof Error ? execError.message : String(execError);
        return {
          toolCallId: tc.id,
          content: '',
          error: message,
        };
      }
    }),
  );
}
```

### loop-detector.ts

```typescript
// packages/core/src/agent/loop-detector.ts

import type { ToolCall } from '../types/index.js';

/**
 * 检测 LLM 是否陷入死循环。
 *
 * 比较每个 Step 的 toolCalls 与上一个 Step。
 * 连续 THRESHOLD(3) 次相同 → 判定为死循环。
 */
export class LoopDetector {
  private readonly THRESHOLD = 3;

  private previousToolCalls: ToolCall[] | null = null;
  private repeatCount = 0;

  addToolCalls(toolCalls: ToolCall[]): void {
    if (
      this.previousToolCalls &&
      this.isSameCallSet(this.previousToolCalls, toolCalls)
    ) {
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

  /**
   * 比较两组 toolCalls 的函数名和 JSON 参数字符串是否完全相同。
   * 不做 JSON 深度解析——先覆盖最常见场景，后续可按需升级。
   */
  private isSameCallSet(a: ToolCall[], b: ToolCall[]): boolean {
    if (a.length !== b.length) return false;

    return a.every(
      (tc, i) =>
        tc.function.name === b[i].function.name &&
        tc.function.arguments === b[i].function.arguments,
    );
  }
}
```

---

## 测试方案

### Tool Executor 单元测试

```typescript
describe('executeAll', () => {
  // ===== 并行执行 =====
  it('应该并行执行多个工具调用');
  it('多个工具的执行顺序不应影响结果顺序');
  it('单个工具调用应正常执行');

  // ===== 参数解析 =====
  it('应该正确解析 JSON arguments');
  it('arguments 为空字符串时返回解析错误');
  it('arguments 为非法 JSON 时返回解析错误');
  it('arguments 包含嵌套对象和数组时应正确解析');

  // ===== 错误隔离 =====
  it('一个工具失败不应影响另一个工具');
  it('工具抛出 Error 时应返回 error 字段');
  it('工具抛出非 Error 对象时应捕获');

  // ===== Abort =====
  it('signal.aborted 时应返回 aborted 结果');

  // ===== 空输入 =====
  it('toolCalls 为空数组时应返回空数组');
});
```

### Loop Detector 单元测试

```typescript
describe('LoopDetector', () => {
  // ===== 基本检测 =====
  it('第一次调用不应判定为循环');
  it('连续 2 次相同调用不应判定为循环');
  it('连续 3 次相同调用应判定为循环');
  it('第 2 次不同时应重置计数');
  it('第 3 次与第 2 次不同时应重置计数');

  // ===== 比较逻辑 =====
  it('函数名不同时应判定为不同');
  it('arguments 不同时应判定为不同');
  it('数组长度不同时应判定为不同');
  it('数组顺序不同时应判定为不同');

  // ===== reset =====
  it('reset 后应清除状态（不判定为循环）');
  it('reset 后第一次调用 repeatCount 应为 1');

  // ===== 边界 =====
  it('空 toolCalls 数组与空数组比较应相同');
  it('arguments 为空字符串时应正常比较');
});
```

### Mock ToolRegistry

```typescript
function createMockRegistry(
  handlers: Record<string, (args: Record<string, unknown>) => string>,
): ToolRegistry {
  return {
    getDefinitions: () => [],
    execute: async (name: string, args: Record<string, unknown>) => {
      const handler = handlers[name];
      if (!handler) {
        throw new Error(`Tool not found: ${name}`);
      }
      return handler(args);
    },
  };
}

// 使用示例：测试错误隔离
const registry = createMockRegistry({
  succeed: () => 'success',
  fail: () => {
    throw new Error('boom');
  },
  slow: async () => {
    await new Promise(r => setTimeout(r, 100));
    return 'done';
  },
});
```

---

## 产出物

| 文件 | 说明 |
|---|---|
| `packages/core/src/agent/tool-executor.ts` | `executeAll()` 函数 |
| `packages/core/src/agent/loop-detector.ts` | `LoopDetector` 类 |
| `packages/core/src/agent/__tests__/tool-executor.test.ts` | Tool Executor 单元测试 |
| `packages/core/src/agent/__tests__/loop-detector.test.ts` | Loop Detector 单元测试 |

---

## 与 Phase 2 的接口约定

Phase 3 的两个组件被 Phase 2（AgentLoop）调用：

```
AgentLoop.run()
  │
  ├─ loopDetector.reset()          ← Turn 开始时
  │
  ├─ executeAll(toolCalls, ...)    ← finish_reason 为 tool_calls 时
  │
  └─ loopDetector.addToolCalls()   ← 工具执行完毕后
     loopDetector.isLooping()     ← 检查是否死循环
```

AgentLoop 依赖：
- `executeAll` 始终返回与输入等长的数组（不抛异常）
- `LoopDetector.isLooping()` 只在连续 3 次相同调用后返回 true
- `LoopDetector.reset()` 在每个新 Turn 必须调用（AgentLoop.run() 开头）
