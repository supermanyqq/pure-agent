import { useState, useRef, useEffect, useCallback } from 'react';
import type { AgentEventMap, AgentOptions, FinishReason, Message } from '@pure-agent/core';
import {
  AgentLoop,
  createContextManager,
  createDeepSeekClient,
  createEmptyToolRegistry,
  DEFAULT_SYSTEM_PROMPT,
  formatSystemPrompt,
  loadCliConfig,
  loadProviderConfig,
} from '@pure-agent/core';
import { applySlashCommand } from '../commands/handlers.js';
import { parseInput } from '../commands/parser.js';
import {
  createSessionSettings,
  toReasoningOptions,
} from '../session-settings.js';
import type { SessionSettings } from '../session-settings.js';
import { getNewTurnMessages } from '../turn-messages.js';
import type { AgentState, UIMessage } from '../types.js';

const INITIAL_MESSAGE_ID_COUNTER = 0;
const DEFAULT_MODEL = 'deepseek-v4-pro';
const DEFAULT_MAX_STEPS = 10;
const DEFAULT_MAX_TOKENS = 4_096;
const DEFAULT_TEMPERATURE = 0;

let messageIdCounter = INITIAL_MESSAGE_ID_COUNTER;

function nextId(): string {
  messageIdCounter += 1;
  return `msg-${messageIdCounter}`;
}

function messageToUI(message: Message): UIMessage {
  const content = typeof message.content === 'string' ? message.content : '';
  const toolCallNames =
    message.role === 'assistant' && 'toolCalls' in message && message.toolCalls
      ? message.toolCalls.map((toolCall) => toolCall.function.name)
      : undefined;
  return { id: nextId(), role: message.role, content, toolCallNames };
}

export interface UseAgentOptions {
  model?: string;
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export interface UseAgentReturn {
  state: AgentState;
  submit: (input: string) => Promise<void>;
  reset: () => void;
  abort: () => void;
}

function createInitialSettings(options: UseAgentOptions): SessionSettings {
  const cliConfig = loadCliConfig();
  try {
    const providerConfig = loadProviderConfig();
    return createSessionSettings(
      options.model ?? providerConfig.defaultModel,
      cliConfig.defaultEffort,
    );
  } catch {
    return createSessionSettings(options.model ?? DEFAULT_MODEL, cliConfig.defaultEffort);
  }
}

function createIdleState(settings: SessionSettings, notice: string | null): AgentState {
  return {
    status: 'idle',
    streamingText: '',
    toolCallNames: [],
    completedMessages: [],
    currentStep: 0,
    lastError: null,
    lastStatus: null,
    lastFinishReason: null,
    settings,
    notice,
  };
}

/** Manages one interactive conversation, including commands and streaming state. */
export function useAgent(options: UseAgentOptions = {}): UseAgentReturn {
  const [state, setState] = useState<AgentState>(() =>
    createIdleState(createInitialSettings(options), null),
  );
  const agentRef = useRef<AgentLoop | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const messageCountBeforeTurnRef = useRef<number>(0);
  const settingsRef = useRef<SessionSettings>(state.settings);
  const abortRef = useRef<AbortController | null>(null);
  const initErrorRef = useRef<string | null>(null);

  const getAgent = useCallback((): AgentLoop | null => {
    if (initErrorRef.current) return null;
    if (!agentRef.current) {
      try {
        const config = loadProviderConfig();
        const provider = createDeepSeekClient(config);
        const toolRegistry = createEmptyToolRegistry();
        const contextManager = createContextManager();
        const emitter = {
          emit: <K extends keyof AgentEventMap>(type: K, payload: AgentEventMap[K]): void => {
            switch (type) {
              case 'agent:stream:delta': {
                const streamDelta = payload as AgentEventMap['agent:stream:delta'];
                setState((previous) => ({
                  ...previous,
                  status: 'streaming',
                  streamingText: previous.streamingText + streamDelta.content,
                }));
                break;
              }
              case 'agent:thinking':
                setState((previous) => ({
                  ...previous,
                  status: 'thinking',
                  streamingText: '',
                  toolCallNames: [],
                }));
                break;
              case 'agent:step:start': {
                const stepStart = payload as AgentEventMap['agent:step:start'];
                setState((previous) => ({ ...previous, currentStep: stepStart.step }));
                break;
              }
              case 'agent:tool_calls': {
                const toolCalls = payload as AgentEventMap['agent:tool_calls'];
                setState((previous) => ({
                  ...previous,
                  status: 'executing',
                  toolCallNames: toolCalls.toolCalls.map((toolCall) => toolCall.function.name),
                }));
                break;
              }
              case 'agent:error': {
                const agentError = payload as AgentEventMap['agent:error'];
                setState((previous) => ({
                  ...previous,
                  status: 'error',
                  lastError: agentError.error.message,
                }));
                break;
              }
              case 'agent:abort':
                setState((previous) => ({
                  ...previous,
                  status: 'idle',
                  streamingText: '',
                }));
                break;
              case 'agent:turn:end': {
                const turnEnd = payload as AgentEventMap['agent:turn:end'];
                const newMessages = getNewTurnMessages(
                  turnEnd.messages,
                  messageCountBeforeTurnRef.current,
                );
                const uiMessages = newMessages.map(messageToUI);
                messagesRef.current = turnEnd.messages;
                setState((previous) => ({
                  ...previous,
                  status: 'idle',
                  streamingText: '',
                  toolCallNames: [],
                  completedMessages: [...previous.completedMessages, ...uiMessages],
                  currentStep: 0,
                  lastStatus: turnEnd.status,
                  lastFinishReason: turnEnd.finishReason ?? null,
                }));
                break;
              }
              case 'agent:turn:start':
              case 'agent:executing':
              case 'agent:tool_result':
              case 'agent:response':
                break;
            }
          },
        };
        agentRef.current = new AgentLoop(provider, toolRegistry, contextManager, emitter);
      } catch (error: unknown) {
        initErrorRef.current = error instanceof Error ? error.message : String(error);
        return null;
      }
    }
    return agentRef.current;
  }, []);

  const resetConversation = useCallback((settings: SessionSettings, notice: string | null): void => {
    messagesRef.current = [];
    messageCountBeforeTurnRef.current = 0;
    settingsRef.current = settings;
    agentRef.current = null;
    abortRef.current = null;
    initErrorRef.current = null;
    setState(createIdleState(settings, notice));
  }, []);

  const sendMessage = useCallback(async (userInput: string): Promise<void> => {
    const agent = getAgent();
    if (!agent) {
      setState((previous) => ({
        ...previous,
        status: 'error',
        lastError: initErrorRef.current ?? 'Agent initialization failed',
      }));
      return;
    }

    const userMessage: UIMessage = {
      id: nextId(),
      role: 'user',
      content: userInput,
    };
    setState((previous) => ({
      ...previous,
      status: 'thinking',
      streamingText: '',
      toolCallNames: [],
      lastError: null,
      notice: null,
      completedMessages: [...previous.completedMessages, userMessage],
    }));
    messagesRef.current.push({ role: 'user', content: userInput });
    messageCountBeforeTurnRef.current = messagesRef.current.length;
    abortRef.current = new AbortController();

    const sessionSettings = settingsRef.current;
    const reasoningOptions = toReasoningOptions(sessionSettings.effort);
    const agentOptions: AgentOptions = {
      model: sessionSettings.model,
      maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
      maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      systemPrompt: options.systemPrompt ?? formatSystemPrompt(DEFAULT_SYSTEM_PROMPT),
      ...reasoningOptions,
    };

    try {
      const result = await agent.run(
        messagesRef.current,
        agentOptions,
        abortRef.current.signal,
      );
      const resultError = result.error;
      if (result.status === 'error' && resultError) {
        setState((previous) => ({
          ...previous,
          status: 'error',
          lastError: resultError.message,
          lastStatus: result.status,
        }));
      }
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setState((previous) => ({ ...previous, status: 'idle' }));
      } else {
        const message = error instanceof Error ? error.message : String(error);
        setState((previous) => ({
          ...previous,
          status: 'error',
          lastError: message,
        }));
      }
    } finally {
      abortRef.current = null;
    }
  }, [getAgent, options.maxSteps, options.maxTokens, options.systemPrompt, options.temperature]);

  const submit = useCallback(async (input: string): Promise<void> => {
    const parsedInput = parseInput(input);
    if (parsedInput.kind === 'invalid-command') {
      setState((previous) => ({ ...previous, notice: parsedInput.message }));
      return;
    }
    if (parsedInput.kind === 'command') {
      const commandResult = applySlashCommand(parsedInput.command, settingsRef.current);
      if (commandResult.kind === 'reset') {
        resetConversation(commandResult.settings, commandResult.message);
        return;
      }
      settingsRef.current = commandResult.settings;
      setState((previous) => ({
        ...previous,
        settings: commandResult.settings,
        notice: commandResult.message,
      }));
      return;
    }
    await sendMessage(parsedInput.content);
  }, [resetConversation, sendMessage]);

  const reset = useCallback(() => {
    resetConversation(settingsRef.current, null);
  }, [resetConversation]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    const agent = getAgent();
    if (!agent && initErrorRef.current) {
      setState((previous) => ({
        ...previous,
        status: 'error',
        lastError: initErrorRef.current,
      }));
    }
  }, [getAgent]);

  return { state, submit, reset, abort };
}
