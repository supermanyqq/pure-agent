import type { SessionSnapshot } from '../../../shared/ipc.js';

/** Replaces one IPC snapshot without discarding background updates for other sessions. */
export function replaceSession(
  sessions: SessionSnapshot[],
  updatedSession: SessionSnapshot,
): SessionSnapshot[] {
  return sessions.map((session) => (
    session.id === updatedSession.id ? updatedSession : session
  ));
}
