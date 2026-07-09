import type { AgentEventEmitter } from '../types/index.js';

/**
 * 创建一个简单的事件发射器，将事件输出到 console。
 * 适用于 CLI 调试场景。
 */
export function createConsoleEmitter(): AgentEventEmitter {
  return {
    emit(type: string, payload?: Record<string, unknown>): void {
      switch (type) {
        case 'agent:thinking':
          // 静默，不输出
          break;
        case 'agent:stream:delta':
          // 流式输出文本
          if (payload?.content) {
            process.stdout.write(payload.content as string);
          }
          break;
        case 'agent:response':
          // 最终响应
          if (payload?.content) {
            process.stdout.write((payload.content as string) + '\n');
          }
          break;
        case 'agent:error':
          console.error('\n[ERROR]', (payload as Record<string, unknown>)?.error ?? payload);
          break;
        case 'agent:abort':
          console.warn('\n[ABORTED]');
          break;
        case 'agent:turn:end':
        case 'agent:step:start':
        case 'agent:turn:start':
        case 'agent:tool_calls':
        case 'agent:executing':
        case 'agent:tool_result':
        default:
          // 非交互模式下静默
          break;
      }
    },
  };
}
