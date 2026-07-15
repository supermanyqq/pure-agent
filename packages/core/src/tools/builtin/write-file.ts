/**
 * write_file — 创建或覆写文件。
 *
 * 参考：Kilo Code write.ts（diff 预览、LSP 诊断、BOM 处理、mkdir -p 语义）
 */

import { writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve, relative, normalize } from 'node:path';
import type { Tool, ToolDefinition } from '../../types/index.js';

// ===== 参数 Schema =====

const WRITE_FILE_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'The path to the file to write (absolute or relative to working directory).',
    },
    content: {
      type: 'string',
      description: 'The content to write to the file.',
    },
  },
  required: ['path', 'content'],
};

const WRITE_FILE_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'write_file',
    description:
      'Create a new file or overwrite an existing file with new content. ' +
      'This tool will create parent directories automatically if they do not exist. ' +
      'If the file already exists, it will be overwritten. ' +
      'ALWAYS prefer editing existing files using edit_file tool when possible — ' +
      'only write new files when creating something new. ' +
      'The output includes line count and byte size confirmation.',
    parameters: WRITE_FILE_PARAMETERS,
  },
};

// ===== 工具函数 =====

function resolveSafePath(workDir: string, inputPath: string): string {
  const normalized = normalize(inputPath);
  const resolved = resolve(workDir, normalized);

  const rel = relative(workDir, resolved);
  if (rel.startsWith('..') || resolve(workDir, rel) !== resolved) {
    throw new Error(
      `Path traversal detected: "${inputPath}" resolves outside working directory.`,
    );
  }

  return resolved;
}

export function createWriteFileTool(workDir: string): Tool {
  return {
    definition: WRITE_FILE_DEFINITION,

    async execute(args: Record<string, unknown>): Promise<string> {
      const pathArg = String(args['path'] ?? '');
      if (!pathArg.trim()) {
        return 'Error: "path" is required.';
      }

      const content = String(args['content'] ?? '');
      // content 允许空字符串（创建空文件）

      // 路径解析与安全检查
      let resolvedPath: string;
      try {
        resolvedPath = resolveSafePath(workDir, pathArg.trim());
      } catch (err: unknown) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      // 确保父目录存在
      try {
        await mkdir(dirname(resolvedPath), { recursive: true });
      } catch (err: unknown) {
        return `Error: Cannot create parent directory for ${pathArg}: ${(err as Error).message}`;
      }

      // 检查文件是否已存在
      // 检查文件是否已存在
      let existed = false;
      let previousBytes = 0;
      let oldContent: string | null = null;
      try {
        oldContent = await readFile(resolvedPath, 'utf-8');
        existed = true;
        previousBytes = Buffer.byteLength(oldContent, 'utf-8');
      } catch {
        // 文件不存在
      }

      // 写入文件
      try {
        await writeFile(resolvedPath, content, 'utf-8');
      } catch (err: unknown) {
        return `Error: Cannot write to ${pathArg}: ${(err as Error).message}`;
      }

      // 确认写入
      let writtenBytes = 0;
      try {
        const newStat = await stat(resolvedPath);
        writtenBytes = newStat.size;
      } catch {
        writtenBytes = Buffer.byteLength(content, 'utf-8');
      }

      const relPath = relative(workDir, resolvedPath) || pathArg;
      const lineCount = content.split('\n').length;
      const parts: string[] = [];

      parts.push(`Wrote ${lineCount} lines to ${relPath} (${writtenBytes.toLocaleString()} bytes).`);

      if (existed) {
        if (oldContent === content) {
          parts.push('(File content was unchanged.)');
        } else {
          parts.push(
            `(Overwrote existing file of ${previousBytes.toLocaleString()} bytes. ` +
            `${writtenBytes - previousBytes >= 0 ? '+' : ''}${(writtenBytes - previousBytes).toLocaleString()} bytes change.)`,
          );
        }
      } else {
        parts.push('(New file.)');
      }

      return parts.join('\n');
    },
  };
}
