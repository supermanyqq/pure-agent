/**
 * shell_exec — 执行 Shell 命令。
 *
 * 参考：Kilo Code shell.ts（超时+输出截断）+ Hermes approval.py（危险命令检测）
 */

import { exec, type ExecOptions } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool, ToolDefinition } from '../../types/index.js';

const execAsync = promisify(exec);

// ===== 常量 =====

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 50_000;

// ===== 危险命令模式（参考 Hermes approval.py） =====

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf\s+\/\b/, reason: 'Recursive force-delete from filesystem root' },
  { pattern: /\brm\s+-rf\s+\/etc\b/, reason: 'Delete system config directory' },
  { pattern: /\brm\s+-rf\s+\/var\b/, reason: 'Delete system variable data' },
  { pattern: /\brm\s+-rf\s+\/usr\b/, reason: 'Delete system binaries' },
  { pattern: /\brm\s+-rf\s+\/boot\b/, reason: 'Delete boot files' },
  { pattern: /\brm\s+-rf\s+\/home\b/, reason: 'Delete user home directories' },
  { pattern: /\bmkfs\./, reason: 'Format filesystem' },
  { pattern: /\bdd\s+if=.*of=\/dev\/sd/, reason: 'Write raw data to disk device' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'Redirect output to disk device' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}|fork\s*bomb/i, reason: 'Fork bomb' },
  { pattern: /\bshutdown\b/, reason: 'System shutdown' },
  { pattern: /\breboot\b/, reason: 'System reboot' },
  { pattern: /\bchmod\s+(-R\s+)?777\s+\//, reason: 'Make root world-writable' },
  { pattern: /\bcurl\s+.*\|\s*(ba)?sh\b/, reason: 'Pipe remote script directly to shell' },
  { pattern: /\bwget\s+.*\|\s*(ba)?sh\b/, reason: 'Pipe remote script directly to shell' },
  { pattern: /\bsudo\s+rm\s+-rf/, reason: 'Privileged forced-delete' },
  { pattern: /\bgit\s+push\s+--force\b/, reason: 'Force-push to remote' },
];

// ===== 参数 Schema =====

const SHELL_EXEC_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description:
        'The shell command to execute. Must be non-interactive. ' +
        'Use --no-pager / --non-interactive flags where applicable. ' +
        'The command will be terminated if it runs longer than the timeout.',
    },
    cwd: {
      type: 'string',
      description:
        'Working directory for the command. Defaults to the agent working directory.',
    },
    timeout: {
      type: 'number',
      minimum: 1,
      maximum: 120,
      description: `Maximum execution time in seconds. Default is ${DEFAULT_TIMEOUT_MS / 1000}s, max 120s.`,
    },
  },
  required: ['command'],
};

const SHELL_EXEC_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'shell_exec',
    description:
      'Execute a shell command and return the output (stdout + stderr + exit code). ' +
      'The command runs in a non-interactive shell with a timeout. ' +
      'Output is truncated if it exceeds 50,000 characters. ' +
      'Dangerous commands (rm -rf /, mkfs, dd to disk, fork bombs, shutdown, etc.) are blocked. ' +
      'Use this to run build commands, run tests, list files, check system state, or execute scripts. ' +
      'For reading files, prefer the read_file tool. For searching code, prefer the grep tool. ' +
      'For finding files by name, prefer the glob tool.',
    parameters: SHELL_EXEC_PARAMETERS,
  },
};

// ===== 工具函数 =====

function checkDangerousCommands(command: string): string | null {
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked dangerous command: ${reason}. Pattern matched: ${pattern.source.slice(0, 60)}...`;
    }
  }
  return null;
}

function truncateOutput(stdout: string, stderr: string, maxChars: number): { stdout: string; stderr: string; truncated: boolean } {
  const total = stdout.length + stderr.length;
  if (total <= maxChars) {
    return { stdout, stderr, truncated: false };
  }

  // 按比例截断，保留头部和尾部
  const headRatio = 0.4;
  const tailRatio = 0.4;
  const headChars = Math.floor(maxChars * headRatio);
  const tailChars = Math.floor(maxChars * tailRatio);

  let truncatedStdout = stdout;
  let truncatedStderr = stderr;

  if (stdout.length > headChars + tailChars) {
    truncatedStdout =
      stdout.slice(0, headChars) +
      `\n\n... [${stdout.length - headChars - tailChars} chars truncated] ...\n\n` +
      stdout.slice(-tailChars);
  }

  if (stderr.length > headChars + tailChars) {
    truncatedStderr =
      stderr.slice(0, headChars) +
      `\n\n... [${stderr.length - headChars - tailChars} chars truncated] ...\n\n` +
      stderr.slice(-tailChars);
  }

  return { stdout: truncatedStdout, stderr: truncatedStderr, truncated: true };
}

export function createShellExecTool(workDir: string): Tool {
  return {
    definition: SHELL_EXEC_DEFINITION,

    async execute(args: Record<string, unknown>): Promise<string> {
      const command = String(args['command'] ?? '');
      if (!command.trim()) {
        return 'Error: "command" is required.';
      }

      // 危险命令检测
      const dangerError = checkDangerousCommands(command);
      if (dangerError) {
        return `Error: ${dangerError}`;
      }

      const cwd = String(args['cwd'] ?? workDir);
      const timeoutSec = (args['timeout'] as number | undefined) ?? DEFAULT_TIMEOUT_MS / 1000;
      const timeoutMs = Math.min(Math.max(1, timeoutSec * 1000), 120_000);

      const startTime = Date.now();

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer max
          shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
          env: {
            ...process.env,
            PYTHONUNBUFFERED: '1',
            DEBIAN_FRONTEND: 'noninteractive',
          },
        });

        const duration = Date.now() - startTime;
        const { stdout: out, stderr: err, truncated } = truncateOutput(stdout, stderr, MAX_OUTPUT_CHARS);

        const parts: string[] = [];
        parts.push(`Exit code: 0`);
        parts.push(`Duration: ${(duration / 1000).toFixed(1)}s`);

        if (out) {
          parts.push(`--- stdout ---`);
          parts.push(out);
        }
        if (err) {
          parts.push(`--- stderr ---`);
          parts.push(err);
        }
        if (truncated) {
          parts.push(`\n(Output truncated to ${MAX_OUTPUT_CHARS.toLocaleString()} chars.)`);
        }

        return parts.join('\n');
      } catch (err: unknown) {
        const duration = Date.now() - startTime;

        // exec 错误（非零退出码）
        if (err && typeof err === 'object' && 'stdout' in err) {
          const execErr = err as { stdout: string; stderr: string; code: number; killed: boolean };
          const { stdout: out, stderr: errOutput, truncated } = truncateOutput(
            execErr.stdout ?? '',
            execErr.stderr ?? '',
            MAX_OUTPUT_CHARS,
          );

          const parts: string[] = [];

          if (execErr.killed) {
            parts.push(`Error: Command timed out after ${timeoutSec}s.`);
          }
          parts.push(`Exit code: ${execErr.code ?? -1}`);
          parts.push(`Duration: ${(duration / 1000).toFixed(1)}s`);

          if (out) {
            parts.push(`--- stdout ---`);
            parts.push(out);
          }
          if (errOutput) {
            parts.push(`--- stderr ---`);
            parts.push(errOutput);
          }
          if (truncated) {
            parts.push(`\n(Output truncated to ${MAX_OUTPUT_CHARS.toLocaleString()} chars.)`);
          }

          return parts.join('\n');
        }

        // 信号错误（kill, timeout）
        if (err instanceof Error) {
          if ('signal' in err) {
            const signal = (err as Error & { signal: string }).signal;
            if (signal) {
              return `Error: Command was terminated by signal ${signal}.`;
            }
          }
          return `Error: ${err.message}`;
        }

        return `Error: Command execution failed: ${String(err)}`;
      }
    },
  };
}
