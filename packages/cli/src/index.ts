#!/usr/bin/env node
/**
 * @pure-agent/cli — 终端 CLI 入口。
 *
 * 用法：
 *   echo "你的问题" | npx pure-agent          # 管道模式（纯文本）
 *   pure-agent "你的问题"                       # 单次问答（纯文本）
 *   pure-agent                                  # 交互模式（Ink TUI）
 *
 * 环境变量：
 *   PURE_AGENT_API_KEY    — DeepSeek API key（必需）
 *   PURE_AGENT_MODEL      — 模型名（默认 deepseek-v4-pro）
 *   PURE_AGENT_BASE_URL   — API 地址（默认 https://api.deepseek.com）
 */

import { render, Text, Box } from 'ink';
import React from 'react';
import { App } from './app.js';

const args = process.argv.slice(2);

// ===== 管道模式 / 命令行参数模式 / 非 TTY → 纯文本输出 =====

if (!process.stdout.isTTY || !process.stdin.isTTY || args.length > 0) {
  // 使用原有的纯文本模式（不依赖 Ink）
  const { runPlainText } = await import('./plain.js');
  await runPlainText(args);
} else {
  // ===== 交互模式 → Ink TUI =====
  const { waitUntilExit } = render(
    React.createElement(App, {}),
    {
      exitOnCtrlC: true,
      patchConsole: true,
    },
  );
  await waitUntilExit;
}
