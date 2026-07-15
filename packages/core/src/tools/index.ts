/**
 * Tool Registry 工厂 + 所有内置工具注册。
 */

import type { ToolRegistry } from '../types/index.js';
import { createEmptyToolRegistry } from './empty-registry.js';
import { createWebFetchTool } from './builtin/web-fetch.js';
import { createWebSearchTool } from './builtin/web-search.js';
import { createReadFileTool } from './builtin/read-file.js';
import { createWriteFileTool } from './builtin/write-file.js';
import { createEditFileTool } from './builtin/edit-file.js';
import { createShellExecTool } from './builtin/shell-exec.js';
import { createGlobTool } from './builtin/glob.js';
import { createGrepTool } from './builtin/grep.js';

/**
 * 创建包含所有内置工具的默认 ToolRegistry。
 */
export function createDefaultToolRegistry(workDir: string = process.cwd()): ToolRegistry {
  const registry = createEmptyToolRegistry();

  // File toolset — 文件操作
  registry.register(createReadFileTool(workDir));
  registry.register(createWriteFileTool(workDir));
  registry.register(createEditFileTool(workDir));

  // Search toolset — 搜索
  registry.register(createGlobTool(workDir));
  registry.register(createGrepTool(workDir));

  // Shell toolset — 命令执行
  registry.register(createShellExecTool(workDir));

  // Web toolset — 网络
  registry.register(createWebSearchTool());
  registry.register(createWebFetchTool());

  return registry;
}

export { createEmptyToolRegistry } from './empty-registry.js';
export { createWebFetchTool } from './builtin/web-fetch.js';
export { createWebSearchTool } from './builtin/web-search.js';
export { createReadFileTool } from './builtin/read-file.js';
export { createWriteFileTool } from './builtin/write-file.js';
export { createEditFileTool } from './builtin/edit-file.js';
export { createShellExecTool } from './builtin/shell-exec.js';
export { createGlobTool } from './builtin/glob.js';
export { createGrepTool } from './builtin/grep.js';
