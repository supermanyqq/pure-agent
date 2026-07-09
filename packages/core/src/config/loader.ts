import type { ProviderConfig } from './types.js';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_MAX_TOKENS = 4_096;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 3;

/**
 * 从环境变量加载 Provider 配置。
 *
 * 优先级：环境变量 > 默认值
 *
 * 环境变量：
 * - PURE_AGENT_API_KEY（必需）
 * - PURE_AGENT_BASE_URL
 * - PURE_AGENT_MODEL
 * - PURE_AGENT_MAX_TOKENS
 * - PURE_AGENT_TEMPERATURE
 * - PURE_AGENT_TIMEOUT
 * - PURE_AGENT_MAX_RETRIES
 */
export function loadProviderConfig(overrides?: Partial<ProviderConfig>): ProviderConfig {
  const apiKey = overrides?.apiKey ?? process.env.PURE_AGENT_API_KEY;
  if (!apiKey) {
    throw new Error(
      'PURE_AGENT_API_KEY environment variable is required.\n' +
        'Set it via: export PURE_AGENT_API_KEY=sk-...\n' +
        'Or get a key from https://api-docs.deepseek.com/',
    );
  }

  return {
    apiKey,
    baseUrl: overrides?.baseUrl ?? process.env.PURE_AGENT_BASE_URL ?? DEFAULT_BASE_URL,
    defaultModel: overrides?.defaultModel ?? process.env.PURE_AGENT_MODEL ?? DEFAULT_MODEL,
    maxTokens: overrides?.maxTokens ?? parseEnvInt('PURE_AGENT_MAX_TOKENS') ?? DEFAULT_MAX_TOKENS,
    temperature:
      overrides?.temperature ?? parseEnvFloat('PURE_AGENT_TEMPERATURE') ?? DEFAULT_TEMPERATURE,
    timeout: overrides?.timeout ?? parseEnvInt('PURE_AGENT_TIMEOUT') ?? DEFAULT_TIMEOUT_MS,
    maxRetries: overrides?.maxRetries ?? parseEnvInt('PURE_AGENT_MAX_RETRIES') ?? DEFAULT_MAX_RETRIES,
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
