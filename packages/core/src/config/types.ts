export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  maxTokens: number;
  temperature: number;
  timeout: number;
  maxRetries: number;
}

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export interface CliConfig {
  defaultEffort: ReasoningEffort;
}

export interface StoredConfigSection {
  [key: string]: unknown;
}

export interface StoredConfig {
  [key: string]: unknown;
  provider?: StoredConfigSection;
  cli?: StoredConfigSection;
}

export interface ConfigFileOptions {
  configPath?: string;
}
