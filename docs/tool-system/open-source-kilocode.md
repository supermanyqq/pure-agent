# Kilo Code — Tool System 设计分析

> 项目路径：`open-source/kilocode-main/`
> 语言：TypeScript
> 核心框架：Effect-TS（Effect Layer DI + Schema + Effect 异步）
> 工具数量：20+ builtin + Kilo 扩展工具 + MCP + Plugin
> 核心文件：`packages/opencode/src/tool/registry.ts`、`packages/opencode/src/tool/tool.ts`、`packages/opencode/src/tool/json-schema.ts`、`packages/opencode/src/kilocode/tool/registry.ts`、`packages/opencode/src/kilocode/sandbox/`

---

## 一、架构概览

Kilo Code 的工具系统基于 **Effect-TS** 框架，采用 **Layer 依赖注入 + Effect Schema 类型安全参数定义 + InstanceState 状态管理**模式。这是三个项目中最类型安全、最函数式的设计。

```
packages/opencode/src/tool/
  ├── tool.ts              ← Tool.Def / Tool.Info / Tool.define() 核心抽象
  ├── registry.ts          ← ToolRegistry Layer（依赖注入 + InstanceState）
  ├── json-schema.ts       ← Effect Schema → JSON Schema 7 自动生成
  ├── schema.ts            ← ToolID schema
  ├── truncate.ts          ← 输出截断服务
  ├── invalid.ts           ← 未知工具调用错误处理
  ├── read.ts              ← 文件/目录读取（支持图片/PDF）
  ├── write.ts             ← 文件写入
  ├── edit.ts              ← search/replace 编辑
  ├── apply_patch.ts       ← unified diff patch
  ├── shell.ts             ← Shell 执行（tree-sitter 命令解析）
  ├── glob.ts              ← 文件 glob 匹配
  ├── grep.ts              ← 内容搜索（内部使用 ripgrep）
  ├── task.ts              ← 子 Agent 委派（foreground + background）
  ├── webfetch.ts          ← Web 内容获取
  ├── websearch.ts         ← Web 搜索
  ├── todowrite.ts         ← 任务列表管理
  ├── question.ts          ← 向用户提问
  ├── skill.ts             ← 技能加载
  ├── plan.ts              ← Plan 模式退出
  ├── lsp.ts               ← LSP 诊断（experimental）
  ├── repo_clone.ts        ← 仓库克隆（experimental）
  └── repo_overview.ts     ← 仓库概览（experimental）

packages/opencode/src/kilocode/
  ├── tool/registry.ts     ← Kilo 扩展工具注册表
  ├── sandbox/             ← 沙箱系统（文件系统/网络/环境变量限制）
  │   ├── policy.ts
  │   ├── network.ts
  │   ├── network-tools.ts
  │   └── activation.ts
  └── tool/                ← Kilo 专属工具
       ├── codebase_search.ts
       ├── semantic-search.ts
       ├── memory-save.ts
       ├── memory-recall.ts
       ├── agent-manager.ts
       ├── background-process.ts
       ├── generate-image.ts
       └── interactive-terminal.ts
```

---

## 二、工具定义模式

### 2.1 Tool.Def — 核心接口

```typescript
// packages/opencode/src/tool/tool.ts
export interface Def<
    Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
    M extends Metadata = Metadata,
> {
    id: string;
    description: string;
    parameters: Parameters;              // Effect Schema.Decoder — 既是类型又是校验器
    jsonSchema?: JSONSchema7;            // 可选的预构建 JSON Schema
    execute(
        args: Schema.Schema.Type<Parameters>,  // 自动推导参数类型！
        ctx: Context,
    ): Effect.Effect<ExecuteResult<M>>;
    formatValidationError?(error: unknown): string;
}
```

**关键设计：Effect Schema 的双向能力**：

```typescript
// 1. 从 Schema 推导 TypeScript 类型（编译时）
type ReadArgs = Schema.Schema.Type<typeof Parameters>;
// → { filePath: string; offset?: number; limit?: number }

// 2. 自动生成 JSON Schema（给 LLM）
const jsonSchema = Schema.toJsonSchemaDocument(Parameters);

// 3. 运行时参数校验
Schema.decodeUnknownEffect(Parameters)(rawArgs);
// 校验失败 → InvalidArgumentsError（含 LLM 可读的错误信息）
```

### 2.2 Tool.define() — 工厂函数

```typescript
export function define<Parameters, Result, R, ID extends string>(
    id: ID,
    init: Effect.Effect<Init<Parameters, Result>, never, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service>
    & { id: ID };
```

**两阶段生命周期**：

- `Info` — lazy descriptor，含 `id` + `init()` 函数。这是 `Tool.define()` 的返回类型。
- `Def` — materialized tool，含编译后的 `execute` 闭包。通过 `Tool.init(info)` 创建。

```typescript
// 阶段 1: 定义（lazy）
export const ReadTool = Tool.define("read", Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service;  // 依赖注入
    // ...
    return {
        description: DESCRIPTION,
        parameters: Parameters,
        execute: (args, ctx) => Effect.gen(function* () { ... }),
    };
}));

// 阶段 2: 初始化（materialize）
const readDef = yield* Tool.init(ReadTool);
```

**这种两阶段设计的价值**：
- `Info` 阶段可以依赖 Effect services（Config、Agent、FileSystem 等），但不创建执行闭包
- `Def` 阶段创建最终的 `execute` 闭包，内部包装了参数校验、truncation、telemetry

### 2.3 参数校验包装器

`Tool.init()` 内部通过 `wrap()` 函数自动为 `execute` 添加：

```typescript
// tool/tool.ts — wrap() 函数
toolInfo.execute = (args, ctx) => {
    return Effect.gen(function* () {
        // 1. 参数校验（编译一次的闭包）
        const decoded = yield* decode(args).pipe(
            Effect.mapError((error) =>
                new InvalidArgumentsError({
                    tool: id,
                    detail: toolInfo.formatValidationError?.(error) ?? String(error),
                }),
            ),
        );
        // 2. 执行
        const result = yield* execute(decoded, ctx);
        // 3. 自动 truncation
        const truncated = yield* truncate.output(result.output, {}, agent);
        return { ...result, output: truncated.content, metadata: { ...result.metadata, truncated: truncated.truncated } };
    }).pipe(Effect.orDie, Effect.withSpan("Tool.execute", { attributes }));
};
```

**每一层都是自动的**——工具开发者只需要写业务逻辑。

### 2.4 执行上下文

```typescript
type Context<M extends Metadata = Metadata> = {
    sessionID: SessionID;
    messageID: MessageID;
    agent: string;
    abort: AbortSignal;
    callID?: string;
    extra?: { [key: string]: unknown };
    messages: MessageV2.WithParts[];    // 完整对话历史
    metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>;
    ask(input: Omit<Permission.Request, "id" | "sessionID" | "tool">): Effect.Effect<void>;
};
```

**`ctx.ask()`** 是工具请求用户审批的通道——返回 Effect，成功表示用户同意，失败（`PermissionRejectedError`）表示拒绝。

### 2.5 工具结果

```typescript
interface ExecuteResult<M extends Metadata = Metadata> {
    title: string;                       // UI 展示标题
    metadata: M;                         // 结构化元数据
    output: string;                      // 传给 LLM 的文本
    attachments?: FilePart[];            // 文件附件（图片/PDF）
}
```

---

## 三、工具注册与发现

### 3.1 ToolRegistry — Effect Layer 实现

Kilo Code 没有传统意义上的 Registry 类。整个 Registry 是一个 **Effect Layer**：

```typescript
// packages/opencode/src/tool/registry.ts
export class Service extends Context.Service<Service, Interface>()(
    "@opencode/ToolRegistry"
) {}

export interface Interface {
    readonly ids: () => Effect.Effect<string[]>;
    readonly all: () => Effect.Effect<Tool.Def[]>;
    readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>;
    readonly tools: (model: { providerID; modelID; family?; agent }) =>
        Effect.Effect<Tool.Def[]>;
}
```

### 3.2 Layer 构建流程

```typescript
export const layer: Layer.Layer<Service, never, Config | Plugin | ...> =
    Layer.effect(Service, Effect.gen(function* () {
        // 1. 解析所有依赖服务（通过 yield* 注入）
        const config = yield* Config.Service;
        const plugin = yield* Plugin.Service;
        const skill = yield* Skill.Service;
        const truncate = yield* Truncate.Service;
        // ...

        // 2. 初始化所有 builtin 工具的 Info → Def
        const tool = yield* Effect.all({
            invalid: Tool.init(invalid),
            shell: Tool.init(shell),
            read: Tool.init(read),
            glob: Tool.init(glob),
            grep: Tool.init(grep),
            edit: Tool.init(edit),
            write: Tool.init(writetool),
            task: Tool.init(task),
            fetch: Tool.init(webfetch),
            todo: Tool.init(todo),
            search: Tool.init(websearch),
            skill: Tool.init(skilltool),
            patch: Tool.init(patchtool),
            question: Tool.init(question),
            lsp: Tool.init(lsptool),
            plan: Tool.init(plan),
        });

        // 3. 收集自定义工具（Plugin + 文件扫描）
        const custom: Tool.Def[] = [];
        // 文件扫描：{tool,tools}/*.{js,ts}
        const matches = Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dirs });
        for (const match of matches) {
            const mod = yield* import(pathToFileURL(match).href);
            for (const [id, def] of Object.entries(mod)) {
                if (!isPluginTool(def)) continue;  // 检查 { args, description, execute }
                custom.push(fromPlugin(id, def));
            }
        }
        // Plugin packages
        for (const p of (yield* plugin.list())) {
            for (const [id, def] of Object.entries(p.tool ?? {})) {
                custom.push(fromPlugin(id, def));
            }
        }

        // 4. Kilo 专属工具
        const kilo = yield* KiloToolRegistry.build(kiloToolInfos, { agent, truncate, indexing });

        // 5. 组装 State
        const state = yield* InstanceState.make<State>(() => ({
            builtin: KiloToolRegistry.describe([...builtins], kilo),
            custom,
            task: tool.task,
            read: tool.read,
        }));

        // 6. 返回 Service
        return Service.of({
            all: () => [...state.builtin.map(ToolNetwork.builtin), ...state.custom],
            tools: (model) => filterAndAssembleTools(state, model),
            ids: () => all().map(t => t.id),
            named: () => ({ task: state.task, read: state.read }),
        });
    }));
```

### 3.3 依赖注入链

```typescript
export const defaultLayer = Layer.suspend(() =>
    layer.pipe(
        Layer.provide(Config.defaultLayer),
        Layer.provide(Plugin.defaultLayer),
        Layer.provide(Question.defaultLayer),
        Layer.provide(Todo.defaultLayer),
        Layer.provide(Skill.defaultLayer),
        Layer.provide(Agent.defaultLayer),
        Layer.provide(Session.defaultLayer),
        Layer.provide(BackgroundJob.defaultLayer),
        Layer.provide(Provider.defaultLayer),
        Layer.provide(Git.defaultLayer),
        Layer.provide(RepositoryCache.defaultLayer),
        Layer.provide(LSP.defaultLayer),
        Layer.provide(AppFileSystem.defaultLayer),
        Layer.provide(Bus.layer),
        Layer.provide(ToolNetwork.httpLayer),
        Layer.provide(Format.defaultLayer),
        Layer.provide(CrossSpawnSpawner.defaultLayer),
        Layer.provide(Truncate.defaultLayer),
        // ... Kilo 额外依赖
    ),
);
```

**45 个服务 Layer** 通过 Effect 的 `Layer.provide` 自动注入。测试时只需替换 Layer 即可 mock。

### 3.4 工具过滤

`tools(input)` 方法在三个维度上过滤工具：

```typescript
const tools = Effect.fn("ToolRegistry.tools")(function* (input) {
    const filtered = (yield* all()).filter((tool) => {
        // 1. 权限过滤：agent permission 矩阵
        if (!KiloToolRegistry.available(tool, input.agent)) return false;

        // 2. Feature flag 过滤：webSearch 需要 provider 支持
        if (tool.id === WebSearchTool.id)
            return webSearchEnabled(input.providerID);

        // 3. 模型路由过滤：edit vs apply_patch
        const usePatch = KiloToolRegistry.usePatch(input);
        if (tool.id === ApplyPatchTool.id) return usePatch;
        if (tool.id === EditTool.id) return !usePatch;

        return true;
    });

    // 4. 动态描述注入（Task + Skill）
    return yield* Effect.forEach(filtered, (tool) => ({
        ...tool,
        description: [
            tool.description,
            tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined,
            tool.id === SkillTool.id ? yield* describeSkill(input.agent) : undefined,
        ].filter(Boolean).join("\n"),
    }), { concurrency: "unbounded" });
});
```

**Task 和 Skill 的描述是动态的**——它们根据当前 Agent 的状态注入可用的子 Agent 列表和技能列表。

---

## 四、工具执行

### 4.1 执行生命周期

```
SessionTools.resolve(model, agent)
  │
  ├─ ToolRegistry.tools(model) → Tool.Def[]
  ├─ ToolJsonSchema.fromTool(tool) → JSONSchema7
  ├─ ProviderTransform.schema(model, schema) → provider-specific schema
  ├─ AI SDK tool() 包装 → Tools record
  │
  ▼
LLM Runtime Loop (ToolRuntime.stream)
  │
  ├─ LLM 返回 tool-calls
  ├─ dispatch(tools, call):
  │    ├─ 1. tool._decode(call.input)   → 参数校验
  │    ├─ 2. tool.execute(input, ctx)   → 执行
  │    └─ 3. tool._encode(result)       → 结果编码
  │
  └─ 结果 append 到 messages → 继续 LLM 请求
```

### 4.2 错误处理层次

```typescript
// 第 1 层：参数校验错误
new InvalidArgumentsError({
    tool: "read",
    detail: "filePath is required",
})
// → message: "The read tool was called with invalid arguments: filePath is required.
//              Please rewrite the input so it satisfies the expected schema."

// 第 2 层：权限拒绝
PermissionRejectedError / PermissionDeniedError / PermissionCorrectedError
// → 在 execute 之前阻止调用

// 第 3 层：工具执行错误
// 被 Effect.orDie 包装 → 杀进程（unexpected errors 不应静默吞掉）

// 第 4 层：LLM 层工具失败
LLM.ToolFailure
// → 包装为 stream event，LLM 收到 tool_error 结果
```

### 4.3 truncation 服务

```typescript
// packages/opencode/src/tool/truncate.ts
interface Interface {
    output(
        content: string,
        opts: { maxLength?: number },
        agent: Agent.Info,
    ): Effect.Effect<{
        content: string;
        truncated: boolean;
        outputPath?: string;
    }>;
}
```

每个工具的 `execute` 自动经过 truncation——开发者不需要手动处理。

---

## 五、Schema 管理

### 5.1 Effect Schema → JSON Schema 自动生成

```typescript
// packages/opencode/src/tool/json-schema.ts
export function fromSchema(schema: Schema.Top): JSONSchema7 {
    // 1. Effect Schema → JSON Schema Draft 2020-12
    const result = Schema.toJsonSchemaDocument(schema, {
        additionalProperties: true,
    });

    // 2. 规范化变换：
    // - 内联 $ref 引用（解析 #/$defs/...）
    // - 剥离 additionalProperties: true（多数 Provider 拒绝）
    // - 扁平化非重叠 allOf
    // - 折叠单成员 anyOf
    // - 整数 safe bounds（Number.MIN_SAFE_INTEGER ~ MAX_SAFE_INTEGER）
    return normalize(result);
}

// 缓存：WeakMap<Schema.Top, JSONSchema7>
```

### 5.2 Provider 特定转换

```typescript
// packages/opencode/src/provider/transform.ts
export function schema(model, base: JSONSchema7): JSONSchema7 {
    switch (model.providerID) {
        case "moonshot":  // Kimi
            return stripRefSiblings(stripTupleItems(base));
        case "google":    // Gemini
            return geminiTransform(base);  // int enum→string enum, 过滤 required, etc.
        default:
            return base;
    }
}

// packages/llm/src/protocols/utils/gemini-tool-schema.ts
export function convert(schema: JSONSchema7): GeminiToolSchema {
    // 移除 JSON Schema intent keywords
    // 注入 nullable
    // const → enum 映射
    // minLength 支持
}
```

---

## 六、沙箱系统

Kilo Code 有完整的沙箱系统（`packages/opencode/src/kilocode/sandbox/`）：

### 6.1 文件系统限制

```typescript
// sandbox/policy.ts
const FS_RESTRICTIONS = {
    writable: [projectDir, globalDataDir, cacheDir],
    denied: [".git/**"],
    protected: [".kilocode/**", ".kilo/**"],
};
```

### 6.2 网络限制

三种模式：
- `deny` — 阻止所有网络请求
- `proxy` — allowlist 主机
- `allow` — 开放访问

### 6.3 环境变量保护

```typescript
const PROTECTED_ENV = [
    "KILO_CONFIG", "KILO_SERVER_PASSWORD",
    "KILO_API_KEY", "KILO_TOKEN",
];
```

### 6.4 Tool Network 分类

```typescript
// sandbox/network-tools.ts
// 工具分为两类：
// - Opaque: 无网络访问（read, write, glob, grep, todo, skill, task, plan, question）
// - Network: 有网络访问（shell, webfetch, websearch, lsp, mcp-*）

export function isBuiltin(tool: Tool.Def): boolean;
export function builtin(tool: Tool.Def): Tool.Def;      // 包裹沙箱拦截
```

---

## 七、权限系统

### 7.1 核心评估引擎

```typescript
// packages/core/src/permission.ts
export function evaluate(
    permission: string,
    pattern: string,
    ...rulesets: Rule[][]
): { action: "allow" | "deny" | "ask" };

// findLast 匹配：最后一个匹配的规则生效
// 默认 action: "ask"
```

### 7.2 审批请求流

```typescript
// 工具中调用
ctx.ask({
    permission: "shell",
    pattern: command,
    metadata: { parsedPaths },
});

// → Permission.ask() 评估所有规则
// → 发布 permission.asked 事件到 event bus
// → 等待用户回复（once / always / reject）
// → 拒绝时 reject Promise → PermissionRejectedError
```

### 7.3 配置文件保护

即使工具操作权限是 "always allow"，对 `.kilocode/`、`.kilo/` 等配置文件的编辑**永远需要显式审批**。

### 7.4 子 Agent 权限继承

```typescript
// tool/task.ts
function deriveSubagentSessionPermission(parent): PermissionRules {
    return {
        question: false,               // 不能直接问用户
        interactive_terminal: false,   // 不能接管终端
        ...parentRestrictions,         // 继承父 Agent 的限制
    };
}
```

Headless 子 Agent 的权限请求直接失败为 `DeniedError`——因为没有用户可问。

---

## 八、子 Agent 委派（Task Tool）

```typescript
// tool/task.ts
const Parameters = Schema.Struct({
    description: Schema.String,
    prompt: Schema.String,
    subagent_type: Schema.String,
    task_id: Schema.optional(Schema.String),    // 恢复之前的子 Agent
    command: Schema.optional(Schema.String),
    background: Schema.optional(Schema.Boolean), // 异步后台运行
});
```

**Foreground 模式**：
1. 创建子 session（继承权限 + 限制）
2. 启动子 `SessionPrompt`
3. 阻塞等待完成
4. 消耗的 token 费用归入父消息

**Background 模式**（experimental）：
1. 通过 `BackgroundJob.Service.start()` 启动
2. 父 Agent 立即收到 "正在运行" 结果
3. 完成后结果作为合成消息注入父对话

**Resumability**：失败的子 Agent 可通过 `task_id` 参数恢复。

---

## 九、MCP 集成

```typescript
// packages/opencode/src/mcp/index.ts

// 连接类型：local (stdio) / remote (HTTP)

// 工具发现：
function listTools(key, client, timeout) {
    return Effect.tryPromise(() => client.listTools(undefined, { timeout }));
}

// 工具转换：
function convertMcpTool(mcpTool, client, timeout): Tool {
    return dynamicTool({
        description: mcpTool.description ?? "",
        inputSchema: jsonSchema({
            ...mcpTool.inputSchema,
            type: "object",              // 强制包裹
            additionalProperties: false,  // 严格模式
        }),
        execute: async (args) =>
            client.callTool({ name: mcpTool.name, arguments: args },
                CallToolResultSchema, { timeout }),
    });
}

// 命名规范：{server}_{tool}
```

**动态更新**：监听 `ToolListChangedNotificationSchema`，收到后刷新工具列表。

**网络限制联动**：沙箱网络模式受限时，所有 MCP 工具从 LLM 可见工具中移除。

---

## 十、Plugin 工具系统

### 10.1 Plugin 工具定义（Zod）

```typescript
// packages/plugin/src/tool.ts
export function tool<Args extends z.ZodRawShape>(input: {
    description: string;
    args: Args;
    execute(
        args: z.infer<z.ZodObject<Args>>,
        context: ToolContext,
    ): Promise<ToolResult>;
}): ToolDefinition;
```

### 10.2 Zod → Effect Schema 桥接

Registry 在加载 Plugin 工具时自动转换：

```typescript
// tool/registry.ts — fromPlugin()
function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
    const entries = Object.entries(def.args ?? {});
    const allZod = entries.every(([, v]) => isZodType(v));
    const zodParams = allZod ? z.object(def.args) : undefined;
    const jsonSchema = zodParams
        ? zodJsonSchema(zodParams)
        : legacyJsonSchema(entries);
    return {
        id,
        parameters: zodParams
            ? Schema.declare<unknown>(u => zodParams.safeParse(u).success)
            : Schema.Unknown,
        description: def.description,
        jsonSchema,
        execute: (args, ctx) => { /* EffectBridge + ctx.ask 适配 */ },
    };
}
```

### 10.3 Plugin 生命周期钩子

```typescript
// 三个 plugin trigger:
plugin.trigger("tool.definition", { toolID }, output)   // schema 组装时
plugin.trigger("tool.execute.before", ...)               // 执行前
plugin.trigger("tool.execute.after", ...)                // 执行后
```

---

## 十一、对 Pure Agent 的启示

| Kilo Code 设计 | Pure Agent 借鉴程度 | 说明 |
|---------------|-------------------|------|
| Effect Schema 类型安全参数 | 🔮 强烈推荐后期采纳 | 自动生成 JSON Schema + 编译时类型检查 |
| Effect Layer 依赖注入 | 🔮 参考思想 | 非 Effect 项目可用 tsyringe 或手动 DI |
| Tool.Info / Tool.Def 两阶段 | 🔮 参考 | lazy init + materialize 模式 |
| 参数校验自动包装 | ✅ 思想已采纳 | executeAll 中的 JSON.parse 即此思路 |
| truncation 服务 | ✅ 已在 tool-pruner.ts 中 | 需要更细粒度的 per-tool truncation |
| 沙箱系统（FS/Network/Env） | 🔮 后期采纳 | 桌面端安全需求 |
| ToolNetwork 分类（opaque/network） | 🔮 参考 | 沙箱策略依赖此分类 |
| 动态 Task/Skill 描述注入 | 🔮 参考 | 工具描述根据 Agent 状态动态生成 |
| tree-sitter 命令解析 | ❌ 暂不采纳 | 实现复杂度高，收益有限 |
| Zod ↔ Effect Schema 桥接 | 🔮 参考 | Plugin 工具兼容层 |

---

## 十二、关键文件索引

| 文件 | 功能 |
|------|------|
| `packages/opencode/src/tool/tool.ts` | `Tool.Def`, `Tool.Info`, `Tool.define()`, `InvalidArgumentsError`, wrap 自动包装 |
| `packages/opencode/src/tool/registry.ts` | `ToolRegistry` Layer 定义 + 构建 + builtin/custom 组装 |
| `packages/opencode/src/tool/json-schema.ts` | Effect Schema → JSON Schema 7 + 规范化 |
| `packages/opencode/src/tool/schema.ts` | `ToolID` schema |
| `packages/opencode/src/tool/truncate.ts` | 输出截断服务 |
| `packages/opencode/src/tool/read.ts` | 文件读取（目录/图片/PDF 支持） |
| `packages/opencode/src/tool/shell.ts` | Shell 执行（tree-sitter 命令解析） |
| `packages/opencode/src/tool/task.ts` | 子 Agent 委派（foreground + background） |
| `packages/opencode/src/tool/invalid.ts` | 未知工具错误处理 |
| `packages/opencode/src/session/tools.ts` | Session 层工具解析 + MCP + Schema pipeline |
| `packages/opencode/src/provider/transform.ts` | Provider 特定 Schema 转换 |
| `packages/llm/src/tool-runtime.ts` | LLM 工具执行循环（dispatch + step management） |
| `packages/llm/src/protocols/utils/gemini-tool-schema.ts` | Gemini Schema 适配 |
| `packages/opencode/src/permission/index.ts` | 权限服务（ask/reply/always/save） |
| `packages/opencode/src/kilocode/tool/registry.ts` | Kilo 专属工具注册表 + feature flag 门控 |
| `packages/opencode/src/kilocode/sandbox/policy.ts` | 沙箱策略（FS/Network/Env 限制） |
| `packages/opencode/src/kilocode/sandbox/network-tools.ts` | 工具网络分类（opaque/network/host） |
| `packages/opencode/src/kilocode/sandbox/activation.ts` | 沙箱激活/停用 |
| `packages/opencode/src/mcp/index.ts` | MCP 客户端 + 工具发现/转换 |
| `packages/plugin/src/tool.ts` | Plugin 工具定义（Zod-based） |
| `packages/core/src/permission.ts` | 核心权限评估引擎 |
