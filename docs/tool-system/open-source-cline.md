# Cline — Tool System 设计分析

> 项目路径：`open-source/cline-main/`
> 语言：TypeScript
> 架构：SDK 三层（Shared Types → Core Extensions → App Integration）+ 独立 Plugin Sandbox
> 核心文件：`sdk/packages/shared/src/agent.ts`、`sdk/packages/core/src/extensions/tools/definitions.ts`、`sdk/packages/core/src/extensions/tools/schemas.ts`、`sdk/packages/core/src/services/plugin-tools.ts`

---

## 一、架构概览

Cline 的工具系统采用**工厂函数 + 数组注入 + Plugin Sandbox**模式。没有中央 Registry 类，工具以 `AgentTool[]` 数组形式存在，通过工厂函数按需创建，注入到 `AgentRuntime`。

```
sdk/packages/shared/src/agent.ts             ← AgentTool / AgentToolContext 核心接口
sdk/packages/shared/src/tools/create.ts       ← createTool() 工厂（Zod → JSON Schema）
sdk/packages/shared/src/llms/tools.ts         ← ToolPolicy / ToolApprovalRequest

sdk/packages/core/src/extensions/tools/
  ├── types.ts              ← Executor 类型定义 + ToolExecutors 接口
  ├── definitions.ts        ← 每个工具的工厂函数 + createDefaultTools()
  ├── schemas.ts            ← Zod schemas（primary + union）
  ├── presets.ts            ← ToolPresets（act/plan/search/minimal/yolo）
  ├── model-tool-routing.ts ← 模型特定工具路由（codex→apply_patch, etc.）
  ├── helpers.ts            ← withTimeout / TimeoutError / input normalization
  └── executors/            ← 内置 Node.js Executor 实现

apps/vscode/src/sdk/       ← VS Code 层：审批 UI、per-tool policies、host executors
apps/cli/src/runtime/       ← CLI 层：交互式审批、ACP tool kind mapping
```

---

## 二、工具定义模式

### 2.1 AgentTool 接口

```typescript
// sdk/packages/shared/src/agent.ts
export interface AgentToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    lifecycle?: {
        completesRun?: boolean;  // 成功后是否结束当前 run
    };
}

export interface AgentTool<TInput = unknown, TOutput = unknown>
    extends AgentToolDefinition {
    timeoutMs?: number;           // 超时时间（默认 30000）
    retryable?: boolean;          // 是否可重试（默认 true）
    maxRetries?: number;          // 最大重试次数（默认 3）
    execute: (
        input: TInput,
        context: AgentToolContext,
    ) => Promise<TOutput> | TOutput;
}
```

### 2.2 createTool() 工厂函数

```typescript
// sdk/packages/shared/src/tools/create.ts
export function createTool<TSchema extends z.ZodTypeAny>(options: {
    name: string;
    description: string;
    inputSchema: TSchema;       // 接受 Zod schema 或裸 JSON Schema
    timeoutMs?: number;
    retryable?: boolean;
    maxRetries?: number;
    lifecycle?: { completesRun?: boolean };
    execute: (input: z.infer<TSchema>, ctx: AgentToolContext) => Promise<any>;
}): AgentTool<z.infer<TSchema>, any>;
```

**工厂函数内部做三件事**：

1. **Zod → JSON Schema 转换**：`zodToJsonSchema()` 自动转换
2. **Schema 规范化**：剥离 `$schema` meta-key，强制顶层 `type: "object"`
3. **联合类型保护**：检查 `oneOf`/`anyOf` 分支都是 object 类型，否则注册时抛异常（fail fast）

### 2.3 AgentToolContext

```typescript
export interface AgentToolContext {
    sessionId?: string;
    agentId: string;
    conversationId?: string;
    runId?: string;
    iteration: number;
    toolCallId?: string;
    signal?: AbortSignal;
    metadata?: Record<string, unknown>;
    snapshot?: AgentRuntimeStateSnapshot;  // 运行时的状态快照
    emitUpdate?: (update: unknown) => void; // 流式更新回调
}
```

### 2.4 参数定义：Zod Schemas

每个工具有两套 Schema：

```typescript
// 主 Schema — 传给 LLM
export const ReadFilesInputSchema = z.object({
    files: z.array(ReadFileRequestSchema).describe("Array of file read requests"),
});

// Union Schema — 运行时灵活校验
export const ReadFilesInputUnionSchema = z.union([
    ReadFilesInputSchema,
    ReadFileRequestSchema,        // 单文件
    z.array(ReadFileRequestSchema), // 文件数组
    z.array(z.string()),          // 路径字符串数组
    z.string(),                    // 单个路径字符串
    z.object({ file_paths: z.array(AbsolutePath) }), // 替代格式
    // ...
]);
```

**设计意图**：LLM 看到的是严格的 Schema，但运行时能兼容不同模型的不同输出格式。

### 2.5 工具结果格式

```typescript
export interface ToolOperationResult {
    query: string;       // 执行的输入
    result: unknown;     // 结果内容
    error?: string;      // 错误信息
    success: boolean;    // 是否成功
    duration?: number;   // 耗时 ms
}
```

---

## 三、工具注册与发现

### 3.1 无中央 Registry

Cline **没有** `ToolRegistry` 类。工具通过 `createDefaultTools()` 一次性创建：

```typescript
// sdk/packages/core/src/extensions/tools/definitions.ts
export function createDefaultTools(options: CreateDefaultToolsOptions): AgentTool[] {
    const tools: AgentTool[] = [];

    if (enableReadFiles && executors.readFile)
        tools.push(createReadFilesTool(executors.readFile, config));

    if (enableSearch && executors.search)
        tools.push(createSearchTool(executors.search, config));

    if (enableBash && executors.shell)
        tools.push(createShellTool(executors.shell, config));

    if (enableEditor && executors.editor)
        tools.push(createEditorTool(executors.editor, config));

    // ... 每个工具一个 if 分支
    return tools;
}
```

**双重门控**：每个工具的创建需要 `enableFlag && executor` 两个条件同时满足。

### 3.2 Tool Presets

工具分组通过 Preset 实现：

```typescript
// sdk/packages/core/src/extensions/tools/presets.ts
export const ToolPresets = {
    act: {
        editor: true, bash: true, readFiles: true,
        search: true, webFetch: true, skills: true,
        askQuestion: true, spawnAgent: true, agentTeams: true,
    },
    plan: {  // 只读模式
        readFiles: true, search: true, webFetch: true,
        bash: true, skills: true, askQuestion: true,
        spawnAgent: true, agentTeams: true,
    },
    search: { readFiles: true, search_codebase: true },
    minimal: { bash: true },
    yolo: {   // 全工具 + 全部 auto-approve
        readFiles: true, bash: true, editor: true,
        submit_and_exit: true,
        // ... 危险工具 autoApprove = true
    },
};
```

### 3.3 Plugin 工具发现

```typescript
// sdk/packages/core/src/services/plugin-tools.ts

// 1. 文件系统扫描
const matches = Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: configDir });

// 2. 动态 import → 检查导出
const mod = await import(pathToFileURL(match).href);
for (const [id, def] of Object.entries(mod)) {
    if (!isPluginTool(def)) continue;
    // def 需满足 { args, description, execute } 接口
    custom.push(fromPlugin(id, def));
}

// 3. Plugin package 工具
for (const plugin of await pluginService.list()) {
    for (const [id, def] of Object.entries(plugin.tool ?? {})) {
        custom.push(fromPlugin(id, def));
    }
}
```

### 3.4 Plugin Sandbox

Cline 的插件在**独立 V8 isolate**（`plugin-sandbox.ts` + `plugin-sandbox-bootstrap.ts`）中运行：

```typescript
// Plugin 通过 API 注册工具
const api: AgentExtensionApi = {
    registerTool: (tool) => tools.push(tool),
    registerCommand: () => {},
    registerMessageBuilder: () => {},
    registerRule: () => {},
    registerProvider: () => {},
    registerMcpServer: (_server) => { /* requires "mcp" capability */ },
};
await extension.setup(api, { workspaceInfo });
```

**隔离保证**：
- Plugin 代码在主进程之外运行
- 一个 Plugin 崩溃不影响其他
- Plugin 只能通过 API 交互

---

## 四、工具执行

### 4.1 执行生命周期

```
AgentRuntime
  │
  ├─ 1. beforeTool hooks[]
  │      → 可 skip / stop / modify input / modify policy
  │
  ├─ 2. Tool Approval
  │      → requestToolApproval callback
  │      → 评估 ToolPolicy (enabled / autoApprove)
  │
  ├─ 3. execute(input, context)
  │      → withTimeout(promise, timeoutMs)
  │      → retry 逻辑（retryable && maxRetries）
  │
  └─ 4. afterTool hooks[]
         → 可 stop / modify result
```

### 4.2 超时机制

```typescript
// sdk/packages/core/src/extensions/tools/helpers.ts
export function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    message: string
): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new TimeoutError(message, ms)), ms)
        ),
    ]);
}
```

每工具可配置独立超时：
| 工具 | 默认超时 |
|------|---------|
| read_files | 10s |
| search_codebase | 15s |
| run_commands | 30s |
| editor | 20s |
| fetch_web_content | 30s |

### 4.3 重试策略

```typescript
// 可重试工具：read_files, search_codebase, run_commands, web_fetch
retryable: true, maxRetries: 3

// 不可重试工具（状态变更操作，重试可能造成双重修改）
retryable: false  // editor, apply_patch, skills
```

### 4.4 并行执行

- **工具内并行**：`read_files` 用 `Promise.all` 并发读取多个文件，`run_commands` 并发执行多个命令
- **工具间并行/串行**：`AgentRuntimeConfig.toolExecution: "sequential" | "parallel"`

### 4.5 审批流

```typescript
// 审批策略
interface ToolPolicy {
    enabled?: boolean;       // 是否可用
    autoApprove?: boolean;   // 是否跳过审批（默认 true，即不审批！）
}

// 审批请求
interface ToolApprovalRequest {
    sessionId: string;
    toolName: string;
    input: unknown;
    policy: ToolPolicy;
}

// 在 AgentRuntimeConfig 中注入审批回调
requestToolApproval?: (req: ToolApprovalRequest) => Promise<ToolApprovalResult>;
```

**Desktop IPC 审批**（`tool-approval.ts`）：
1. Runtime 写入 `.request.json` 到审批目录
2. 轮询等待 `.decision.json`
3. Desktop UI 进程读取请求、展示对话框、写入决策

---

## 五、模型特定工具路由

```typescript
// sdk/packages/core/src/extensions/tools/model-tool-routing.ts
export const DEFAULT_MODEL_TOOL_ROUTING_RULES: ToolRoutingRule[] = [
    {
        name: "openai-native-use-apply-patch",
        mode: "act",
        providerIdIncludes: ["openai-native"],
        enableTools: ["apply_patch"],
        disableTools: ["editor"],
    },
    {
        name: "codex-and-gpt-use-apply-patch",
        mode: "act",
        modelIdIncludes: ["codex", "gpt"],
        enableTools: ["apply_patch"],
        disableTools: ["editor"],
    },
];
```

**设计意图**：不同模型对工具格式的擅长程度不同。OpenAI/GPT/Codex 更擅长 unified diff 格式，所以替换 `editor`（search/replace）为 `apply_patch`（unified diff）。

---

## 六、Hook 系统

Cline 提供 `beforeTool` / `afterTool` 两个生命周期钩子：

```typescript
// sdk/packages/shared/src/agent.ts
interface AgentRuntimeHooks {
    beforeTool?: (context: AgentBeforeToolContext) =>
        AgentBeforeToolResult | undefined;
    afterTool?: (context: AgentAfterToolContext) =>
        AgentAfterToolResult | undefined;
}
```

**PreToolUse hook** 可：
- `cancel: true` → 阻止执行
- `input` 覆写 → 修改参数
- `contextModification` → 注入上下文
- `policy` 覆写 → 改变审批策略

**PostToolUse hook** 可：
- `result` 覆写 → 修改返回内容
- `stop: true` → 停止 Agent

Hook 脚本是外部进程（Bash/Node/Python/PowerShell），通过 stdin/stdout JSON 通信。

---

## 七、安全机制

### 7.1 默认策略

⚠️ **注意**：Cline 的默认 `ToolPolicy.autoApprove = true`！需要在 Host 层显式收紧：

```typescript
// VS Code 层 — 所有工具默认需要审批
function buildToolPolicies(): Record<string, ToolPolicy> {
    return {
        "read_files":      { enabled: true, autoApprove: false },
        "search_codebase": { enabled: true, autoApprove: false },
        "editor":          { enabled: true, autoApprove: false },
        "run_commands":    { enabled: true, autoApprove: false },
        // ... MCP 工具按 serverName__toolName 格式单独策略
    };
}
```

### 7.2 YOLO 模式

```typescript
// tools/presets.ts
const yoloPolicy: ToolPolicy = { enabled: true, autoApprove: true };
const policies: Record<string, ToolPolicy> = { "*": yoloPolicy };
for (const toolName of ALL_DEFAULT_TOOL_NAMES) {
    policies[toolName] = yoloPolicy;
}
```

### 7.3 审批拒绝检测

```typescript
// apps/vscode/src/sdk/tool-approval-denial.ts
DEFAULT_TOOL_APPROVAL_DENIAL_REASON = "User denied the tool execution"
USER_MESSAGE_TOOL_APPROVAL_DENIAL_REASON =
    "Tool execution was cancelled because the user sent a follow-up message."
```

系统区分用户拒绝 vs 技术错误，实现更聪明的重试逻辑。

---

## 八、MCP 集成

```typescript
// sdk/packages/core/src/extensions/mcp/tools.ts
export async function createMcpTools(options): Promise<AgentTool[]> {
    const descriptors = await options.provider.listTools(options.serverName);
    return descriptors.map((descriptor) => {
        return createTool({
            name: `${serverName}__${descriptor.name}`,  // 双下划线命名
            description: descriptor.description,
            inputSchema: descriptor.inputSchema,         // 直接使用 MCP 的 schema
            execute: async (input, context) =>
                options.provider.callTool({ serverName, toolName, arguments: input }),
        });
    });
}
```

**命名约定**：`serverName__toolName`（双下划线分隔），避免命名冲突。

**设置持久化**：每 MCP 工具的 auto-approve 设置可单独保存。

---

## 九、Team / 多 Agent 工具

Cline 在 `sdk/packages/core/src/extensions/tools/team/team-tools.ts` 中提供 18 个协作工具：

```
team_spawn_teammate    team_shutdown_teammate
team_status            team_task
team_run_task          team_cancel_run
team_list_runs         team_await_runs
team_send_message      team_broadcast
team_read_mailbox      team_mission_log
team_cleanup           team_create_outcome
team_attach_outcome_fragment
team_review_outcome_fragment
team_finalize_outcome  team_list_outcomes
```

只在 `act` 和 `plan` preset 中启用，子 Agent 可限制 spawn 权限。

---

## 十、对 Pure Agent 的启示

| Cline 设计 | Pure Agent 借鉴程度 | 说明 |
|-----------|-------------------|------|
| `createTool()` Zod → JSON Schema | 🔮 后期采纳 | 当前手写 JSON Schema 已够用 |
| Executor 接口解耦 | ✅ 思想借鉴 | Host 特定逻辑通过 executor 注入 |
| Tool Presets（act/plan/yolo） | 🔮 后期采纳 | Agent 模式配置工具集 |
| beforeTool / afterTool hooks | 🔮 后期采纳 | 审批沙箱拦截点 |
| Plugin sandbox (V8 isolate) | ❌ 不采纳 | Node.js 更适用 worker_threads |
| model-tool-routing | 🔮 后期采纳 | 不同模型切换 editor/apply_patch |
| 双重门控（enableFlag + executor） | ✅ 思想借鉴 | Toolset 可用性 + check_fn |
| 工具内并行（多文件读/多命令） | ✅ 直接采纳 | Phase 2 工具实现时采用 |
| Desktop IPC 审批 | 🔮 参考 | 桌面端审批方案 |

---

## 十一、关键文件索引

| 文件 | 功能 |
|------|------|
| `sdk/packages/shared/src/agent.ts` | `AgentTool`, `AgentToolContext`, `AgentRuntimeConfig`, hooks 接口 |
| `sdk/packages/shared/src/tools/create.ts` | `createTool()` 工厂 + Schema 规范化 |
| `sdk/packages/shared/src/llms/tools.ts` | `ToolPolicy`, `ToolApprovalRequest` |
| `sdk/packages/core/src/extensions/tools/types.ts` | Executor 类型 + `DefaultToolName` 枚举 |
| `sdk/packages/core/src/extensions/tools/definitions.ts` | 每工具工厂函数 + `createDefaultTools()` |
| `sdk/packages/core/src/extensions/tools/schemas.ts` | Zod primary + union schemas |
| `sdk/packages/core/src/extensions/tools/presets.ts` | `ToolPresets` + preset 解析 |
| `sdk/packages/core/src/extensions/tools/model-tool-routing.ts` | 模型特定工具路由规则 |
| `sdk/packages/core/src/extensions/tools/helpers.ts` | `withTimeout`, `TimeoutError`, 输入规范化 |
| `sdk/packages/core/src/extensions/mcp/tools.ts` | MCP → `AgentTool` 桥接 |
| `sdk/packages/core/src/extensions/tools/team/team-tools.ts` | 18 个多 Agent 协作工具 |
| `sdk/packages/core/src/services/plugin-tools.ts` | Plugin 工具发现 + sandbox 加载 |
| `apps/vscode/src/sdk/sdk-tool-policies.ts` | VS Code 审批策略构建 |
| `apps/cli/src/runtime/tool-policies.ts` | CLI 交互式审批策略 |
