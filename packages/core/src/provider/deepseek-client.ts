import type { Message, ToolCall, ToolDefinition, StreamEvent, FinishReason, TokenUsage } from '../types/index.js';
import type { SendMessageParams, SendMessageResult, DeepSeekClient } from '../types/provider.js';
import type { ProviderConfig } from '../config/types.js';
import type { DeepSeekRequestBody, DeepSeekStreamChunk } from './deepseek-types.js';
import { httpRequest } from './http-client.js';
import { parseSSEStream, type SSEEvent } from './sse-parser.js';
import { HttpAbortError, IncompleteStreamError, SSEParseError } from './errors.js';

// StreamEvent 类型已移至 types/index.ts 以避免 types → provider 循环依赖
// 此处重新导出一份以保持向后兼容
export type { StreamEvent };

// ─── buildRequestBody ──────────────────────────

function buildRequestBody(params: {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  thinking?: { type: 'enabled' | 'disabled' };
  reasoningEffort?: 'high' | 'max';
}): DeepSeekRequestBody {
  const body: DeepSeekRequestBody = {
    model: params.model,
    messages: params.messages.map(mapMessageToDeepSeek),
    stream: true,
    stream_options: { include_usage: true },
  };

  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools.map(mapToolDefinitionToDeepSeek);
    body.tool_choice = 'auto';
  }

  if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.thinking) body.thinking = params.thinking;
  if (params.reasoningEffort) body.reasoning_effort = params.reasoningEffort;

  return body;
}

function mapMessageToDeepSeek(message: Message): {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
} {
  const base: {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    reasoning_content?: string;
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
  } = { role: message.role, content: message.content };

  if (message.role === 'assistant' && 'reasoningContent' in message && message.reasoningContent) {
    base.reasoning_content = message.reasoningContent;
  }

  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    base.tool_calls = message.toolCalls.map(tc => ({
      id: tc.id,
      type: tc.type,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
  }

  if (message.role === 'tool') {
    return { ...base, tool_call_id: message.toolCallId };
  }

  return base;
}

function mapToolDefinitionToDeepSeek(tool: ToolDefinition) {
  return {
    type: 'function' as const,
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  };
}

// ─── SSE → DeepSeek JSON 解析 ──────────────────

/**
 * 将通用 SSEEvent 解析为 DeepSeekStreamChunk。
 * 畸形 JSON 必须抛出 SSEParseError，不能静默跳过。
 */
function parseDeepSeekEvent(event: SSEEvent): DeepSeekStreamChunk | null {
  if (event.data === '[DONE]') return null;
  try {
    return JSON.parse(event.data) as DeepSeekStreamChunk;
  } catch (error: unknown) {
    throw new SSEParseError(
      error instanceof Error
        ? `Invalid DeepSeek SSE JSON: ${error.message}`
        : 'Invalid DeepSeek SSE JSON',
    );
  }
}

/** 将 SSEEvent 流转换为 DeepSeekStreamChunk 流，跳过 [DONE] 标记 */
async function* mapSSEToChunks(
  sseEvents: AsyncGenerator<SSEEvent>,
): AsyncGenerator<DeepSeekStreamChunk> {
  for await (const event of sseEvents) {
    const chunk = parseDeepSeekEvent(event);
    if (chunk) yield chunk;
  }
}

// ─── aggregateStream ───────────────────────────

interface ToolCallAccumulator {
  id: string;
  name: string;
  argumentsFragments: string[];
}

async function* aggregateStream(
  chunks: AsyncGenerator<DeepSeekStreamChunk>,
): AsyncGenerator<StreamEvent> {
  const toolCallAccumulators = new Map<number, ToolCallAccumulator>();
  let finalFinishReason: FinishReason | undefined;
  let finalUsage: TokenUsage | undefined;

  for await (const chunk of chunks) {
    // 先提取 usage（usage-only 终帧没有 choices，但仍需记录 usage）
    if (chunk.usage) {
      finalUsage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
      };
    }

    const choice = chunk.choices[0];
    if (!choice) continue;

    const delta = choice.delta;
    const finishReason = choice.finish_reason;

    // reasoning_content delta — 发射 reasoning 事件（Agent Loop 累积但不转发 UI）
    if (delta.reasoning_content) {
      yield { type: 'reasoning', content: delta.reasoning_content };
    }

    // Text delta
    if (delta.content) {
      yield { type: 'text', content: delta.content };
    }

    // Tool calls delta — arguments 按 index 增量推送
    if (delta.tool_calls) {
      for (const tcDelta of delta.tool_calls) {
        const index = tcDelta.index;

        if (!toolCallAccumulators.has(index)) {
          toolCallAccumulators.set(index, {
            id: '',
            name: '',
            argumentsFragments: [],
          });
        }
        const acc = toolCallAccumulators.get(index)!;

        if (tcDelta.id) acc.id = tcDelta.id;

        if (tcDelta.function?.name && !acc.name) {
          acc.name = tcDelta.function.name;
          yield { type: 'tool_call_start', id: acc.id, name: acc.name };
        }

        if (tcDelta.function?.arguments) {
          acc.argumentsFragments.push(tcDelta.function.arguments);
          yield {
            type: 'tool_call_delta',
            id: acc.id,
            arguments: tcDelta.function.arguments,
          };
        }
      }
    }

    if (finishReason) finalFinishReason = finishReason;
  }

  // 没有 finish reason 的流必须失败，不能静默生成 done
  if (!finalFinishReason) {
    throw new IncompleteStreamError();
  }
  yield { type: 'done', finishReason: finalFinishReason, usage: finalUsage };
}

// ─── streamMessage ─────────────────────────────

async function* streamMessage(
  apiKey: string,
  baseUrl: string,
  params: SendMessageParams,
): AsyncGenerator<StreamEvent> {
  const body = buildRequestBody({
    model: params.model!,
    messages: params.messages,
    tools: params.tools,
    maxTokens: params.maxTokens,
    temperature: params.temperature,
    thinking: params.thinking,
    reasoningEffort: params.reasoningEffort,
  });

  try {
    const res = await httpRequest({
      url: `${baseUrl}/chat/completions`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: params.signal,
      timeout: params.timeout,
      maxRetries: params.maxRetries,
    });

    const sseEvents = parseSSEStream(res.body);
    const chunks = mapSSEToChunks(sseEvents);
    yield* aggregateStream(chunks);
  } catch (error: unknown) {
    if (error instanceof HttpAbortError) {
      yield { type: 'aborted' };
      return;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      yield { type: 'aborted' };
      return;
    }
    throw error;
  }
}

// ─── collectStreamResponse ─────────────────────

/**
 * 消费 StreamEvent 流，重建完整的 SendMessageResult。
 *
 * Agent Loop 用这个函数消费流，拿到完整的 text + toolCalls + finishReason + usage，
 * 方便进入下一轮决策。
 */
export async function collectStreamResponse(
  stream: AsyncGenerator<StreamEvent>,
): Promise<SendMessageResult> {
  let text = '';
  let reasoningContent = '';
  const toolCallsMap = new Map<string, { name: string; argumentsStr: string }>();
  let finishReason: FinishReason | undefined;
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for await (const event of stream) {
    switch (event.type) {
      case 'reasoning':
        reasoningContent += event.content;
        break;
      case 'text':
        text += event.content;
        break;
      case 'tool_call_start':
        toolCallsMap.set(event.id, { name: event.name, argumentsStr: '' });
        break;
      case 'tool_call_delta':
        if (toolCallsMap.has(event.id)) {
          toolCallsMap.get(event.id)!.argumentsStr += event.arguments;
        }
        break;
      case 'done':
        finishReason = event.finishReason;
        if (event.usage) usage = event.usage;
        break;
      case 'aborted':
        throw new DOMException('Aborted', 'AbortError');
    }
  }

  // 防御：流结束但未收到 done 事件 → 视为不完整响应
  if (!finishReason) {
    throw new IncompleteStreamError(
      'Stream ended without a done event — response may be incomplete',
    );
  }

  const toolCalls: ToolCall[] = Array.from(toolCallsMap.entries())
    .map(([id, tc]) => {
      // 校验 arguments 拼接后是否为合法 JSON
      try {
        JSON.parse(tc.argumentsStr);
      } catch {
        console.warn(
          `[provider] Tool call ${id} (${tc.name}): arguments JSON parse failed, skipping`,
        );
        return null;
      }
      return {
        id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: tc.argumentsStr,
        },
      };
    })
    .filter((tc): tc is ToolCall => tc !== null);

  return { text, toolCalls, finishReason, usage };
}

// ─── createDeepSeekClient ──────────────────────

export function createDeepSeekClient(config: ProviderConfig): DeepSeekClient {
  const baseUrl = config.baseUrl.replace(/\/$/, '');

  return {
    streamMessage: (params: SendMessageParams) =>
      streamMessage(config.apiKey, baseUrl, {
        ...params,
        model: params.model ?? config.defaultModel,
        maxTokens: params.maxTokens ?? config.maxTokens,
        temperature: params.temperature ?? config.temperature,
        timeout: params.timeout ?? config.timeout,
        maxRetries: params.maxRetries ?? config.maxRetries,
      }),
  };
}
