import type { Message, ToolCall, TurnStatus, FinishReason } from '@pure-agent/core';
import type { SessionSettings } from './session-settings.js';
export type { TurnStatus, FinishReason };

/** 一条聊天消息的 UI 展示 */
export interface UIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  thoughtDurationMs?: number;
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

export type ApiKeyStatus = 'configured' | 'required' | 'entering';

export type PickerKind = 'model' | 'effort';

export interface PickerState {
  kind: PickerKind;
}

/** useAgent hook 返回的状态 */
export interface AgentState {
  status: AgentStatus;
  streamingText: string;
  streamingThoughtDurationMs: number | null;
  toolCallNames: string[];
  completedMessages: UIMessage[];
  currentStep: number;
  lastError: string | null;
  lastStatus: TurnStatus | null;
  lastFinishReason: FinishReason | null;
  settings: SessionSettings;
  notice: string | null;
  apiKeyStatus: ApiKeyStatus;
  picker: PickerState | null;
}
