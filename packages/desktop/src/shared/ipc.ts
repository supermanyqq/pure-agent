export const DESKTOP_API_VERSION = 1;

export const IPC_CHANNELS = {
  createSession: 'desktop:create-session',
  listSessions: 'desktop:list-sessions',
  sendMessage: 'desktop:send-message',
  stopSession: 'desktop:stop-session',
  sessionUpdated: 'desktop:session-updated',
} as const;

export type ConversationRole = 'user' | 'assistant';

export type SessionStatus = 'idle' | 'thinking' | 'reasoning' | 'streaming' | 'error';

export interface ChatMessage {
  id: string;
  role: ConversationRole;
  content: string;
  reasoningContent?: string;
  createdAt: number;
}

export interface StreamingMessage {
  id: string;
  content: string;
  reasoningContent?: string;
}

export interface SessionSnapshot {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  messages: ChatMessage[];
  streamingMessage: StreamingMessage | null;
  errorMessage: string | null;
}

export interface SendMessageInput {
  sessionId: string;
  content: string;
}

export type SessionUpdateListener = (session: SessionSnapshot) => void;

export interface DesktopAPI {
  listSessions(): Promise<SessionSnapshot[]>;
  createSession(): Promise<SessionSnapshot>;
  sendMessage(input: SendMessageInput): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  onSessionUpdated(listener: SessionUpdateListener): () => void;
}

declare global {
  interface Window {
    desktopAPI: DesktopAPI;
  }
}
