# Tool System — 总体设计

## 模块定位

Tool System 是 Pure Agent 的**工具能力层**。它负责定义工具的接口规范、管理工具的注册与查找、执行工具调用，并提供一组内置工具（文件读写、Shell 执行、Web 搜索等）。

一句话：**Tool System 回答"Agent 能做什么、怎么做、有哪些能力可用"这三个问题。**

---

## 在整体架构中的位置

```
Agent Loop
    │
    ├── toolRegistry.getDefinitions() → ToolDefinition[] → 传给 LLM
    │
    └── toolRegistry.execute(name, args) → string → 工具执行结果
              │
              ▼
         Tool Registry
              │
              ├── 内置工具
              │     ├── read_file
              │     ├── write_file
              │     ├── shell_exec
              │     ├── web_search
              │     └── web_fetch
              │
              └── (后期) 用户自定义工具 / MCP 工具
```

Tool System 位于 Agent Loop 之下。Agent Loop 不直接知道有哪些工具，只通过 `ToolRegistry` 接口获取定义列表和执行工具调用。

---

## 模块结构

```
tools/
├── types.ts              # Tool 相关类型定义
├── registry.ts           # 工具注册表（注册、查找、获取定义列表）
├── executor.ts           # 工具执行器（参数校验、错误处理、超时控制）
├── builtin/
│   ├── read-file.ts      # 文件读取工具
│   ├── write-file.ts     # 文件写入工具
│   ├── shell-exec.ts     # Shell 命令执行工具
│   ├── web-search.ts     # Web 搜索工具
│   └── web-fetch.ts      # Web 内容获取工具
└── index.ts              # 公共 API 导出 + createToolRegistry() 工厂函数
```

---

## 对外接口

### ToolRegistry

```ts
interface ToolRegistry {
  /** 执行一个工具，返回字符串结果 */
  execute(name: string, args: Record<string, unknown>): Promise<string>;

  /** 获取所有已注册工具的定义列表（用于传给 LLM） */
  getDefinitions(): ToolDefinition[];

  /** 注册一个工具 */
  register(tool: Tool): void;

  /** 注销一个工具 */
  unregister(name: string): void;
}
```

### Tool 接口

```ts
interface Tool {
  /** 工具定义（传给 LLM 的元数据） */
  definition: ToolDefinition;

  /** 执行函数 */
  execute(args: Record<string, unknown>): Promise<string>;
}

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;  // JSON Schema
  };
}
```

---

## 设计决策

### 1. 工具定义和执行分离

`ToolDefinition`（传给 LLM 的元数据）和 `execute`（执行逻辑）分离：
- **序列化安全**：`getDefinitions()` 返回纯数据对象，不包含函数引用
- **跨进程扩展**：后期工具定义可通过 IPC 传输到其他进程
- **安全边界**：传给 LLM 的只是 name + description + parameters JSON Schema，LLM 永远接触不到执行逻辑

### 2. 工具结果统一为字符串

所有工具的 `execute()` 返回 `string`。原因：
- LLM API 要求 tool result content 为字符串
- 统一格式简化 Agent Loop 中的结果处理
- 结构化数据由各工具自行 `JSON.stringify`

### 3. 内置工具按能力分类

| 类别 | 工具 | 说明 |
|---|---|---|
| **文件系统** | `read_file` | 读取文件内容（支持指定行范围） |
| | `write_file` | 写入/创建文件 |
| **Shell** | `shell_exec` | 执行 Shell 命令（含超时和输出截断） |
| **Web** | `web_search` | 搜索引擎查询 |
| | `web_fetch` | 获取 URL 内容并转为 Markdown |

设计原则：
- 每个工具做一件事
- 工具名使用 `snake_case`（OpenAI Function Calling 惯例）
- 参数通过 JSON Schema 定义，LLM 自行决定传什么参数

### 4. 工具执行的安全性

内置工具在能力层做第一道安全防护：

| 机制 | 说明 |
|---|---|
| **路径沙箱** | `read_file` / `write_file` 限制在工作目录内，拒绝 `../` 逃逸 |
| **命令白名单** | `shell_exec` 可配置禁止的危险命令（`rm -rf /` 等） |
| **输出截断** | `shell_exec` 输出超过阈值（默认 50K chars）时截断并标记 |
| **超时控制** | `shell_exec` 和 `web_fetch` 设置超时（默认 30s），防止 hang |
| **用户确认** | 危险操作（`write_file`、`shell_exec`）可配置为需要用户确认 |

> 安全机制的第一道在 Tool System（参数校验、路径沙箱），第二道在 Agent Loop（用户确认提示），第三道在操作系统（文件权限、进程隔离）。

### 5. 参数校验策略

工具执行前做 JSON Schema 校验：
- 必填参数缺失 → 返回错误信息（让 LLM 修正后重试）
- 参数类型错误 → 返回错误信息
- 不做过于严格的校验（如字符串长度限制），LLM 通常生成合理的参数

校验失败不抛异常，而是返回描述性错误字符串——让 LLM 看到错误后自我修正。

### 6. 工具注册表的有序性

`getDefinitions()` 返回按名称排序的工具列表。排序确保每次传给 LLM 的工具定义顺序一致，这对 prompt caching 至关重要（顺序变化 → 缓存前缀不匹配 → cache miss）。

---

## 错误处理

工具执行的错误不抛给 Agent Loop，而是统一返回为字符串结果：

```ts
// 正常结果
"File content:\nimport foo from 'bar'\n..."

// 参数错误
"Error: Missing required parameter 'path'"

// 执行错误
"Error: ENOENT: no such file or directory: /nonexistent/file.txt"
```

LLM 看到错误后可以调整策略（换路径、修正参数、向用户解释），不需要 Agent Loop 介入。

---

## 后期扩展

### 用户自定义工具

支持通过配置文件注册用户自定义工具（Shell 脚本、HTTP API 等）：

```json
{
  "tools": [
    {
      "name": "deploy_to_vercel",
      "description": "Deploy the current project to Vercel",
      "command": "vercel deploy --prod",
      "parameters": { ... }
    }
  ]
}
```

### MCP (Model Context Protocol) 工具

后期支持通过 MCP 协议动态发现和调用外部工具服务，兼容 Claude Code / Cursor 等生态。

---

## 测试策略

| 层级 | 测试内容 |
|---|---|
| 单元测试 | 每个内置工具的 `execute()` 逻辑（mock 外部依赖） |
| 单元测试 | Registry 的注册/注销/查找 |
| 单元测试 | 参数校验（必填参数缺失、类型错误） |
| 集成测试 | 真实文件读写（临时目录） |
| 集成测试 | 真实 Shell 命令执行 |
| 边界测试 | 路径逃逸防护、超大文件读取、二进制文件、超时触发 |

---

## 参考资料

- [OpenAI Function Calling — Tool Definition](https://platform.openai.com/docs/guides/function-calling)
- [DeepSeek API — Function Calling](https://api-docs.deepseek.com/guides/function_calling)
- [JSON Schema Specification](https://json-schema.org/)
