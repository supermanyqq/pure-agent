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

import { render } from 'ink';
import React from 'react';
import { App } from './app.js';

const args = process.argv.slice(2);
const isTTY = process.stdout.isTTY && process.stdin.isTTY;

// ===== 管道 / 参数 / 非 TTY → 纯文本回退 =====

if (!isTTY || args.length > 0) {
  try {
    const { runPlainText } = await import('./plain.js');
    await runPlainText(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('\n[FATAL]', msg);
    process.exit(1);
  }
} else {
  // ===== 交互模式 → Ink TUI =====
  try {
    const { waitUntilExit } = render(
      React.createElement(App, {}),
      {
        exitOnCtrlC: true,
        patchConsole: true,
      },
    );
    await waitUntilExit;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('\n[FATAL]', msg);
    process.exit(1);
  }
}
