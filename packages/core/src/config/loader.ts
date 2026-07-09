import type { ProviderConfig } from './types.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-pro';
const DEFAULT_MAX_TOKENS = 4_096;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 3;
const CONFIG_FILE_PATH = join(homedir(), '.pure-agent', 'config.json');

/**
 * 从 ~/.pure-agent/config.json 读取配置。
 * 文件不存在或解析失败时返回空对象（不中断加载链路）。
 */
function loadConfigFile(): Partial<ProviderConfig> {
  try {
    const raw = readFileSync(CONFIG_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const provider = (parsed['provider'] as Record<string, unknown>) ?? {};
    return {
      apiKey: typeof provider['apiKey'] === 'string' ? provider['apiKey'] : undefined,
      baseUrl: typeof provider['baseUrl'] === 'string' ? provider['baseUrl'] : undefined,
      defaultModel: typeof provider['defaultModel'] === 'string' ? provider['defaultModel'] : undefined,
      maxTokens: typeof provider['maxTokens'] === 'number' ? provider['maxTokens'] : undefined,
      temperature: typeof provider['temperature'] === 'number' ? provider['temperature'] : undefined,
      timeout: typeof provider['timeout'] === 'number' ? provider['timeout'] : undefined,
      maxRetries: typeof provider['maxRetries'] === 'number' ? provider['maxRetries'] : undefined,
    };
  } catch {
    // 文件不存在或解析失败 → 静默跳过
    return {};
  }
}

/**
 * 加载 Provider 配置。
 *
 * 优先级：传入 overrides > 环境变量 > ~/.pure-agent/config.json > 默认值
 * API Key 必须通过 overrides、环境变量或配置文件提供。
 */
export function loadProviderConfig(overrides?: Partial<ProviderConfig>): ProviderConfig {
  const fileConfig = loadConfigFile();
  const apiKey = overrides?.apiKey ?? process.env.PURE_AGENT_API_KEY ?? fileConfig.apiKey;

  if (!apiKey) {
    throw new Error(
      'API key is required. Set PURE_AGENT_API_KEY environment variable, ' +
      'configure ~/.pure-agent/config.json, or pass { apiKey } to loadProviderConfig().',
    );
  }

  return {
    apiKey,
    baseUrl: overrides?.baseUrl ?? process.env.PURE_AGENT_BASE_URL ?? fileConfig.baseUrl ?? DEFAULT_BASE_URL,
    defaultModel: overrides?.defaultModel ?? process.env.PURE_AGENT_MODEL ?? fileConfig.defaultModel ?? DEFAULT_MODEL,
    maxTokens: overrides?.maxTokens ?? parseEnvInt('PURE_AGENT_MAX_TOKENS') ?? fileConfig.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature:
      overrides?.temperature ?? parseEnvFloat('PURE_AGENT_TEMPERATURE') ?? fileConfig.temperature ?? DEFAULT_TEMPERATURE,
    timeout: overrides?.timeout ?? parseEnvInt('PURE_AGENT_TIMEOUT') ?? fileConfig.timeout ?? DEFAULT_TIMEOUT_MS,
    maxRetries: overrides?.maxRetries ?? parseEnvInt('PURE_AGENT_MAX_RETRIES') ?? fileConfig.maxRetries ?? DEFAULT_MAX_RETRIES,
  };
}

function parseEnvInt(key: string): number | undefined {
  const v = process.env[key];
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return isNaN(n) ? undefined : n;
}

function parseEnvFloat(key: string): number | undefined {
  const v = process.env[key];
  if (v === undefined) return undefined;
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}
