import { describe, expect, it } from 'vitest';
import type { Message } from '@pure-agent/core';
import {
  SessionManager,
  type AgentRunInput,
  type AgentRuntime,
} from '../session-manager.js';

class ImmediateRuntime implements AgentRuntime {
  readonly calls: AgentRunInput[] = [];

  async run(input: AgentRunInput): Promise<void> {
    this.calls.push({ ...input, messages: [...input.messages] });
    const latestMessage = input.messages.at(-1);
    const latestUserContent = latestMessage?.role === 'user' ? latestMessage.content : '';
    const reply = `reply:${latestUserContent}`;
    input.callbacks.onDelta('reply:');
    input.callbacks.onDelta(latestUserContent);
    input.callbacks.onComplete([
      ...input.messages,
      { role: 'assistant', content: reply },
    ]);
  }
}

class ControlledRuntime implements AgentRuntime {
  latestInput: AgentRunInput | null = null;
  private completeRun: (() => void) | null = null;

  run(input: AgentRunInput): Promise<void> {
    this.latestInput = input;
    return new Promise((resolve) => {
      this.completeRun = resolve;
    });
  }

  delta(content: string): void {
    this.latestInput?.callbacks.onDelta(content);
  }

  complete(content: string): void {
    const input = this.latestInput;
    if (!input) throw new Error('Expected a pending Agent run');
    const messages: Message[] = [
      ...input.messages,
      { role: 'assistant', content },
    ];
    input.callbacks.onComplete(messages);
    this.completeRun?.();
  }

  abort(): void {
    this.latestInput?.callbacks.onAborted();
    this.completeRun?.();
  }
}

describe('SessionManager', () => {
  it('keeps each session history independent across a switch', async () => {
    const runtime = new ImmediateRuntime();
    const manager = new SessionManager(runtime);
    const first = manager.createSession();
    const second = manager.createSession();

    await manager.sendMessage({ sessionId: first.id, content: 'first prompt' });
    await manager.sendMessage({ sessionId: second.id, content: 'second prompt' });

    expect(manager.getSession(first.id)?.messages.map(({ content }) => content))
      .toEqual(['first prompt', 'reply:first prompt']);
    expect(manager.getSession(second.id)?.messages.map(({ content }) => content))
      .toEqual(['second prompt', 'reply:second prompt']);
  });

  it('passes completed history to the next turn', async () => {
    const runtime = new ImmediateRuntime();
    const manager = new SessionManager(runtime);
    const session = manager.createSession();

    await manager.sendMessage({ sessionId: session.id, content: 'one' });
    await manager.sendMessage({ sessionId: session.id, content: 'two' });

    expect(runtime.calls[1]?.messages.map(({ content }) => content))
      .toEqual(['one', 'reply:one', 'two']);
  });

  it('accumulates deltas into one pending assistant message', async () => {
    const runtime = new ControlledRuntime();
    const manager = new SessionManager(runtime);
    const session = manager.createSession();
    const run = manager.sendMessage({ sessionId: session.id, content: 'stream this' });

    runtime.delta('he');
    runtime.delta('llo');

    expect(manager.getSession(session.id)?.streamingMessage).toMatchObject({ content: 'hello' });
    runtime.complete('hello');
    await run;

    expect(manager.getSession(session.id)).toMatchObject({
      status: 'idle',
      streamingMessage: null,
    });
    expect(manager.getSession(session.id)?.messages.map(({ content }) => content))
      .toEqual(['stream this', 'hello']);
  });

  it('stops only the requested session run', async () => {
    const runtime = new ControlledRuntime();
    const manager = new SessionManager(runtime);
    const first = manager.createSession();
    const second = manager.createSession();
    const run = manager.sendMessage({ sessionId: first.id, content: 'stop this' });

    manager.stopSession(second.id);
    expect(runtime.latestInput?.signal.aborted).toBe(false);

    manager.stopSession(first.id);
    expect(runtime.latestInput?.signal.aborted).toBe(true);
    runtime.abort();
    await run;
  });
});
