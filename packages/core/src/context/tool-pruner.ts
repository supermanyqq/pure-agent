/**
 * Tool Pruner — 工具结果预裁剪（廉价，无 LLM 调用）。
 *
 * 在 LLM 摘要之前执行，减少摘要输入大小。三个阶段：
 * 1. 去重：相同内容的 tool 结果只保留最新副本
 * 2. 摘要化：大 tool 结果（>200 chars）替换为信息丰富的单行描述
 * 3. 截断：tool_call arguments JSON 保结构截断
 *
 * 借鉴 hermes-agent context_compressor.py 的 _prune_old_tool_results。
 */

import type { Message, ToolCall } from '../types/index.js';
import type { ToolPruneResult } from './types.js';
import {
  TOOL_CONTENT_TRUNCATE_HEAD_CHARS,
  MIN_TOOL_CONTENT_PRUNE_CHARS,
  MIN_TOOL_ARGS_TRUNCATE_CHARS,
} from './types.js';
import { estimateMsgBudgetTokens } from './token-counter.js';

// 去重使用 content 字符串直接作为 Map key（可靠且无碰撞风险）

// ===== 工具结果摘要化 =====

function parseArgs(argsJson: string): Record<string, unknown> {
  try {
    return JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * 为每种工具类型生成信息丰富的单行描述。
 * 模仿 hermes-agent 的 _summarize_tool_result()。
 */
function summarizeToolResult(
  toolName: string,
  toolArgs: string,
  toolContent: string,
): string {
  const args = parseArgs(toolArgs);
  const contentLen = toolContent.length;
  const lineCount = (toolContent.match(/\n/g) || []).length + 1;

  switch (toolName) {
    case 'terminal':
    case 'shell_exec': {
      const cmd = String(args.command ?? '');
      const truncatedCmd = cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
      const exitMatch = toolContent.match(/"exit_code"\s*:\s*(-?\d+)/);
      const exitCode = exitMatch ? exitMatch[1] : '?';
      return `[${toolName}] ran \`${truncatedCmd}\` -> exit ${exitCode}, ${lineCount} lines output`;
    }

    case 'read_file': {
      const path = String(args.path ?? '?');
      const offset = args.offset ?? 1;
      return `[read_file] read ${path} from line ${offset} (${contentLen.toLocaleString()} chars)`;
    }

    case 'write_file': {
      const path = String(args.path ?? '?');
      const writtenContent = String(args.content ?? '');
      const writtenLines = writtenContent.split('\n').length;
      return `[write_file] wrote to ${path} (${writtenLines} lines)`;
    }

    case 'search_files':
    case 'grep':
    case 'search_content': {
      const pattern = String(args.pattern ?? '?');
      const dir = String(args.path ?? '.');
      const matchCount = toolContent.match(/"total_count"\s*:\s*(\d+)/)?.[1] ?? '?';
      return `[${toolName}] search for '${pattern}' in ${dir} -> ${matchCount} matches`;
    }

    case 'patch':
    case 'edit_file': {
      const path = String(args.path ?? '?');
      return `[${toolName}] ${path} (${contentLen.toLocaleString()} chars result)`;
    }

    case 'web_search': {
      const query = String(args.query ?? '?');
      return `[web_search] query='${query}' (${contentLen.toLocaleString()} chars result)`;
    }

    case 'web_fetch':
    case 'web_extract': {
      const urls = args.urls;
      const urlDesc = Array.isArray(urls)
        ? urls.length > 1
          ? `${String(urls[0])} (+${urls.length - 1} more)`
          : String(urls[0] ?? '?')
        : '?';
      return `[${toolName}] ${urlDesc} (${contentLen.toLocaleString()} chars)`;
    }

    case 'memory': {
      const action = String(args.action ?? '?');
      const target = String(args.target ?? '?');
      return `[memory] ${action} on ${target}`;
    }

    case 'todo':
      return '[todo] updated task list';

    case 'ask_user':
    case 'clarify':
      return '[clarify] asked user a question';

    case 'execute_code': {
      const codePreview = String(args.code ?? '').slice(0, 60).replace(/\n/g, ' ');
      const suffix = String(args.code ?? '').length > 60 ? '...' : '';
      return `[execute_code] \`${codePreview}${suffix}\` (${lineCount} lines output)`;
    }

    case 'delegate_task': {
      const goal = String(args.goal ?? '');
      const truncatedGoal = goal.length > 60 ? goal.slice(0, 57) + '...' : goal;
      return `[delegate_task] '${truncatedGoal}' (${contentLen.toLocaleString()} chars result)`;
    }

    default: {
      const entries = Object.entries(args).slice(0, 2);
      const params = entries
        .map(([k, v]) => ` ${k}=${String(v).slice(0, 40)}`)
        .join('');
      return `[${toolName}]${params} (${contentLen.toLocaleString()} chars result)`;
    }
  }
}

// ===== Tool Call Arguments 截断 =====

/**
 * 截断 tool_call arguments JSON 中过长的字符串值，保持 JSON 有效性。
 * JSON 无效时返回原字符串不变。
 */
function truncateToolCallArgs(args: string, headChars = 200): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return args;
  }

  function shrink(value: unknown): unknown {
    if (typeof value === 'string') {
      if (value.length > headChars) {
        return value.slice(0, headChars) + '...[truncated]';
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(shrink);
    }
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = shrink(v);
      }
      return result;
    }
    return value;
  }

  const shrunken = shrink(parsed);
  return JSON.stringify(shrunken);
}

// ===== 主要入口 =====

export interface PruneOptions {
  protectTailCount: number;
  protectTailTokens?: number;
}

/**
 * 对旧 tool 结果执行三阶段预裁剪。
 * 不修改原数组，返回新数组和裁剪数量。
 */
export function pruneOldToolResults(
  messages: Message[],
  options: PruneOptions,
): ToolPruneResult {
  if (messages.length === 0) {
    return { messages: [], prunedCount: 0 };
  }

  const result = messages.map((m) => ({ ...m }));
  let pruned = 0;

  // 构建 tool_call_id → (name, arguments) 索引
  const callIdToTool = new Map<string, { name: string; args: string }>();
  for (const msg of result) {
    if (msg.role === 'assistant' && 'toolCalls' in msg && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        callIdToTool.set(tc.id, {
          name: tc.function.name,
          args: tc.function.arguments,
        });
      }
    }
  }

  // 确定裁剪边界（token budget 优先，消息计数作为硬下限）
  const { protectTailCount, protectTailTokens } = options;
  let pruneBoundary: number;

  if (protectTailTokens !== undefined && protectTailTokens > 0) {
    let accumulated = 0;
    let boundary = result.length;
    const minProtect = Math.min(protectTailCount, result.length);

    for (let i = result.length - 1; i >= 0; i--) {
      const msgTokens = estimateMsgBudgetTokens(result[i]);
      if (
        accumulated + msgTokens > protectTailTokens &&
        result.length - i >= minProtect
      ) {
        boundary = i;
        break;
      }
      accumulated += msgTokens;
      boundary = i;
    }

    const budgetProtectCount = result.length - boundary;
    const protectedCount = Math.max(budgetProtectCount, minProtect);
    pruneBoundary = Math.max(0, result.length - protectedCount);
  } else {
    pruneBoundary = Math.max(0, result.length - protectTailCount);
  }

  // 阶段 1：去重相同 tool 结果（直接用 content 字符串作 key）
  const seenContents = new Set<string>();
  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (msg.role !== 'tool') continue;

    const content = msg.content;
    if (content.length < MIN_TOOL_CONTENT_PRUNE_CHARS) continue;

    if (seenContents.has(content)) {
      result[i] = {
        ...msg,
        content:
          '[Duplicate tool output — same content as a more recent call]',
      };
      pruned++;
    } else {
      seenContents.add(content);
    }
  }

  // 阶段 2：大 tool 结果 → 单行描述
  for (let i = 0; i < pruneBoundary; i++) {
    const msg = result[i];
    if (msg.role !== 'tool') continue;

    const content = msg.content;
    if (content.length <= MIN_TOOL_CONTENT_PRUNE_CHARS) continue;
    if (content.startsWith('[Duplicate tool output')) continue;

    const toolInfo = callIdToTool.get(msg.toolCallId);
    const toolName = toolInfo?.name ?? 'unknown';
    const toolArgs = toolInfo?.args ?? '';
    const summary = summarizeToolResult(toolName, toolArgs, content);

    result[i] = { ...msg, content: summary };
    pruned++;
  }

  // 阶段 3：截断 assistant 消息中的 tool_call arguments
  for (let i = 0; i < pruneBoundary; i++) {
    const msg = result[i];
    if (msg.role !== 'assistant' || !('toolCalls' in msg) || !msg.toolCalls) {
      continue;
    }

    let modified = false;
    const newTCs: ToolCall[] = msg.toolCalls.map((tc) => {
      const args = tc.function.arguments;
      if (args.length > MIN_TOOL_ARGS_TRUNCATE_CHARS) {
        const newArgs = truncateToolCallArgs(args);
        if (newArgs !== args) {
          modified = true;
          return {
            ...tc,
            function: { ...tc.function, arguments: newArgs },
          };
        }
      }
      return tc;
    });

    if (modified) {
      result[i] = { ...msg, toolCalls: newTCs };
    }
  }

  return { messages: result, prunedCount: pruned };
}
