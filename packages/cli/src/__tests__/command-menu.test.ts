import { describe, expect, it } from 'vitest';
import { getVisibleCommands } from '../components/CommandMenu.js';
import { SLASH_COMMANDS } from '../commands/parser.js';

describe('getVisibleCommands', () => {
  it('只显示匹配的斜杠命令', () => {
    expect(getVisibleCommands('/mo')).toEqual([
      expect.objectContaining({ name: '/model' }),
    ]);
  });

  it('普通聊天输入不显示命令菜单', () => {
    expect(getVisibleCommands('explain context management')).toEqual([]);
  });

  it('单独输入 / 时显示全部命令', () => {
    expect(getVisibleCommands('/')).toEqual(SLASH_COMMANDS);
  });
});
