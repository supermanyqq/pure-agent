import { describe, expect, it } from 'vitest';
import {
  getCommandCandidates,
  getNextCommandCompletion,
} from '../commands/completion.js';

describe('slash command completion', () => {
  it('返回当前 slash 前缀匹配的命令', () => {
    expect(getCommandCandidates('/mo').map((command) => command.name)).toEqual(['/model']);
  });

  it('补全唯一的带参数命令并追加空格', () => {
    expect(getNextCommandCompletion('/mo', null)).toEqual({
      input: '/model ',
      state: {
        prefix: '/mo',
        nextIndex: 0,
        lastInput: '/model ',
      },
    });
  });

  it('从根 slash 循环全部命令', () => {
    const first = getNextCommandCompletion('/', null);

    expect(first).toEqual({
      input: '/help',
      state: {
        prefix: '/',
        nextIndex: 1,
        lastInput: '/help',
      },
    });
    expect(getNextCommandCompletion('/help', first?.state ?? null)?.input).toBe('/new');
  });

  it('不补全普通消息或已有参数的命令', () => {
    expect(getNextCommandCompletion('explain context', null)).toBeNull();
    expect(getNextCommandCompletion('/model deepseek-v4-pro', null)).toBeNull();
  });
});
