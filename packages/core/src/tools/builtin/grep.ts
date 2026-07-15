/**
 * grep — 文件内容搜索（正则表达式）。
 *
 * 参考：Kilo Code grep.ts（简洁、mtime 排序、结果截断）
 * 实现：使用 Node.js 原生 fs.readFile + 逐行正则匹配
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, join, extname, normalize } from 'node:path';
import type { Tool, ToolDefinition } from '../../types/index.js';

// ===== 常量 =====

const MAX_RESULTS = 50;
const MAX_LINE_LENGTH = 2000;
const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'out', 'build', '__pycache__', '.next', '.cache', 'coverage', '.claude', '.kilocode']);
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cpp', '.h', '.hpp',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg', '.md', '.mdx', '.txt',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.env.example',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.sql', '.graphql', '.proto',
  '.vue', '.svelte', '.astro',
  '.gitignore', '.npmrc', '.editorconfig', '.prettierrc', '.eslintrc',
  'Dockerfile', 'Makefile', '.dockerignore',
]);

// ===== 参数 Schema =====

const GREP_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description:
        'The regex pattern to search for. Uses JavaScript regex syntax. ' +
        'Examples: "interface.*Tool", "import.*from", "TODO|FIXME", "create\\w+Tool".',
    },
    path: {
      type: 'string',
      description:
        'File or directory to search in. Defaults to the working directory.',
    },
    include: {
      type: 'string',
      description:
        'File glob pattern to filter which files to search, e.g. "*.ts", "*.{ts,tsx}".',
    },
  },
  required: ['pattern'],
};

const GREP_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'grep',
    description:
      'Search file contents using regex patterns. Returns matching lines with file paths and line numbers. ' +
      'Automatically skips binary files and excluded directories (node_modules, .git, dist, etc.). ' +
      'Results are capped at 50 matches. Lines longer than 2000 chars are truncated. ' +
      'Use this to find code references, TODO comments, function definitions, or any text pattern. ' +
      'For finding files by name, use the glob tool instead.',
    parameters: GREP_PARAMETERS,
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

function isTextFile(filepath: string): boolean {
  const ext = extname(filepath);
  if (TEXT_EXTENSIONS.has(ext)) return true;

  // 无扩展名的文本文件
  const basename = filepath.split('/').pop() || '';
  if (TEXT_EXTENSIONS.has(basename)) return true;

  return false;
}

function globMatch(filename: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '___DBS___')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/___DBS___/g, '.*')
    .replace(/\[!/g, '[^');

  // 如果是简单 glob（不含 **），只匹配文件名，不做路径匹配
  if (!pattern.includes('**')) {
    const basename = filename.split('/').pop() || '';
    return new RegExp(`^${regexStr}$`).test(basename);
  }

  return new RegExp(`^${regexStr}$`).test(filename);
}

async function scanFiles(
  searchPath: string,
  includePattern: string | null,
): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const filepath = join(dir, entry.name);
        if (!isTextFile(filepath)) continue;
        if (includePattern) {
          const rel = relative(searchPath, filepath);
          if (!globMatch(rel, includePattern)) continue;
        }
        files.push(filepath);
      }
    }
  }

  await walk(searchPath);
  return files;
}

interface GrepMatch {
  filepath: string;
  lineNum: number;
  line: string;
  mtime: number;
}

export function createGrepTool(workDir: string): Tool {
  return {
    definition: GREP_DEFINITION,

    async execute(args: Record<string, unknown>): Promise<string> {
      const patternStr = String(args['pattern'] ?? '');
      if (!patternStr.trim()) {
        return 'Error: "pattern" is required.';
      }

      const searchPathStr = String(args['path'] ?? workDir);
      const includePattern = args['include'] ? String(args['include']) : null;

      // 验证正则
      let regex: RegExp;
      try {
        regex = new RegExp(patternStr, 'g');
      } catch (err: unknown) {
        return `Error: Invalid regex pattern: ${(err as Error).message}`;
      }

      let resolvedPath: string;
      try {
        resolvedPath = resolveSafePath(workDir, searchPathStr.trim());
      } catch (err: unknown) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      try {
        const searchStat = await stat(resolvedPath);

        // 单个文件
        if (searchStat.isFile()) {
          const matches = await searchFile(resolvedPath, regex);
          return formatResults(matches, patternStr, relative(workDir, resolvedPath) || searchPathStr);
        }

        // 目录
        const files = await scanFiles(resolvedPath, includePattern);
        const allMatches: GrepMatch[] = [];

        for (const filepath of files) {
          if (allMatches.length >= MAX_RESULTS * 2) break;
          const fileMatches = await searchFile(filepath, regex);
          allMatches.push(...fileMatches);
        }

        // 按 mtime 降序排列
        allMatches.sort((a, b) => b.mtime - a.mtime);

        const relDir = relative(workDir, resolvedPath) || '.';
        return formatResults(allMatches.slice(0, MAX_RESULTS), patternStr, relDir, allMatches.length > MAX_RESULTS);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          return `Error: Path not found: ${searchPathStr}`;
        }
        return `Error: Cannot search ${searchPathStr}: ${(err as Error).message}`;
      }
    },
  };
}

async function searchFile(filepath: string, regex: RegExp): Promise<GrepMatch[]> {
  let mtime = 0;
  try {
    const st = await stat(filepath);
    mtime = st.mtimeMs;
  } catch {
    // ignore
  }

  let content: string;
  try {
    content = await readFile(filepath, 'utf-8');
  } catch {
    return [];
  }

  const matches: GrepMatch[] = [];
  const lines = content.split('\n');

  // 重置 regex state（带 g flag 的 regex 有状态）
  regex.lastIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      let line = lines[i];
      if (line.length > MAX_LINE_LENGTH) {
        line = line.slice(0, MAX_LINE_LENGTH) + '... (line truncated)';
      }
      matches.push({
        filepath,
        lineNum: i + 1,
        line: line.trim(),
        mtime,
      });

      if (matches.length >= MAX_RESULTS) break;
    }
  }

  return matches;
}

function formatResults(
  matches: GrepMatch[],
  pattern: string,
  searchTarget: string,
  truncated = false,
): string {
  if (matches.length === 0) {
    return `No matches found for "${pattern}" in ${searchTarget}.`;
  }

  const parts: string[] = [];

  // 按文件分组
  const byFile = new Map<string, GrepMatch[]>();
  for (const m of matches) {
    const existing = byFile.get(m.filepath) || [];
    existing.push(m);
    byFile.set(m.filepath, existing);
  }

  parts.push(
    `Found ${truncated ? `${MAX_RESULTS}+` : matches.length} match(es) for "${pattern}" in ${searchTarget}:`,
  );
  parts.push('');

  for (const [filepath, fileMatches] of byFile) {
    // 使用相对路径展示
    const displayPath = filepath;
    parts.push(`${displayPath}:`);

    for (const m of fileMatches) {
      parts.push(`  ${m.lineNum}: ${m.line}`);
    }
    parts.push('');
  }

  if (truncated) {
    parts.push(`(Results capped at ${MAX_RESULTS} matches. Narrow your pattern or path for more specific results.)`);
  }

  return parts.join('\n');
}
