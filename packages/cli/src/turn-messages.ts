import type { Message } from '@pure-agent/core';

export interface NewTurnMessage {
  message: Message;
  thoughtDurationMs?: number;
  reasoningContent?: string;
}

const FIRST_DURATION_INDEX = 0;
const NEXT_DURATION_INDEX = 1;

/** Returns messages appended by one AgentLoop turn with matching assistant thought durations. */
export function getNewTurnMessages(
  messages: Message[],
  messageCountBeforeTurn: number,
  thoughtDurationsMs: readonly number[],
): NewTurnMessage[] {
  let durationIndex = FIRST_DURATION_INDEX;
  return messages.slice(messageCountBeforeTurn).map((message) => {
    if (message.role !== 'assistant') return { message };

    const thoughtDurationMs = thoughtDurationsMs[durationIndex];
    durationIndex += NEXT_DURATION_INDEX;
    const reasoningContent = 'reasoningContent' in message ? (message as { reasoningContent?: string }).reasoningContent : undefined;
    return { message, thoughtDurationMs, reasoningContent };
  });
}
