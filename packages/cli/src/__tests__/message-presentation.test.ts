import { describe, expect, it } from 'vitest';
import {
  formatThoughtDuration,
  getMessagePresentation,
} from '../components/message-presentation.js';

describe('message presentation', () => {
  it('将不足一秒的真实耗时展示为 1s', () => {
    expect(formatThoughtDuration(200)).toBe('Thought for 1s');
  });

  it('将毫秒四舍五入为秒', () => {
    expect(formatThoughtDuration(3_450)).toBe('Thought for 3s');
  });

  it('为用户消息返回深色行和 › 前缀', () => {
    expect(getMessagePresentation({ id: 'user-1', role: 'user', content: 'hello' }))
      .toMatchObject({ prefix: '› ', backgroundColor: 'gray', color: 'white' });
  });

  it('为助手消息返回 ● 前缀且保留 Thought 耗时', () => {
    expect(getMessagePresentation({
      id: 'assistant-1',
      role: 'assistant',
      content: '你好',
      thoughtDurationMs: 3_450,
    })).toMatchObject({ prefix: '● ', color: 'white', thoughtLabel: 'Thought for 3s' });
  });
});
