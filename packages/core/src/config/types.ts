export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  maxTokens: number;
  temperature: number;
  timeout: number;
  maxRetries: number;
}
