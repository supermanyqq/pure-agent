import { describe, expect, it } from 'vitest';
import { DESKTOP_API_VERSION, IPC_CHANNELS } from '../ipc.js';

describe('desktop IPC contract', () => {
  it('keeps every renderer command and update channel explicit', () => {
    expect(DESKTOP_API_VERSION).toBe(1);
    expect(IPC_CHANNELS).toEqual({
      createSession: 'desktop:create-session',
      listSessions: 'desktop:list-sessions',
      sendMessage: 'desktop:send-message',
      stopSession: 'desktop:stop-session',
      sessionUpdated: 'desktop:session-updated',
    });
  });
});
