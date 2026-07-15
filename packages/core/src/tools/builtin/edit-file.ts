/**
 * edit_file — 精确字符串替换编辑器。
 *
 * 参考：Kilo Code edit.ts + Cline editor（search/replace 模式，非 unified diff）
 * 设计：old_string → new_string 精确替换，唯一性校验，防误修改
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, normalize } from 'node:path';
import type { Tool, ToolDefinition } from '../../types/index.js';

// ===== 参数 Schema =====

const EDIT_FILE_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'The path to the file to edit (absolute or relative to working directory).',
    },
    oldString: {
      type: 'string',
      description:
        'The exact text to replace. Must match exactly one occurrence in the file. ' +
        'Include enough surrounding context to make it unique. Preserve exact indentation.',
    },
    newString: {
      type: 'string',
      description:
        'The replacement text. Use an empty string to delete the matched text. ' +
        'Preserve exact indentation.',
    },
  },
  required: ['path', 'oldString', 'newString'],
};

const EDIT_FILE_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'edit_file',
    description:
      'Perform exact string replacements in an existing file. ' +
      'The edit will FAIL if oldString is not unique in the file — provide more surrounding context to make it unique. ' +
      'ALWAYS prefer editing existing files. NEVER write new files unless explicitly required. ' +
      'When editing text, ensure you preserve the exact indentation (tabs/spaces) as it appears before. ' +
      'For deletion, use an empty string as newString.',
    parameters: EDIT_FILE_PARAMETERS,
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

export function createEditFileTool(workDir: string): Tool {
  return {
    definition: EDIT_FILE_DEFINITION,

    async execute(args: Record<string, unknown>): Promise<string> {
      const pathArg = String(args['path'] ?? '');
      if (!pathArg.trim()) {
        return 'Error: "path" is required.';
      }

      const oldString = String(args['oldString'] ?? '');
      const newString = String(args['newString'] ?? '');

      if (!oldString) {
        return 'Error: "oldString" must be a non-empty string. Use write_file to create a new file.';
      }

      // 路径解析与安全检查
      let resolvedPath: string;
      try {
        resolvedPath = resolveSafePath(workDir, pathArg.trim());
      } catch (err: unknown) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      // 读取文件
      let content: string;
      try {
        content = await readFile(resolvedPath, 'utf-8');
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          return `Error: File not found: ${pathArg}. Use write_file to create a new file.`;
        }
        return `Error: Cannot read file ${pathArg}: ${(err as Error).message}`;
      }

      // 检查 oldString 在文件中的出现次数
      let count = 0;
      let matchIndex = -1;
      let searchIndex = 0;

      while (true) {
        const idx = content.indexOf(oldString, searchIndex);
        if (idx === -1) break;
        count++;
        matchIndex = idx;
        searchIndex = idx + 1;

        // 性能保护：超过 100 次放弃
        if (count > 100) break;
      }

      if (count === 0) {
        return (
          `Error: The text to replace was not found in the file (0 matches).\n\n` +
          `Tips:\n` +
          `- Check that the indentation (tabs/spaces) in oldString matches the file exactly\n` +
          `- oldString must be exact — including all whitespace, punctuation, and newlines\n` +
          `- Try reading the file first to copy the exact text you want to replace`
        );
      }

      if (count > 1) {
        return (
          `Error: Found ${count} matches of the text to replace. ` +
          `The oldString must match exactly one location in the file.\n\n` +
          `Tips:\n` +
          `- Include more surrounding context lines in oldString to make it unique\n` +
          `- Each match must be distinguished by different lines above or below the target text`
        );
      }

      // 执行替换
      const newContent = content.slice(0, matchIndex) + newString + content.slice(matchIndex + oldString.length);

      // 写入文件
      try {
        await writeFile(resolvedPath, newContent, 'utf-8');
      } catch (err: unknown) {
        return `Error: Cannot write to file ${pathArg}: ${(err as Error).message}`;
      }

      // 生成 diff 预览
      const relPath = relative(workDir, resolvedPath) || pathArg;
      const oldLines = oldString.split('\n').length;
      const newLines = newString.split('\n').length;

      const parts: string[] = [];
      parts.push(`Successfully edited ${relPath}.`);

      if (newString === '') {
        parts.push(`Deleted ${oldLines} line(s).`);
      } else if (oldLines === 1 && newLines === 1) {
        parts.push(`Replaced 1 line.`);
      } else {
        parts.push(
          `Replaced ${oldLines} line(s) with ${newLines} line(s).`,
        );
      }

      return parts.join('\n');
    },
  };
}
