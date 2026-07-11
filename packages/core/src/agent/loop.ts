import type { Message, ToolCall, AgentOptions, TurnOutput, ChatRequest, FinishReason, TurnStatus } from '../types/index.js';
import type { ChatProvider, ToolRegistry, ContextManager, AgentEventEmitter } from '../types/index.js';
import { StepBuilder } from './step-builder.js';
import { ToolCallAccumulator } from './tool-call-accumulator.js';
import { executeAll } from './tool-executor.js';
import { LoopDetector } from './loop-detector.js';

// ===== 内部类型 =====

interface StreamSuccess {
  type: 'success';
  textContent: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
}

interface StreamAborted {
  type: 'abort';
}

interface StreamError {
  type: 'error';
  error: Error;
}

type StreamResult = StreamSuccess | StreamAborted | StreamError;

// ===== finish_reason → TurnStatus 映射 =====

function mapFinishReasonToStatus(finishReason: FinishReason): TurnStatus {
  switch (finishReason) {
    case 'stop':
      return 'completed';
    case 'length':
      return 'truncated';
    case 'content_filter':
      return 'content_filtered';
    case 'insufficient_system_resource':
      return 'error';
    case 'tool_calls':
      // tool_calls 不直接映射为终态，由 Loop 继续处理
      return 'completed';
  }
}

// ===== AgentLoop =====

export class AgentLoop {
  private readonly loopDetector: LoopDetector;
  private readonly stepBuilder: StepBuilder;
  private runInProgress = false;

  constructor(
    private readonly provider: ChatProvider,
    private readonly toolRegistry: ToolRegistry,
    contextManager: ContextManager,
    private readonly events: AgentEventEmitter,
  ) {
    this.loopDetector = new LoopDetector();
    this.stepBuilder = new StepBuilder(contextManager);
  }

  async run(
    messages: Message[],
    options: AgentOptions,
    signal: AbortSignal,
  ): Promise<TurnOutput> {
    // Single-flight 守卫：同一实例不允许并发 run
    if (this.runInProgress) {
      throw new Error('AgentLoop instance already has an active turn');
    }
    this.runInProgress = true;

    try {
      this.loopDetector.reset();
      let steps = 0;

      this.emit('agent:turn:start', { messages });

      while (steps < options.maxSteps) {
        // ===== 检查点 1：每个 Step 开始前 =====
        if (signal.aborted) {
          return this.finish(messages, steps, 'aborted');
        }

        steps++;
        this.emit('agent:step:start', { step: steps });

        // ===== 阶段 A：构建请求 =====
        let chatRequest: ChatRequest;
        try {
          chatRequest = await this.stepBuilder.build(
            messages,
            this.toolRegistry.getDefinitions(),
            options,
            signal,
          );
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            return this.finish(messages, steps, 'aborted');
          }
          return this.finish(
            messages,
            steps,
            'error',
            { error: err instanceof Error ? err : new Error(String(err)) },
          );
        }

        // ===== 阶段 B：流式调用 LLM =====
        this.emit('agent:thinking', { step: steps });

        const streamResult = await this.processStream(chatRequest, signal);

        if (streamResult.type === 'abort') {
          return this.finish(messages, steps, 'aborted');
        }
        if (streamResult.type === 'error') {
          return this.finish(messages, steps, 'error', { error: streamResult.error });
        }

        const { textContent, reasoningContent, toolCalls, finishReason } = streamResult;

        // ===== 阶段 C：判断 finish_reason =====

        // C1: 正常结束 → 保存文本回复
        if (finishReason === 'stop') {
          messages.push({
            role: 'assistant',
            content: textContent,
          });
          this.emit('agent:response', { content: textContent });
          return this.finish(messages, steps, 'completed', { finishReason });
        }

        // C2: 工具调用
        if (finishReason === 'tool_calls') {
          // 防御：tool_calls 可能为空
          if (toolCalls.length === 0) {
            if (textContent) {
              messages.push({ role: 'assistant', content: textContent });
              this.emit('agent:response', { content: textContent });
            }
            return this.finish(messages, steps, 'completed', { finishReason });
          }

          // 保存 assistant 消息（含 tool_calls 和 reasoningContent）
          messages.push({
            role: 'assistant',
            content: textContent || null,
            reasoningContent: reasoningContent || undefined,
            toolCalls: toolCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            })),
          });

          this.emit('agent:tool_calls', { toolCalls });

          // ===== 阶段 D：执行工具 =====
          this.emit('agent:executing', { toolCalls });

          const execResult = await this.executeTools(
            toolCalls,
            signal,
            messages,
          );
          if (execResult === 'aborted') {
            return this.finish(messages, steps, 'aborted');
          }
          if (execResult === 'error') {
            return this.finish(
              messages,
              steps,
              'error',
              { error: new Error('Tool execution infrastructure failure') },
            );
          }

          // ===== 阶段 E：检测死循环 =====
          this.loopDetector.addToolCalls(toolCalls);
          if (this.loopDetector.isLooping()) {
            return this.finish(
              messages,
              steps,
              'error',
              { error: new Error('LOOP_DETECTED: 连续 3 次重复的工具调用') },
            );
          }

          continue;
        }

        // C3: 其他 finish_reason（length, content_filter, insufficient_system_resource 等）
        // 不执行工具：非 tool_calls 终态下的 tool delta 可能不完整（截断/过滤），
        // 执行这些工具会产生不可预期的副作用
        if (toolCalls.length > 0) {
          // 保存 assistant 消息但不包含 toolCalls（它们不完整/不可信）
          // 也不保存 reasoningContent（非 tool_calls 轮次不需要回放）
          if (textContent) {
            messages.push({ role: 'assistant', content: textContent });
          }
          const status = mapFinishReasonToStatus(finishReason);
          return this.finish(messages, steps, status, { finishReason });
        }

        if (textContent) {
          messages.push({ role: 'assistant', content: textContent });
        }
        const status = mapFinishReasonToStatus(finishReason);
        return this.finish(messages, steps, status, { finishReason });
      }

      // maxSteps 到达
      return this.finish(messages, steps, 'max_steps');
    } finally {
      this.runInProgress = false;
    }
  }

  // ===== 私有方法 =====

  /**
   * 流式调用 LLM，文本 delta 转发 UI，tool_calls 在内存中累积。
   * reasoning 累积但不转发 UI（只保存到 assistant tool-call message）。
   */
  private async processStream(
    chatRequest: ChatRequest,
    signal: AbortSignal,
  ): Promise<StreamResult> {
    let textContent = '';
    let reasoningContent = '';
    let finishReason: FinishReason = 'stop';
    const accumulator = new ToolCallAccumulator();

    try {
      const stream = this.provider.streamMessage({
        model: chatRequest.model,
        messages: chatRequest.messages,
        tools: chatRequest.tools,
        maxTokens: chatRequest.maxTokens,
        temperature: chatRequest.temperature,
        thinking: chatRequest.thinking,
        reasoningEffort: chatRequest.reasoningEffort,
        signal,
      });

      for await (const event of stream) {
        // ===== 检查点 2：流式迭代中 =====
        if (signal.aborted) {
          return { type: 'abort' };
        }

        switch (event.type) {
          case 'reasoning':
            reasoningContent += event.content;
            // 不发射 agent:stream:delta — reasoning 不展示给用户
            break;

          case 'text':
            textContent += event.content;
            this.emit('agent:stream:delta', { content: event.content });
            break;

          case 'tool_call_start':
            accumulator.startToolCall(event.id, event.name);
            break;

          case 'tool_call_delta':
            accumulator.appendArguments(event.id, event.arguments);
            break;

          case 'done':
            finishReason = event.finishReason;
            break;

          case 'aborted':
            return { type: 'abort' };
        }
      }

      return {
        type: 'success',
        textContent,
        reasoningContent,
        toolCalls: accumulator.getToolCalls(),
        finishReason,
      };
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { type: 'abort' };
      }
      // 不在此处发射 agent:error，由 run() 中的 finish() 统一发射
      return { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  /**
   * 执行工具调用，将结果追加到 messages。
   */
  private async executeTools(
    toolCalls: ToolCall[],
    signal: AbortSignal,
    messages: Message[],
  ): Promise<'success' | 'aborted' | 'error'> {
    // ===== 检查点 3：工具执行前 =====
    if (signal.aborted) {
      return 'aborted';
    }

    let results;
    try {
      results = await executeAll(toolCalls, this.toolRegistry, signal);
    } catch (err: unknown) {
      // 基础设施级异常（非单个工具的业务错误）→ 终止 Turn
      return 'error' as const;
    }

    for (const result of results) {
      // ===== 检查点 4：每个工具结果处理前 =====
      if (signal.aborted) {
        return 'aborted';
      }

      messages.push({
        role: 'tool',
        toolCallId: result.toolCallId,
        content: result.error
          ? `Error: ${result.error}\n\n${result.content}`
          : result.content,
      });

      this.emit('agent:tool_result', result);
    }

    return 'success';
  }

  // ===== 唯一终止方法 =====

  /**
   * 中央化终态事件发射。所有终止路径（completed/aborted/error/max_steps/truncated/content_filtered）
   * 必须经过此方法，确保每 Turn 恰好一次 turn:end。
   */
  private finish(
    messages: Message[],
    steps: number,
    status: TurnStatus,
    options: { error?: Error; finishReason?: FinishReason } = {},
  ): TurnOutput {
    if (status === 'aborted') {
      this.emit('agent:abort', {});
    }
    if (status === 'error' && options.error) {
      this.emit('agent:error', { error: options.error });
    }
    this.emit('agent:turn:end', {
      messages,
      steps,
      status,
      finishReason: options.finishReason,
    });
    return {
      messages,
      steps,
      status,
      error: options.error,
      finishReason: options.finishReason,
    };
  }

  private emit<K extends keyof import('../types/index.js').AgentEventMap>(
    type: K,
    payload: import('../types/index.js').AgentEventMap[K],
  ): void {
    this.events.emit(type, payload);
  }
}
