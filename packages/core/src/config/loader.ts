import type {
  CliConfig,
  ConfigFileOptions,
  ProviderConfig,
  ReasoningEffort,
  StoredConfig,
} from './types.js';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-pro';
const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium';
const DEFAULT_MAX_TOKENS = 4_096;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 3;
const CONFIG_DIRECTORY_NAME = '.pure-agent';
const CONFIG_FILE_NAME = 'config.json';
const CONFIG_DIRECTORY_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
const JSON_INDENTATION_SPACES = 2;
const TEMPORARY_FILE_SUFFIX = '.tmp';
const API_KEY_DISPLAY_PREFIX_LENGTH = 3;
const API_KEY_START_INDEX = 0;
const DECIMAL_RADIX = 10;
const FILE_NOT_FOUND_ERROR_CODE = 'ENOENT';
const CONFIG_FILE_ENCODING = 'utf8';
const CONFIG_FILE_NEWLINE = '\n';

/** Returns the default per-user configuration file path. */
export function getConfigFilePath(): string {
  return join(homedir(), CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);
}

/**
 * Reads the persisted JSON configuration without environment-variable overrides.
 * Missing files produce an empty configuration; invalid JSON must be surfaced to writers.
 */
export function readStoredConfig(options: ConfigFileOptions = {}): StoredConfig {
  const configPath = resolveConfigPath(options);
  try {
    const raw = readFileSync(configPath, CONFIG_FILE_ENCODING);
    return parseStoredConfig(raw, configPath);
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) return {};
    throw error;
  }
}

/** Saves an API Key without exposing it in command output or error messages. */
export function saveApiKey(apiKey: string, options: ConfigFileOptions = {}): void {
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) {
    throw new Error('API key must not be empty');
  }

  const configPath = resolveConfigPath(options);
  const current = readStoredConfig({ configPath });
  const provider = isRecord(current.provider) ? current.provider : {};
  const next: StoredConfig = {
    ...current,
    provider: {
      ...provider,
      apiKey: normalizedApiKey,
    },
  };
  const directoryPath = dirname(configPath);
  const temporaryConfigPath = `${configPath}${TEMPORARY_FILE_SUFFIX}`;
  const serialized = `${JSON.stringify(next, null, JSON_INDENTATION_SPACES)}${CONFIG_FILE_NEWLINE}`;

  mkdirSync(directoryPath, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
  chmodSync(directoryPath, CONFIG_DIRECTORY_MODE);
  writeFileSync(temporaryConfigPath, serialized, {
    encoding: CONFIG_FILE_ENCODING,
    mode: CONFIG_FILE_MODE,
  });
  chmodSync(temporaryConfigPath, CONFIG_FILE_MODE);
  renameSync(temporaryConfigPath, configPath);
  chmodSync(configPath, CONFIG_FILE_MODE);
}

/** Returns an API Key display value that never includes the complete secret. */
export function redactApiKey(apiKey: string | undefined): string {
  if (!apiKey) return 'not configured';
  if (apiKey.length <= API_KEY_DISPLAY_PREFIX_LENGTH) return '***';
  return `${apiKey.slice(API_KEY_START_INDEX, API_KEY_DISPLAY_PREFIX_LENGTH)}…`;
}

/** Loads the CLI-only defaults that do not require an API Key. */
export function loadCliConfig(options: ConfigFileOptions = {}): CliConfig {
  try {
    const storedConfig = readStoredConfig(options);
    const cli = isRecord(storedConfig.cli) ? storedConfig.cli : {};
    const defaultEffort = cli['defaultEffort'];
    return {
      defaultEffort: isReasoningEffort(defaultEffort)
        ? defaultEffort
        : DEFAULT_REASONING_EFFORT,
    };
  } catch {
    return { defaultEffort: DEFAULT_REASONING_EFFORT };
  }
}

/**
 * 从 ~/.pure-agent/config.json 读取配置。
 * 文件不存在或解析失败时返回空对象（不中断加载链路）。
 */
function loadConfigFile(): Partial<ProviderConfig> {
  try {
    const parsed = readStoredConfig();
    const provider = isRecord(parsed.provider) ? parsed.provider : {};
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

function resolveConfigPath(options: ConfigFileOptions): string {
  return options.configPath ?? getConfigFilePath();
}

function parseStoredConfig(raw: string, configPath: string): StoredConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Configuration file contains invalid JSON: ${configPath}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Configuration file must contain a JSON object: ${configPath}`);
  }
  return parsed;
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && error.code === FILE_NOT_FOUND_ERROR_CODE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high';
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

  const config: ProviderConfig = {
    apiKey,
    baseUrl: overrides?.baseUrl ?? process.env.PURE_AGENT_BASE_URL ?? fileConfig.baseUrl ?? DEFAULT_BASE_URL,
    defaultModel: overrides?.defaultModel ?? process.env.PURE_AGENT_MODEL ?? fileConfig.defaultModel ?? DEFAULT_MODEL,
    maxTokens: overrides?.maxTokens ?? parseEnvInt('PURE_AGENT_MAX_TOKENS') ?? fileConfig.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature:
      overrides?.temperature ?? parseEnvFloat('PURE_AGENT_TEMPERATURE') ?? fileConfig.temperature ?? DEFAULT_TEMPERATURE,
    timeout: overrides?.timeout ?? parseEnvInt('PURE_AGENT_TIMEOUT') ?? fileConfig.timeout ?? DEFAULT_TIMEOUT_MS,
    maxRetries: overrides?.maxRetries ?? parseEnvInt('PURE_AGENT_MAX_RETRIES') ?? fileConfig.maxRetries ?? DEFAULT_MAX_RETRIES,
  };

  return validateProviderConfig(config);
}

function parseEnvInt(key: string): number | undefined {
  const v = process.env[key];
  if (v === undefined) return undefined;
  // 完整字符串校验：拒绝 "3abc" 这类部分数字
  if (!/^-?\d+$/.test(v.trim())) return undefined;
  const n = parseInt(v, DECIMAL_RADIX);
  return isNaN(n) ? undefined : n;
}

function parseEnvFloat(key: string): number | undefined {
  const v = process.env[key];
  if (v === undefined) return undefined;
  // 完整字符串校验：拒绝非数字内容
  if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return undefined;
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}

/**
 * 校验 ProviderConfig 的语义合法性。
 * 在合并所有来源后调用，非法配置立即失败。
 */
function validateProviderConfig(config: ProviderConfig): ProviderConfig {
  if (!Number.isFinite(config.maxTokens) || config.maxTokens <= 0) {
    throw new Error('maxTokens must be a positive finite number');
  }
  if (!Number.isFinite(config.timeout) || config.timeout <= 0) {
    throw new Error('timeout must be a positive finite number');
  }
  if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0) {
    throw new Error('maxRetries must be a non-negative integer');
  }
  if (!Number.isFinite(config.temperature)) {
    throw new Error('temperature must be finite');
  }
  try {
    const url = new URL(config.baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('baseUrl must use http or https');
    }
  } catch {
    throw new Error('baseUrl is not a valid URL');
  }
  return config;
}
