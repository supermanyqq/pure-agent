import { describe, expect, it } from 'vitest';
import type { Message } from '@pure-agent/core';
import { getNewTurnMessages } from '../turn-messages.js';

describe('getNewTurnMessages', () => {
  it('按 assistant 消息顺序配对本轮思考耗时', () => {
    const toolCall = {
      id: 'call-1',
      type: 'function' as const,
      function: { name: 'lookup', arguments: '{}' },
    };
    const messages: Message[] = [{ role: 'user', content: 'first question' }];
    const messageCountBeforeTurn = messages.length;
    const toolRequest: Message = {
      role: 'assistant',
      content: 'tool request',
      toolCalls: [toolCall],
    };
    const toolResult: Message = {
      role: 'tool',
      toolCallId: toolCall.id,
      content: 'result',
    };
    const assistantAnswer: Message = { role: 'assistant', content: 'first answer' };
    messages.push(toolRequest, toolResult, assistantAnswer);

    expect(getNewTurnMessages(messages, messageCountBeforeTurn, [1_000, 2_000])).toEqual([
      { message: toolRequest, thoughtDurationMs: 1_000 },
      { message: toolResult },
      { message: assistantAnswer, thoughtDurationMs: 2_000 },
    ]);
  });

  it('assistant 耗时不足时不添加 thoughtDurationMs', () => {
    const messages: Message[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'assistant', content: 'second answer' },
    ];

    expect(getNewTurnMessages(messages, 1, [1_000])).toEqual([
      { message: messages[1], thoughtDurationMs: 1_000 },
      { message: messages[2] },
    ]);
  });

  it('没有新消息时保持空数组', () => {
    const messages: Message[] = [{ role: 'user', content: 'first question' }];

    expect(getNewTurnMessages(messages, messages.length, [1_000])).toEqual([]);
  });
});
