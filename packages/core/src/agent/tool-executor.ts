import type { ToolCall, ToolResult } from '../types/index.js';
import type { ToolRegistry } from '../types/index.js';

/**
 * 并行执行多个工具调用，错误隔离。
 *
 * 每个工具调用独立的 try/catch，一个失败不影响其他。
 * 执行前将 ToolCall.function.arguments 从 JSON 字符串解析为对象。
 */
export async function executeAll(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  signal: AbortSignal,
): Promise<ToolResult[]> {
  return Promise.all(
    toolCalls.map(async (tc): Promise<ToolResult> => {
      // 如果已被 abort，快速返回
      if (signal.aborted) {
        return {
          toolCallId: tc.id,
          content: '',
          error: 'Aborted by user',
        };
      }

      // 1. 解析 JSON arguments
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch (parseError) {
        return {
          toolCallId: tc.id,
          content: '',
          error: `Invalid JSON arguments: ${(parseError as Error).message}`,
        };
      }

      // 2. 校验工具名（只允许安全的标识符格式）
      if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(tc.function.name)) {
        return {
          toolCallId: tc.id,
          content: '',
          error: `Invalid tool name: "${tc.function.name}"`,
        };
      }

      // 3. 执行工具
      try {
        const content = await registry.execute(tc.function.name, args);
        return { toolCallId: tc.id, content };
      } catch (execError) {
        const message =
          execError instanceof Error ? execError.message : String(execError);
        return {
          toolCallId: tc.id,
          content: '',
          error: message,
        };
      }
    }),
  );
}
