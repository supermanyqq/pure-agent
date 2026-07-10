/**
 * 纯文本模式 — 管道 / 参数 / 非 TTY 下的回退实现。
 *
 * 不使用 Ink，直接 console.log 输出。
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

const config = loadProviderConfig();
const provider = createDeepSeekClient(config);
const toolRegistry = createEmptyToolRegistry();
const contextManager = createContextManager();
const events = createConsoleEmitter();

const agent = new AgentLoop(provider, toolRegistry, contextManager, events);
const DEFAULT_MAX_STEPS = 10;
const systemPrompt = formatSystemPrompt(DEFAULT_SYSTEM_PROMPT);

class Conversation {
  private messages: Message[] = [{ role: 'system' as const, content: systemPrompt }];

  async send(userInput: string): Promise<TurnOutput> {
    const signal = new AbortController().signal;
    this.messages.push({ role: 'user', content: userInput });
    const result = await agent.run(this.messages, {
      model: config.defaultModel,
      maxSteps: DEFAULT_MAX_STEPS,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    }, signal);
    this.messages = result.messages;
    return result;
  }
}

export async function runPlainText(args: string[]): Promise<void> {
  // 命令行参数模式：pure-agent "你的问题"
  if (args.length > 0) {
    const question = args.join(' ');
    const conv = new Conversation();
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
      const conv = new Conversation();
      const result = await conv.send(input);
      if (result.status === 'error') {
        console.error('\n[ERROR]', result.error?.message ?? 'Unknown error');
        process.exitCode = 1;
      }
    }
    return;
  }

  // 交互模式（无 Ink 回退）
  const conv = new Conversation();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  console.log('Pure Agent — type your question (Ctrl+D to exit)');
  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === 'exit' || trimmed === 'quit') break;
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
