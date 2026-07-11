import { SLASH_COMMANDS } from './parser.js';
import type { SlashCommandDefinition } from './parser.js';

const COMMAND_PREFIX = '/';
const SPACE_SEPARATOR = ' ';
const FIRST_CANDIDATE_INDEX = 0;
const NEXT_CANDIDATE_INCREMENT = 1;

export interface CommandCompletionState {
  prefix: string;
  nextIndex: number;
  lastInput: string;
}

export interface CommandCompletionResult {
  input: string;
  state: CommandCompletionState;
}

/** Returns commands whose name begins with one slash-only input token. */
export function getCommandCandidates(input: string): readonly SlashCommandDefinition[] {
  if (!isCommandNamePrefix(input)) return [];
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(input));
}

/** Completes a slash command and cycles candidates only while the input remains unchanged. */
export function getNextCommandCompletion(
  input: string,
  previousState: CommandCompletionState | null,
): CommandCompletionResult | null {
  const isCycling = previousState !== null && input === previousState.lastInput;
  const prefix = isCycling ? previousState.prefix : input;
  const candidates = getCommandCandidates(prefix);
  if (candidates.length === 0) return null;

  const candidateIndex = isCycling
    ? previousState.nextIndex % candidates.length
    : FIRST_CANDIDATE_INDEX;
  const command = candidates[candidateIndex];
  const completedInput = command.acceptsArguments
    ? `${command.name}${SPACE_SEPARATOR}`
    : command.name;
  const nextIndex = (candidateIndex + NEXT_CANDIDATE_INCREMENT) % candidates.length;

  return {
    input: completedInput,
    state: { prefix, nextIndex, lastInput: completedInput },
  };
}

function isCommandNamePrefix(input: string): boolean {
  return input.startsWith(COMMAND_PREFIX) && !input.includes(SPACE_SEPARATOR);
}
