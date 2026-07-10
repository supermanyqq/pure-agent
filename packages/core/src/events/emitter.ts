import type { AgentEventEmitter, AgentEventMap } from '../types/index.js';

/**
 * 创建一个简单的事件发射器，将事件输出到 console。
 * 适用于 CLI 调试场景。
 */
export function createConsoleEmitter(): AgentEventEmitter {
  return {
    emit<K extends keyof AgentEventMap>(type: K, payload: AgentEventMap[K]): void {
      const p = payload as Record<string, unknown>;
      switch (type) {
        case 'agent:thinking':
          // 静默，不输出
          break;
        case 'agent:stream:delta':
          // 流式输出文本
          if (p.content) {
            process.stdout.write(p.content as string);
          }
          break;
        case 'agent:response':
          // 最终响应
          if (p.content) {
            process.stdout.write((p.content as string) + '\n');
          }
          break;
        case 'agent:error': {
          const err = p.error ?? payload;
          // 脱敏后再输出：防止 Error 对象或 payload 中意外包含 API key
          const raw = err instanceof Error ? err.message : JSON.stringify(err);
          const safe = raw.replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED]');
          console.error('\n[ERROR]', safe);
          break;
        }
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
