import { Box, Text } from 'ink';
import { SLASH_COMMANDS } from '../commands/parser.js';
import type { SlashCommandDefinition } from '../commands/parser.js';

const COMMAND_PREFIX = '/';
const EMPTY_COMMAND_QUERY = COMMAND_PREFIX;
const HELP_SEPARATOR = ' — ';

export interface CommandMenuProps {
  input: string;
}

/** Returns commands matching the current slash-command prefix. */
export function getVisibleCommands(input: string): readonly SlashCommandDefinition[] {
  const query = input.trimStart().toLowerCase();
  if (!query.startsWith(COMMAND_PREFIX)) return [];
  if (query === EMPTY_COMMAND_QUERY) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(query));
}

/** Renders lightweight command discovery above the interactive input. */
export function CommandMenu({ input }: CommandMenuProps) {
  const commands = getVisibleCommands(input);
  if (commands.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      {commands.map((command) => (
        <Text key={command.name} dimColor>
          <Text color="cyan">{command.usage}</Text>
          {HELP_SEPARATOR}
          {command.description}
        </Text>
      ))}
    </Box>
  );
}
