import type { ToolCall } from '../types/index.js';

/**
 * 检测 LLM 是否陷入死循环。
 *
 * 比较每个 Step 的 toolCalls 与上一个 Step。
 * 连续 THRESHOLD(3) 次相同 → 判定为死循环。
 */
export class LoopDetector {
  private readonly THRESHOLD = 3;

  private previousToolCalls: ToolCall[] | null = null;
  private repeatCount = 0;

  /**
   * 记录本次 Step 的工具调用，更新重复计数。
   */
  addToolCalls(toolCalls: ToolCall[]): void {
    if (
      this.previousToolCalls &&
      this.isSameCallSet(this.previousToolCalls, toolCalls)
    ) {
      this.repeatCount++;
    } else {
      this.repeatCount = 1;
    }
    this.previousToolCalls = toolCalls;
  }

  /**
   * 是否已检测到死循环。
   */
  isLooping(): boolean {
    return this.repeatCount >= this.THRESHOLD;
  }

  /**
   * 每个新 Turn 开始时重置状态。
   */
  reset(): void {
    this.previousToolCalls = null;
    this.repeatCount = 0;
  }

  /**
   * 比较两组 ToolCall 是否相同。
   *
   * 相同判定：
   * 1. 数组长度相同
   * 2. 每个位置的 function.name 相同
   * 3. 每个位置的 function.arguments 相同（字符串比较，不做 JSON 深度解析）
   */
  private isSameCallSet(a: ToolCall[], b: ToolCall[]): boolean {
    if (a.length !== b.length) return false;

    return a.every(
      (tc, i) =>
        tc.function.name === b[i].function.name &&
        tc.function.arguments === b[i].function.arguments,
    );
  }
}
