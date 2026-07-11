import { describe, expect, it } from 'vitest';
import type { Message } from '@pure-agent/core';
import { getNewTurnMessages } from '../turn-messages.js';

describe('getNewTurnMessages', () => {
  it('使用调用前消息数提取原地追加的本轮消息', () => {
    const messages: Message[] = [{ role: 'user', content: 'first question' }];
    const messageCountBeforeTurn = messages.length;
    const assistantMessage: Message = { role: 'assistant', content: 'first answer' };
    messages.push(assistantMessage);

    expect(getNewTurnMessages(messages, messageCountBeforeTurn)).toEqual([
      assistantMessage,
    ]);
    expect(getNewTurnMessages(messages, messages.length)).toEqual([]);
  });
});
