# Phase 1 — 工具注册表（registry.ts）

## 目标

实现完整的 `ToolRegistry`：工具注册、注销、按名称查找执行、以及按名称排序的定义列表导出（保证 Prompt Caching 前缀稳定）。

## 前置依赖

| 依赖 | 说明 |
|---|---|
| `types/` | `Tool`、`ToolDefinition`、`ToolRegistry` 接口已定义 |
| Agent Loop | 无需真实 Agent Loop，仅需 `ToolRegistry` 接口 |

## 接口设计

```typescript
// packages/core/src/tools/registry.ts

import type { Tool, ToolDefinition, ToolRegistry } from '../types/index.js';

function createToolRegistry(): ToolRegistry
```

### 行为规范

- `register(tool: Tool)`: 注册工具，同名工具覆盖旧定义
- `unregister(name: string)`: 注销工具，不存在时静默成功
- `getDefinitions(): ToolDefinition[]`: 按工具名排序返回定义列表
- `execute(name: string, args: Record<string, unknown>): Promise<string>`: 查找并执行工具，不存在时返回错误字符串（不抛异常）

## 核心实现

```typescript
export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>();

  return {
    register(tool: Tool): void {
      tools.set(tool.definition.function.name, tool);
    },

    unregister(name: string): void {
      tools.delete(name);
    },

    getDefinitions(): ToolDefinition[] {
      return Array.from(tools.values())
        .map(t => t.definition)
        .sort((a, b) => a.function.name.localeCompare(b.function.name));
    },

    async execute(name: string, args: Record<string, unknown>): Promise<string> {
      const tool = tools.get(name);
      if (!tool) {
        return `Error: Tool "${name}" not found.`;
      }
      try {
        return await tool.execute(args);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error: ${message}`;
      }
    },
  };
}
```

## 验收标准

- [ ] `tsc --noEmit` 通过
- [ ] 注册工具后可正常执行
- [ ] 同名覆盖旧工具
- [ ] 注销后执行返回错误字符串
- [ ] `getDefinitions()` 返回按名称排序的列表
- [ ] 工具执行异常返回错误字符串（不抛异常）

## 下一步

Phase 1 完成后，`createToolRegistry()` 可注册任意工具。Phase 2 实现内置工具。
