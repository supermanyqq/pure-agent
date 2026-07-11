import { describe, expect, it } from 'vitest';
import { createSessionSettings, toReasoningOptions } from '../session-settings.js';

describe('session settings', () => {
  it('从模型和 effort 创建会话设置', () => {
    expect(createSessionSettings('deepseek-v4-pro', 'medium')).toEqual({
      model: 'deepseek-v4-pro',
      effort: 'medium',
    });
  });

  it('将 off 映射为禁用 thinking', () => {
    expect(toReasoningOptions('off')).toEqual({
      thinking: { type: 'disabled' },
    });
  });

  it('将 low 映射为启用 thinking 但不指定 reasoningEffort', () => {
    expect(toReasoningOptions('low')).toEqual({
      thinking: { type: 'enabled' },
    });
  });

  it('将 medium 映射为 DeepSeek high reasoning effort', () => {
    expect(toReasoningOptions('medium')).toEqual({
      thinking: { type: 'enabled' },
      reasoningEffort: 'high',
    });
  });

  it('将 high 映射为 DeepSeek max reasoning effort', () => {
    expect(toReasoningOptions('high')).toEqual({
      thinking: { type: 'enabled' },
      reasoningEffort: 'max',
    });
  });
});
