import type { ToolRegistry, ToolDefinition } from '../types/index.js';

/**
 * 空工具注册表 — 用于不需要工具调用的纯对话场景。
 */
export function createEmptyToolRegistry(): ToolRegistry {
  return {
    getDefinitions(): ToolDefinition[] {
      return [];
    },
    async execute(_name: string, _args: Record<string, unknown>): Promise<string> {
      throw new Error(`No tools registered. Cannot execute "${_name}".`);
    },
  };
}
