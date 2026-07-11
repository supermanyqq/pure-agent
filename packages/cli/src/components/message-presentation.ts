import type { UIMessage } from '../types.js';

export interface MessagePresentation {
  prefix: string;
  color: string;
  backgroundColor?: string;
  thoughtLabel?: string;
}

const MILLISECONDS_PER_SECOND = 1_000;
const MINIMUM_DISPLAY_SECONDS = 1;
const USER_PREFIX = '› ';
const ASSISTANT_PREFIX = '● ';
const SYSTEM_PREFIX = '◆ ';
const TOOL_PREFIX = '◆ ';

export function formatThoughtDuration(milliseconds: number): string {
  const seconds = Math.max(
    MINIMUM_DISPLAY_SECONDS,
    Math.round(milliseconds / MILLISECONDS_PER_SECOND),
  );
  return `Thought for ${seconds}s`;
}

export function getMessagePresentation(message: UIMessage): MessagePresentation {
  const thoughtLabel = message.thoughtDurationMs === undefined
    ? undefined
    : formatThoughtDuration(message.thoughtDurationMs);

  if (message.role === 'user') {
    return { prefix: USER_PREFIX, color: 'white', backgroundColor: 'gray' };
  }
  if (message.role === 'assistant') {
    return { prefix: ASSISTANT_PREFIX, color: 'white', thoughtLabel };
  }
  if (message.role === 'tool') return { prefix: TOOL_PREFIX, color: 'yellow' };
  return { prefix: SYSTEM_PREFIX, color: 'gray' };
}
