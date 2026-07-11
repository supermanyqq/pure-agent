import { describe, expect, it } from 'vitest';
import {
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  resolveSupportedModel,
} from '../runtime-options.js';

describe('runtime options', () => {
  it('仅公开两个受支持的 DeepSeek 模型', () => {
    expect(MODEL_OPTIONS.map((option) => option.value)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
    ]);
  });

  it('公开固定的四档 reasoning effort', () => {
    expect(EFFORT_OPTIONS.map((option) => option.value)).toEqual([
      'off',
      'low',
      'medium',
      'high',
    ]);
  });

  it('将未知模型归一为默认的 Pro 模型', () => {
    expect(resolveSupportedModel('unknown-model')).toBe('deepseek-v4-pro');
  });
});
