import { SLASH_COMMANDS } from './parser.js';
import type { SlashCommand } from './parser.js';
import type { SessionSettings } from '../session-settings.js';

const NEWLINE = '\n';
const HELP_SEPARATOR = ' — ';

export type SlashCommandResult =
  | { kind: 'notice'; settings: SessionSettings; message: string }
  | { kind: 'reset'; settings: SessionSettings; message: string };

/** Applies a parsed command without mutating the active session. */
export function applySlashCommand(
  command: SlashCommand,
  settings: SessionSettings,
): SlashCommandResult {
  switch (command.type) {
    case 'help':
      return {
        kind: 'notice',
        settings,
        message: SLASH_COMMANDS.map((definition) =>
          `${definition.usage}${HELP_SEPARATOR}${definition.description}`,
        ).join(NEWLINE),
      };
    case 'new':
      return {
        kind: 'reset',
        settings,
        message: 'Started a new conversation.',
      };
    case 'model':
      return command.model
        ? {
            kind: 'notice',
            settings: { ...settings, model: command.model },
            message: `Model switched to ${command.model}.`,
          }
        : {
            kind: 'notice',
            settings,
            message: `Current model: ${settings.model}.`,
          };
    case 'effort':
      return command.effort
        ? {
            kind: 'notice',
            settings: { ...settings, effort: command.effort },
            message: `Reasoning effort switched to ${command.effort}.`,
          }
        : {
            kind: 'notice',
            settings,
            message: `Current reasoning effort: ${settings.effort}.`,
          };
  }
}
