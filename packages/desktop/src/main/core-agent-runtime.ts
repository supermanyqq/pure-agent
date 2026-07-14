import {
  AgentLoop,
  createContextManager,
  createDeepSeekClient,
  createEmptyToolRegistry,
  DEFAULT_SYSTEM_PROMPT,
  formatSystemPrompt,
  loadProviderConfig,
} from '@pure-agent/core';
import type {
  AgentEventEmitter,
  AgentEventMap,
  AgentOptions,
  Message,
  TurnOutput,
} from '@pure-agent/core';
import type {
  AgentRunCallbacks,
  AgentRunInput,
  AgentRuntime,
} from './session-manager.js';

const DEFAULT_MAX_STEPS = 10;

export interface AgentLoopRunner {
  run(messages: Message[], options: AgentOptions, signal: AbortSignal): Promise<TurnOutput>;
}

export interface SessionAgent {
  loop: AgentLoopRunner;
  options: AgentOptions;
}

export type SessionAgentFactory = (
  sessionId: string,
  events: AgentEventEmitter,
) => SessionAgent;

export interface CoreAgentRuntimeOptions {
  createSessionAgent?: SessionAgentFactory;
}

/** Bridges one Core AgentLoop per session to the desktop session runtime contract. */
export class CoreAgentRuntime implements AgentRuntime {
  private readonly agents = new Map<string, SessionAgent>();
  private readonly callbacks = new Map<string, AgentRunCallbacks>();
  private readonly createSessionAgent: SessionAgentFactory;

  constructor(options: CoreAgentRuntimeOptions = {}) {
    this.createSessionAgent = options.createSessionAgent ?? createDefaultSessionAgent;
  }

  async run(input: AgentRunInput): Promise<void> {
    this.callbacks.set(input.sessionId, input.callbacks);
    try {
      const agent = this.getSessionAgent(input.sessionId);
      await agent.loop.run(input.messages, agent.options, input.signal);
    } finally {
      this.callbacks.delete(input.sessionId);
    }
  }

  private getSessionAgent(sessionId: string): SessionAgent {
    const existingAgent = this.agents.get(sessionId);
    if (existingAgent) return existingAgent;

    const events = this.createEventEmitter(sessionId);
    const nextAgent = this.createSessionAgent(sessionId, events);
    this.agents.set(sessionId, nextAgent);
    return nextAgent;
  }

  private createEventEmitter(sessionId: string): AgentEventEmitter {
    return {
      emit: <K extends keyof AgentEventMap>(type: K, payload: AgentEventMap[K]): void => {
        const callbacks = this.callbacks.get(sessionId);
        if (!callbacks) return;

        switch (type) {
          case 'agent:stream:delta':
            callbacks.onDelta((payload as AgentEventMap['agent:stream:delta']).content);
            return;
          case 'agent:error':
            callbacks.onError((payload as AgentEventMap['agent:error']).error);
            return;
          case 'agent:abort':
            callbacks.onAborted();
            return;
          case 'agent:turn:end': {
            const turnEnd = payload as AgentEventMap['agent:turn:end'];
            if (turnEnd.status !== 'error' && turnEnd.status !== 'aborted') {
              callbacks.onComplete(turnEnd.messages);
            }
            return;
          }
          case 'agent:turn:start':
          case 'agent:step:start':
          case 'agent:thinking':
          case 'agent:tool_calls':
          case 'agent:executing':
          case 'agent:tool_result':
          case 'agent:response':
            return;
        }
      },
    };
  }
}

function createDefaultSessionAgent(_sessionId: string, events: AgentEventEmitter): SessionAgent {
  const config = loadProviderConfig();
  const provider = createDeepSeekClient(config);
  return {
    loop: new AgentLoop(
      provider,
      createEmptyToolRegistry(),
      createContextManager(),
      events,
    ),
    options: {
      model: config.defaultModel,
      maxSteps: DEFAULT_MAX_STEPS,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      systemPrompt: formatSystemPrompt(DEFAULT_SYSTEM_PROMPT),
    },
  };
}
