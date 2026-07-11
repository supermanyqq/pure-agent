import { describe, expect, it } from 'vitest';
import { getAppHeight } from '../app-layout.js';

describe('getAppHeight', () => {
  it('保留可用的终端行数', () => {
    expect(getAppHeight(40)).toBe(40);
  });

  it('没有终端行数时不约束布局高度', () => {
    expect(getAppHeight(undefined)).toBeUndefined();
  });
});
