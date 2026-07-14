# Desktop Chat UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the real Electron desktop chat workspace described in `docs/desktop/design.md`.

**Architecture:** Electron main owns all session and AgentLoop state; a preload bridge exposes typed commands and session snapshots; React renders those snapshots with Streamdown. `SessionManager` depends on a small runtime interface so its multi-session and streaming rules are unit-testable without a provider.

**Tech Stack:** TypeScript strict, Electron 43, electron-vite 5, React 19, Vite 8, Vitest, streamdown 2, @streamdown/code.

## Global Constraints

- Never use `any`; use discriminated unions and explicit interfaces.
- Extract every non-obvious numeric literal into a named constant.
- Keep API keys and Node APIs out of the Renderer.
- Implement only history navigation, new sessions, multi-turn messages, stop, errors, and streaming Markdown; no persistence, settings panel, or reference-image menu sections.
- Use `Streamdown` for assistant messages, and `isAnimating` for pending messages.

---

### Task 1: Package and Electron shell

**Files:**
- Modify: `packages/desktop/package.json`
- Modify: `packages/desktop/tsconfig.json`
- Create: `packages/desktop/electron.vite.config.ts`
- Create: `packages/desktop/src/preload/index.ts`
- Create: `packages/desktop/src/renderer/index.html`
- Create: `packages/desktop/src/renderer/src/main.tsx`
- Create: `packages/desktop/src/renderer/src/vite-env.d.ts`
- Test: `packages/desktop/src/shared/__tests__/ipc.test.ts`

**Interfaces:** Produces the `window.desktopAPI` bridge and a main/preload/renderer project layout for Tasks 2–4.

- [ ] **Step 1: Write the failing IPC contract test**

```ts
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
```

- [ ] **Step 2: Verify the test fails**

Run: `pnpm --filter @pure-agent/desktop exec vitest run src/shared/__tests__/ipc.test.ts`

Expected: FAIL because `src/shared/ipc.ts` does not exist.

- [ ] **Step 3: Implement the minimal typed shell**

```ts
export const DESKTOP_API_VERSION = 1;
export const IPC_CHANNELS = {
  createSession: 'desktop:create-session',
  listSessions: 'desktop:list-sessions',
  sendMessage: 'desktop:send-message',
  stopSession: 'desktop:stop-session',
  sessionUpdated: 'desktop:session-updated',
} as const;
```

Set `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and expose only the functions declared by `DesktopAPI` through `contextBridge`.

- [ ] **Step 4: Verify the shell**

Run: `pnpm --filter @pure-agent/desktop exec vitest run src/shared/__tests__/ipc.test.ts && pnpm --filter @pure-agent/desktop typecheck`

Expected: 1 passing test and TypeScript exit code 0.

### Task 2: Session state and real Core runtime

**Files:**
- Create: `packages/desktop/src/shared/ipc.ts`
- Create: `packages/desktop/src/main/session-manager.ts`
- Create: `packages/desktop/src/main/core-agent-runtime.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Test: `packages/desktop/src/main/__tests__/session-manager.test.ts`

**Interfaces:** `SessionManager` produces `createSession(): SessionSnapshot`, `listSessions(): SessionSnapshot[]`, `sendMessage(input: SendMessageInput): Promise<void>`, `stopSession(sessionId: string): void`, and `subscribe(listener: SessionListener): () => void`. It consumes `AgentRuntime.run(input: AgentRunInput): Promise<void>`.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it('keeps each session history independent across a switch', async () => {
  const runtime = new FakeRuntime();
  const manager = new SessionManager(runtime);
  const first = manager.createSession();
  const second = manager.createSession();
  await manager.sendMessage({ sessionId: first.id, content: 'first prompt' });
  await manager.sendMessage({ sessionId: second.id, content: 'second prompt' });
  expect(manager.getSession(first.id)?.messages.map(({ content }) => content))
    .toEqual(['first prompt', 'reply:first prompt']);
});

it('passes completed history to the next turn and accumulates deltas in one pending message', async () => {
  const runtime = new ControlledRuntime();
  const session = manager.createSession();
  const first = manager.sendMessage({ sessionId: session.id, content: 'one' });
  runtime.delta('he'); runtime.delta('llo'); runtime.complete(); await first;
  await manager.sendMessage({ sessionId: session.id, content: 'two' });
  expect(runtime.calls[1]?.messages.map(({ content }) => content))
    .toEqual(['one', 'hello', 'two']);
});
```

- [ ] **Step 2: Verify lifecycle tests fail**

Run: `pnpm --filter @pure-agent/desktop exec vitest run src/main/__tests__/session-manager.test.ts`

Expected: FAIL because `SessionManager` and `AgentRuntime` do not exist.

- [ ] **Step 3: Implement session orchestration and Core adapter**

`SessionManager` creates immutable snapshots after every state transition. `CoreAgentRuntime` maps Agent events: `agent:thinking` to `thinking`, `agent:stream:delta` to `onDelta`, `agent:turn:end` to `onComplete`, `agent:error` to `onError`, and `agent:abort` to `onAborted`. It creates an AgentLoop per `sessionId`, adds user messages before `run`, and forwards the existing session history on every run.

- [ ] **Step 4: Verify session behavior**

Run: `pnpm --filter @pure-agent/desktop exec vitest run src/main/__tests__/session-manager.test.ts`

Expected: all session-manager lifecycle tests pass without environment credentials.

### Task 3: Renderer session projection and message UI

**Files:**
- Create: `packages/desktop/src/renderer/src/hooks/use-sessions.ts`
- Create: `packages/desktop/src/renderer/src/components/sidebar.tsx`
- Create: `packages/desktop/src/renderer/src/components/chat-view.tsx`
- Create: `packages/desktop/src/renderer/src/components/message-bubble.tsx`
- Create: `packages/desktop/src/renderer/src/components/composer.tsx`
- Create: `packages/desktop/src/renderer/src/app.tsx`
- Create: `packages/desktop/src/renderer/src/styles.css`
- Test: `packages/desktop/src/renderer/src/hooks/__tests__/session-reducer.test.ts`
- Test: `packages/desktop/src/renderer/src/components/__tests__/message-bubble.test.tsx`

**Interfaces:** `useSessions()` returns `{ sessions, selectedSession, selectSession, createSession, sendMessage, stopSession }`; `MessageBubble` consumes `{ message: ChatMessage; isStreaming: boolean }`.

- [ ] **Step 1: Write failing renderer tests**

```tsx
it('replaces only the matching session when a background stream update arrives', () => {
  const next = replaceSession([first, second], { ...second, streamingMessage: stream });
  expect(next).toEqual([first, { ...second, streamingMessage: stream }]);
});

it('hands assistant streaming markdown to Streamdown with animation enabled', () => {
  render(<MessageBubble message={assistant} isStreaming />);
  expect(Streamdown).toHaveBeenCalledWith(
    expect.objectContaining({ children: assistant.content, isAnimating: true }),
    undefined,
  );
});
```

- [ ] **Step 2: Verify renderer tests fail**

Run: `pnpm --filter @pure-agent/desktop exec vitest run src/renderer/src/hooks/__tests__/session-reducer.test.ts src/renderer/src/components/__tests__/message-bubble.test.tsx`

Expected: FAIL because the reducer and MessageBubble are missing.

- [ ] **Step 3: Implement the visual composition**

Use a 276px `<aside>` for `Sidebar`, a single `<main>` for `ChatView`, and a sticky Composer. Use CSS custom properties from `docs/desktop/design.md`; render no menu panel, project explorer, settings panel, or right rail. `MessageBubble` imports `Streamdown` and `streamdown/styles.css`; it uses `@streamdown/code` only for assistant content. Composer uses Enter to send, Shift+Enter for a line break, and replaces Send with Stop while the selected session is active.

- [ ] **Step 4: Verify renderer behavior**

Run: `pnpm --filter @pure-agent/desktop exec vitest run src/renderer/src/hooks/__tests__/session-reducer.test.ts src/renderer/src/components/__tests__/message-bubble.test.tsx && pnpm --filter @pure-agent/desktop typecheck`

Expected: renderer tests pass and TypeScript exit code 0.

### Task 4: End-to-end wiring and verification

**Files:**
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/renderer/src/app.tsx`
- Modify: `packages/desktop/src/renderer/src/styles.css`
- Modify: `docs/architecture.md`
- Modify: `docs/desktop/phase-4-verification.md`

**Interfaces:** Main registers each `IPC_CHANNELS` handler and broadcasts `SessionSnapshot`; the final UI only depends on `window.desktopAPI`.

- [ ] **Step 1: Write the final failing main wiring test**

```ts
it('forwards a manager update to the renderer update channel', () => {
  manager.emit(snapshot);
  expect(webContents.send).toHaveBeenCalledWith(
    IPC_CHANNELS.sessionUpdated,
    snapshot,
  );
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @pure-agent/desktop exec vitest run src/main/__tests__/ipc-handlers.test.ts`

Expected: FAIL because desktop IPC handlers have not been registered.

- [ ] **Step 3: Register handlers and document the delivered architecture**

Register `listSessions`, `createSession`, `sendMessage`, and `stopSession` in main; subscribe once to SessionManager and broadcast `sessionUpdated`. Update `docs/architecture.md` with the actual package files and scripts. Add the exact visual checklist to phase 4 documentation.

- [ ] **Step 4: Run all evidence gates**

Run:

```bash
pnpm --filter @pure-agent/desktop typecheck
pnpm --filter @pure-agent/desktop test
pnpm --filter @pure-agent/desktop build
pnpm --filter @pure-agent/desktop dev
```

Expected: typecheck/test/build exit 0; the desktop window visibly supports new sessions, sidebar switching, multi-turn interactions, and streaming Markdown while omitting the second reference image's menu.

## Plan Self-Review

- Session creation, switching, independent histories, multi-turn history forwarding, streamed updates, Streamdown, stop, error state, window security, layout, and verification each have an owning task.
- Type names are introduced before use: IPC data in Task 1, main lifecycle in Task 2, renderer projection in Task 3, integration in Task 4.
- The plan intentionally excludes persistence, settings, tool cards, and secondary navigation because they are outside the requested interface.
