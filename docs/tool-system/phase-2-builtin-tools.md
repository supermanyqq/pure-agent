# Phase 2 — 内置工具（builtin/*.ts）

## 目标

实现 5 个内置工具，覆盖 Agent 最常用的能力：文件读写、Shell 执行、Web 搜索与内容获取。

## 前置依赖

| 依赖 | 说明 |
|---|---|
| Phase 1 | `createToolRegistry()` 已可用 |
| `types/` | `Tool`、`ToolDefinition` 接口 |

## 工具清单

### read_file

读取文件内容，支持指定行范围。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | ✅ | 文件路径（相对于工作目录） |
| `startLine` | number | ❌ | 起始行号（1-based），默认 1 |
| `endLine` | number | ❌ | 结束行号（inclusive），默认文件末尾 |

安全约束：
- 路径必须在工作目录内（禁止 `../` 逃逸）
- 文件大小上限（默认 1MB）
- 二进制文件检测（返回 `[Binary file]` 或前 200 字符预览）

### write_file

创建或覆写文件。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | ✅ | 文件路径 |
| `content` | string | ✅ | 文件内容 |

安全约束：
- 路径沙箱（同 read_file）
- 用户确认（可配置）

### shell_exec

执行 Shell 命令，返回 stdout + stderr + exit code。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `command` | string | ✅ | Shell 命令 |
| `cwd` | string | ❌ | 工作目录 |

安全约束：
- 超时控制（默认 30s）
- 输出截断（默认 50K chars）
- 命令黑名单（可配置，如 `rm -rf /`）

### web_search

Web 搜索引擎查询。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | ✅ | 搜索关键词 |
| `maxResults` | number | ❌ | 最大结果数，默认 5 |

### web_fetch

获取 URL 内容并转为 Markdown。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | ✅ | 目标 URL |
| `maxLength` | number | ❌ | 最大内容长度，默认 100K chars |

安全约束：
- 超时控制（默认 30s）
- 仅允许 HTTP/HTTPS 协议
- SSRF 防护（禁止内网 IP）

## 实现模板

每个工具导出 `createXxxTool(): Tool` 工厂函数：

```typescript
// packages/core/src/tools/builtin/read-file.ts
import type { Tool } from '../../types/index.js';

export function createReadFileTool(workDir: string): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from the local filesystem.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (relative to working directory)' },
            startLine: { type: 'number', description: 'Start line (1-based), default 1' },
            endLine: { type: 'number', description: 'End line (inclusive), default: end of file' },
          },
          required: ['path'],
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const path = String(args['path']);
      // ... 路径沙箱校验、文件读取、行范围截取
    },
  };
}
```

## 验收标准

- [ ] `tsc --noEmit` 通过
- [ ] 每个工具有独立单元测试
- [ ] read_file 路径逃逸测试失败，返回错误字符串
- [ ] write_file 写入 + read_file 读取端到端通过
- [ ] shell_exec 超时和输出截断生效
- [ ] web_fetch SSRF 防护（内网 IP 拒绝）

## 完成后

注册所有内置工具：

```typescript
// packages/core/src/tools/index.ts
import { createToolRegistry } from './registry.js';
import { createReadFileTool } from './builtin/read-file.js';
// ... 其他工具

export function createDefaultToolRegistry(workDir: string): ToolRegistry {
  const registry = createToolRegistry();
  registry.register(createReadFileTool(workDir));
  registry.register(createWriteFileTool(workDir));
  registry.register(createShellExecTool());
  registry.register(createWebSearchTool());
  registry.register(createWebFetchTool());
  return registry;
}
```
