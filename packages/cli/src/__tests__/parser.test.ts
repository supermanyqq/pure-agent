import { describe, expect, it } from 'vitest';
import { parseInput } from '../commands/parser.js';

describe('parseInput', () => {
  it('将普通文本保留为聊天消息', () => {
    expect(parseInput('解释一下上下文管理')).toEqual({
      kind: 'message',
      content: '解释一下上下文管理',
    });
  });

  it('解析模型切换命令', () => {
    expect(parseInput('/model deepseek-v4-flash')).toEqual({
      kind: 'command',
      command: { type: 'model', model: 'deepseek-v4-flash' },
    });
  });

  it('解析不带参数的查询命令', () => {
    expect(parseInput('/model')).toEqual({
      kind: 'command',
      command: { type: 'model' },
    });
    expect(parseInput('/effort')).toEqual({
      kind: 'command',
      command: { type: 'effort' },
    });
  });

  it('解析帮助和新会话命令', () => {
    expect(parseInput('/help')).toEqual({ kind: 'command', command: { type: 'help' } });
    expect(parseInput('/new')).toEqual({ kind: 'command', command: { type: 'new' } });
  });

  it('拒绝非法 effort 和未知命令', () => {
    expect(parseInput('/effort extreme')).toEqual({
      kind: 'invalid-command',
      message: expect.stringMatching(/off.*low.*medium.*high/i),
    });
    expect(parseInput('/missing')).toEqual({
      kind: 'invalid-command',
      message: expect.stringMatching(/unknown command/i),
    });
  });
});
