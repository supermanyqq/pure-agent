// ===== 消息类型 =====

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string };

// ===== 工具调用（OpenAI 兼容格式）=====

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON 字符串
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema 对象
  };
}

// ===== 工具执行结果 =====

export interface ToolResult {
  toolCallId: string;
  content: string;
  error?: string;
}

// ===== Agent 状态 =====

export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'executing'
  | 'stopped'
  | 'error';

// ===== Agent 配置 =====

export interface AgentOptions {
  model: string;
  maxSteps: number;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

// ===== Turn 输出 =====

export interface TurnOutput {
  messages: Message[];
  steps: number;
  status: 'completed' | 'max_steps' | 'aborted' | 'error';
  error?: Error;
}

// ===== 请求构造 =====

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stream: true;
}

// ===== 外部接口（Agent Loop 依赖的抽象） =====

// StreamEvent 定义在此而非 provider/deepseek-client，避免 types → provider 循环依赖
// Provider 层实现此类型，AgentLoop 消费此类型
export type StreamEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; arguments: string }
  | { type: 'done'; finishReason: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } };

export interface ChatProvider {
  streamMessage(params: {
    model?: string;
    messages: Message[];
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  }): AsyncGenerator<StreamEvent>;
}

export interface ToolRegistry {
  execute(name: string, args: Record<string, unknown>): Promise<string>;
  getDefinitions(): ToolDefinition[];
}

export interface ContextManager {
  fitToWindow(
    messages: Message[],
    tools: ToolDefinition[],
    options?: TrimOptions,
  ): Promise<TrimResult>;
  estimateTokens(messages: Message[], tools?: ToolDefinition[]): number;
  getCompressionStats(): CompressionStats;
  /** 重置所有 per-session 压缩状态（/new, /reset, session end） */
  reset(): void;
  /** 模型切换时更新配置并清除模型相关的追踪状态 */
  updateModel(model: string, contextLength: number): void;
}

export interface AgentEventEmitter {
  emit(type: string, payload?: Record<string, unknown>): void;
}

// ===== Context Management 类型 =====

/** fitToWindow 的返回结果 */
export interface TrimResult {
  messages: Message[];
  removedTurns: number;
  removedMessageCount: number;
  summarized: boolean;
  summary?: string;
  estimatedTokens: number;
  tokensSaved: number;
  /** 压缩结果状态码 */
  status: TrimStatus;
  /** 面向用户或日志的警告信息 */
  warning?: string;
}

export type TrimStatus =
  | 'unchanged'
  | 'pruned_only'
  | 'summarized'
  | 'fallback_summary'
  | 'skipped_thrashing'
  | 'aborted_auth_error'
  | 'aborted_network_error';

/** fitToWindow 的调用选项（每次调用可覆盖） */
export interface TrimOptions {
  completionReserve?: number;
  enableSummarization?: boolean;
  signal?: AbortSignal;
  focusTopic?: string;
  force?: boolean;
}

/** 压缩统计（供外部读取，不包含敏感信息） */
export interface CompressionStats {
  compressionCount: number;
  lastSavingsPercent: number;
  ineffectiveCompressionCount: number;
  lastCompressAborted: boolean;
  summaryInCooldown: boolean;
}

/** 摘要器接口（由应用层注入 Provider 实现） */
export interface Summarizer {
  summarize(messages: Message[], signal?: AbortSignal): Promise<string>;
}

/** 上下文窗口超限错误 */
export class ContextWindowError extends Error {
  constructor(
    message: string,
    public readonly currentTokens: number,
    public readonly windowSize: number,
  ) {
    super(message);
    this.name = 'ContextWindowError';
  }
}
