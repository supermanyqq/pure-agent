import type { DeepSeekStreamChunk } from './deepseek-types';
import { SSEParseError } from './errors';

const SSE_DATA_PREFIX = 'data: ';
const SSE_DOUBLE_NEWLINE = '\n\n';
const SSE_DONE_MARKER = '[DONE]';

/**
 * 解析 SSE (Server-Sent Events) 流。
 *
 * 接收 HTTP 响应的 body（ReadableStream），逐 chunk 读取二进制字节，
 * 按 SSE 帧格式解析，yield 每个解析好的 DeepSeekStreamChunk。
 *
 * 粘包/拆包处理：
 * - Chunk 边界不一定对齐 SSE 帧边界
 * - 维护字符串 buffer，追加新 chunk 文本 → 提取完整帧（\n\n 分隔）→ 不完整的留在 buffer
 *
 * 错误策略：
 * - 单行 JSON 解析失败 → 容错跳过，继续后续行
 * - 流整体不是有效 SSE 格式 → 抛 SSEParseError
 *
 * 设计决策：只做 SSE 协议解析，不拼接 tool_calls arguments 片段。
 * 语义聚合由 deepseek-client 负责。
 * 这样 sse-parser 可复用于任何 OpenAI 兼容的 SSE 流。
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<DeepSeekStreamChunk> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let yieldedCount = 0;
  let receivedBytes = false;
  let sawDoneMarker = false;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        if (buffer.trim()) {
          if (isDoneMarker(buffer.trimEnd())) { sawDoneMarker = true; }
          else {
            const chunk = extractChunkFromFrame(buffer.trimEnd());
            if (chunk) {
              yieldedCount++; yield chunk;
            } else {
              // 流末尾有不完整帧（无法解析为有效的 SSE data: 行）
              console.warn('[sse-parser] Incomplete frame at end of stream, discarded');
            }
          }
        }
        // 流整体不是有效 SSE 格式（收到数据但未产出任何 chunk 且无 [DONE] 标记）
        if (receivedBytes && yieldedCount === 0 && !sawDoneMarker) {
          throw new SSEParseError(
            'Stream contained no valid SSE frames. Expected "data: <JSON>" or "data: [DONE]" lines.',
          );
        }
        return;
      }

      if (value.length > 0) receivedBytes = true;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split(SSE_DOUBLE_NEWLINE);
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        if (isDoneMarker(frame)) { sawDoneMarker = true; continue; }
        const chunk = extractChunkFromFrame(frame);
        if (chunk) { yieldedCount++; yield chunk; }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** 检查帧是否为 [DONE] 结束标记 */
function isDoneMarker(frameText: string): boolean {
  const trimmed = frameText.trim();
  return trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]';
}

function extractChunkFromFrame(frameText: string): DeepSeekStreamChunk | null {
  const dataLines = frameText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith(SSE_DATA_PREFIX));

  if (dataLines.length === 0) return null;

  // SSE 规范：同一帧内的多条 data: 行用 \n 拼接
  const jsonStr = dataLines.map(line => line.slice(SSE_DATA_PREFIX.length)).join('\n');

  if (jsonStr === SSE_DONE_MARKER) return null;

  try {
    return JSON.parse(jsonStr) as DeepSeekStreamChunk;
  } catch {
    // 日志脱敏：移除可能的 API key 模式
    const sanitized = jsonStr.replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED]');
    console.warn('[sse-parser] Skipped malformed JSON line:', sanitized.slice(0, 80));
    return null;
  }
}
