import type { ToolRegistry, ToolDefinition, Tool } from '../types/index.js';

/**
 * 空工具注册表 — 用于不需要工具调用的纯对话场景。
 */
export function createEmptyToolRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>();

  return {
    getDefinitions(): ToolDefinition[] {
      return Array.from(tools.values())
        .map(t => t.definition)
        .sort((a, b) => a.function.name.localeCompare(b.function.name));
    },
    async execute(name: string, args: Record<string, unknown>): Promise<string> {
      const tool = tools.get(name);
      if (!tool) {
        return `Error: Tool "${name}" not found.`;
      }
      return tool.execute(args);
    },
    register(tool: Tool): void {
      tools.set(tool.definition.function.name, tool);
    },
    unregister(name: string): void {
      tools.delete(name);
    },
  };
}
