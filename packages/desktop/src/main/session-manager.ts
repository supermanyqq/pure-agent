import type { Message } from '@pure-agent/core';
import type {
  ChatMessage,
  SendMessageInput,
  SessionSnapshot,
  SessionStatus,
  SessionUpdateListener,
  StreamingMessage,
} from '../shared/ipc.js';

const DEFAULT_SESSION_TITLE = '新会话';
const SESSION_ID_PREFIX = 'session';
const MESSAGE_ID_PREFIX = 'message';
const ID_SEPARATOR = '-';
const COUNTER_INCREMENT = 1;
const INITIAL_COUNTER = 0;
const TITLE_MAX_LENGTH = 32;
const TITLE_ELLIPSIS = '…';
const TITLE_WHITESPACE_PATTERN = /\s+/g;
const TITLE_WHITESPACE_REPLACEMENT = ' ';
const EMPTY_CONTENT_ERROR = '消息内容不能为空。';
const SESSION_NOT_FOUND_ERROR = '会话不存在。';
const ACTIVE_SESSION_ERROR = '该会话正在生成回复。';
const ABORTED_SESSION_NOTICE = '回复已停止。';

export interface AgentRunCallbacks {
  onDelta(content: string): void;
  onComplete(messages: Message[]): void;
  onError(error: Error): void;
  onAborted(): void;
}

export interface AgentRunInput {
  sessionId: string;
  messages: Message[];
  signal: AbortSignal;
  callbacks: AgentRunCallbacks;
}

export interface AgentRuntime {
  run(input: AgentRunInput): Promise<void>;
}

interface SessionRecord {
  snapshot: SessionSnapshot;
  coreMessages: Message[];
  completedCoreMessageCount: number;
  abortController: AbortController | null;
}

/** Owns the independent Core history and renderer snapshot for every desktop session. */
export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly listeners = new Set<SessionUpdateListener>();
  private sessionCounter = INITIAL_COUNTER;
  private messageCounter = INITIAL_COUNTER;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly now: () => number = Date.now,
  ) {}

  createSession(): SessionSnapshot {
    const timestamp = this.now();
    const snapshot: SessionSnapshot = {
      id: this.nextSessionId(),
      title: DEFAULT_SESSION_TITLE,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'idle',
      messages: [],
      streamingMessage: null,
      errorMessage: null,
    };
    this.sessions.set(snapshot.id, {
      snapshot,
      coreMessages: [],
      completedCoreMessageCount: INITIAL_COUNTER,
      abortController: null,
    });
    this.notify(snapshot);
    return copySnapshot(snapshot);
  }

  listSessions(): SessionSnapshot[] {
    return [...this.sessions.values()]
      .map(({ snapshot }) => copySnapshot(snapshot))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  getSession(sessionId: string): SessionSnapshot | undefined {
    const record = this.sessions.get(sessionId);
    return record ? copySnapshot(record.snapshot) : undefined;
  }

  subscribe(listener: SessionUpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sendMessage(input: SendMessageInput): Promise<void> {
    const content = input.content.trim();
    if (!content) throw new Error(EMPTY_CONTENT_ERROR);

    const record = this.getRecord(input.sessionId);
    if (record.abortController) throw new Error(ACTIVE_SESSION_ERROR);

    const coreMessage: Message = { role: 'user', content };
    record.coreMessages.push(coreMessage);
    record.completedCoreMessageCount += COUNTER_INCREMENT;
    record.snapshot.messages.push(this.createChatMessage('user', content));
    if (record.snapshot.title === DEFAULT_SESSION_TITLE) {
      record.snapshot.title = createSessionTitle(content);
    }
    record.snapshot.status = 'thinking';
    record.snapshot.streamingMessage = null;
    record.snapshot.errorMessage = null;
    record.snapshot.updatedAt = this.now();

    const abortController = new AbortController();
    record.abortController = abortController;
    this.notify(record.snapshot);

    const callbacks = this.createCallbacks(record, abortController);
    try {
      await this.runtime.run({
        sessionId: input.sessionId,
        messages: record.coreMessages,
        signal: abortController.signal,
        callbacks,
      });
    } catch (error: unknown) {
      if (!abortController.signal.aborted) {
        callbacks.onError(toError(error));
      }
    }
  }

  stopSession(sessionId: string): void {
    this.getRecord(sessionId).abortController?.abort();
  }

  private createCallbacks(record: SessionRecord, abortController: AbortController): AgentRunCallbacks {
    return {
      onDelta: (content) => {
        if (!this.isCurrentRun(record, abortController) || !content) return;
        const streamingMessage = record.snapshot.streamingMessage ?? this.createStreamingMessage();
        streamingMessage.content += content;
        record.snapshot.streamingMessage = streamingMessage;
        record.snapshot.status = 'streaming';
        record.snapshot.updatedAt = this.now();
        this.notify(record.snapshot);
      },
      onComplete: (messages) => {
        if (!this.isCurrentRun(record, abortController)) return;
        const newCoreMessages = messages.slice(record.completedCoreMessageCount);
        record.coreMessages = [...messages];
        record.completedCoreMessageCount = messages.length;
        record.snapshot.messages.push(...toChatMessages(newCoreMessages, () => this.createChatMessageId()));
        record.snapshot.status = 'idle';
        record.snapshot.streamingMessage = null;
        record.snapshot.errorMessage = null;
        record.snapshot.updatedAt = this.now();
        record.abortController = null;
        this.notify(record.snapshot);
      },
      onError: (error) => {
        if (!this.isCurrentRun(record, abortController)) return;
        record.snapshot.status = 'error';
        record.snapshot.streamingMessage = null;
        record.snapshot.errorMessage = error.message;
        record.snapshot.updatedAt = this.now();
        record.abortController = null;
        this.notify(record.snapshot);
      },
      onAborted: () => {
        if (!this.isCurrentRun(record, abortController)) return;
        record.snapshot.status = 'idle';
        record.snapshot.streamingMessage = null;
        record.snapshot.errorMessage = ABORTED_SESSION_NOTICE;
        record.snapshot.updatedAt = this.now();
        record.abortController = null;
        this.notify(record.snapshot);
      },
    };
  }

  private getRecord(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(SESSION_NOT_FOUND_ERROR);
    return record;
  }

  private isCurrentRun(record: SessionRecord, abortController: AbortController): boolean {
    return record.abortController === abortController;
  }

  private createChatMessage(role: ChatMessage['role'], content: string): ChatMessage {
    return {
      id: this.createChatMessageId(),
      role,
      content,
      createdAt: this.now(),
    };
  }

  private createChatMessageId(): string {
    this.messageCounter += COUNTER_INCREMENT;
    return `${MESSAGE_ID_PREFIX}${ID_SEPARATOR}${this.messageCounter}`;
  }

  private createStreamingMessage(): StreamingMessage {
    return { id: this.createChatMessageId(), content: '' };
  }

  private nextSessionId(): string {
    this.sessionCounter += COUNTER_INCREMENT;
    return `${SESSION_ID_PREFIX}${ID_SEPARATOR}${this.sessionCounter}`;
  }

  private notify(snapshot: SessionSnapshot): void {
    const update = copySnapshot(snapshot);
    for (const listener of this.listeners) {
      listener(update);
    }
  }
}

function createSessionTitle(content: string): string {
  const normalized = content.replace(TITLE_WHITESPACE_PATTERN, TITLE_WHITESPACE_REPLACEMENT);
  if (normalized.length <= TITLE_MAX_LENGTH) return normalized;
  return `${normalized.slice(INITIAL_COUNTER, TITLE_MAX_LENGTH)}${TITLE_ELLIPSIS}`;
}

function toChatMessages(
  messages: Message[],
  createId: () => string,
): ChatMessage[] {
  return messages.flatMap<ChatMessage>((message) => {
    if (message.role === 'user') {
      return [{ id: createId(), role: 'user' as const, content: message.content, createdAt: Date.now() }];
    }
    if (message.role === 'assistant' && typeof message.content === 'string' && message.content) {
      return [{ id: createId(), role: 'assistant' as const, content: message.content, createdAt: Date.now() }];
    }
    return [];
  });
}

function copySnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return {
    ...snapshot,
    messages: snapshot.messages.map((message) => ({ ...message })),
    streamingMessage: snapshot.streamingMessage ? { ...snapshot.streamingMessage } : null,
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
