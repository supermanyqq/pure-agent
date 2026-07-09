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
 *   PURE_AGENT_MODEL      — 模型名（默认 deepseek-chat）
 *   PURE_AGENT_BASE_URL   — API 地址（默认 https://api.deepseek.com）
 */

import * as readline from 'node:readline';
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

// ===== 运行一次对话 =====

async function runOnce(userInput: string): Promise<void> {
  const signal = new AbortController().signal;

  const result = await agent.run(
    [{ role: 'user' as const, content: userInput }],
    {
      model: config.defaultModel,
      maxSteps: DEFAULT_MAX_STEPS,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      systemPrompt: formatSystemPrompt(DEFAULT_SYSTEM_PROMPT),
    },
    signal,
  );

  if (result.status === 'error') {
    console.error('\n[ERROR]', result.error?.message ?? 'Unknown error');
    process.exitCode = 1;
  }
}

// ===== 主入口 =====

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // 命令行参数模式：pure-agent "你的问题"
  if (args.length > 0) {
    const question = args.join(' ');
    await runOnce(question);
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
      await runOnce(input);
      return;
    }
  }

  // 交互模式：逐行对话
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
      await runOnce(trimmed);
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
