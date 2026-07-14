import {
  IPC_CHANNELS,
  type SendMessageInput,
  type SessionSnapshot,
  type SessionUpdateListener,
} from '../shared/ipc.js';

const INVALID_MESSAGE_INPUT_ERROR = '消息请求格式无效。';
const INVALID_SESSION_ID_ERROR = '会话标识无效。';

export type IpcHandler = (event: unknown, input?: unknown) => unknown | Promise<unknown>;

export interface IpcHandlerRegistrar {
  handle(channel: string, handler: IpcHandler): void;
}

export interface SessionUpdateSender {
  send(channel: string, snapshot: SessionSnapshot): void;
}

export interface DesktopSessionService {
  createSession(): SessionSnapshot;
  listSessions(): SessionSnapshot[];
  sendMessage(input: SendMessageInput): Promise<void>;
  stopSession(sessionId: string): void;
  subscribe(listener: SessionUpdateListener): () => void;
}

/** Registers the small, validated IPC surface that the renderer can invoke. */
export function registerIpcHandlers(
  registrar: IpcHandlerRegistrar,
  sessions: DesktopSessionService,
  updates: SessionUpdateSender,
): () => void {
  registrar.handle(IPC_CHANNELS.listSessions, () => sessions.listSessions());
  registrar.handle(IPC_CHANNELS.createSession, () => sessions.createSession());
  registrar.handle(IPC_CHANNELS.sendMessage, (_event, input) => {
    if (!isSendMessageInput(input)) throw new Error(INVALID_MESSAGE_INPUT_ERROR);
    return sessions.sendMessage(input);
  });
  registrar.handle(IPC_CHANNELS.stopSession, (_event, input) => {
    if (typeof input !== 'string') throw new Error(INVALID_SESSION_ID_ERROR);
    sessions.stopSession(input);
  });

  return sessions.subscribe((snapshot) => {
    updates.send(IPC_CHANNELS.sessionUpdated, snapshot);
  });
}

function isSendMessageInput(value: unknown): value is SendMessageInput {
  if (!isRecord(value)) return false;
  return typeof value.sessionId === 'string' && typeof value.content === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
