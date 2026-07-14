import { describe, expect, it, vi } from 'vitest';
import type { AgentEventEmitter, AgentOptions, Message, TurnOutput } from '@pure-agent/core';
import {
  CoreAgentRuntime,
  type SessionAgent,
} from '../core-agent-runtime.js';
import type { AgentRunCallbacks } from '../session-manager.js';

const SESSION_ID = 'session-1';
const SECOND_SESSION_ID = 'session-2';
const USER_CONTENT = 'hello';
const DELTA_CONTENT = 'hel';
const RESPONSE_CONTENT = 'hello';
const STEP_COUNT = 1;
const MAX_STEPS = 10;
const MAX_TOKENS = 4_096;
const TEMPERATURE = 0;

const INITIAL_MESSAGES: Message[] = [{ role: 'user', content: USER_CONTENT }];

const AGENT_OPTIONS: AgentOptions = {
  model: 'deepseek-v4-pro',
  maxSteps: MAX_STEPS,
  maxTokens: MAX_TOKENS,
  temperature: TEMPERATURE,
};

function createCallbacks(): AgentRunCallbacks {
  return {
    onDelta: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    onAborted: vi.fn(),
  };
}

function createSessionAgent(events: AgentEventEmitter): SessionAgent {
  return {
    options: AGENT_OPTIONS,
    loop: {
      async run(messages): Promise<TurnOutput> {
        const completedMessages: Message[] = [
          ...messages,
          { role: 'assistant', content: RESPONSE_CONTENT },
        ];
        events.emit('agent:stream:delta', { content: DELTA_CONTENT });
        events.emit('agent:turn:end', {
          messages: completedMessages,
          steps: STEP_COUNT,
          status: 'completed',
          finishReason: 'stop',
        });
        return {
          messages: completedMessages,
          steps: STEP_COUNT,
          status: 'completed',
          finishReason: 'stop',
        };
      },
    },
  };
}

describe('CoreAgentRuntime', () => {
  it('forwards Core deltas and completed history to the active session callbacks', async () => {
    const runtime = new CoreAgentRuntime({
      createSessionAgent: (_sessionId, events) => createSessionAgent(events),
    });
    const callbacks = createCallbacks();

    await runtime.run({
      sessionId: SESSION_ID,
      messages: INITIAL_MESSAGES,
      signal: new AbortController().signal,
      callbacks,
    });

    expect(callbacks.onDelta).toHaveBeenCalledWith(DELTA_CONTENT);
    expect(callbacks.onComplete).toHaveBeenCalledWith([
      ...INITIAL_MESSAGES,
      { role: 'assistant', content: RESPONSE_CONTENT },
    ]);
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it('creates one loop per session and reuses it for later turns', async () => {
    const createSessionAgentSpy = vi.fn(
      (_sessionId: string, events: AgentEventEmitter) => createSessionAgent(events),
    );
    const runtime = new CoreAgentRuntime({ createSessionAgent: createSessionAgentSpy });
    const controller = new AbortController();

    await runtime.run({
      sessionId: SESSION_ID,
      messages: INITIAL_MESSAGES,
      signal: controller.signal,
      callbacks: createCallbacks(),
    });
    await runtime.run({
      sessionId: SESSION_ID,
      messages: INITIAL_MESSAGES,
      signal: controller.signal,
      callbacks: createCallbacks(),
    });
    await runtime.run({
      sessionId: SECOND_SESSION_ID,
      messages: INITIAL_MESSAGES,
      signal: controller.signal,
      callbacks: createCallbacks(),
    });

    expect(createSessionAgentSpy).toHaveBeenCalledTimes(2);
  });
});
