import type { Message, ToolCall, TurnStatus, FinishReason } from '@pure-agent/core';
export type { TurnStatus, FinishReason };

/** 一条聊天消息的 UI 展示 */
export interface UIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** 如果是工具调用，展示工具名 */
  toolCallNames?: string[];
}

/** Agent 当前状态 */
export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'executing'
  | 'error';

/** useAgent hook 返回的状态 */
export interface AgentState {
  status: AgentStatus;
  streamingText: string;
  toolCallNames: string[];
  completedMessages: UIMessage[];
  currentStep: number;
  lastError: string | null;
  lastStatus: TurnStatus | null;
  lastFinishReason: FinishReason | null;
}
