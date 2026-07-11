import {
  getConfigFilePath,
  readStoredConfig,
  redactApiKey,
  saveApiKey,
} from '@pure-agent/core';

const SHOW_COMMAND = 'show';
const SET_COMMAND = 'set';
const API_KEY_SETTING = 'api-key';
const STDIN_OPTION = '--stdin';
const NEWLINE = '\n';
const API_KEY_PROMPT = 'API key: ';
const API_KEY_SAVED_MESSAGE = 'API key saved.';
const CTRL_C_CHARACTER = '\u0003';
const BACKSPACE_CHARACTER = '\b';
const DELETE_CHARACTER = '\u007f';
const CARRIAGE_RETURN_CHARACTER = '\r';
const ENTER_CHARACTER = '\n';
const NO_ARGUMENTS = 0;
const FIRST_ARGUMENT_INDEX = 0;
const API_KEY_ARGUMENT_OFFSET = 1;
const INPUT_START_INDEX = 0;
const LAST_CHARACTER_OFFSET = -1;
const CONFIG_USAGE =
  'Usage: pure-agent config show | pure-agent config set api-key [--stdin]';

export interface TextOutput {
  write(chunk: string): unknown;
}

export interface ConfigCommandDependencies {
  input: AsyncIterable<unknown>;
  output: TextOutput;
  configPath?: string;
  isInteractive: boolean;
}

interface RawModeInput extends AsyncIterable<unknown> {
  isRaw?: boolean;
  resume(): void;
  setRawMode(mode: boolean): void;
}

/** Runs a top-level `pure-agent config` command. */
export async function runConfigCommand(
  args: string[],
  dependencies: ConfigCommandDependencies,
): Promise<void> {
  const [command, ...rest] = args;
  if (command === SHOW_COMMAND && rest.length === NO_ARGUMENTS) {
    showConfig(dependencies);
    return;
  }
  if (command === SET_COMMAND && rest[FIRST_ARGUMENT_INDEX] === API_KEY_SETTING) {
    await setApiKey(rest.slice(API_KEY_ARGUMENT_OFFSET), dependencies);
    return;
  }
  throw new Error(CONFIG_USAGE);
}

function showConfig(dependencies: ConfigCommandDependencies): void {
  const storedConfig = readStoredConfig({ configPath: dependencies.configPath });
  const provider = storedConfig.provider;
  const apiKey = provider && typeof provider['apiKey'] === 'string'
    ? provider['apiKey']
    : undefined;
  const configPath = dependencies.configPath ?? getConfigFilePath();

  dependencies.output.write(`API Key: ${redactApiKey(apiKey)}${NEWLINE}`);
  dependencies.output.write(`Config file: ${configPath}${NEWLINE}`);
}

async function setApiKey(
  args: string[],
  dependencies: ConfigCommandDependencies,
): Promise<void> {
  const apiKey = await readApiKey(args, dependencies);
  saveApiKey(apiKey, { configPath: dependencies.configPath });
  dependencies.output.write(`${API_KEY_SAVED_MESSAGE}${NEWLINE}`);
}

async function readApiKey(
  args: string[],
  dependencies: ConfigCommandDependencies,
): Promise<string> {
  if (args.length === API_KEY_ARGUMENT_OFFSET && args[FIRST_ARGUMENT_INDEX] === STDIN_OPTION) {
    return readTrimmedInput(dependencies.input);
  }
  if (args.length > NO_ARGUMENTS) throw new Error(CONFIG_USAGE);
  if (!dependencies.isInteractive) {
    throw new Error('Non-interactive API key configuration requires --stdin.');
  }
  return readHiddenInput(dependencies.input, dependencies.output);
}

async function readTrimmedInput(input: AsyncIterable<unknown>): Promise<string> {
  let value = '';
  for await (const chunk of input) {
    value += String(chunk);
  }
  return value.trim();
}

async function readHiddenInput(
  input: AsyncIterable<unknown>,
  output: TextOutput,
): Promise<string> {
  if (!isRawModeInput(input)) {
    throw new Error('Interactive API key input is unavailable on this terminal. Use --stdin.');
  }

  const wasRaw = input.isRaw ?? false;
  let value = '';
  output.write(API_KEY_PROMPT);
  input.setRawMode(true);
  input.resume();

  try {
    for await (const chunk of input) {
      for (const character of String(chunk)) {
        if (character === CTRL_C_CHARACTER) {
          throw new Error('API key input cancelled.');
        }
        if (character === ENTER_CHARACTER || character === CARRIAGE_RETURN_CHARACTER) {
          output.write(NEWLINE);
          return value.trim();
        }
        if (character === BACKSPACE_CHARACTER || character === DELETE_CHARACTER) {
          value = value.slice(INPUT_START_INDEX, LAST_CHARACTER_OFFSET);
          continue;
        }
        value += character;
      }
    }
  } finally {
    input.setRawMode(wasRaw);
  }

  throw new Error('API key input ended before confirmation.');
}

function isRawModeInput(input: AsyncIterable<unknown>): input is RawModeInput {
  const candidate = input as Partial<RawModeInput>;
  return typeof candidate.setRawMode === 'function' && typeof candidate.resume === 'function';
}
