const MINIMUM_TERMINAL_ROWS = 1;

export const CHAT_VIEW_LAYOUT = {
  flexDirection: 'column',
  flexGrow: 1,
  flexShrink: 1,
  overflow: 'hidden',
} as const;

/** Returns a usable full-screen height only for an interactive terminal. */
export function getAppHeight(rows: number | undefined): number | undefined {
  return rows !== undefined && rows >= MINIMUM_TERMINAL_ROWS ? rows : undefined;
}
