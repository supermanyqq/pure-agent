# Phase 1 — 工具结果预裁剪（tool-pruner.ts）

## 目标

实现 `tool-pruner.ts`：在 LLM 摘要前对旧 tool 结果进行廉价预裁剪。纯字符串处理，无 LLM 调用，< 1ms 完成。

## 前置依赖

| 依赖 | 说明 |
|---|---|
| `types/` | `Message`, `ToolCall`, `ToolResult` |
| `context/types.ts` | `PruneResult` 及相关类型 |

## 接口设计

```typescript
// packages/core/src/context/tool-pruner.ts

function pruneToolResults(
  messages: Message[],
  options?: PruneOptions,
): PruneResult
```

### 参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `messages` | `Message[]` | 完整消息历史 |
| `options.protectTailCount` | `number` | 尾部保护条数，默认 8 |
| `options.protectTailTokens` | `number` | 尾部保护 token 数 |
| `options.maxToolContentChars` | `number` | tool 结果最大字符数，默认 200 |
| `options.singleLineSummary` | `boolean` | 是否启用摘要化，默认 true |

### 返回值

```typescript
interface PruneResult {
  messages: Message[];          // 裁剪后的消息
  prunedCount: number;          // 被裁剪的消息数
  tokensSaved: number;          // 节省的 token 数
  duplicatesRemoved: number;    // 去重的 tool 结果数
  summarizedCount: number;      // 被摘要化的 tool 结果数
}
```

---

## 核心流程

```
pruneToolResults(messages, options)
  │
  ├── 1. 去重
  │     遍历 tool 消息，计算 content 的 MD5 哈希
  │     相同哈希 → 只保留最新出现的副本
  │     注意：不同 toolCallId 的相同 content 视为重复
  │
  ├── 2. 摘要化
  │     tool 结果 > 200 chars → 替换为信息丰富的单行描述
  │     [terminal]   ran `cmd` → exit N, M lines output
  │     [read_file]  read path from line N (M chars)
  │     [search]     search for 'q' in dir/ → N matches
  │     [generic]    tool_name returned M chars
  │
  └── 3. 截断
        assistant 消息的 tool_calls arguments JSON 过长
        → JSON 保结构截断（保留 keys，截断 values）
```

---

## 详细实现

### Step 1: 去重

```typescript
function deduplicateToolResults(
  messages: Message[],
  protectTailCount: number,
): { messages: Message[]; duplicatesRemoved: number } {
  // 保护尾部消息不被去重
  const protectedStart = Math.max(0, messages.length - protectTailCount);
  const protectedMsgs = messages.slice(protectedStart);
  const candidateMsgs = messages.slice(0, protectedStart);

  // 从后向前遍历，记录每个 content 哈希的最新位置
  const seen = new Map<string, number>(); // hash → index
  const keep = new Set<number>();

  for (let i = candidateMsgs.length - 1; i >= 0; i--) {
    const msg = candidateMsgs[i];
    if (msg.role !== 'tool') {
      keep.add(i);
      continue;
    }
    const hash = md5(msg.content);
    if (seen.has(hash)) {
      // 重复 → 跳过
      continue;
    }
    seen.set(hash, i);
    keep.add(i);
  }

  // 按索引排序重建消息列表
  const kept = candidateMsgs.filter((_, i) => keep.has(i));
  const duplicatesRemoved = candidateMsgs.length - kept.length;

  return {
    messages: [...kept, ...protectedMsgs],
    duplicatesRemoved,
  };
}
```

注意事项：
- 从后向前遍历确保保留最新副本
- 非 tool 消息永远保留
- `protectTailCount` 条尾部消息完全不受影响

### Step 2: 摘要化

tool 结果按工具名分类，生成信息丰富的单行描述：

```typescript
function summarizeToolResult(
  toolName: string,
  content: string,
  maxChars: number,
): string | null {
  if (content.length <= maxChars) return null; // 不需要摘要化

  switch (toolName) {
    case 'shell_exec':
    case 'terminal': {
      // [terminal] ran `npm test` → exit 0, 47 lines output
      const firstLine = content.split('\n')[0]?.slice(0, 100) ?? '';
      const lines = content.split('\n').length;
      // 尝试提取 exit code
      const exitMatch = content.match(/exit[= ](\d+)/i);
      const exitStr = exitMatch ? `exit ${exitMatch[1]}` : 'completed';
      return `[terminal] ran \`${firstLine}\` → ${exitStr}, ${lines} lines output`;
    }

    case 'read_file': {
      // [read_file] read config.py from line 1 (3,400 chars)
      // 从 arguments 中无法获取 path，这里从 content 中提取
      const lines = content.split('\n').length;
      return `[read_file] read file (${content.length} chars, ${lines} lines)`;
    }

    case 'search_files':
    case 'search': {
      const matchCount = (content.match(/^Found \d+|^\d+ matches?/m)?.[0]) ?? 'N matches';
      return `[search] ${matchCount}`;
    }

    case 'web_search': {
      const resultCount = (content.match(/^\d+ results?/m)?.[0]) ?? 'N results';
      return `[web_search] ${resultCount}`;
    }

    case 'web_fetch': {
      return `[web_fetch] fetched URL (${content.length} chars)`;
    }

    default: {
      // [tool_name] returned M chars
      return `[${toolName}] returned ${content.length} chars`;
    }
  }
}
```

### Step 3: 截断 tool_calls arguments

```typescript
function truncateToolCallArguments(
  toolCalls: ToolCall[],
  maxArgsLength: number = 1500,
): ToolCall[] {
  return toolCalls.map(tc => {
    if (tc.function.arguments.length <= maxArgsLength) return tc;

    try {
      const args = JSON.parse(tc.function.arguments);
      const truncated = truncateObjectValues(args, 200);
      return {
        ...tc,
        function: {
          ...tc.function,
          arguments: JSON.stringify(truncated),
        },
      };
    } catch {
      // JSON 解析失败 → 直接字符串截断
      return {
        ...tc,
        function: {
          ...tc.function,
          arguments: tc.function.arguments.slice(0, maxArgsLength) + '...',
        },
      };
    }
  });
}

/** 递归截断对象中的长字符串值，保留结构 */
function truncateObjectValues(
  obj: Record<string, unknown>,
  maxLen: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value.length > maxLen) {
      result[key] = value.slice(0, maxLen) + '...[truncated]';
    } else if (Array.isArray(value)) {
      result[key] = value.map(v =>
        typeof v === 'string' && v.length > maxLen
          ? v.slice(0, maxLen) + '...[truncated]'
          : v
      );
    } else if (typeof value === 'object' && value !== null) {
      result[key] = truncateObjectValues(
        value as Record<string, unknown>,
        maxLen,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}
```

---

## 边界控制

通过两个参数保护尾部消息不被误裁剪：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `protectTailCount` | 8 | 尾部 N 条消息完全不受去重/摘要化影响 |
| `protectTailTokens` | 由调用方预算决定 | 尾部保护的 token 预算 |

尾部保护的原因：当前活跃 Turn 中的 tool 结果可能需要完整内容（LLM 正在基于这些结果做决策），而去重/摘要化是针对历史 Turn 的廉价优化。

---

## 边界情况

| 场景 | 行为 |
|---|---|
| 空消息列表 | 返回空 `PruneResult` |
| 无 tool 消息 | 原样返回，所有计数为 0 |
| 所有消息在保护区内 | 不做任何裁剪 |
| tool content 为 null | 视为空字符串处理 |
| 去重后所有候选消息被移除 | 只返回保护区消息 |
| 超长 tool content（>100K chars） | 摘要化后仍截断到 maxToolContentChars |

---

## 测试方案

```typescript
describe('pruneToolResults', () => {
  // 去重
  it('相同 content 的 tool 结果只保留最新副本');
  it('不同 toolCallId 但相同 content 视为重复');
  it('非 tool 消息不受去重影响');

  // 摘要化
  it('shell_exec 大结果 → 单行摘要');
  it('read_file 大结果 → 单行摘要');
  it('小结果（≤200 chars）不摘要化');

  // 截断
  it('tool_calls arguments 过长时 JSON 保结构截断');
  it('arguments JSON 解析失败时直接字符串截断');

  // 尾部保护
  it('尾部 protectTailCount 条消息完全不受影响');
  it('仅有的消息数 ≤ protectTailCount 时不做任何裁剪');
});
```

---

## 产出物

| 文件 | 说明 |
|---|---|
| `packages/core/src/context/tool-pruner.ts` | 工具结果预裁剪实现 |
| `packages/core/src/context/__tests__/tool-pruner.test.ts` | 单元测试 |
