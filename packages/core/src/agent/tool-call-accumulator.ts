import type { ToolCall } from '../types/index.js';

/**
 * 将 Provider 的 StreamEvent（tool_call_start / tool_call_delta）合并为完整的 ToolCall[]。
 *
 * 适配 DeepSeek Client 的实际 StreamEvent 格式：
 * - tool_call_start: 新的工具调用开始（携带 id 和 name）
 * - tool_call_delta: 工具参数片段（按 id 累积拼接 arguments）
 */
export class ToolCallAccumulator {
  private toolCalls: Map<string, ToolCall> = new Map();
  // 维护插入顺序以保证输出稳定
  private insertionOrder: string[] = [];

  /**
   * 记录 tool_call_start 事件，创建新的 ToolCall 条目。
   */
  startToolCall(id: string, name: string): void {
    if (!this.toolCalls.has(id)) {
      this.toolCalls.set(id, {
        id,
        type: 'function',
        function: {
          name,
          arguments: '',
        },
      });
      this.insertionOrder.push(id);
    }
  }

  /**
   * 追加 tool_call_delta 事件中的 arguments 片段。
   */
  appendArguments(id: string, argumentsFragment: string): void {
    const existing = this.toolCalls.get(id);
    if (existing) {
      existing.function.arguments += argumentsFragment;
    }
  }

  /**
   * 返回按插入顺序排列的完整 ToolCall 数组。
   */
  getToolCalls(): ToolCall[] {
    return this.insertionOrder
      .map(id => this.toolCalls.get(id))
      .filter((tc): tc is ToolCall => tc !== undefined);
  }
}
