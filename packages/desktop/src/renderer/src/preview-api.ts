import type {
  ChatMessage,
  ConversationRole,
  DesktopAPI,
  SendMessageInput,
  SessionSnapshot,
  SessionUpdateListener,
} from '../../shared/ipc.js';

const PREVIEW_SESSION_ID_PREFIX = 'preview-session';
const PREVIEW_MESSAGE_ID_PREFIX = 'preview-message';
const ID_SEPARATOR = '-';
const COUNTER_INCREMENT = 1;
const INITIAL_COUNTER = 0;
const PREVIEW_SESSION_TITLE = '界面预览';
const PREVIEW_REPLY = '### 已收到\n\n这是独立 Renderer 预览使用的示例 Markdown。真实 Electron 窗口会通过 **Pure Agent Core** 进行流式回复。\n\n```ts\nawait agent.run(history)\n```';
const PREVIEW_SESSION_ERROR = '预览会话不存在。';
const DEVELOPMENT_SERVER_PROTOCOL = 'http:';
const ELECTRON_USER_AGENT_TOKEN = 'Electron';
const IPC_UNAVAILABLE_ERROR = 'Desktop IPC bridge is unavailable.';

let previewAPI: DesktopAPI | null = null;

/** Returns the secure Electron bridge, or a development-only in-memory preview transport. */
export function getDesktopApi(): DesktopAPI {
  if (window.desktopAPI) return window.desktopAPI;
  if (window.navigator.userAgent.includes(ELECTRON_USER_AGENT_TOKEN)) {
    throw new Error(IPC_UNAVAILABLE_ERROR);
  }
  if (window.location.protocol !== DEVELOPMENT_SERVER_PROTOCOL) {
    throw new Error(IPC_UNAVAILABLE_ERROR);
  }
  previewAPI ??= createPreviewDesktopApi();
  return previewAPI;
}

/** Creates a local-only API for visual renderer development when no Electron preload exists. */
export function createPreviewDesktopApi(): DesktopAPI {
  const sessions = new Map<string, SessionSnapshot>();
  const listeners = new Set<SessionUpdateListener>();
  let sessionCounter = INITIAL_COUNTER;
  let messageCounter = INITIAL_COUNTER;

  function createMessage(role: ConversationRole, content: string): ChatMessage {
    messageCounter += COUNTER_INCREMENT;
    return {
      id: `${PREVIEW_MESSAGE_ID_PREFIX}${ID_SEPARATOR}${messageCounter}`,
      role,
      content,
      createdAt: Date.now(),
    };
  }

  function notify(session: SessionSnapshot): void {
    const update = copySession(session);
    for (const listener of listeners) {
      listener(update);
    }
  }

  function getSession(sessionId: string): SessionSnapshot {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(PREVIEW_SESSION_ERROR);
    return session;
  }

  return {
    async listSessions(): Promise<SessionSnapshot[]> {
      return [...sessions.values()].map(copySession);
    },
    async createSession(): Promise<SessionSnapshot> {
      sessionCounter += COUNTER_INCREMENT;
      const timestamp = Date.now();
      const session: SessionSnapshot = {
        id: `${PREVIEW_SESSION_ID_PREFIX}${ID_SEPARATOR}${sessionCounter}`,
        title: PREVIEW_SESSION_TITLE,
        createdAt: timestamp,
        updatedAt: timestamp,
        status: 'idle',
        messages: [],
        streamingMessage: null,
        errorMessage: null,
      };
      sessions.set(session.id, session);
      notify(session);
      return copySession(session);
    },
    async sendMessage(input: SendMessageInput): Promise<void> {
      const session = getSession(input.sessionId);
      session.messages.push(createMessage('user', input.content));
      session.status = 'thinking';
      session.updatedAt = Date.now();
      notify(session);

      session.status = 'streaming';
      session.streamingMessage = createMessage('assistant', PREVIEW_REPLY);
      session.updatedAt = Date.now();
      notify(session);

      session.messages.push(createMessage('assistant', PREVIEW_REPLY));
      session.streamingMessage = null;
      session.status = 'idle';
      session.updatedAt = Date.now();
      notify(session);
    },
    async stopSession(sessionId: string): Promise<void> {
      const session = getSession(sessionId);
      session.streamingMessage = null;
      session.status = 'idle';
      session.updatedAt = Date.now();
      notify(session);
    },
    onSessionUpdated(listener: SessionUpdateListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function copySession(session: SessionSnapshot): SessionSnapshot {
  return {
    ...session,
    messages: session.messages.map((message) => ({ ...message })),
    streamingMessage: session.streamingMessage ? { ...session.streamingMessage } : null,
  };
}
