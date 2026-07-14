import { describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '../../../../shared/ipc.js';
import { replaceSession } from '../session-reducer.js';

const FIRST_SESSION: SessionSnapshot = {
  id: 'session-1',
  title: 'first',
  createdAt: 1,
  updatedAt: 1,
  status: 'idle',
  messages: [],
  streamingMessage: null,
  errorMessage: null,
};

const SECOND_SESSION: SessionSnapshot = {
  id: 'session-2',
  title: 'second',
  createdAt: 2,
  updatedAt: 2,
  status: 'thinking',
  messages: [],
  streamingMessage: null,
  errorMessage: null,
};

const STREAMING_UPDATE: SessionSnapshot = {
  ...SECOND_SESSION,
  status: 'streaming',
  streamingMessage: { id: 'message-1', content: 'hello' },
};

describe('replaceSession', () => {
  it('replaces only the matching session when a background stream update arrives', () => {
    expect(replaceSession([FIRST_SESSION, SECOND_SESSION], STREAMING_UPDATE))
      .toEqual([FIRST_SESSION, STREAMING_UPDATE]);
  });
});
