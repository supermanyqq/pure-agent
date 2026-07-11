import { SLASH_COMMANDS } from './parser.js';
import type { SlashCommand } from './parser.js';
import type { SessionSettings } from '../session-settings.js';
import type { PickerKind } from '../types.js';

const NEWLINE = '\n';
const HELP_SEPARATOR = ' — ';

export type SlashCommandResult =
  | { kind: 'notice'; settings: SessionSettings; message: string }
  | { kind: 'reset'; settings: SessionSettings; message: string }
  | { kind: 'config'; settings: SessionSettings; action: 'show' | 'set-api-key' }
  | { kind: 'picker'; settings: SessionSettings; picker: PickerKind };

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
      if (!command.model) return { kind: 'picker', settings, picker: 'model' };
      return {
        kind: 'notice',
        settings: { ...settings, model: command.model },
        message: `Model switched to ${command.model}.`,
      };
    case 'effort':
      if (!command.effort) return { kind: 'picker', settings, picker: 'effort' };
      return {
        kind: 'notice',
        settings: { ...settings, effort: command.effort },
        message: `Reasoning effort switched to ${command.effort}.`,
      };
    case 'config':
      return { kind: 'config', settings, action: command.action };
  }
}
