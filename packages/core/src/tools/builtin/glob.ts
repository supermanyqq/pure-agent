/**
 * glob — 文件模式匹配搜索。
 *
 * 参考：Kilo Code glob.ts（简洁、mtime 排序、权限门控）
 * 实现：使用 Node.js 原生 fs.readdir（递归），无外部依赖
 */

import { readdir, stat } from 'node:fs/promises';
import { resolve, relative, join, normalize } from 'node:path';
import type { Tool, ToolDefinition } from '../../types/index.js';

// ===== 常量 =====

const MAX_RESULTS = 200;
const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'out', 'build', '__pycache__', '.next', '.cache', 'coverage']);

// ===== 参数 Schema =====

const GLOB_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description:
        'Glob pattern to match files, e.g. "**/*.ts", "src/**/*.test.*", "*.json". ' +
        'Supports standard glob syntax: * (any chars), ** (any directories), ? (single char), [abc] (character class).',
    },
    path: {
      type: 'string',
      description:
        'Directory to search in. Defaults to the working directory.',
    },
  },
  required: ['pattern'],
};

const GLOB_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'glob',
    description:
      'Find files matching a glob pattern. Returns file paths sorted by modification time (newest first). ' +
      'Use this to discover files by name pattern before reading or searching them. ' +
      'Automatically excludes node_modules, .git, dist, and similar directories. ' +
      'Results are capped at 200 files. ' +
      'Common patterns: "**/*.ts" (all TypeScript), "src/**/*.test.*" (test files), "*.json" (JSON files).',
    parameters: GLOB_PARAMETERS,
  },
};

// ===== 工具函数 =====

function resolveSafePath(workDir: string, inputPath: string): string {
  const normalized = normalize(inputPath);
  const resolved = resolve(workDir, normalized);
  const rel = relative(workDir, resolved);
  if (rel.startsWith('..') || resolve(workDir, rel) !== resolved) {
    throw new Error(`Path traversal detected: "${inputPath}" resolves outside working directory.`);
  }
  return resolved;
}

/**
 * 简单的 glob 匹配实现。
 * 支持 *, **, ?, [abc] 基本 glob 语法。
 */
function globMatch(filename: string, pattern: string): boolean {
  // 转换 glob pattern 为正则表达式
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 转义正则特殊字符
    .replace(/\*\*\/?/g, '___DOUBLESTAR___') // 临时替换 **
    .replace(/\*/g, '[^/]*') // * 匹配任意非 / 字符
    .replace(/\?/g, '[^/]') // ? 匹配单个非 / 字符
    .replace(/___DOUBLESTAR___/g, '.*') // ** 匹配任意字符（含 /）
    .replace(/\[!/g, '[^'); // [!...] → [^...] 否定字符类

  // 确保全路径匹配
  const anchoredRegex = new RegExp(`^${regexStr}$`);
  return anchoredRegex.test(filename);
}

async function walkDir(
  dir: string,
  pattern: string,
  relativeTo: string,
): Promise<Array<{ filepath: string; mtime: number }>> {
  const results: Array<{ filepath: string; mtime: number }> = [];

  async function walk(currentDir: string): Promise<void> {
    if (results.length >= MAX_RESULTS * 2) return;

    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return; // 跳过无权限目录
    }

    for (const entry of entries) {
      if (results.length >= MAX_RESULTS * 2) return;

      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        await walk(join(currentDir, entry.name));
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const filepath = join(currentDir, entry.name);
        const rel = relative(relativeTo, filepath);

        if (globMatch(rel, pattern)) {
          let mtime = 0;
          try {
            const st = await stat(filepath);
            mtime = st.mtimeMs;
          } catch {
            // ignore stat errors
          }
          results.push({ filepath, mtime });
        }
      }
    }
  }

  await walk(dir);
  return results;
}

export function createGlobTool(workDir: string): Tool {
  return {
    definition: GLOB_DEFINITION,

    async execute(args: Record<string, unknown>): Promise<string> {
      const pattern = String(args['pattern'] ?? '');
      if (!pattern.trim()) {
        return 'Error: "pattern" is required.';
      }

      const searchPath = String(args['path'] ?? workDir);

      let resolvedPath: string;
      try {
        resolvedPath = resolveSafePath(workDir, searchPath.trim());
      } catch (err: unknown) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      try {
        const results = await walkDir(resolvedPath, pattern.trim(), resolvedPath);

        // 按 mtime 降序排列（最新的在前）
        results.sort((a, b) => b.mtime - a.mtime);

        const truncated = results.length > MAX_RESULTS;
        const display = results.slice(0, MAX_RESULTS);

        const parts: string[] = [];
        parts.push(`Found ${results.length} files matching "${pattern}" in ${relative(workDir, resolvedPath) || '.'}:`);
        parts.push('');

        for (const r of display) {
          const rel = relative(workDir, r.filepath);
          parts.push(rel);
        }

        if (truncated) {
          parts.push(`\n(Showing ${MAX_RESULTS} of ${results.length} results. Narrow your pattern for more specific results.)`);
        } else if (results.length === 0) {
          parts.push('(No files found.)');
        }

        return parts.join('\n');
      } catch (err: unknown) {
        return `Error: Cannot search ${searchPath}: ${(err as Error).message}`;
      }
    },
  };
}
