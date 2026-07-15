# Phase 1 — 工具注册表（registry.ts）

## 目标

实现完整的 `ToolRegistry`：工具注册、注销、toolset 分组管理、可用性门控、以及按名称排序的定义列表导出（保证 Prompt Caching 前缀稳定）。

## 前置依赖

| 依赖 | 说明 |
|------|------|
| `types/` | `Tool`、`ToolDefinition`、`ToolRegistry`、`ToolContext`、`ToolResult` 接口已定义 |
| Agent Loop | 无需真实 Agent Loop，仅需 `ToolRegistry` 接口 |

---

## 三项目 Registry 设计对比

在重写本文档前，我们分析了三个开源项目的注册表设计：

### Hermes Agent — 单例 + 自注册 + AST 发现

```python
# tools/registry.py — 模块级单例
class ToolRegistry:
    def __init__(self):
        self._tools: Dict[str, ToolEntry] = {}
        self._toolset_checks: Dict[str, Callable] = {}
        self._lock = threading.RLock()
        self._generation: int = 0  # 单调递增，用于 cache invalidation

registry = ToolRegistry()  # 单例

# tools/file_tools.py — 工具文件自注册（模块 import 时执行）
registry.register(
    name="read_file",
    toolset="file",
    schema=READ_FILE_SCHEMA,
    handler=_handle_read_file,
    check_fn=_check_file_reqs,
    emoji="📖",
)

# 发现机制：AST 扫描 tools/*.py → import → 触发模块级 register() 调用
def discover_builtin_tools(tools_dir):
    for path in sorted(tools_path.glob("*.py")):
        if _module_registers_tools(path):   # AST 检查是否有 registry.register() 调用
            importlib.import_module(f"tools.{path.stem}")
```

**设计要点**：
- **自注册**：工具文件 import 时自动调用 `registry.register()`
- **AST 发现**：静态分析源码确定哪些模块是工具模块，避免维护中央清单
- **Generation counter**：每次 register/deregister 递增，外部缓存可 key 在 generation 上
- **线程安全**：`threading.RLock` 保护读写，`_snapshot_state()` 提供一致性快照
- **冲突检测**：同名工具来自不同 toolset 时默认拒绝，需要 `override=True` opt-in

### Cline — 工厂函数 + 数组注入

```typescript
// 无中央 Registry 类，工具直接作为 AgentTool[] 注入 AgentRuntime
function createDefaultTools(options: CreateDefaultToolsOptions): AgentTool[] {
    const tools: AgentTool[] = [];
    if (enableReadFiles && executors.readFile)
        tools.push(createReadFilesTool(executors.readFile, config));
    if (enableSearch && executors.search)
        tools.push(createSearchTool(executors.search, config));
    // ...
    return tools;
}

// Plugin 工具通过 sandbox 中的 registerTool API 注册
const api: AgentExtensionApi = {
    registerTool: (tool) => tools.push(tool),
    // ...
};
```

**设计要点**：
- **无中央 Registry**：工具以 `AgentTool[]` 数组形式存在
- **条件编译**：每工具有 enable flag + executor 存在性双重门控
- **Plugin sandbox**：插件在独立 V8 isolate 中运行，通过 API 注册工具

### Kilo Code — Effect Layer + InstanceState

```typescript
// 工具注册表是一个 Effect Layer，通过依赖注入提供服务
export const layer: Layer.Layer<Service, never, Config | Plugin | ...> = Layer.effect(
    Service,
    Effect.gen(function* () {
        // 解析所有工具 Info → 通过 Tool.init(info) 初始化
        const tool = yield* Effect.all({
            invalid: Tool.init(invalid),
            read: Tool.init(read),
            shell: Tool.init(shell),
            // ... 20+ builtin tools
        });

        // State 包含 builtin + custom 两个数组
        const state = yield* InstanceState.make<State>(() => ({
            custom: [],
            builtin: KiloToolRegistry.describe([...]),
        }));

        return Service.of({
            all: () => [...state.builtin, ...state.custom],
            tools: (model) => filterByPermissions(all()),
        });
    }),
);
```

**设计要点**：
- **Effect Layer DI**：所有依赖通过 Layer 注入，易测试
- **InstanceState**：保持 mutable state 但通过 Effect 管理 lifecycle
- **builtin + custom 分离**：两种来源的工具分别管理
- **Tool.Info vs Tool.Def**：Info 是 lazy descriptor，Def 是 materialized tool

---

## Pure Agent 的 Registry 设计

综合三个项目的设计，Pure Agent 的 Registry 采用以下方案：

### 接口设计

```typescript
// packages/core/src/tools/registry.ts

import type { Tool, ToolDefinition, ToolRegistry, ToolContext, ToolResult } from '../types/index.js';

function createToolRegistry(): ToolRegistry
```

### 核心实现

```typescript
interface ToolEntry {
  tool: Tool;
  registeredAt: number;  // Date.now()，用于调试和审计
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolEntry>();
  const toolsets = new Map<string, Set<string>>();  // toolset → tool names

  return {
    // ===== 注册 =====
    register(tool: Tool): void {
      const name = tool.definition.name;

      // 校验：工具名必须匹配 snake_case 或 MCP namespace 格式
      if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(name)) {
        throw new Error(`Invalid tool name: "${name}"`);
      }

      const existing = tools.get(name);
      const newToolset = tool.definition.toolset;

      if (existing && existing.tool.definition.toolset !== newToolset) {
        // 不同 toolset 的同名工具：记录警告但允许覆盖
        // MCP toolset 之间的覆盖是合法行为（server 刷新或两个 server 有同名工具）
        console.warn(
          `Tool "${name}": toolset "${newToolset}" overwriting "${existing.tool.definition.toolset}"`,
        );
      }

      tools.set(name, { tool, registeredAt: Date.now() });

      // 维护 toolset 索引
      if (!toolsets.has(newToolset)) {
        toolsets.set(newToolset, new Set());
      }
      toolsets.get(newToolset)!.add(name);
    },

    // ===== 注销 =====
    unregister(name: string): void {
      const entry = tools.get(name);
      if (!entry) return;  // 静默成功

      const toolset = entry.tool.definition.toolset;
      tools.delete(name);

      // 清理 toolset 索引
      const toolsetTools = toolsets.get(toolset);
      if (toolsetTools) {
        toolsetTools.delete(name);
        if (toolsetTools.size === 0) {
          toolsets.delete(toolset);
        }
      }
    },

    // ===== 获取定义列表 =====
    getDefinitions(): ToolDefinition[] {
      return Array.from(tools.values())
        .map(e => e.tool.definition)
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    // ===== 按 toolset 获取定义 =====
    getDefinitionsByToolset(toolset: string): ToolDefinition[] {
      const toolNames = toolsets.get(toolset);
      if (!toolNames) return [];

      return Array.from(toolNames)
        .map(name => tools.get(name)?.tool.definition)
        .filter((d): d is ToolDefinition => d !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    // ===== 执行 =====
    async execute(
      name: string,
      args: Record<string, unknown>,
      context: ToolContext,
    ): Promise<ToolResult> {
      const entry = tools.get(name);
      if (!entry) {
        return {
          content: '',
          error: `Tool "${name}" not found. Available tools: ${this.getToolNames().join(', ')}`,
        };
      }

      try {
        return await entry.tool.execute(args, context);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: '',
          error: `Tool execution failed: ${message}`,
        };
      }
    },

    // ===== Toolset 管理 =====
    isToolsetAvailable(toolset: string): boolean {
      return toolsets.has(toolset) && (toolsets.get(toolset)?.size ?? 0) > 0;
    },

    getToolsets(): string[] {
      return Array.from(toolsets.keys()).sort();
    },

    // ===== 查询 =====
    getToolNames(): string[] {
      return Array.from(tools.keys()).sort();
    },

    has(name: string): boolean {
      return tools.has(name);
    },

    get(name: string): Tool | undefined {
      return tools.get(name)?.tool;
    },
  };
}
```

### 行为规范

| 方法 | 行为 |
|------|------|
| `register(tool)` | 注册工具，同名且同 toolset 的覆盖旧定义；同名不同 toolset 记录警告后覆盖 |
| `unregister(name)` | 注销工具，自动清理 toolset 索引；不存在时静默成功 |
| `getDefinitions()` | 按工具名排序返回定义列表（保证 Prompt Caching 前缀稳定） |
| `getDefinitionsByToolset(ts)` | 按 toolset 过滤，按名称排序 |
| `execute(name, args, ctx)` | 查找并执行工具，不存在时返回含可用工具列表的错误信息 |
| `isToolsetAvailable(ts)` | 检查 toolset 是否有已注册工具 |

### 设计决策

#### 1. 非单例模式

与 Hermes 的模块级单例不同，Pure Agent 使用工厂函数 `createToolRegistry()`。原因：
- **测试友好**：每个测试可以创建独立 Registry 实例
- **多 Agent 场景**：不同 Agent（主 Agent / 子 Agent）可以有不同的 toolset 配置
- **无全局状态**：避免 import side-effect 和测试间的状态污染

#### 2. Toolset 二级索引

维护 `toolset → Set<tool name>` 的二级索引，支持按 toolset 查询：
- `getDefinitionsByToolset(toolset)` — O(1) 查找 toolset → O(n) 遍历该 toolset 下的工具
- `getToolsets()` — O(1) 返回所有 toolset 名称
- 注册/注销时同步维护索引

#### 3. 确定性的定义顺序

`getDefinitions()` 按名称字母排序。这是从 Hermes 和 Cline 中学到的关键设计：

- **Prompt Caching**：工具定义顺序直接影响缓存命中。DeepSeek 和 Anthropic 的 prompt caching 以 prefix match 为基础，顺序变化 → cache miss。
- **跨平台一致性**：不同操作系统的文件系统 `readdir` 顺序不同，排序消除平台差异。
- Hermes 也使用 `for name in sorted(tool_names)` 确保稳定输出。

#### 4. 注册冲突处理

借鉴 Hermes 的 conflict detection 但简化：

| 场景 | 行为 |
|------|------|
| 同名、同 toolset | 覆盖（视为工具升级） |
| 同名、不同 toolset | 记录 warning 后覆盖 |
| 无效工具名 | 抛出异常（注册时 fail fast） |

后期可引入 Hermes 的 `override` opt-in 机制用于 plugin 安全门控。

#### 5. 无 check_fn（当前阶段）

Hermes 的 `check_fn` 探针（检测 Docker daemon、Playwright binary 等）是强大的设计，但在 Pure Agent 当前阶段并非必需。后期可在 toolset 层面引入 `availabilityCheck` 回调和 TTL 缓存。

---

## 注册工作流

```
应用启动
  │
  ├─ const registry = createToolRegistry()
  │
  ├─ // 注册内置工具
  │   registry.register(createReadFileTool(workDir))
  │   registry.register(createWriteFileTool(workDir))
  │   registry.register(createEditFileTool(workDir))
  │   registry.register(createGlobTool(workDir))
  │   registry.register(createGrepTool(workDir))
  │   registry.register(createShellExecTool())
  │   registry.register(createWebSearchTool())
  │   registry.register(createWebFetchTool())
  │
  ├─ // (后期) 扫描用户自定义工具
  │   for (const toolFile of scanUserTools()) {
  │     registry.register(loadTool(toolFile))
  │   }
  │
  ├─ // (后期) 连接 MCP Servers，注册其工具
  │   for (const mcpTool of await discoverMcpTools()) {
  │     registry.register(mcpTool)
  │   }
  │
  └─ // 注入 Agent Loop
      const agentLoop = createAgentLoop({ toolRegistry: registry })
```

---

## 验收标准

- [ ] `tsc --noEmit` 通过
- [ ] 注册工具后 `getDefinitions()` 包含该工具
- [ ] 同名覆盖旧工具
- [ ] 注销后 `execute()` 返回错误信息（含可用工具列表）
- [ ] `getDefinitions()` 返回按名称排序的列表
- [ ] `getDefinitionsByToolset('file')` 只返回 file toolset 下的工具
- [ ] `getToolsets()` 返回所有已注册 toolset
- [ ] 注销最后一个 toolset 的工具后，toolset 从 `getToolsets()` 中消失
- [ ] 工具执行异常返回 `ToolResult { error: "..." }`（不抛异常）
- [ ] 不存在工具的错误信息包含可用工具列表
- [ ] 注册无效工具名（含特殊字符）时抛出异常

## 下一步

Phase 1 完成后，`createToolRegistry()` 可注册任意工具。Phase 2 实现内置工具。
