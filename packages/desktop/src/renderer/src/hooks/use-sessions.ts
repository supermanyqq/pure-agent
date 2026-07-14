import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionSnapshot } from '../../../shared/ipc.js';
import { getDesktopApi } from '../preview-api.js';
import { replaceSession } from './session-reducer.js';

const INITIAL_SESSION_INDEX = 0;

export interface UseSessionsResult {
  sessions: SessionSnapshot[];
  selectedSession: SessionSnapshot | null;
  selectSession(sessionId: string): void;
  createSession(): Promise<void>;
  sendMessage(content: string): Promise<void>;
  stopSession(): Promise<void>;
}

/** Projects main-process session snapshots into the currently selected conversation. */
export function useSessions(): UseSessionsResult {
  const desktopAPI = getDesktopApi();
  const [sessions, setSessions] = useState<SessionSnapshot[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const mergeSession = useCallback((updatedSession: SessionSnapshot): void => {
    setSessions((currentSessions) => {
      const hasSession = currentSessions.some(({ id }) => id === updatedSession.id);
      const nextSessions = hasSession
        ? replaceSession(currentSessions, updatedSession)
        : [updatedSession, ...currentSessions];
      return sortByRecentActivity(nextSessions);
    });
  }, []);

  useEffect(() => {
    let isMounted = true;
    const unsubscribe = desktopAPI.onSessionUpdated((updatedSession) => {
      if (!isMounted) return;
      mergeSession(updatedSession);
      setSelectedSessionId((currentId) => currentId ?? updatedSession.id);
    });

    async function initializeSessions(): Promise<void> {
      const initialSessions = await desktopAPI.listSessions();
      if (!isMounted) return;
      if (initialSessions.length > INITIAL_SESSION_INDEX) {
        setSessions(sortByRecentActivity(initialSessions));
        setSelectedSessionId((currentId) => currentId ?? initialSessions[INITIAL_SESSION_INDEX].id);
        return;
      }

      const createdSession = await desktopAPI.createSession();
      if (!isMounted) return;
      mergeSession(createdSession);
      setSelectedSessionId(createdSession.id);
    }

    void initializeSessions();
    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [desktopAPI, mergeSession]);

  const selectedSession = useMemo(
    () => sessions.find(({ id }) => id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  );

  const createSession = useCallback(async (): Promise<void> => {
    const createdSession = await desktopAPI.createSession();
    mergeSession(createdSession);
    setSelectedSessionId(createdSession.id);
  }, [desktopAPI, mergeSession]);

  const sendMessage = useCallback(async (content: string): Promise<void> => {
    if (!selectedSessionId) return;
    await desktopAPI.sendMessage({ sessionId: selectedSessionId, content });
  }, [desktopAPI, selectedSessionId]);

  const stopSession = useCallback(async (): Promise<void> => {
    if (!selectedSessionId) return;
    await desktopAPI.stopSession(selectedSessionId);
  }, [desktopAPI, selectedSessionId]);

  return {
    sessions,
    selectedSession,
    selectSession: setSelectedSessionId,
    createSession,
    sendMessage,
    stopSession,
  };
}

function sortByRecentActivity(sessions: SessionSnapshot[]): SessionSnapshot[] {
  return [...sessions].sort((left, right) => right.updatedAt - left.updatedAt);
}
