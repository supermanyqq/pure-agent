import { describe, expect, it } from 'vitest';
import { CHAT_VIEW_LAYOUT, getAppHeight } from '../app-layout.js';

describe('getAppHeight', () => {
  it('保留可用的终端行数', () => {
    expect(getAppHeight(40)).toBe(40);
  });

  it('没有终端行数时不约束布局高度', () => {
    expect(getAppHeight(undefined)).toBeUndefined();
  });

  it('聊天视口不使用底部对齐，消息从顶部开始', () => {
    expect(CHAT_VIEW_LAYOUT).not.toHaveProperty('justifyContent');
    expect(CHAT_VIEW_LAYOUT).toMatchObject({
      flexDirection: 'column',
      flexGrow: 1,
      flexShrink: 1,
    });
  });
});
