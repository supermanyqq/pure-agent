# Desktop Chat UI Design

## Purpose

Implement Pure Agent's Phase 8 desktop application as a real Electron conversation client. It must provide a session-history sidebar, a focused current conversation, independent session switching, new-session creation, multi-turn Core Agent interactions, and Streamdown rendering for incomplete streaming Markdown.

## Decisions

- Use Electron + `electron-vite` + React. The project does not add a generic component-library panel because the reference direction calls for an intentionally quiet, custom work surface.
- Use main-process `SessionManager` as the sole owner of conversations and Core runtime state. Renderer state is a projection of IPC snapshots.
- Keep sessions memory-only for this phase. This supports the requested history-switching behavior during an application run without inventing a storage contract.
- Reuse `loadProviderConfig`, `createDeepSeekClient`, `AgentLoop`, `createContextManager`, `createEmptyToolRegistry`, and `formatSystemPrompt(DEFAULT_SYSTEM_PROMPT)` from `@pure-agent/core`.
- Provide deterministic tests through an injected `AgentRuntime`; production uses `CoreAgentRuntime`.

## Acceptance Criteria

1. Launching `pnpm --filter @pure-agent/desktop dev` opens a desktop window with a left history sidebar and no right-side secondary content.
2. New Session creates and selects an empty session; switching items restores the selected session's independent messages and in-progress stream state.
3. Sending two messages in one session makes the second Core Agent invocation receive the first turn's completed messages.
4. Agent text deltas update the same pending assistant message and are sent to Renderer during generation.
5. Assistant completed and pending markdown is rendered with `Streamdown`; the pending element passes `isAnimating={true}`.
6. Stop affects only the selected session's active run. Missing API key and runtime errors display an actionable session-local message.
7. Desktop typecheck, tests, production build, and a manually inspected Electron window provide passing evidence.

## Visual Direction

The visual system and layout contract live in [desktop/design.md](../../desktop/design.md). The sidebar's blue-to-violet signal line is the signature interaction; everything else remains lightweight and pale to let the actual conversation carry the screen.
