/**
 * read_file — 读取文件内容，支持行范围、目录列表、二进制检测。
 *
 * 参考：Kilo Code read.ts（行号、offset/limit 分页、二进制检测、目录模式）
 */

import { readFile, stat, readdir } from 'node:fs/promises';
import { resolve, relative, basename, dirname, extname, normalize } from 'node:path';
import type { Tool, ToolDefinition } from '../../types/index.js';

// ===== 常量 =====

const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_FILE_BYTES = 1024 * 1024; // 1MB
const SAMPLE_BYTES = 4096;

const BINARY_EXTENSIONS = new Set([
  '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.class', '.jar', '.war',
  '.7z', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
  '.odp', '.bin', '.dat', '.obj', '.o', '.a', '.lib', '.wasm', '.pyc', '.pyo',
]);

const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

// ===== 参数 Schema =====

const READ_FILE_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'The path to the file or directory to read. Can be absolute or relative to the working directory.',
    },
    offset: {
      type: 'number',
      description: 'The line number to start reading from (1-indexed). Only needed for large files.',
    },
    limit: {
      type: 'number',
      description: `Maximum number of lines to read. Defaults to ${DEFAULT_READ_LIMIT}.`,
    },
  },
  required: ['path'],
};

const READ_FILE_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_file',
    description:
      'Read a file or directory from the local filesystem. ' +
      'For files: returns content with line numbers. Supports offset/limit pagination for large files. ' +
      'For directories: returns a formatted listing of directory contents. ' +
      'Automatically detects binary and image files, returning metadata instead of raw content. ' +
      'You can access any file directly by using this tool. You have the capability to call multiple tools in a single response — ' +
      'speculatively read multiple files as a batch when they are potentially useful. ' +
      'If the file does not exist, you will receive an error message. DO NOT attempt to read the same non-existent file again.',
    parameters: READ_FILE_PARAMETERS,
  },
};

// ===== 工具函数 =====

function resolveSafePath(workDir: string, inputPath: string): string {
  const normalized = normalize(inputPath);
  const resolved = resolve(workDir, normalized);

  // 检查路径遍历逃逸
  const rel = relative(workDir, resolved);
  if (rel.startsWith('..') || resolve(workDir, rel) !== resolved) {
    throw new Error(
      `Path traversal detected: "${inputPath}" resolves outside working directory.`,
    );
  }

  return resolved;
}

function isBinaryFile(filepath: string, bytes: Buffer): boolean {
  // 1. 扩展名检测
  const ext = extname(filepath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;

  // 2. 内容检测：null byte 或高比例非打印字符
  if (bytes.length === 0) return false;

  // UTF-16/32 BOM 检测
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe) || // UTF-16 LE
    (bytes[0] === 0xfe && bytes[1] === 0xff) || // UTF-16 BE
    (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) // UTF-32 LE
  ) {
    return false;
  }

  let nonPrintableCount = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true;
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintableCount++;
    }
  }

  return nonPrintableCount / bytes.length > 0.3;
}

function isImageFile(filepath: string): boolean {
  return SUPPORTED_IMAGE_EXTENSIONS.has(extname(filepath).toLowerCase());
}

async function readTextLines(
  filepath: string,
  offset: number,
  limit: number,
): Promise<{ lines: string[]; totalLines: number; truncated: boolean }> {
  const content = await readFile(filepath, 'utf-8');
  const allLines = content.split('\n');
  const totalLines = allLines.length;

  const start = Math.max(0, offset - 1);
  const end = Math.min(start + limit, totalLines);

  let lines = allLines.slice(start, end);
  let truncated = end < totalLines;

  // 截断过长的单行
  lines = lines.map((line) => {
    if (line.length > MAX_LINE_LENGTH) {
      truncated = true;
      return line.slice(0, MAX_LINE_LENGTH) + `... (line truncated to ${MAX_LINE_LENGTH} chars)`;
    }
    return line;
  });

  return { lines, totalLines, truncated };
}

function formatFileContent(
  filepath: string,
  lines: string[],
  offset: number,
  totalLines: number,
  truncated: boolean,
  workDir: string,
): string {
  const relPath = relative(workDir, filepath) || basename(filepath);
  const parts: string[] = [];

  parts.push(`<file path="${relPath}" lines="${offset}-${offset + lines.length - 1}">`);
  for (let i = 0; i < lines.length; i++) {
    parts.push(`${offset + i}: ${lines[i]}`);
  }
  parts.push('</file>');

  if (truncated) {
    const next = offset + lines.length;
    const remaining = totalLines - (offset + lines.length - 1);
    parts.push(
      `\n(Showing lines ${offset}-${offset + lines.length - 1} of ${totalLines}. ` +
        `Use offset=${next} to read the next ${remaining} lines.)`,
    );
  } else {
    parts.push(`\n(End of file — total ${totalLines} lines)`);
  }

  return parts.join('\n');
}

async function formatDirectoryListing(
  dirPath: string,
  workDir: string,
): Promise<string> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const relPath = relative(workDir, dirPath) || basename(dirPath);

  const parts: string[] = [];
  parts.push(`<directory path="${relPath}">`);

  // 排序：目录在前，文件在后，同类按名称排序
  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    const suffix = entry.isDirectory() ? '/' : entry.isSymbolicLink() ? '@' : '';
    parts.push(`  ${entry.name}${suffix}`);
  }

  parts.push(`</directory>`);
  parts.push(`\n(${entries.length} entries)`);

  return parts.join('\n');
}

// ===== 工厂函数 =====

export function createReadFileTool(workDir: string): Tool {
  return {
    definition: READ_FILE_DEFINITION,

    async execute(args: Record<string, unknown>): Promise<string> {
      const pathArg = String(args['path'] ?? '');
      if (!pathArg.trim()) {
        return 'Error: "path" is required.';
      }

      const offset = args['offset'] as number | undefined;
      if (offset !== undefined && (!Number.isFinite(offset) || offset < 1)) {
        return 'Error: "offset" must be a positive integer.';
      }

      const limit = (args['limit'] as number | undefined) ?? DEFAULT_READ_LIMIT;
      if (!Number.isFinite(limit) || limit < 1) {
        return 'Error: "limit" must be a positive integer.';
      }

      // 路径解析与安全检查
      let resolvedPath: string;
      try {
        resolvedPath = resolveSafePath(workDir, pathArg.trim());
      } catch (err: unknown) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      // 文件元数据
      let fileStat;
      try {
        fileStat = await stat(resolvedPath);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          // 尝试建议相似文件
          const dir = dirname(resolvedPath);
          const base = basename(resolvedPath);
          try {
            const entries = await readdir(dir);
            const similar = entries
              .filter((e) => e.toLowerCase().includes(base.toLowerCase()))
              .slice(0, 3);
            if (similar.length > 0) {
              return `Error: File not found: ${pathArg}\n\nDid you mean one of these?\n${similar.join('\n')}`;
            }
          } catch {
            // ignore dir read errors
          }
          return `Error: File not found: ${pathArg}`;
        }
        if (code === 'EACCES') {
          return `Error: Permission denied: ${pathArg}`;
        }
        return `Error: Cannot access ${pathArg}: ${(err as Error).message}`;
      }

      // 目录
      if (fileStat.isDirectory()) {
        try {
          const listing = await formatDirectoryListing(resolvedPath, workDir);
          return listing;
        } catch (err: unknown) {
          return `Error: Cannot read directory ${pathArg}: ${(err as Error).message}`;
        }
      }

      // 文件大小检查
      if (fileStat.size > MAX_FILE_BYTES) {
        const sizeMB = (fileStat.size / (1024 * 1024)).toFixed(1);
        return (
          `File is too large (${sizeMB} MB, limit is ${MAX_FILE_BYTES / (1024 * 1024)} MB). ` +
          `Use offset and limit to read specific sections.`
        );
      }

      // 空文件
      if (fileStat.size === 0) {
        return `<file path="${relative(workDir, resolvedPath)}">File is empty.</file>`;
      }

      // 二进制检测
      try {
        const sample = await readFile(resolvedPath);
        if (isBinaryFile(resolvedPath, sample)) {
          if (isImageFile(resolvedPath)) {
            return `[Image file: ${fileStat.size} bytes, type: ${extname(resolvedPath).toUpperCase().slice(1)}]`;
          }
          return `[Binary file: ${fileStat.size} bytes, type: ${extname(resolvedPath) || 'unknown'}]`;
        }
      } catch (err: unknown) {
        return `Error: Cannot read file ${pathArg}: ${(err as Error).message}`;
      }

      // 读取文本内容
      try {
        const { lines, totalLines, truncated } = await readTextLines(
          resolvedPath,
          offset ?? 1,
          Math.min(limit, DEFAULT_READ_LIMIT),
        );
        return formatFileContent(resolvedPath, lines, offset ?? 1, totalLines, truncated, workDir);
      } catch (err: unknown) {
        return `Error: Cannot read file ${pathArg}: ${(err as Error).message}`;
      }
    },
  };
}
