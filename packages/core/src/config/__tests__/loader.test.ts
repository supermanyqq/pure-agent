import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasConfiguredApiKey,
  loadCliConfig,
  loadProviderConfig,
  readStoredConfig,
  redactApiKey,
  saveApiKey,
} from '../loader.js';

const TEST_DIRECTORY_PREFIX = 'pure-agent-config-';
const TEST_CONFIG_FILE_NAME = 'config.json';
const TEST_API_KEY = 'sk-test-1234567890';
const ORIGINAL_CONFIG_JSON = JSON.stringify({
  featureFlag: true,
  provider: { baseUrl: 'https://api.example.com' },
});
const CONFIG_FILE_MODE = 0o600;
const FILE_PERMISSION_MASK = 0o777;

let temporaryDirectory: string;
let configPath: string;

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
  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), TEST_DIRECTORY_PREFIX));
    configPath = join(temporaryDirectory, TEST_CONFIG_FILE_NAME);
  });

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
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

  it('保存 API Key 时保留未知字段并限制文件权限', () => {
    writeFileSync(configPath, ORIGINAL_CONFIG_JSON);

    saveApiKey(TEST_API_KEY, { configPath });

    expect(readStoredConfig({ configPath })).toEqual({
      featureFlag: true,
      provider: {
        apiKey: TEST_API_KEY,
        baseUrl: 'https://api.example.com',
      },
    });
    expect(readFileSync(configPath, 'utf8')).toContain('"featureFlag": true');
    expect(statSync(configPath).mode & FILE_PERMISSION_MASK).toBe(CONFIG_FILE_MODE);
  });

  it('拒绝空白 API Key 且不覆盖已有配置', () => {
    writeFileSync(configPath, ORIGINAL_CONFIG_JSON);

    expect(() => saveApiKey('   ', { configPath })).toThrow(/API key/i);
    expect(readFileSync(configPath, 'utf8')).toBe(ORIGINAL_CONFIG_JSON);
  });

  it('脱敏 API Key 不会泄露完整值', () => {
    expect(redactApiKey(TEST_API_KEY)).not.toContain(TEST_API_KEY);
    expect(redactApiKey(undefined)).toMatch(/not configured/i);
  });

  it('从持久化配置加载有效的默认思考深度', () => {
    writeFileSync(configPath, JSON.stringify({ cli: { defaultEffort: 'high' } }));

    expect(loadCliConfig({ configPath })).toEqual({ defaultEffort: 'high' });
  });

  it('配置文件包含非空 API Key 时报告为已配置', () => {
    writeFileSync(configPath, JSON.stringify({ provider: { apiKey: TEST_API_KEY } }));

    withEnv('PURE_AGENT_API_KEY', undefined, () => {
      expect(hasConfiguredApiKey({ configPath })).toBe(true);
    });
  });

  it('环境变量 API Key 优先于空白文件配置', () => {
    writeFileSync(configPath, JSON.stringify({ provider: { apiKey: '  ' } }));

    withEnv('PURE_AGENT_API_KEY', TEST_API_KEY, () => {
      expect(hasConfiguredApiKey({ configPath })).toBe(true);
    });
  });

  it('没有有效 API Key 时报告为未配置', () => {
    writeFileSync(configPath, JSON.stringify({ provider: { apiKey: '  ' } }));

    withEnv('PURE_AGENT_API_KEY', undefined, () => {
      expect(hasConfiguredApiKey({ configPath })).toBe(false);
    });
  });
});
