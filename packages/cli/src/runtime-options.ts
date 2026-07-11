import type { ReasoningEffort } from '@pure-agent/core';

export type SupportedModel = 'deepseek-v4-pro' | 'deepseek-v4-flash';

export interface RuntimeOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

export const DEFAULT_SUPPORTED_MODEL: SupportedModel = 'deepseek-v4-pro';

export const MODEL_OPTIONS: readonly RuntimeOption<SupportedModel>[] = [
  {
    value: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    description: 'Highest capability.',
  },
  {
    value: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    description: 'Fast and efficient.',
  },
];

export const EFFORT_OPTIONS: readonly RuntimeOption<ReasoningEffort>[] = [
  { value: 'off', label: 'Off', description: 'Disable model thinking.' },
  { value: 'low', label: 'Low', description: 'Use standard thinking.' },
  { value: 'medium', label: 'Medium', description: 'Use high reasoning effort.' },
  { value: 'high', label: 'High', description: 'Use maximum reasoning effort.' },
];

/** Returns whether a model ID belongs to the CLI's supported provider catalog. */
export function isSupportedModel(value: string): value is SupportedModel {
  return value === 'deepseek-v4-pro' || value === 'deepseek-v4-flash';
}

/** Converts persisted or supplied model IDs to a supported CLI model. */
export function resolveSupportedModel(value: string | undefined): SupportedModel {
  return value && isSupportedModel(value) ? value : DEFAULT_SUPPORTED_MODEL;
}
