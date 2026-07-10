#!/usr/bin/env node
/**
 * @pure-agent/cli — 终端 CLI 入口。
 *
 * 用法：
 *   echo "你的问题" | npx pure-agent
 *   PURE_AGENT_API_KEY=sk-... npx pure-agent
 *
 * 环境变量：
 *   PURE_AGENT_API_KEY    — DeepSeek API key（必需）
 *   PURE_AGENT_MODEL      — 模型名（默认 deepseek-v4-pro）
 *   PURE_AGENT_BASE_URL   — API 地址（默认 https://api.deepseek.com）
 */

import * as readline from 'node:readline';
import type { Message, TurnOutput } from '@pure-agent/core';
import {
  createDeepSeekClient,
  createEmptyToolRegistry,
  createContextManager,
  createConsoleEmitter,
  AgentLoop,
  loadProviderConfig,
  formatSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
} from '@pure-agent/core';

// ===== 配置 =====

const config = loadProviderConfig();
const provider = createDeepSeekClient(config);
const toolRegistry = createEmptyToolRegistry();
const contextManager = createContextManager();
const events = createConsoleEmitter();

const agent = new AgentLoop(provider, toolRegistry, contextManager, events);

const DEFAULT_MAX_STEPS = 10;

// ===== 多轮对话 =====

class Conversation {
  private messages: Message[] = [];

  constructor(systemPrompt: string) {
    this.messages = [{ role: 'system', content: systemPrompt }];
  }

  async send(userInput: string): Promise<TurnOutput> {
    const signal = new AbortController().signal;

    // 追加用户消息
    this.messages.push({ role: 'user', content: userInput });

    // 运行 Agent Loop（含上下文管理）
    const result = await agent.run(
      this.messages,
      {
        model: config.defaultModel,
        maxSteps: DEFAULT_MAX_STEPS,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      },
      signal,
    );

    // 用 Agent 返回的完整消息历史（含 assistant/tool 消息）替换当前历史
    this.messages = result.messages;

    return result;
  }

  /** 重置对话，保留 system prompt */
  reset(): void {
    const systemMsg = this.messages[0]?.role === 'system'
      ? this.messages[0]
      : { role: 'system' as const, content: '' };
    this.messages = [systemMsg];
  }
}

// ===== 主入口 =====

async function main(): Promise<void> {
  const systemPrompt = formatSystemPrompt(DEFAULT_SYSTEM_PROMPT);
  const args = process.argv.slice(2);

  // 命令行参数模式：pure-agent "你的问题"
  if (args.length > 0) {
    const question = args.join(' ');
    const conv = new Conversation(systemPrompt);
    const result = await conv.send(question);

    if (result.status === 'error') {
      console.error('\n[ERROR]', result.error?.message ?? 'Unknown error');
      process.exitCode = 1;
    }
    return;
  }

  // 管道模式：echo "问题" | pure-agent
  if (!process.stdin.isTTY) {
    const chunks: string[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as string);
    }
    const input = chunks.join('').trim();
    if (input) {
      const conv = new Conversation(systemPrompt);
      const result = await conv.send(input);

      if (result.status === 'error') {
        console.error('\n[ERROR]', result.error?.message ?? 'Unknown error');
        process.exitCode = 1;
      }
    }
    return;
  }

  // 交互模式：多轮对话
  const conv = new Conversation(systemPrompt);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  console.log('Pure Agent — multi-turn conversation (Ctrl+D to exit, /new to reset)');
  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === 'exit' || trimmed === 'quit') break;
    if (trimmed === '/new') {
      conv.reset();
      contextManager.reset();
      console.log('[Conversation reset]');
      rl.prompt();
      continue;
    }
    if (trimmed) {
      try {
        const result = await conv.send(trimmed);
        if (result.status === 'error') {
          console.error('[ERROR]', result.error?.message ?? 'Unknown error');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[ERROR]', msg);
      }
    }
    rl.prompt();
  }

  rl.close();
  console.log('\nGoodbye.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});
