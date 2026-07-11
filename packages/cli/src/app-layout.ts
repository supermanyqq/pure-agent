const MINIMUM_TERMINAL_ROWS = 1;

/** Returns a usable full-screen height only for an interactive terminal. */
export function getAppHeight(rows: number | undefined): number | undefined {
  return rows !== undefined && rows >= MINIMUM_TERMINAL_ROWS ? rows : undefined;
}
