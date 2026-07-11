import type { Message } from '@pure-agent/core';

/** Returns messages appended by one AgentLoop turn to a mutable history array. */
export function getNewTurnMessages(
  messages: Message[],
  messageCountBeforeTurn: number,
): Message[] {
  return messages.slice(messageCountBeforeTurn);
}
