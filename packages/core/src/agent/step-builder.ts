import type { Message, ToolDefinition, ChatRequest, AgentOptions } from '../types/index.js';
import type { ContextManager, ContextWindowError } from '../types/index.js';
// ContextWindowError 是类型导入（仅用于 catch 判断），class 实例由 context 模块创建
export { ContextWindowError } from '../types/index.js';

/**
 * 将消息历史、工具列表、Agent 配置组装为 LLM API 调用所需的 ChatRequest。
 *
 * 职责：
 * 1. 确保 system prompt 存在
 * 2. 调用 ContextManager.fitToWindow() 裁剪超窗口消息
 * 3. 按名称排序工具定义（保证 DeepSeek Context Caching 前缀稳定）
 * 4. 组装最终的 ChatRequest 对象
 */
export class StepBuilder {
  constructor(private readonly contextManager: ContextManager) {}

  async build(
    messages: Message[],
    tools: ToolDefinition[],
    options: AgentOptions,
    signal: AbortSignal,
  ): Promise<ChatRequest> {
    // 1. 确保 system prompt 存在
    const messagesWithSystem = this.ensureSystemPrompt(
      messages,
      options.systemPrompt,
    );

    // 2. 裁剪超窗口消息（可能触发 LLM 摘要调用）
    const trimResult = await this.contextManager.fitToWindow(
      messagesWithSystem,
      tools,
      {
        completionReserve: options.maxTokens ?? 4096,
        signal,
      },
    );

    // 2a. 记录裁剪日志
    if (trimResult.removedTurns > 0) {
      console.warn(
        `[context] Trimmed ${trimResult.removedTurns} turns ` +
        `(${trimResult.removedMessageCount} messages)` +
        (trimResult.summarized ? ', summarized' : '') +
        (trimResult.warning ? `, warning: ${trimResult.warning}` : ''),
      );
    }

    // 2b. 验证 system 消息未被裁剪修改（prompt caching 关键条件）
    this.validateSystemPrompt(messagesWithSystem, trimResult.messages);

    // 如果裁剪时需要 abort
    if (signal.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }

    // 3. 准备工具定义（排序）
    const preparedTools = this.prepareTools(tools);

    // 4. 组装请求
    return this.assembleRequest(trimResult.messages, preparedTools, options);
  }

  // ===== 私有方法 =====

  /**
   * 确保消息历史中存在 system prompt。
   *
   * 优先级：
   * 1. messages 中已有的 system 消息（第一条 role === 'system'）
   * 2. options.systemPrompt（在前面插入）
   * 3. 都没有则不添加
   */
  private ensureSystemPrompt(
    messages: Message[],
    systemPrompt?: string,
  ): Message[] {
    // 已有 system 消息
    if (messages.length > 0 && messages[0].role === 'system') {
      return messages;
    }

    // 用 options.systemPrompt 插入
    if (systemPrompt) {
      return [{ role: 'system', content: systemPrompt }, ...messages];
    }

    // 都没有，返回原样
    return messages;
  }

  /**
   * 验证 system 消息在 fitToWindow 后未被修改。
   * system 消息变化会导致 prompt caching 前缀不匹配，所有后续请求 cache miss。
   */
  private validateSystemPrompt(
    original: Message[],
    trimmed: Message[],
  ): void {
    if (trimmed.length === 0) return;

    const originalSystem = original[0];
    const trimmedSystem = trimmed[0];

    if (
      originalSystem === trimmedSystem ||
      (originalSystem?.role === 'system' &&
        trimmedSystem?.role === 'system' &&
        originalSystem?.content === trimmedSystem?.content)
    ) {
      return;
    }

    console.warn(
      '[StepBuilder] System prompt was modified or removed during fitToWindow. ' +
        'This will cause prompt cache misses for all subsequent steps in this turn.',
    );
  }

  /**
   * 准备工具定义：按名称排序后返回。
   * 排序确保每次请求中工具定义顺序一致，满足 DeepSeek Context Caching 的前缀匹配要求。
   */
  private prepareTools(
    tools: ToolDefinition[],
  ): ToolDefinition[] | undefined {
    if (tools.length === 0) return undefined;

    return [...tools].sort((a, b) =>
      a.function.name.localeCompare(b.function.name),
    );
  }

  /**
   * 组装最终的 ChatRequest 对象。
   * 只在有值时传入可选字段（temperature、max_tokens、tools）。
   */
  private assembleRequest(
    messages: Message[],
    tools: ToolDefinition[] | undefined,
    options: AgentOptions,
  ): ChatRequest {
    const request: ChatRequest = {
      model: options.model,
      messages,
      stream: true,
    };

    if (tools && tools.length > 0) {
      request.tools = tools;
    }

    if (options.temperature !== undefined) {
      request.temperature = options.temperature;
    }

    if (options.maxTokens !== undefined) {
      request.maxTokens = options.maxTokens;
    }

    return request;
  }
}
