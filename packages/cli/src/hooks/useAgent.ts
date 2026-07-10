import { useState, useRef, useCallback } from 'react';
import type { Message, AgentOptions, TurnOutput, AgentEventMap, FinishReason } from '@pure-agent/core';
import {
  AgentLoop,
  loadProviderConfig,
  createDeepSeekClient,
  createEmptyToolRegistry,
  createContextManager,
  formatSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
} from '@pure-agent/core';
import type { AgentState, UIMessage, AgentStatus } from '../types.js';

let _idCounter = 0;
function nextId(): string {
  return `msg-${++_idCounter}`;
}

function messageToUI(msg: Message): UIMessage {
  const content = typeof msg.content === 'string' ? msg.content : '';
  const toolCallNames =
    msg.role === 'assistant' && 'toolCalls' in msg && msg.toolCalls
      ? msg.toolCalls.map((tc) => tc.function.name)
      : undefined;
  return { id: nextId(), role: msg.role, content, toolCallNames };
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
  send: (userInput: string) => Promise<void>;
  reset: () => void;
  abort: () => void;
}

/**
 * Agent 生命周期 hook — 封装 AgentLoop 的创建、调用和事件订阅。
 *
 * 使用方式：
 * ```tsx
 * const { state, send, reset } = useAgent();
 * send("Hello");
 * ```
 */
export function useAgent(options: UseAgentOptions = {}): UseAgentReturn {
  const [state, setState] = useState<AgentState>({
    status: 'idle',
    streamingText: '',
    toolCallNames: [],
    completedMessages: [],
    currentStep: 0,
    lastError: null,
    lastStatus: null,
    lastFinishReason: null,
  });

  // 用 ref 保存持久化的 Conversation 状态（避免 re-render 重建 agent）
  const agentRef = useRef<AgentLoop | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // 懒初始化 agent
  const getAgent = useCallback(() => {
    if (!agentRef.current) {
      const config = loadProviderConfig();
      const provider = createDeepSeekClient(config);
      const toolRegistry = createEmptyToolRegistry();
      const contextManager = createContextManager();

      const emitter = {
        emit: <K extends keyof AgentEventMap>(type: K, payload: AgentEventMap[K]): void => {
          switch (type) {
            case 'agent:stream:delta': {
              const p = payload as AgentEventMap['agent:stream:delta'];
              setState((prev) => ({
                ...prev,
                status: 'streaming',
                streamingText: prev.streamingText + p.content,
              }));
              break;
            }
            case 'agent:thinking': {
              setState((prev) => ({
                ...prev,
                status: 'thinking',
                streamingText: '',
                toolCallNames: [],
              }));
              break;
            }
            case 'agent:step:start': {
              const p = payload as AgentEventMap['agent:step:start'];
              setState((prev) => ({ ...prev, currentStep: p.step }));
              break;
            }
            case 'agent:tool_calls': {
              const p = payload as AgentEventMap['agent:tool_calls'];
              setState((prev) => ({
                ...prev,
                status: 'executing',
                toolCallNames: p.toolCalls.map((tc) => tc.function.name),
              }));
              break;
            }
            case 'agent:response': {
              // response 事件是完整文本，但 streaming 已经逐 delta 展示过了
              // 这里不需要重复更新
              break;
            }
            case 'agent:error': {
              const p = payload as AgentEventMap['agent:error'];
              setState((prev) => ({
                ...prev,
                status: 'error',
                lastError: p.error.message,
              }));
              break;
            }
            case 'agent:abort': {
              setState((prev) => ({
                ...prev,
                status: 'idle',
                streamingText: '',
              }));
              break;
            }
            case 'agent:turn:end': {
              const p = payload as AgentEventMap['agent:turn:end'];
              // 将本轮新的 assistant/tool 消息转为 UI 消息
              const newMessages = p.messages.slice(messagesRef.current.length);
              const uiMessages = newMessages.map(messageToUI);

              setState((prev) => ({
                ...prev,
                status: 'idle',
                streamingText: '',
                toolCallNames: [],
                completedMessages: [...prev.completedMessages, ...uiMessages],
                currentStep: 0,
                lastStatus: p.status,
                lastFinishReason: p.finishReason ?? null,
              }));

              // 更新持久化消息历史
              messagesRef.current = p.messages;
              break;
            }
            // agent:turn:start, agent:executing, agent:tool_result — 静默
          }
        },
      };

      agentRef.current = new AgentLoop(provider, toolRegistry, contextManager, emitter);
    }
    return agentRef.current;
  }, []);

  const send = useCallback(
    async (userInput: string): Promise<void> => {
      const agent = getAgent();

      // 添加用户消息到 UI
      const userMsg: UIMessage = {
        id: nextId(),
        role: 'user',
        content: userInput,
      };
      setState((prev) => ({
        ...prev,
        status: 'thinking',
        streamingText: '',
        toolCallNames: [],
        lastError: null,
        completedMessages: [...prev.completedMessages, userMsg],
      }));

      // 追加到消息历史
      messagesRef.current.push({ role: 'user', content: userInput });

      abortRef.current = new AbortController();

      const agentOptions: AgentOptions = {
        model: options.model ?? 'deepseek-v4-pro',
        maxSteps: options.maxSteps ?? 10,
        maxTokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0,
        systemPrompt:
          options.systemPrompt ?? formatSystemPrompt(DEFAULT_SYSTEM_PROMPT),
      };

      try {
        const result = await agent.run(
          messagesRef.current,
          agentOptions,
          abortRef.current.signal,
        );

        // turn:end 事件已更新状态，这里处理未被事件覆盖的 case
        if (result.status === 'error' && result.error) {
          setState((prev) => ({
            ...prev,
            status: 'error',
            lastError: result.error!.message,
            lastStatus: result.status,
          }));
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setState((prev) => ({ ...prev, status: 'idle' }));
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          setState((prev) => ({
            ...prev,
            status: 'error',
            lastError: msg,
          }));
        }
      } finally {
        abortRef.current = null;
      }
    },
    [getAgent, options],
  );

  const reset = useCallback(() => {
    messagesRef.current = [];
    agentRef.current = null;
    setState({
      status: 'idle',
      streamingText: '',
      toolCallNames: [],
      completedMessages: [],
      currentStep: 0,
      lastError: null,
      lastStatus: null,
      lastFinishReason: null,
    });
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { state, send, reset, abort };
}
