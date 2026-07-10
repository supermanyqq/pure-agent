// ===== 共享 Provider 类型（避免循环依赖） =====

export type FinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter'
  | 'insufficient_system_resource';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ===== 消息类型 =====

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      reasoningContent?: string;
      toolCalls?: ToolCall[];
    }
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
  [key: string]: unknown;
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

export type TurnStatus =
  | 'completed'
  | 'max_steps'
  | 'aborted'
  | 'truncated'
  | 'content_filtered'
  | 'error';

export interface TurnOutput {
  messages: Message[];
  steps: number;
  status: TurnStatus;
  error?: Error;
  finishReason?: FinishReason;
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
  | { type: 'reasoning'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; arguments: string }
  | { type: 'done'; finishReason: FinishReason; usage?: TokenUsage }
  | { type: 'aborted' };

export interface ChatProvider {
  streamMessage(params: {
    model?: string;
    messages: Message[];
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    timeout?: number;
    maxRetries?: number;
    thinking?: { type: 'enabled' | 'disabled' };
    reasoningEffort?: 'high' | 'max';
  }): AsyncGenerator<StreamEvent>;
}

export interface ToolRegistry {
  execute(name: string, args: Record<string, unknown>): Promise<string>;
  getDefinitions(): ToolDefinition[];
  register(tool: Tool): void;
  unregister(name: string): void;
}

/** 完整的工具定义（definition + execute），用于注册 */
export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<string>;
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

export interface AgentEventMap {
  'agent:turn:start': { messages: Message[] };
  'agent:step:start': { step: number };
  'agent:thinking': { step: number };
  'agent:stream:delta': { content: string };
  'agent:tool_calls': { toolCalls: ToolCall[] };
  'agent:executing': { toolCalls: ToolCall[] };
  'agent:tool_result': ToolResult;
  'agent:response': { content: string };
  'agent:abort': Record<string, never>;
  'agent:error': { error: Error };
  'agent:turn:end': {
    messages: Message[];
    steps: number;
    status: TurnStatus;
    finishReason?: FinishReason;
  };
}

export interface AgentEventEmitter {
  emit<K extends keyof AgentEventMap>(
    type: K,
    payload: AgentEventMap[K],
  ): void;
}

// ===== Context Management 类型 =====

export type TrimSuccessStatus =
  | 'unchanged'
  | 'pruned_only'
  | 'summarized'
  | 'fallback_summary';

export type TrimFailureStatus =
  | 'compression_busy'
  | 'skipped_thrashing'
  | 'aborted_auth_error'
  | 'aborted_network_error'
  | 'uncompressible';

interface TrimBase {
  messages: Message[];
  removedTurns: number;
  removedMessageCount: number;
  summarized: boolean;
  summary?: string;
  estimatedTokens: number;
  effectiveWindow: number;
  tokensSaved: number;
  warning?: string;
}

/** fitToWindow 的返回结果 — 可判别联合类型 */
export type TrimResult =
  | (TrimBase & { ok: true; status: TrimSuccessStatus })
  | (TrimBase & {
      ok: false;
      status: TrimFailureStatus;
      reason: string;
    });

// 保留 TrimStatus 联合类型以保持向后兼容
export type TrimStatus = TrimSuccessStatus | TrimFailureStatus;

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
  summarize(messages: Message[], options: SummarizeOptions): Promise<SummaryResult>;
}

/** 摘要结果 — body 为未格式化正文，不含前缀/后缀标记 */
export interface SummaryResult {
  body: string;
  method: 'llm' | 'fallback';
  usage?: TokenUsage;
}

/** 摘要选项 */
export interface SummarizeOptions {
  previousSummary?: string;
  summaryBudget?: number;
  signal?: AbortSignal;
  focusTopic?: string;
  model?: string;
  maxSummaryTokens?: number;
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
