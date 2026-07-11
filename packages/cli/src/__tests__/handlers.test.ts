import { describe, expect, it } from 'vitest';
import { applySlashCommand } from '../commands/handlers.js';

const INITIAL_SETTINGS = {
  model: 'deepseek-v4-pro',
  effort: 'medium' as const,
};

describe('applySlashCommand', () => {
  it('切换模型但保持 effort', () => {
    expect(applySlashCommand({ type: 'model', model: 'deepseek-v4-flash' }, INITIAL_SETTINGS))
      .toEqual({
        kind: 'notice',
        settings: { model: 'deepseek-v4-flash', effort: 'medium' },
        message: 'Model switched to deepseek-v4-flash.',
      });
  });

  it('查询模型不会修改设置', () => {
    expect(applySlashCommand({ type: 'model' }, INITIAL_SETTINGS)).toEqual({
      kind: 'notice',
      settings: INITIAL_SETTINGS,
      message: 'Current model: deepseek-v4-pro.',
    });
  });

  it('切换 effort 但保持模型', () => {
    expect(applySlashCommand({ type: 'effort', effort: 'high' }, INITIAL_SETTINGS)).toEqual({
      kind: 'notice',
      settings: { model: 'deepseek-v4-pro', effort: 'high' },
      message: 'Reasoning effort switched to high.',
    });
  });

  it('new 请求重置会话但保留设置', () => {
    expect(applySlashCommand({ type: 'new' }, INITIAL_SETTINGS)).toEqual({
      kind: 'reset',
      settings: INITIAL_SETTINGS,
      message: 'Started a new conversation.',
    });
  });

  it('help 返回命令帮助而不修改设置', () => {
    const result = applySlashCommand({ type: 'help' }, INITIAL_SETTINGS);

    expect(result.kind).toBe('notice');
    expect(result.settings).toEqual(INITIAL_SETTINGS);
    expect(result.message).toContain('/model');
    expect(result.message).toContain('/effort');
    expect(result.message).toContain('/config');
  });

  it('配置命令返回 UI 配置意图而不修改设置', () => {
    expect(applySlashCommand({ type: 'config', action: 'show' }, INITIAL_SETTINGS)).toEqual({
      kind: 'config',
      action: 'show',
      settings: INITIAL_SETTINGS,
    });
    expect(applySlashCommand({ type: 'config', action: 'set-api-key' }, INITIAL_SETTINGS)).toEqual({
      kind: 'config',
      action: 'set-api-key',
      settings: INITIAL_SETTINGS,
    });
  });
});
