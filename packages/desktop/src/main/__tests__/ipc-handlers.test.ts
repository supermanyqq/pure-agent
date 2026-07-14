import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type SessionSnapshot } from '../../shared/ipc.js';
import {
  registerIpcHandlers,
  type IpcHandler,
  type IpcHandlerRegistrar,
} from '../ipc-handlers.js';
import { SessionManager, type AgentRunInput, type AgentRuntime } from '../session-manager.js';

const SESSION_ID = 'session-1';
const USER_CONTENT = 'hello';
const RESPONSE_CONTENT = 'reply:hello';

class ImmediateRuntime implements AgentRuntime {
  async run(input: AgentRunInput): Promise<void> {
    input.callbacks.onComplete([
      ...input.messages,
      { role: 'assistant', content: RESPONSE_CONTENT },
    ]);
  }
}

function createRegistrar(): { registrar: IpcHandlerRegistrar; handlers: Map<string, IpcHandler> } {
  const handlers = new Map<string, IpcHandler>();
  return {
    registrar: {
      handle(channel, handler): void {
        handlers.set(channel, handler);
      },
    },
    handlers,
  };
}

function getHandler(handlers: Map<string, IpcHandler>, channel: string): IpcHandler {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Expected ${channel} to be registered`);
  return handler;
}

describe('registerIpcHandlers', () => {
  it('forwards a manager update to the renderer update channel', async () => {
    const manager = new SessionManager(new ImmediateRuntime());
    const { registrar, handlers } = createRegistrar();
    const sendUpdate = vi.fn<(channel: string, snapshot: SessionSnapshot) => void>();

    registerIpcHandlers(registrar, manager, { send: sendUpdate });
    const createSession = getHandler(handlers, IPC_CHANNELS.createSession);
    const created = await createSession(undefined);

    expect(sendUpdate).toHaveBeenCalledWith(IPC_CHANNELS.sessionUpdated, created);
    expect(getHandler(handlers, IPC_CHANNELS.listSessions)(undefined)).toEqual([created]);
  });

  it('passes a renderer message to the matching session', async () => {
    const manager = new SessionManager(new ImmediateRuntime());
    const { registrar, handlers } = createRegistrar();

    registerIpcHandlers(registrar, manager, { send: vi.fn() });
    const created = await getHandler(handlers, IPC_CHANNELS.createSession)(undefined);
    await getHandler(handlers, IPC_CHANNELS.sendMessage)(undefined, {
      sessionId: created.id,
      content: USER_CONTENT,
    });

    expect(manager.getSession(SESSION_ID)?.messages.map(({ content }) => content))
      .toEqual([USER_CONTENT, RESPONSE_CONTENT]);
  });
});
