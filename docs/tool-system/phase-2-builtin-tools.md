# Phase 2 — 内置工具（builtin/*.ts）

## 目标

实现 8 个内置工具，覆盖 AI Coding Agent 最常用的能力。在初版设计的 5 个工具基础上，新增 `edit_file`（精确字符串替换）、`glob`（文件模式匹配）和 `grep`（内容搜索）——这三个工具是 Cline 和 Kilo Code 实践中最重要的文件操作工具。

## 前置依赖

| 依赖 | 说明 |
|------|------|
| Phase 1 | `createToolRegistry()` 已可用 |
| `types/` | `Tool`、`ToolDefinition`、`ToolContext`、`ToolResult` 接口 |

---

## 三项目内置工具对比

| 工具 | Hermes Agent | Cline | Kilo Code | Pure Agent |
|------|-------------|-------|-----------|------------|
| 文件读取 | `read_file`（行范围） | `read_files`（单/多文件） | `read`（行范围、目录列表、图片/PDF） | `read_file`（行范围） |
| 文件写入 | `write_file` | `editor`（diff-based） | `write`（创建/覆写） | `write_file`（创建/覆写） |
| 文件编辑 | `patch`（unified diff） | `editor`（search/replace） | `edit`（search/replace）+ `apply_patch` | `edit_file`（search/replace） |
| Shell | `terminal` | `run_commands`（多命令并发） | `bash`（tree-sitter 解析） | `shell_exec` |
| 文件匹配 | `search_files` | `search_codebase` | `glob` + `grep` | `glob` + `grep` |
| Web 搜索 | `web_search` | — | `websearch` | `web_search` |
| Web 获取 | `web_extract` | `fetch_web_content` | `webfetch` | `web_fetch` |
| 子 Agent | `delegate_task` | `spawn_agent` | `task` | （后期）`delegate_task` |
| 任务管理 | `todo` | — | `todowrite` | （后期）`todo` |
| 技能 | `skills_list/view/manage` | `skills` | `skill` | （后期）`skill` |
| 用户提问 | `clarify` | `ask_question` | `question` | （后期）`ask_user` |

### 关键差异分析

**1. 文件编辑：search/replace vs diff/patch**

- **Hermes**：同时提供 `patch`（unified diff）和精确编辑，`patch` 使用 Python 的 `patch_parser.py` 解析和应用。
- **Cline**：`editor` 使用 search/replace 模式（`old_string` → `new_string`），对 OpenAI 模型提供 `apply_patch` 替代方案（via model routing rules）。
- **Kilo Code**：同时提供 `edit`（search/replace）和 `apply_patch`（unified diff），通过 feature flag 二选一。
- **Pure Agent 选择**：采用 search/replace 模式（`edit_file`）。原因：(a) LLM 生成精确替换字符串比生成 unified diff 更可靠；(b) 实现更简单；(c) 与 Cline 的 `editor` 和 Kilo Code 的 `edit` 保持一致。

**2. 文件搜索：单工具 vs glob+grep 分离**

- **Hermes**：`search_files` 同时做文件名和内容搜索。
- **Kilo Code**：`glob`（文件名匹配）和 `grep`（内容搜索）分离。
- **Pure Agent 选择**：分离 `glob` 和 `grep`，保持单一职责。`glob` 用于发现文件（"找所有 .ts 文件"），`grep` 用于搜索内容（"找包含 'ToolRegistry' 的文件"）。LLM 可组合使用：先 glob 缩小范围，再 grep 精确定位。

**3. Shell 命令执行：命令格式**

- **Hermes**：`terminal` 接受单个命令字符串。
- **Cline**：`run_commands` 接受命令数组，并发执行多个独立命令。
- **Kilo Code**：`bash` 接受单个命令字符串，使用 tree-sitter 解析命令以提取文件路径（用于权限审批）。
- **Pure Agent 选择**：接受单个命令字符串。多命令需求可由 LLM 多次调用 `shell_exec` 满足，Agent Loop 已支持并行工具调用（`executeAll` 使用 `Promise.all`）。

---

## 工具清单

### 1. read_file

读取文件内容，支持指定行范围。借鉴 Kilo Code 的 `read` 工具设计，增加目录列表和图片/PDF 检测能力。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | ✅ | 文件或目录路径（相对于工作目录） |
| `offset` | number | ❌ | 起始行号（1-based），默认 1 |
| `limit` | number | ❌ | 最大读取行数，默认 2000 |

**安全约束**：
- 路径必须在工作目录内（禁止 `../` 逃逸，参考 Hermes `path_security.py` 的 `validate_within_dir()`）
- 文件大小上限（默认 1MB），超大文件返回错误提示（建议使用 offset/limit）
- 二进制文件检测：读取前 4KB 检测 null byte，返回 `[Binary file: N bytes, MIME type]`
- 图片文件（PNG/JPEG/GIF/WebP）检测：返回 `[Image: N bytes, dimensions]`，提示 LLM 可以使用 vision 能力
- 目录列表：传入目录路径时，返回格式化的目录内容列表（参考 Kilo Code 的 `read` 目录模式）
- 敏感设备路径阻断：`/dev/zero`, `/dev/random`, `/dev/urandom`, `/dev/stdin`, `/dev/tty`（参考 Hermes）

**输出格式**：
```
<file path="src/tools/registry.ts" lines="1-50">
... 文件内容（带行号前缀）...
</file>
```

### 2. write_file

创建或覆写文件。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | ✅ | 文件路径 |
| `content` | string | ✅ | 文件内容 |

**安全约束**：
- 路径沙箱（同 read_file）
- 写入前检查目录是否存在，不存在则自动创建（`mkdir -p` 语义）
- 写入前读取已有文件（如果存在），记录 overwrite 状态
- 用户确认（可配置）：作为 file toolset 的默认审批策略

**输出格式**：
```
Wrote 42 lines to src/tools/registry.ts (1,234 bytes).
(Overwrote existing file of 980 bytes)
```

### 3. edit_file

精确字符串替换——在文件中查找匹配的字符串并替换。借鉴 Cline 的 `editor` 和 Kilo Code 的 `edit`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | ✅ | 文件路径 |
| `oldString` | string | ✅ | 要替换的原始字符串（必须唯一匹配） |
| `newString` | string | ✅ | 替换后的新字符串 |

**设计决策——为什么用 search/replace 而非 unified diff**：

参考 Cline 的 model-tool-routing：`codex` 和 `gpt` 模型使用 `apply_patch`（unified diff），其他模型使用 `editor`（search/replace）。Kilo Code 也通过 feature flag 切换。Pure Agent 选择 search/replace 作为首选，理由：
1. LLM 生成精确的 `oldString` 比生成正确的 unified diff 更可靠
2. 唯一性检查（oldString 必须精确匹配唯一一处）防止意外修改
3. 实现更简单，不依赖外部 diff/patch 工具
4. 对 LLM 更友好——LLM 擅长复制粘贴式编辑

**安全约束**：
- `oldString` 必须在文件中精确匹配一次且仅一次（否则拒绝并报告匹配次数）
- 路径沙箱（同 read_file）
- 写入后校验文件语法（可选，对 TypeScript/JSON 等使用 parser 验证）

**错误处理**：
- `oldString` 未匹配 → `Error: The string to replace was not found in the file (0 matches).`
- `oldString` 多次匹配 → `Error: Found N matches of the string to replace. Please provide a more specific string with more surrounding context.`

### 4. glob

文件模式匹配——使用 glob pattern 查找文件。借鉴 Kilo Code 的 `glob` 工具。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pattern` | string | ✅ | Glob 模式（如 `**/*.ts`、`src/**/*.test.*`） |
| `path` | string | ❌ | 搜索根目录，默认工作目录 |

**与 grep 的配合**：LLM 可先 `glob` 缩小文件范围，再 `grep` 精确搜索内容。这是 Kilo Code 的推荐工作流。

**安全约束**：
- 路径沙箱（搜索范围限制在工作目录内）
- 结果数量上限（默认 200），超出时截断并提示

**输出格式**：
```
Found 15 files matching "src/**/*.ts":
  src/tools/registry.ts
  src/tools/types.ts
  src/agent/loop.ts
  ...
```

### 5. grep

文件内容搜索——使用正则表达式搜索文件内容。借鉴 Kilo Code 的 `grep` 工具（内部使用 ripgrep）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pattern` | string | ✅ | 搜索模式（正则表达式或固定字符串） |
| `path` | string | ❌ | 搜索目录或文件，默认工作目录 |
| `include` | string | ❌ | 文件名过滤 glob（如 `*.ts`） |
| `maxResults` | number | ❌ | 最大结果数，默认 50 |

**安全约束**：
- 路径沙箱
- 结果数量上限（默认 50），超出时截断
- 自动排除 `node_modules`、`.git`、`dist`、`out`、`__pycache__` 等目录

**输出格式**：
```
Found 3 matches for "ToolRegistry" in src/:
  src/agent/loop.ts:42: import type { ToolRegistry } from '../tools/index.js';
  src/tools/registry.ts:1: export function createToolRegistry(): ToolRegistry {
  src/tools/empty-registry.ts:6: export function createEmptyToolRegistry(): ToolRegistry {
```

### 6. shell_exec

执行 Shell 命令，返回 stdout + stderr + exit code。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | ✅ | Shell 命令 |
| `cwd` | string | ❌ | 工作目录（默认继承 Agent 工作目录） |
| `timeout` | number | ❌ | 超时时间（秒），默认 30 |

**安全约束**：
- 超时控制（默认 30s，可配置）
- 输出截断（默认 50K chars）
- 命令危险模式检测（借鉴 Hermes 的 `DANGEROUS_PATTERNS`）：匹配 `rm -rf /`、`sudo`、`chmod 777`、`> /dev/sda` 等模式时触发审批
- 环境变量隔离：命令在受限 shell 环境中执行（可选配置）

**输出格式**：
```
Exit code: 0
Duration: 1.2s
--- stdout ---
file1.txt
file2.txt
--- stderr ---
(empty)
```

### 7. web_search

Web 搜索引擎查询。借鉴 Hermes 的 `web_search` 和 Kilo Code 的 `websearch`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | ✅ | 搜索关键词 |
| `maxResults` | number | ❌ | 最大结果数，默认 5 |

### 8. web_fetch

获取 URL 内容并转为 Markdown。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | ✅ | 目标 URL |
| `maxLength` | number | ❌ | 最大内容长度（字符），默认 100K |

**安全约束**：
- 超时控制（默认 30s）
- 仅允许 HTTP/HTTPS 协议
- SSRF 防护：禁止内网 IP（`127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`）
- URL 安全校验（参考 Hermes `url_safety.py` 的敏感参数名检测）

---

## 实现模板

每个工具导出 `createXxxTool(options): Tool` 工厂函数。借鉴 Kilo Code 的类型安全做法，为参数提供类型化接口：

```typescript
// packages/core/src/tools/builtin/read-file.ts
import type { Tool, ToolContext, ToolResult } from '../../types/index.js';
import { resolveSafePath } from '../path-security.js';

interface ReadFileArgs {
  path: string;
  offset?: number;
  limit?: number;
}

const READ_FILE_DEFINITION: ToolDefinition = {
  name: 'read_file',
  description: `Read a file from the local filesystem. You can access any file directly by using this tool.
  - You can optionally specify an offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters.
  - You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.
  - If you read a file that exists but has empty contents you will receive 'File is empty.'.
  - You might also receive IDE diagnostic information (errors, warnings, hints) from language servers and linters.
  - If the file does not exist, you will receive an error message. DO NOT attempt to read the same non-existent file again.
  - FilePath must be an absolute path.`,
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to read (absolute or relative to working directory)',
      },
      offset: {
        type: 'number',
        description: 'The line number to start reading from (1-indexed). Only provide if the file is too large to read at once.',
      },
      limit: {
        type: 'number',
        description: 'The number of lines to read. Only provide if the file is too large to read at once.',
      },
    },
    required: ['path'],
  },
  toolset: 'file',
};

export function createReadFileTool(workDir: string): Tool<ReadFileArgs> {
  return {
    definition: READ_FILE_DEFINITION,

    async execute(args: ReadFileArgs, context: ToolContext): Promise<ToolResult> {
      // 1. 路径解析与安全检查
      const resolvedPath = resolveSafePath(workDir, args.path);

      // 2. 设备路径阻断
      if (isBlockedDevicePath(resolvedPath)) {
        return {
          content: '',
          error: `Cannot read from device path: ${args.path}`,
        };
      }

      // 3. 文件元数据检查
      const stat = await fs.stat(resolvedPath);

      // 4. 目录处理
      if (stat.isDirectory()) {
        const entries = await fs.readdir(resolvedPath);
        return {
          content: formatDirectoryListing(resolvedPath, entries),
          renderHint: 'text',
          metadata: { isDirectory: true, entryCount: entries.length },
        };
      }

      // 5. 大小检查
      if (stat.size > MAX_FILE_SIZE) {
        return {
          content: '',
          error: `File is too large (${formatBytes(stat.size)}). Use offset and limit to read specific sections.`,
        };
      }

      // 6. 二进制检测
      const sample = await readSample(resolvedPath);
      if (isBinary(sample)) {
        const mimeType = sniffMime(sample);
        return {
          content: `[Binary file: ${formatBytes(stat.size)}, type: ${mimeType}]`,
          renderHint: 'text',
          metadata: { isBinary: true, size: stat.size, mimeType },
        };
      }

      // 7. 读取内容
      const { content, totalLines } = await readWithPagination(
        resolvedPath,
        args.offset ?? 1,
        args.limit ?? DEFAULT_READ_LIMIT,
      );

      return {
        content: formatFileContent(args.path, content, args.offset ?? 1, totalLines),
        renderHint: 'code',
        metadata: { size: stat.size, totalLines, readLines: countLines(content) },
      };
    },
  };
}
```

---

## 工具描述文案规范

借鉴 Cline 和 Kilo Code 的工具描述，遵循以下原则：

1. **第二人称（you）**：直接对 LLM 说话——"You can access any file..."
2. **能力 + 约束**：先说能做什么，再说限制
3. **使用建议**：给出最佳实践（"It is always better to speculatively read multiple files as a batch"）
4. **错误行为**：明确告诉 LLM 出错时该怎么做（"DO NOT attempt to read the same non-existent file again"）
5. **输出格式**：说明返回内容的格式

**示例——edit_file 的描述**（借鉴 Cline 的 `editor` 描述）：

```
Performs exact string replacements in an existing file.

When editing text, ensure you preserve the exact indentation (tabs/spaces) as it appears before.
ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.

The edit will FAIL if oldString is not unique in the file.
* Either provide a larger string with more surrounding context to make it unique.
* For deletion, use an empty string as newString.
```

---

## 安全层汇总

| 工具 | 路径沙箱 | 大小限制 | 输出截断 | 超时 | 审批 | 其他 |
|------|---------|---------|---------|------|------|------|
| `read_file` | ✅ | 1MB | — | 10s | — | 设备路径阻断、二进制检测 |
| `write_file` | ✅ | — | — | — | 可配置 | 自动创建目录 |
| `edit_file` | ✅ | — | — | — | 可配置 | 唯一性校验 |
| `glob` | ✅ | 200 结果 | 200 结果 | 10s | — | 排除 node_modules 等 |
| `grep` | ✅ | 50 结果 | 50 结果 | 10s | — | 排除 node_modules 等 |
| `shell_exec` | — | — | 50K chars | 30s | 危险命令 | 环境变量隔离 |
| `web_search` | — | 5 结果 | — | 15s | — | — |
| `web_fetch` | — | 100K chars | — | 30s | — | SSRF 防护、协议白名单 |

---

## 验收标准

- [ ] `tsc --noEmit` 通过
- [ ] 每个工具有独立单元测试（覆盖正常流程和错误路径）
- [ ] `read_file` 路径逃逸测试失败，返回错误字符串
- [ ] `read_file` 设备路径阻断测试（`/dev/zero` 等）
- [ ] `read_file` 目录列表输出格式正确
- [ ] `read_file` 二进制文件检测正确
- [ ] `write_file` 写入 + `read_file` 读取端到端通过
- [ ] `edit_file` 精确替换（唯一匹配）通过
- [ ] `edit_file` 非唯一匹配拒绝
- [ ] `edit_file` 零匹配拒绝
- [ ] `glob` 匹配结果正确，超量截断
- [ ] `grep` 搜索结果正确，超量截断
- [ ] `shell_exec` 超时和输出截断生效
- [ ] `shell_exec` 危险命令触发审批回调
- [ ] `web_fetch` SSRF 防护（内网 IP 拒绝）
- [ ] `web_fetch` 非 HTTP/HTTPS 协议拒绝

## 完成后

注册所有内置工具：

```typescript
// packages/core/src/tools/index.ts
import { createToolRegistry } from './registry.js';
import { createReadFileTool } from './builtin/read-file.js';
import { createWriteFileTool } from './builtin/write-file.js';
import { createEditFileTool } from './builtin/edit-file.js';
import { createGlobTool } from './builtin/glob.js';
import { createGrepTool } from './builtin/grep.js';
import { createShellExecTool } from './builtin/shell-exec.js';
import { createWebSearchTool } from './builtin/web-search.js';
import { createWebFetchTool } from './builtin/web-fetch.js';

export function createDefaultToolRegistry(options: {
  workDir: string;
  approvalCallback?: (toolName: string, message: string) => Promise<boolean>;
}): ToolRegistry {
  const registry = createToolRegistry();

  // File toolset
  registry.register(createReadFileTool(options.workDir));
  registry.register(createWriteFileTool(options.workDir, options.approvalCallback));
  registry.register(createEditFileTool(options.workDir, options.approvalCallback));
  registry.register(createGlobTool(options.workDir));
  registry.register(createGrepTool(options.workDir));

  // Shell toolset
  registry.register(createShellExecTool(options.approvalCallback));

  // Web toolset
  registry.register(createWebSearchTool());
  registry.register(createWebFetchTool());

  return registry;
}
```
