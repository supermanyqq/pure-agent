import { describe, it, expect, afterEach } from 'vitest';
import { loadProviderConfig } from '../loader.js';

// 保存和恢复环境变量
function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const original = process.env[key];
  try {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
    fn();
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

describe('loadProviderConfig', () => {
  afterEach(() => {
    // 清理可能残留的测试环境变量
  });

  it('缺少 apiKey 时抛出明确错误', () => {
    withEnv('PURE_AGENT_API_KEY', undefined, () => {
      expect(() => loadProviderConfig()).toThrow(/API key is required/i);
    });
  });

  it('拒绝非正数 maxTokens', () => {
    withEnv('PURE_AGENT_API_KEY', 'sk-test', () => {
      expect(() => loadProviderConfig({ maxTokens: 0 })).toThrow(/maxTokens/i);
      expect(() => loadProviderConfig({ maxTokens: -1 })).toThrow(/maxTokens/i);
      expect(() => loadProviderConfig({ maxTokens: NaN })).toThrow(/maxTokens/i);
      expect(() => loadProviderConfig({ maxTokens: Infinity })).toThrow(/maxTokens/i);
    });
  });

  it('拒绝非正数 timeout', () => {
    withEnv('PURE_AGENT_API_KEY', 'sk-test', () => {
      expect(() => loadProviderConfig({ timeout: 0 })).toThrow(/timeout/i);
      expect(() => loadProviderConfig({ timeout: -100 })).toThrow(/timeout/i);
    });
  });

  it('拒绝负数或非整数 maxRetries', () => {
    withEnv('PURE_AGENT_API_KEY', 'sk-test', () => {
      expect(() => loadProviderConfig({ maxRetries: -1 })).toThrow(/maxRetries/i);
      expect(() => loadProviderConfig({ maxRetries: 1.5 })).toThrow(/maxRetries/i);
    });
  });

  it('拒绝非有限 temperature', () => {
    withEnv('PURE_AGENT_API_KEY', 'sk-test', () => {
      expect(() => loadProviderConfig({ temperature: NaN })).toThrow(/temperature/i);
      expect(() => loadProviderConfig({ temperature: Infinity })).toThrow(/temperature/i);
    });
  });

  it('拒绝非 http/https baseUrl', () => {
    withEnv('PURE_AGENT_API_KEY', 'sk-test', () => {
      expect(() => loadProviderConfig({ baseUrl: 'ftp://api.example.com' })).toThrow(/baseUrl/i);
      expect(() => loadProviderConfig({ baseUrl: 'not-a-url' })).toThrow(/baseUrl/i);
    });
  });

  it('overrides 优先于环境变量和配置文件', () => {
    withEnv('PURE_AGENT_API_KEY', 'sk-test', () => {
      const config = loadProviderConfig({ maxTokens: 9999 });
      expect(config.maxTokens).toBe(9999);
    });
  });

  it('正常配置加载成功', () => {
    withEnv('PURE_AGENT_API_KEY', 'sk-test', () => {
      const config = loadProviderConfig({
        baseUrl: 'https://api.example.com',
        maxTokens: 4096,
        timeout: 60000,
        maxRetries: 2,
        temperature: 0.5,
      });
      expect(config.apiKey).toBe('sk-test');
      expect(config.maxTokens).toBe(4096);
      expect(config.temperature).toBe(0.5);
    });
  });
});
