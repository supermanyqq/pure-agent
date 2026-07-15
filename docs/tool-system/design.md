# Tool System — 总体设计

> 本文基于对三个主流开源 AI Agent 项目（Hermes Agent、Cline、Kilo Code）工具系统的深入分析，重新审视 Pure Agent 的 Tool System 设计。

## 模块定位

Tool System 是 Pure Agent 的**工具能力层**。它负责：

1. **定义工具接口规范** — 工具是什么、如何描述、参数如何声明
2. **管理工具的注册与发现** — 工具从哪里来、如何组织、何时可用
3. **调度工具执行** — 如何调用、如何处理错误、如何管理生命周期
4. **适配多 LLM Provider** — 如何让同一套工具定义兼容不同后端
5. **控制安全边界** — 权限、沙箱、审批流

一句话：**Tool System 回答「Agent 能做什么、怎么做、有哪些能力可用」这三个问题。**

---

## 在整体架构中的位置

```
                      ┌─────────────────────────┐
                      │      Agent Loop          │
                      │                          │
                      │  1. getDefinitions() → LLM│
                      │  2. LLM returns tool_calls│
                      │  3. executeAll() → results│
                      │  4. results → back to LLM │
                      └──────────┬───────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │     Tool Executor        │
                    │  - 并行调度              │
                    │  - 参数解析 & 校验        │
                    │  - 错误隔离              │
                    │  - Abort 感知            │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │     Tool Registry        │
                    │  - register/unregister   │
                    │  - getDefinitions()      │
                    │  - execute(name, args)   │
                    │  - 按 toolset 分组       │
                    └────────────┬────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
        ┌──────────┐     ┌──────────┐      ┌──────────────┐
        │ Builtin   │     │  Plugin   │      │  MCP Tools    │
        │ Tools     │     │  Tools    │      │  (后期)        │
        └──────────┘     └──────────┘      └──────────────┘
```

Tool System 位于 Agent Loop 之下。Agent Loop 不直接知道有哪些工具，只通过 `ToolRegistry` 接口获取定义列表和执行工具调用。

---

## 三项目对比分析

在重写本文档前，我们深入分析了三个开源项目的 Tool System 设计：

| 维度 | Hermes Agent (Python) | Cline (TypeScript) | Kilo Code (TypeScript/Effect) |
|------|----------------------|-------------------|-------------------------------|
| **工具定义方式** | 模块级 `registry.register()` 调用 | `AgentTool` 接口 + `execute()` 函数 | Effect Schema + `Tool.define()` |
| **参数定义** | 手写 JSON Schema dict | `inputSchema: Record<string, unknown>` | Effect `Schema.Struct` → 自动生成 JSON Schema |
| **注册机制** | AST 扫描 + import 触发自注册 | 运行时 `tools` Map + Plugin sandbox | Effect Layer DI + InstanceState |
| **工具分组** | Toolset（file/terminal/web/browser...） | 无显式分组，通过 plugin source 区分 | builtin vs custom 数组 |
| **可用性门控** | `check_fn` 探针 + TTL 缓存 + 故障宽限期 | Tool policy 配置 | Feature flag + 权限矩阵 |
| **Schema 兼容性** | 深度 sanitize（llama.cpp/Anthropic/xAI/Fireworks） | 依赖 AI SDK 适配 | JSONSchema7 → 各 Provider 自行适配 |
| **工具发现** | 渐进式：核心工具常驻，MCP/插件通过 bridge tool 按需加载 | 插件独立 sandbox，registerTool API | 文件系统扫描 + 插件列表 |
| **执行模式** | 同步/异步混合，通过 `_run_async()` 桥接 | Sequential / Parallel 可选 | 全部 Effect-based 异步 |
| **安全机制** | 多层：路径沙箱 + URL 校验 + prompt injection 扫描 + YOLO 模式 | toolPolicies + Plugin sandbox V8 isolate | ToolNetwork 沙箱包裹 + Permission |
| **错误处理** | 全部 JSON `{"error": "..."}` 不抛异常 | Retryable + maxRetries | `InvalidArgumentsError` + Effect error channel |
| **结果管理** | 3 层持久化：per-result / per-turn / preview | 无内置机制 | Truncate service 统一截断 |
| **MCP 集成** | 完整：stdio/HTTP/SSE，reconnect，动态刷新 | Plugin 注册 + MCP capability | 通过 Plugin 体系 |

### 关键设计洞察

**1. 自注册优于显式列表（Hermes）**
Hermes 使用 AST 扫描发现所有调用了 `registry.register()` 的工具模块，然后 import 触发注册。这避免了维护工具清单的中央文件，新增工具只需创建文件即可。缺点是 import 顺序依赖和隐含副作用。

**2. 类型安全的 Schema 定义（Kilo Code）**
Kilo Code 使用 Effect Schema（`Schema.Struct`）定义工具参数，自动生成 JSON Schema 并编译参数校验闭包。这消除了手写 JSON Schema 与运行时校验代码不一致的问题。TypeScript 的类型推导使 execute 函数的 args 参数自动获得正确类型。

**3. 工具可用性探针 + 故障宽限期（Hermes）**
Hermes 的 `check_fn` 会探测外部依赖（Docker、Playwright 等）是否可用。结果 TTL 缓存 30 秒，但如果探针在最近一次成功的 60 秒内返回失败，会被视为瞬态抖动（flake），继续返回 True。这防止了 Docker daemon 暂时繁忙导致整个 terminal toolset 静默消失。

**4. 渐进式工具披露（Hermes tool_search）**
当 MCP/插件工具过多时（超过 context window 的 10%），Hermes 将非核心工具替换为三个桥接工具（`tool_search`、`tool_describe`、`tool_call`）。LLM 先搜索、再查看详情、最后调用。这比直接丢弃工具更优雅——LLM 始终有办法找到需要的工具。

**5. Plugin 沙箱隔离（Cline）**
Cline 的插件在独立 V8 isolate（`plugin-sandbox.ts`）中运行，通过 `registerTool()` API 注册工具。插件代码与主进程物理隔离，一个插件崩溃不影响其他。

**6. Effect Layer 依赖注入（Kilo Code）**
Kilo Code 的整个 ToolRegistry 是 Effect Layer 系统的一部分。每个工具需要的依赖（文件系统、LSP、Git、HTTP 客户端等）通过 Layer 注入，不需要全局变量或 service locator。这使测试变得极为简单——替换一个 Layer 即可 mock 整个依赖树。

---

## 模块结构

```
tools/
├── types.ts              # Tool 相关类型定义
├── registry.ts           # 工具注册表（注册、查找、获取定义列表、toolset 管理）
├── executor.ts           # 工具执行器（并行调度、参数校验、错误处理）
├── schema.ts             # Schema 管理与多 Provider 适配
├── builtin/
│   ├── read-file.ts      # 文件读取工具
│   ├── write-file.ts     # 文件写入工具
│   ├── edit-file.ts      # 文件编辑（精确字符串替换）
│   ├── shell-exec.ts     # Shell 命令执行工具
│   ├── glob.ts           # 文件 glob 匹配
│   ├── grep.ts           # 文件内容搜索
│   ├── web-search.ts     # Web 搜索工具
│   └── web-fetch.ts      # Web 内容获取工具
├── mcp/                   # MCP 工具适配（后期）
│   ├── client.ts          # MCP 客户端
│   ├── discovery.ts       # 工具发现
│   └── bridge.ts          # MCP → Tool 适配桥接
├── plugin/                # 插件工具（后期）
│   └── loader.ts          # 用户自定义工具加载
└── index.ts              # 公共 API 导出 + createToolRegistry() 工厂函数
```

---

## 核心接口

### Tool

```ts
interface Tool<TInput = Record<string, unknown>> {
  /** 工具定义（传给 LLM 的元数据） */
  definition: ToolDefinition;

  /** 执行函数 */
  execute(args: TInput, context: ToolContext): Promise<ToolResult>;
}
```

### ToolDefinition

```ts
interface ToolDefinition {
  /** 工具名称（snake_case，唯一标识） */
  name: string;

  /** 工具描述（会直接传给 LLM，需精心撰写） */
  description: string;

  /** 参数 JSON Schema */
  parameters: Record<string, unknown>;

  /** 工具所属分组 */
  toolset: string;

  /** 生命周期钩子 */
  lifecycle?: {
    /** 此工具成功调用后是否结束当前 turn */
    completesRun?: boolean;
  };
}
```

### ToolContext

借鉴 Cline 和 Kilo Code，为工具执行提供丰富的上下文：

```ts
interface ToolContext {
  /** 当前会话 ID */
  sessionId: string;

  /** 工作目录（所有路径操作的根） */
  workDir: string;

  /** Abort 信号（用户中断或超时） */
  signal: AbortSignal;

  /** 请求用户确认（危险操作） */
  requestApproval(message: string): Promise<boolean>;

  /** 当前消息 ID（用于 Trace） */
  messageId?: string;
}
```

### ToolResult

```ts
interface ToolResult {
  /** 工具输出内容（文本或 JSON 字符串） */
  content: string;

  /** 渲染提示（如 'diff', 'markdown', 'code'） */
  renderHint?: 'text' | 'diff' | 'markdown' | 'code' | 'json';

  /** 错误信息（执行失败时） */
  error?: string;

  /** 元数据（用于 UI 展示和 Title 生成） */
  metadata?: {
    truncated?: boolean;
    outputPath?: string;
    [key: string]: unknown;
  };
}
```

### ToolRegistry

```ts
interface ToolRegistry {
  /** 执行一个工具 */
  execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;

  /** 获取所有已注册工具的定义列表（按名称排序，传给 LLM） */
  getDefinitions(): ToolDefinition[];

  /** 获取指定 toolset 的工具定义列表 */
  getDefinitionsByToolset(toolset: string): ToolDefinition[];

  /** 注册一个工具 */
  register(tool: Tool): void;

  /** 注销一个工具 */
  unregister(name: string): void;

  /** 检查 toolset 是否可用 */
  isToolsetAvailable(toolset: string): boolean;

  /** 获取所有已注册的 toolset 名称 */
  getToolsets(): string[];
}
```

---

## 设计决策

### 1. Tool Definition 与 Execute 分离

`ToolDefinition`（传给 LLM 的元数据）和 `execute`（执行逻辑）分离：

- **序列化安全**：`getDefinitions()` 返回纯数据对象，不包含函数引用
- **跨进程扩展**：工具定义可通过 IPC 传输到渲染进程
- **安全边界**：LLM 永远接触不到执行逻辑，只看到 name + description + parameters

借鉴 Kilo Code 的做法，为 `execute` 函数提供类型安全的 `args` 参数：

```ts
// Kilo Code 模式（理想）：参数 Schema 推导出类型
const ReadParams = Schema.Struct({
  filePath: Schema.String,
  offset: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
});

const readTool = Tool.define("read_file", {
  parameters: ReadParams,
  execute(args: Schema.Type<typeof ReadParams>, ctx) { ... }
});

// Pure Agent 模式（务实）：JSON Schema + 运行时校验
interface ReadFileArgs {
  path: string;
  offset?: number;
  limit?: number;
}

const readFileTool: Tool<ReadFileArgs> = {
  definition: { ... },
  execute(args, ctx) {
    // args 已通过 JSON Schema 校验，类型安全
  },
};
```

### 2. Tool Result 结构化

与初版设计的"统一字符串"不同，新设计返回 `ToolResult` 对象：

- **`content`** — 核心输出文本
- **`renderHint`** — 提示 UI 如何渲染结果（diff 视图、代码高亮、Markdown 等）
- **`error`** — 独立错误字段，不污染 content
- **`metadata`** — UI/日志/Trace 使用的结构化附加信息

这借鉴了 Kilo Code 的 `Tool.Output` 设计，并符合 Anthropic 的 `tool_result` content block 格式。

### 3. Toolset — 工具分组机制

借鉴 Hermes 的 toolset 概念，每个工具属于一个 toolset：

| Toolset | 工具 | 说明 |
|---------|------|------|
| **file** | `read_file`, `write_file`, `edit_file`, `glob`, `grep` | 文件系统操作 |
| **shell** | `shell_exec` | Shell 命令执行 |
| **web** | `web_search`, `web_fetch` | Web 信息获取 |
| **mcp-*** | 动态 MCP 工具 | 外部服务提供的工具 |

**为什么需要 toolset？**
- **可用性门控**：`check_fn` 可以按 toolset 判断（如 browser toolset 需要 Playwright）
- **Agent 配置**：可以为不同 Agent（主 Agent vs 子 Agent）启用不同的 toolset
- **UI 展示**：按 toolset 分组显示工具列表
- **Context 管理**：按 toolset 启用/禁用，减少传给 LLM 的工具数量

### 4. 多 Provider Schema 适配

不同 LLM Provider 对 JSON Schema 的要求不同：

| Provider | 限制 |
|----------|------|
| **Anthropic** | 禁止顶层 `anyOf`/`oneOf`；`input_schema` 必须是 `type: "object"` |
| **OpenAI** | 宽松，但 Codex backend 禁止顶层 combinators |
| **DeepSeek** | 标准 JSON Schema，基本兼容 |
| **llama.cpp** | 严格 GBNF 语法生成器：不接受空 `properties`、不接受数组 `type`、不接受 `null` type |
| **xAI / Fireworks** | 禁止 `$ref` 同级有 `default` 等注解关键字 |

**设计原则**：
- 工具定义使用**标准 JSON Schema**（宽松的超集）
- `getDefinitions()` 输出时执行 **schema sanitization pipeline**：
  1. 空 properties 回填 `{}`
  2. 多类型 `"type": ["string", "null"]` → 单类型 + `nullable` hint
  3. nullable union collapse（`anyOf` 包含 `{"type": "null"}` → 合并）
  4. 顶层 combinator 剥离（allOf/anyOf/oneOf/enum）
  5. `$ref` 同级 forbidden siblings 移除

借鉴 Hermes 的 `schema_sanitizer.py` 设计一个可扩展的 sanitizer chain。

### 5. 工具执行的安全性

四层安全防护：

| 层级 | 机制 | 说明 |
|------|------|------|
| **参数层** | JSON Schema 校验 | 类型、必填、enum 约束 |
| **路径层** | 工作目录沙箱 | 禁止 `../` 逃逸，禁止绝对路径，禁止敏感设备路径 |
| **审批层** | 危险操作确认 | `write_file`、`shell_exec` 可配置需用户确认 |
| **沙箱层** | 进程隔离（后期） | 高风险工具在子进程中执行 |

> 第一道在 Tool System（参数校验、路径沙箱），第二道在 Agent Loop（用户确认提示），第三道在操作系统（文件权限、进程隔离）。

### 6. 工具注册表的确定性与排序

`getDefinitions()` 返回**按名称排序**的工具列表。排序确保：
- Prompt Caching 前缀稳定（顺序变化 → 缓存前缀不匹配 → cache miss）
- 不同操作系统/文件系统的 `readdir` 顺序不一致不影响结果
- Hermes 也采用相同策略（`for name in sorted(tool_names)`）

---

## 工具执行流程

```
AgentLoop 调用 executeAll(toolCalls, registry, signal)
  │
  ├─ Promise.all(toolCalls.map(async (tc) => {
  │
  │    ├─ 0. 检查 signal.aborted → 返回 aborted 结果
  │    │
  │    ├─ 1. JSON.parse(tc.function.arguments)
  │    │     解析 JSON → Record<string, unknown>
  │    │     解析失败 → ToolResult { error: "Invalid JSON arguments: ..." }
  │    │
  │    ├─ 2. 参数 Schema 校验（如果 Tool 提供了 Schema）
  │    │     校验失败 → ToolResult { error: "Invalid arguments: ..." }
  │    │
  │    ├─ 3. registry.execute(name, args, context)
  │    │     查找工具 → 审批检查 → 执行 → 截断
  │    │     工具不存在 → ToolResult { error: "Tool not found: ..." }
  │    │     工具执行异常 → ToolResult { error: "..." }
  │    │
  │    └─ 4. 返回 ToolResult { content, renderHint?, metadata? }
  │
  │  }))
  │
  └─ 返回 ToolResult[]（与输入顺序一致）
```

**关键设计**：
- **Promise.all 而非 allSettled**：每个工具内部 try/catch，错误不传播
- **一个工具失败不影响其他**：错误隔离
- **Abort 信号贯穿全链路**：执行前检查，执行中传递给工具

---

## 工具结果生命周期管理

借鉴 Hermes 的 3 层持久化系统：

```
Tool 执行完成 → raw output (string)
  │
  ├─ 1. Per-result threshold (default 100K chars)
  │     超过 → 写入临时文件，content 替换为 preview + outputPath
  │
  ├─ 2. Per-turn budget (default 200K chars aggregate)
  │     超过 → 最旧的 tool result 替换为摘要
  │
  └─ 3. Context pruning (tool-pruner.ts)
        去重 → 大结果摘要化 → arguments 截断
```

---

## 后期扩展

### Plugin 工具（用户自定义）

借鉴 Cline 的 plugin sandbox + Kilo Code 的文件扫描模式：

```
# ~/.pure-agent/tools/my-tool.ts
import { defineTool } from '@pure-agent/core/tools';

export default defineTool({
  name: 'my_api_call',
  description: 'Call my internal API',
  parameters: {
    type: 'object',
    properties: {
      endpoint: { type: 'string', description: 'API endpoint path' },
    },
    required: ['endpoint'],
  },
  async execute(args, ctx) {
    const resp = await fetch(`https://api.internal/${args.endpoint}`);
    return { content: await resp.text() };
  },
});
```

自动发现路径（参考 Kilo Code 的 `Glob.scanSync("{tool,tools}/*.{js,ts}")`）：
- `~/.pure-agent/tools/*.{js,ts}`
- `<project>/.pure-agent/tools/*.{js,ts}`

### MCP (Model Context Protocol) 工具

后期支持通过 MCP 协议动态发现和调用外部工具服务，兼容 Claude Code / Cursor 等生态。

- MCP 工具注册到 `mcp-{serverName}` toolset
- 支持 stdio / HTTP / SSE transport
- 动态刷新（`notifications/tools/list_changed`）

### 渐进式工具披露（Tool Search）

当工具数量超过阈值时，将非核心工具替换为三个桥接工具（借鉴 Hermes）：

```
tool_search  → BM25 搜索工具目录（name + description + parameter names）
tool_describe → 加载指定工具的完整参数 schema
tool_call    → 调用延迟工具（路由通过标准 dispatch 路径）
```

阈值默认：deferrable 工具占总 context window tokens 的 10% 以上时激活。

---

## 测试策略

| 层级 | 测试内容 |
|------|----------|
| 单元测试 | 每个内置工具的 `execute()` 逻辑（mock 外部依赖） |
| 单元测试 | Registry 的 register/unregister/getDefinitions |
| 单元测试 | 参数校验（必填缺失、类型错误、Schema mismatch） |
| 单元测试 | Schema sanitizer 各 transform 步骤 |
| 集成测试 | 真实文件读写（临时目录） |
| 集成测试 | 真实 Shell 命令执行 |
| 边界测试 | 路径逃逸防护、超大文件、二进制文件、超时、Abort |
| E2E 测试 | AgentLoop 中使用工具完成简单任务 |

---

## 参考资料

- [OpenAI Function Calling — Tool Definition](https://platform.openai.com/docs/guides/function-calling)
- [Anthropic Tool Use — Extended Thinking](https://docs.anthropic.com/en/docs/build-with-claude/tool-use)
- [DeepSeek API — Function Calling](https://api-docs.deepseek.com/guides/function_calling)
- [JSON Schema Specification](https://json-schema.org/)
- [MCP (Model Context Protocol) Specification](https://modelcontextprotocol.io/)
- Hermes Agent — `tools/registry.py`, `tools/tool_search.py`, `tools/schema_sanitizer.py`
- Cline — `sdk/packages/shared/src/agent.ts`, `sdk/packages/core/src/services/plugin-tools.ts`
- Kilo Code — `packages/opencode/src/tool/registry.ts`, `packages/opencode/src/tool/tool.ts`
