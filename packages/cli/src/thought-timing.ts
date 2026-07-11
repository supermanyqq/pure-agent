export interface ThoughtTimingState {
  pendingStartedAtMs: number | null;
  completedDurationsMs: readonly number[];
}

export interface FinishedThoughtTiming {
  state: ThoughtTimingState;
  durationMs: number | null;
}

const EMPTY_DURATIONS: readonly number[] = [];
const MINIMUM_DURATION_MS = 0;

export function createThoughtTimingState(): ThoughtTimingState {
  return { pendingStartedAtMs: null, completedDurationsMs: EMPTY_DURATIONS };
}

export function startThoughtTiming(
  state: ThoughtTimingState,
  startedAtMs: number,
): ThoughtTimingState {
  return { ...state, pendingStartedAtMs: startedAtMs };
}

export function finishThoughtTiming(
  state: ThoughtTimingState,
  finishedAtMs: number,
): FinishedThoughtTiming {
  if (state.pendingStartedAtMs === null) return { state, durationMs: null };

  const durationMs = Math.max(MINIMUM_DURATION_MS, finishedAtMs - state.pendingStartedAtMs);
  return {
    durationMs,
    state: {
      pendingStartedAtMs: null,
      completedDurationsMs: [...state.completedDurationsMs, durationMs],
    },
  };
}

export function clearThoughtTiming(_state: ThoughtTimingState): ThoughtTimingState {
  return createThoughtTimingState();
}
