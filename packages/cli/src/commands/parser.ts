import type { ReasoningEffort } from '@pure-agent/core';

const COMMAND_PREFIX = '/';
const EMPTY_ARGUMENT_COUNT = 0;
const SINGLE_ARGUMENT_COUNT = 1;
const FIRST_ARGUMENT_INDEX = 0;
const SPACE_SEPARATOR = ' ';
const HELP_COMMAND = '/help';
const NEW_COMMAND = '/new';
const MODEL_COMMAND = '/model';
const EFFORT_COMMAND = '/effort';
const EFFORT_VALUES = 'off, low, medium, high';

export interface SlashCommandDefinition {
  name: string;
  usage: string;
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
  { name: HELP_COMMAND, usage: HELP_COMMAND, description: 'Show available commands.' },
  { name: NEW_COMMAND, usage: NEW_COMMAND, description: 'Start a new conversation.' },
  { name: MODEL_COMMAND, usage: `${MODEL_COMMAND} <model-id>`, description: 'Show or switch the model.' },
  {
    name: EFFORT_COMMAND,
    usage: `${EFFORT_COMMAND} <off|low|medium|high>`,
    description: 'Show or switch reasoning effort.',
  },
];

export type SlashCommand =
  | { type: 'help' }
  | { type: 'new' }
  | { type: 'model'; model?: string }
  | { type: 'effort'; effort?: ReasoningEffort };

export type ParsedInput =
  | { kind: 'message'; content: string }
  | { kind: 'command'; command: SlashCommand }
  | { kind: 'invalid-command'; message: string };

/** Classifies chat text and supported interactive slash commands. */
export function parseInput(input: string): ParsedInput {
  const trimmedInput = input.trim();
  if (!trimmedInput.startsWith(COMMAND_PREFIX)) {
    return { kind: 'message', content: input };
  }

  const [name, ...args] = trimmedInput.split(/\s+/);
  if (name === HELP_COMMAND) return parseArgumentFreeCommand(args, { type: 'help' });
  if (name === NEW_COMMAND) return parseArgumentFreeCommand(args, { type: 'new' });
  if (name === MODEL_COMMAND) return parseModelCommand(args);
  if (name === EFFORT_COMMAND) return parseEffortCommand(args);
  return { kind: 'invalid-command', message: `Unknown command: ${name}` };
}

function parseArgumentFreeCommand(
  args: string[],
  command: Extract<SlashCommand, { type: 'help' | 'new' }>,
): ParsedInput {
  if (args.length === EMPTY_ARGUMENT_COUNT) {
    return { kind: 'command', command };
  }
  return { kind: 'invalid-command', message: `Usage: /${command.type}` };
}

function parseModelCommand(args: string[]): ParsedInput {
  if (args.length === EMPTY_ARGUMENT_COUNT) {
    return { kind: 'command', command: { type: 'model' } };
  }
  const model = args.join(SPACE_SEPARATOR).trim();
  if (!model) return { kind: 'invalid-command', message: `Usage: ${MODEL_COMMAND} <model-id>` };
  return { kind: 'command', command: { type: 'model', model } };
}

function parseEffortCommand(args: string[]): ParsedInput {
  if (args.length === EMPTY_ARGUMENT_COUNT) {
    return { kind: 'command', command: { type: 'effort' } };
  }
  if (args.length !== SINGLE_ARGUMENT_COUNT) {
    return { kind: 'invalid-command', message: `Usage: ${EFFORT_COMMAND} <${EFFORT_VALUES}>` };
  }
  const effort = args[FIRST_ARGUMENT_INDEX];
  if (!isReasoningEffort(effort)) {
    return { kind: 'invalid-command', message: `Effort must be one of: ${EFFORT_VALUES}.` };
  }
  return { kind: 'command', command: { type: 'effort', effort } };
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high';
}
