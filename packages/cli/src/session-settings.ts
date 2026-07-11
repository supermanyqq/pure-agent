import type { ReasoningEffort } from '@pure-agent/core';
import type { SupportedModel } from './runtime-options.js';

const THINKING_ENABLED = { type: 'enabled' as const };
const THINKING_DISABLED = { type: 'disabled' as const };

export interface SessionSettings {
  model: SupportedModel;
  effort: ReasoningEffort;
}

export interface ReasoningOptions {
  thinking: { type: 'enabled' | 'disabled' };
  reasoningEffort?: 'high' | 'max';
}

/** Creates the mutable settings that apply to future requests in one session. */
export function createSessionSettings(
  model: SupportedModel,
  effort: ReasoningEffort,
): SessionSettings {
  return { model, effort };
}

/** Maps the CLI's four effort levels to DeepSeek-compatible request options. */
export function toReasoningOptions(effort: ReasoningEffort): ReasoningOptions {
  if (effort === 'off') return { thinking: THINKING_DISABLED };
  if (effort === 'low') return { thinking: THINKING_ENABLED };
  if (effort === 'medium') {
    return { thinking: THINKING_ENABLED, reasoningEffort: 'high' };
  }
  return { thinking: THINKING_ENABLED, reasoningEffort: 'max' };
}
