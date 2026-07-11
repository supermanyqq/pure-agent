import { useState, useRef, useCallback } from 'react';
import { performance } from 'node:perf_hooks';
import type { AgentEventMap, AgentOptions, FinishReason, Message } from '@pure-agent/core';
import {
  AgentLoop,
  createContextManager,
  createDeepSeekClient,
  createEmptyToolRegistry,
  DEFAULT_SYSTEM_PROMPT,
  formatSystemPrompt,
  hasConfiguredApiKey,
  loadCliConfig,
  loadProviderConfig,
  saveApiKey,
} from '@pure-agent/core';
import { applySlashCommand } from '../commands/handlers.js';
import { parseInput } from '../commands/parser.js';
import {
  createSessionSettings,
  toReasoningOptions,
} from '../session-settings.js';
import type { SessionSettings } from '../session-settings.js';
import { resolveSupportedModel } from '../runtime-options.js';
import type { SupportedModel } from '../runtime-options.js';
import {
  clearThoughtTiming,
  createThoughtTimingState,
  finishThoughtTiming,
  startThoughtTiming,
} from '../thought-timing.js';
import { getNewTurnMessages } from '../turn-messages.js';
import type { AgentState, ApiKeyStatus, PickerState, UIMessage } from '../types.js';

const INITIAL_MESSAGE_ID_COUNTER = 0;
const DEFAULT_MAX_STEPS = 10;
const DEFAULT_MAX_TOKENS = 4_096;
const DEFAULT_TEMPERATURE = 0;
const API_KEY_REQUIRED_NOTICE = 'API key is not configured. Run /config set api-key.';
const API_KEY_CONFIGURED_NOTICE = 'API key is configured. Use /config set api-key to replace it.';
const API_KEY_CONFIGURATION_CANCELLED_NOTICE = 'API key configuration cancelled.';
const API_KEY_SAVED_NOTICE = 'API key saved. You can start chatting.';
const API_KEY_SAVE_FAILED_NOTICE = 'Unable to save the API key. Check the configuration file and try again.';

let messageIdCounter = INITIAL_MESSAGE_ID_COUNTER;

function nextId(): string {
  messageIdCounter += 1;
  return `msg-${messageIdCounter}`;
}

function messageToUI(message: Message, thoughtDurationMs?: number): UIMessage {
  const content = typeof message.content === 'string' ? message.content : '';
  const toolCallNames =
    message.role === 'assistant' && 'toolCalls' in message && message.toolCalls
      ? message.toolCalls.map((toolCall) => toolCall.function.name)
      : undefined;
  return {
    id: nextId(),
    role: message.role,
    content,
    thoughtDurationMs,
    toolCallNames,
  };
}

export interface UseAgentOptions {
  model?: SupportedModel;
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
  cancelApiKeyEntry: () => void;
  choosePickerValue: (value: string) => Promise<void>;
  cancelPicker: () => void;
}

function createInitialSettings(options: UseAgentOptions): SessionSettings {
  const cliConfig = loadCliConfig();
  try {
    const providerConfig = loadProviderConfig();
    return createSessionSettings(
      resolveSupportedModel(options.model ?? providerConfig.defaultModel),
      cliConfig.defaultEffort,
    );
  } catch {
    return createSessionSettings(resolveSupportedModel(options.model), cliConfig.defaultEffort);
  }
}

function getApiKeyStatus(): ApiKeyStatus {
  return hasConfiguredApiKey() ? 'configured' : 'required';
}

function createIdleState(
  settings: SessionSettings,
  notice: string | null,
  apiKeyStatus: ApiKeyStatus = getApiKeyStatus(),
): AgentState {
  return {
    status: 'idle',
    streamingText: '',
    streamingThoughtDurationMs: null,
    toolCallNames: [],
    completedMessages: [],
    currentStep: 0,
    lastError: null,
    lastStatus: null,
    lastFinishReason: null,
    settings,
    notice,
    apiKeyStatus,
    picker: null,
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
  const thoughtTimingRef = useRef(createThoughtTimingState());

  function finishCurrentThoughtTiming(): number | null {
    const finished = finishThoughtTiming(thoughtTimingRef.current, performance.now());
    thoughtTimingRef.current = finished.state;
    return finished.durationMs;
  }

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
                const thoughtDurationMs = streamDelta.content
                  ? finishCurrentThoughtTiming()
                  : null;
                setState((previous) => ({
                  ...previous,
                  status: 'streaming',
                  streamingText: previous.streamingText + streamDelta.content,
                  streamingThoughtDurationMs:
                    previous.streamingThoughtDurationMs ?? thoughtDurationMs,
                }));
                break;
              }
              case 'agent:thinking':
                thoughtTimingRef.current = startThoughtTiming(
                  thoughtTimingRef.current,
                  performance.now(),
                );
                setState((previous) => ({
                  ...previous,
                  status: 'thinking',
                  streamingText: '',
                  streamingThoughtDurationMs: null,
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
                finishCurrentThoughtTiming();
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
                  streamingText: '',
                  streamingThoughtDurationMs: null,
                  lastError: agentError.error.message,
                }));
                break;
              }
              case 'agent:abort':
                setState((previous) => ({
                  ...previous,
                  status: 'idle',
                  streamingText: '',
                  streamingThoughtDurationMs: null,
                }));
                break;
              case 'agent:turn:end': {
                const turnEnd = payload as AgentEventMap['agent:turn:end'];
                const newMessages = getNewTurnMessages(
                  turnEnd.messages,
                  messageCountBeforeTurnRef.current,
                  thoughtTimingRef.current.completedDurationsMs,
                );
                const uiMessages = newMessages.map(({ message, thoughtDurationMs }) =>
                  messageToUI(message, thoughtDurationMs),
                );
                messagesRef.current = turnEnd.messages;
                thoughtTimingRef.current = clearThoughtTiming(thoughtTimingRef.current);
                setState((previous) => ({
                  ...previous,
                  status: 'idle',
                  streamingText: '',
                  streamingThoughtDurationMs: null,
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
    thoughtTimingRef.current = clearThoughtTiming(thoughtTimingRef.current);
    setState(createIdleState(settings, notice));
  }, []);

  const sendMessage = useCallback(async (userInput: string): Promise<void> => {
    if (!hasConfiguredApiKey()) {
      setState((previous) => ({
        ...previous,
        status: 'idle',
        lastError: null,
        notice: API_KEY_REQUIRED_NOTICE,
        apiKeyStatus: 'required',
      }));
      return;
    }

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
    thoughtTimingRef.current = clearThoughtTiming(thoughtTimingRef.current);
    setState((previous) => ({
      ...previous,
      status: 'thinking',
      streamingText: '',
      streamingThoughtDurationMs: null,
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
    if (state.apiKeyStatus === 'entering') {
      try {
        saveApiKey(input);
        agentRef.current = null;
        initErrorRef.current = null;
        thoughtTimingRef.current = clearThoughtTiming(thoughtTimingRef.current);
        setState((previous) => ({
          ...previous,
          status: 'idle',
          lastError: null,
          notice: API_KEY_SAVED_NOTICE,
          apiKeyStatus: 'configured',
        }));
      } catch {
        setState((previous) => ({
          ...previous,
          status: 'idle',
          notice: API_KEY_SAVE_FAILED_NOTICE,
          apiKeyStatus: 'required',
        }));
      }
      return;
    }

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
      if (commandResult.kind === 'config') {
        if (commandResult.action === 'set-api-key') {
          setState((previous) => ({
            ...previous,
            status: 'idle',
            lastError: null,
            notice: null,
            apiKeyStatus: 'entering',
          }));
          return;
        }
        const apiKeyStatus = getApiKeyStatus();
        setState((previous) => ({
          ...previous,
          status: 'idle',
          lastError: null,
          notice: apiKeyStatus === 'configured'
            ? API_KEY_CONFIGURED_NOTICE
            : API_KEY_REQUIRED_NOTICE,
          apiKeyStatus,
        }));
        return;
      }
      if (commandResult.kind === 'picker') {
        const picker: PickerState = { kind: commandResult.picker };
        setState((previous) => ({
          ...previous,
          notice: null,
          picker,
        }));
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
  }, [resetConversation, sendMessage, state.apiKeyStatus]);

  const reset = useCallback(() => {
    resetConversation(settingsRef.current, null);
  }, [resetConversation]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const cancelApiKeyEntry = useCallback(() => {
    if (state.apiKeyStatus !== 'entering') return;
    const apiKeyStatus = getApiKeyStatus();
    setState((previous) => ({
      ...previous,
      status: 'idle',
      notice: API_KEY_CONFIGURATION_CANCELLED_NOTICE,
      apiKeyStatus,
    }));
  }, [state.apiKeyStatus]);

  const choosePickerValue = useCallback(async (value: string): Promise<void> => {
    const picker = state.picker;
    if (!picker) return;
    setState((previous) => ({ ...previous, picker: null }));
    const command = picker.kind === 'model' ? `/model ${value}` : `/effort ${value}`;
    await submit(command);
  }, [state.picker, submit]);

  const cancelPicker = useCallback(() => {
    if (!state.picker) return;
    setState((previous) => ({ ...previous, picker: null }));
  }, [state.picker]);

  return {
    state,
    submit,
    reset,
    abort,
    cancelApiKeyEntry,
    choosePickerValue,
    cancelPicker,
  };
}
