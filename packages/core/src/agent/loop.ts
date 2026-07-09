import type { Message, ToolCall, AgentOptions, TurnOutput, StreamEvent, ChatRequest } from '../types/index.js';
import type { ChatProvider, ToolRegistry, ContextManager, AgentEventEmitter } from '../types/index.js';
import { StepBuilder } from './step-builder.js';
import { ToolCallAccumulator } from './tool-call-accumulator.js';
import { executeAll } from './tool-executor.js';
import { LoopDetector } from './loop-detector.js';

// ===== 内部类型 =====

interface StreamSuccess {
  type: 'success';
  textContent: string;
  toolCalls: ToolCall[];
  finishReason: string;
}

interface StreamAborted {
  type: 'abort';
}

interface StreamError {
  type: 'error';
  error: Error;
}

type StreamResult = StreamSuccess | StreamAborted | StreamError;

// ===== AgentLoop =====

export class AgentLoop {
  private readonly loopDetector: LoopDetector;
  private readonly stepBuilder: StepBuilder;

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
    this.loopDetector.reset();
    let steps = 0;

    this.emit('agent:turn:start', { messages });

    while (steps < options.maxSteps) {
      // ===== 检查点 1：每个 Step 开始前 =====
      if (signal.aborted) {
        return this.abort(messages, steps);
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
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return this.abort(messages, steps);
        }
        return this.errorEnd(
          messages,
          steps,
          err instanceof Error ? err : new Error(String(err)),
        );
      }

      // ===== 阶段 B：流式调用 LLM =====
      this.emit('agent:thinking', { step: steps });

      const streamResult = await this.processStream(chatRequest, signal);

      if (streamResult.type === 'abort') {
        return this.abort(messages, steps);
      }
      if (streamResult.type === 'error') {
        return this.errorEnd(messages, steps, streamResult.error);
      }

      const { textContent, toolCalls, finishReason } = streamResult;

      // ===== 阶段 C：判断 finish_reason =====

      // C1: 正常结束 → 保存文本回复
      if (finishReason === 'stop') {
        messages.push({
          role: 'assistant',
          content: textContent,
        });
        this.emit('agent:response', { content: textContent });
        return this.completed(messages, steps);
      }

      // C2: 工具调用
      if (finishReason === 'tool_calls') {
        // 防御：tool_calls 可能为空
        if (toolCalls.length === 0) {
          if (textContent) {
            messages.push({ role: 'assistant', content: textContent });
            this.emit('agent:response', { content: textContent });
          }
          return this.completed(messages, steps);
        }

        // 保存 assistant 消息（含 tool_calls）
        messages.push({
          role: 'assistant',
          content: textContent || null,
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
          return { messages, steps, status: 'aborted' };
        }
        if (execResult === 'error') {
          return this.errorEnd(
            messages,
            steps,
            new Error('Tool execution infrastructure failure'),
          );
        }

        // ===== 阶段 E：检测死循环 =====
        this.loopDetector.addToolCalls(toolCalls);
        if (this.loopDetector.isLooping()) {
          return this.errorEnd(
            messages,
            steps,
            new Error('LOOP_DETECTED: 连续 3 次重复的工具调用'),
          );
        }

        continue;
      }

      // C3: 其他 finish_reason（length, content_filter 等）或 finishReason 为空
      // 防御：如果有累积的 toolCalls 但 finishReason 不是 tool_calls（如 done 事件缺失），
      // 按 tool_calls 路径处理，避免工具调用被静默丢弃
      if (toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: textContent || null,
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
        this.emit('agent:executing', { toolCalls });
        const execResult = await this.executeTools(toolCalls, signal, messages);
        if (execResult === 'aborted') {
          return { messages, steps, status: 'aborted' };
        }
        if (execResult === 'error') {
          return this.errorEnd(
            messages,
            steps,
            new Error('Tool execution infrastructure failure'),
          );
        }
        this.loopDetector.addToolCalls(toolCalls);
        if (this.loopDetector.isLooping()) {
          return this.errorEnd(
            messages,
            steps,
            new Error('LOOP_DETECTED: 连续 3 次重复的工具调用'),
          );
        }
        continue;
      }

      if (textContent) {
        messages.push({ role: 'assistant', content: textContent });
      }
      return this.completed(messages, steps);
    }

    // maxSteps 到达
    this.emit('agent:turn:end', { messages, steps });
    return { messages, steps, status: 'max_steps' };
  }

  // ===== 私有方法 =====

  /**
   * 流式调用 LLM，文本 delta 转发 UI，tool_calls 在内存中累积。
   */
  private async processStream(
    chatRequest: ChatRequest,
    signal: AbortSignal,
  ): Promise<StreamResult> {
    let textContent = '';
    let finishReason = '';
    const accumulator = new ToolCallAccumulator();

    try {
      const stream = this.provider.streamMessage({
        model: chatRequest.model,
        messages: chatRequest.messages,
        tools: chatRequest.tools,
        maxTokens: chatRequest.maxTokens,
        temperature: chatRequest.temperature,
        signal,
      });

      for await (const event of stream) {
        // ===== 检查点 2：流式迭代中 =====
        if (signal.aborted) {
          return { type: 'abort' };
        }

        switch (event.type) {
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
        }
      }

      return {
        type: 'success',
        textContent,
        toolCalls: accumulator.getToolCalls(),
        finishReason,
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { type: 'abort' };
      }
      // 不在此处发射 agent:error，由 run() 中的 errorEnd() 统一发射
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
      this.emit('agent:abort');
      return 'aborted';
    }

    let results;
    try {
      results = await executeAll(toolCalls, this.toolRegistry, signal);
    } catch (err) {
      // 基础设施级异常（非单个工具的业务错误）→ 终止 Turn
      this.emit('agent:error', {
        error: {
          name: (err as Error).name ?? 'Error',
          message: (err as Error).message ?? String(err),
        },
      });
      return 'error' as const;
    }

    for (const result of results) {
      // ===== 检查点 4：每个工具结果处理前 =====
      if (signal.aborted) {
        this.emit('agent:abort');
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

  // ===== 终止辅助方法 =====

  private completed(messages: Message[], steps: number): TurnOutput {
    this.emit('agent:turn:end', { messages, steps });
    return { messages, steps, status: 'completed' };
  }

  private abort(messages: Message[], steps: number): TurnOutput {
    this.emit('agent:abort');
    return { messages, steps, status: 'aborted' };
  }

  private errorEnd(
    messages: Message[],
    steps: number,
    error: Error,
  ): TurnOutput {
    this.emit('agent:error', {
      error: { name: error.name, message: error.message },
    });
    return { messages, steps, status: 'error', error };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private emit(type: string, payload?: any): void {
    this.events.emit(type, payload ?? {});
  }
}
