import type { Message, ToolCall, ToolDefinition, StreamEvent } from '../types';
import type { SendMessageParams, SendMessageResult, TokenUsage, DeepSeekClient, FinishReason } from '../types/provider';
import type { ProviderConfig } from '../config/types';
import type { DeepSeekRequestBody, DeepSeekStreamChunk } from './deepseek-types';
import { httpRequest } from './http-client';
import { parseSSEStream } from './sse-parser';
import { HttpAbortError } from './errors';

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
  thinking?: { type: 'enabled' | 'disabled'; reasoning_effort?: 'high' | 'max' };
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

  return body;
}

function mapMessageToDeepSeek(message: Message): {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
} {
  const base = { role: message.role, content: message.content };

  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      ...base,
      tool_calls: message.toolCalls.map(tc => ({
        id: tc.id,
        type: tc.type,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    };
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
  let finalFinishReason = 'stop';
  let finalUsage: TokenUsage | undefined;

  for await (const chunk of chunks) {
    const choice = chunk.choices[0];
    if (!choice) continue;

    const delta = choice.delta;
    const finishReason = choice.finish_reason;

    // reasoning_content delta — 跳过，不暴露到 StreamEvent

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
    if (chunk.usage) {
      finalUsage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
      };
    }
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

    const chunks = parseSSEStream(res.body);
    yield* aggregateStream(chunks);
  } catch (error: unknown) {
    if (error instanceof HttpAbortError) return;
    if (error instanceof DOMException && error.name === 'AbortError') return;
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
  const toolCallsMap = new Map<string, { name: string; argumentsStr: string }>();
  let finishReason: FinishReason = 'stop';
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for await (const event of stream) {
    switch (event.type) {
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
        finishReason = event.finishReason as FinishReason;
        if (event.usage) usage = event.usage;
        break;
    }
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
