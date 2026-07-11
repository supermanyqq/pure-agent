# 终端 Composer 与运行时选择器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 固定 CLI Composer 到终端底部，并提供 DeepSeek 模型/effort 选择器和 slash command 的 Tab 补全。

**Architecture:** `runtime-options.ts` 集中声明两个允许的模型和四档 effort；`commands/completion.ts` 保持 Tab 循环为可测试纯函数。`useAgent` 仅管理 picker 意图和会话设置，`InputBar` 协调键盘焦点，`App` 用全高 Flex 布局固定 Composer。

**Tech Stack:** TypeScript strict、React 19、Ink 6、ink-text-input、Vitest、pnpm workspace。

## Global Constraints

- 仅允许 `deepseek-v4-pro` 与 `deepseek-v4-flash`；模型参数和默认配置都必须归一到该目录。
- effort 候选仅为 `off`、`low`、`medium`、`high`。
- API Key 掩码模式不得启用 Tab 补全、历史浏览或模型选择器。
- Composer 只显示顶部和底部边框；聊天区溢出时不能移动 Composer。
- 不使用 `any`，数值字面量使用具名常量，候选和状态使用联合类型。

---

### Task 1: 声明运行时目录并限制模型输入

**Files:**
- Create: `packages/cli/src/runtime-options.ts`
- Create: `packages/cli/src/__tests__/runtime-options.test.ts`
- Modify: `packages/cli/src/session-settings.ts`
- Modify: `packages/cli/src/commands/parser.ts`
- Modify: `packages/cli/src/__tests__/parser.test.ts`

**Interfaces:**
- Produces: `SupportedModel`, `MODEL_OPTIONS`, `EFFORT_OPTIONS`, `isSupportedModel()` and `resolveSupportedModel()`.
- Consumes: Core `ReasoningEffort` and existing CLI model/effort parser commands.

- [ ] **Step 1: 写失败测试**

```ts
expect(MODEL_OPTIONS.map((option) => option.value)).toEqual([
  'deepseek-v4-pro',
  'deepseek-v4-flash',
]);
expect(EFFORT_OPTIONS.map((option) => option.value)).toEqual([
  'off', 'low', 'medium', 'high',
]);
expect(resolveSupportedModel('unknown-model')).toBe('deepseek-v4-pro');
expect(parseInput('/model unknown-model')).toEqual({
  kind: 'invalid-command',
  message: 'Model must be one of: deepseek-v4-pro, deepseek-v4-flash.',
});
```

- [ ] **Step 2: 验证 Red**

Run: `pnpm --filter @pure-agent/cli test -- runtime-options.test.ts parser.test.ts`

Expected: FAIL because the catalog and validation do not exist.

- [ ] **Step 3: 实现最小目录与 parser 校验**

```ts
export type SupportedModel = 'deepseek-v4-pro' | 'deepseek-v4-flash';

export const MODEL_OPTIONS = [
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'Highest capability.' },
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'Fast and efficient.' },
] as const;
```

Add the four effort options, `isSupportedModel()`, and `resolveSupportedModel()`. Change `SessionSettings.model` to `SupportedModel`; normalize the initial CLI model before calling `createSessionSettings()`. Reject unsupported `/model <id>` before it reaches a handler.

- [ ] **Step 4: 验证 Green**

Run: `pnpm --filter @pure-agent/cli test -- runtime-options.test.ts parser.test.ts`

Expected: PASS.

- [ ] **Step 5: 提交**

```bash
git add packages/cli/src/runtime-options.ts packages/cli/src/__tests__/runtime-options.test.ts packages/cli/src/session-settings.ts packages/cli/src/commands/parser.ts packages/cli/src/__tests__/parser.test.ts
git commit -m "feat(cli): configure supported DeepSeek models"
```

### Task 2: 实现可循环的 Tab 命令补全

**Files:**
- Create: `packages/cli/src/commands/completion.ts`
- Create: `packages/cli/src/__tests__/completion.test.ts`
- Modify: `packages/cli/src/commands/parser.ts`
- Modify: `packages/cli/src/components/InputBar.tsx`

**Interfaces:**
- Produces: `getCommandCandidates(input)` and `getNextCommandCompletion(input, state)`.
- Consumes: `SLASH_COMMANDS` with new `acceptsArguments: boolean` metadata.

- [ ] **Step 1: 写失败测试**

```ts
expect(getCommandCandidates('/mo').map((command) => command.name)).toEqual(['/model']);
expect(getNextCommandCompletion('/mo', null)).toEqual({
  input: '/model ',
  state: { prefix: '/mo', nextIndex: 0 },
});
expect(getNextCommandCompletion('/', null)?.input).toBe('/help');
expect(getNextCommandCompletion('/help', { prefix: '/', nextIndex: 1 })?.input).toBe('/new');
expect(getNextCommandCompletion('question', null)).toBeNull();
```

- [ ] **Step 2: 验证 Red**

Run: `pnpm --filter @pure-agent/cli test -- completion.test.ts`

Expected: FAIL because the completion module is absent.

- [ ] **Step 3: 实现补全纯函数并接入 InputBar**

Add `acceptsArguments` to every slash command definition. `getNextCommandCompletion()` must accept a previous `{ prefix, nextIndex }` state only while the input equals a previously produced completion; otherwise it starts from the current slash prefix. It returns `null` when there is whitespace after the command token or no candidates.

In `InputBar`, store the returned completion state. On `key.tab` in chat mode, update only `input`; reset the state on any non-Tab input, submit, mode change, picker open, or history navigation. Let `ink-text-input` continue owning text entry.

- [ ] **Step 4: 验证 Green**

Run: `pnpm --filter @pure-agent/cli test -- completion.test.ts command-menu.test.ts`

Expected: PASS.

- [ ] **Step 5: 提交**

```bash
git add packages/cli/src/commands/completion.ts packages/cli/src/__tests__/completion.test.ts packages/cli/src/commands/parser.ts packages/cli/src/components/InputBar.tsx
git commit -m "feat(cli): complete slash commands with tab"
```

### Task 3: 打开并应用 model/effort 选择器

**Files:**
- Create: `packages/cli/src/components/OptionPicker.tsx`
- Create: `packages/cli/src/__tests__/option-picker.test.ts`
- Modify: `packages/cli/src/types.ts`
- Modify: `packages/cli/src/commands/handlers.ts`
- Modify: `packages/cli/src/hooks/useAgent.ts`
- Modify: `packages/cli/src/components/InputBar.tsx`
- Modify: `packages/cli/src/app.tsx`
- Modify: `packages/cli/src/__tests__/handlers.test.ts`

**Interfaces:**
- Produces: `PickerKind = 'model' | 'effort'`, `PickerState`, `getNextPickerIndex()` and `OptionPicker`.
- Consumes: Task 1’s runtime options and existing `submit('/model <id>')` / `submit('/effort <value>')` command paths.

- [ ] **Step 1: 写失败测试**

```ts
expect(applySlashCommand({ type: 'model' }, INITIAL_SETTINGS)).toEqual({
  kind: 'picker', picker: 'model', settings: INITIAL_SETTINGS,
});
expect(applySlashCommand({ type: 'effort' }, INITIAL_SETTINGS)).toEqual({
  kind: 'picker', picker: 'effort', settings: INITIAL_SETTINGS,
});
expect(getNextPickerIndex({ currentIndex: 0, direction: 'up', optionCount: 2 })).toBe(1);
expect(getNextPickerIndex({ currentIndex: 1, direction: 'down', optionCount: 2 })).toBe(0);
```

- [ ] **Step 2: 验证 Red**

Run: `pnpm --filter @pure-agent/cli test -- handlers.test.ts option-picker.test.ts`

Expected: FAIL because query commands still return notices and no picker helper exists.

- [ ] **Step 3: 实现 picker state 与键盘契约**

Define `PickerState` as `{ kind: PickerKind } | null` in `types.ts`. Change no-argument model/effort handler results to `{ kind: 'picker', picker, settings }`; direct values continue returning notices.

`useAgent` stores `picker`, opens it from the result, and exposes `choosePickerValue(value)` and `cancelPicker()`. `choosePickerValue()` submits an internally constructed validated command then closes the picker; `cancelPicker()` only clears picker state.

`OptionPicker` renders a list with the current session option highlighted. `InputBar` consumes ↑, ↓, Enter and Esc while a picker is active; it calls `choosePickerValue()` or `cancelPicker()` and never changes chat history or the text input in this mode.

- [ ] **Step 4: 验证 Green**

Run: `pnpm --filter @pure-agent/cli test -- handlers.test.ts option-picker.test.ts && pnpm --filter @pure-agent/cli typecheck`

Expected: PASS.

- [ ] **Step 5: 提交**

```bash
git add packages/cli/src/components/OptionPicker.tsx packages/cli/src/__tests__/option-picker.test.ts packages/cli/src/types.ts packages/cli/src/commands/handlers.ts packages/cli/src/hooks/useAgent.ts packages/cli/src/components/InputBar.tsx packages/cli/src/app.tsx packages/cli/src/__tests__/handlers.test.ts
git commit -m "feat(cli): select runtime model and effort"
```

### Task 4: 固定 Composer 并完成文档/终端验收

**Files:**
- Modify: `packages/cli/src/app.tsx`
- Modify: `packages/cli/src/components/InputBar.tsx`
- Modify: `docs/cli/design.md`
- Modify: `docs/cli/phase-3-session-commands.md`
- Modify: `docs/cli/phase-4-terminal-ui-and-verification.md`

**Interfaces:**
- Consumes: App `stdout.rows`, picker and InputBar state from Tasks 2–3.
- Produces: a bottom-fixed Composer with horizontal borders.

- [ ] **Step 1: 添加布局验证的失败断言**

Add an exported `getAppHeight(rows?: number): number | undefined` helper and test:

```ts
expect(getAppHeight(40)).toBe(40);
expect(getAppHeight(undefined)).toBeUndefined();
```

Run: `pnpm --filter @pure-agent/cli test -- app-layout.test.ts`

Expected: FAIL because the helper and test file do not exist.

- [ ] **Step 2: 实现全高 Flex 布局与上下边框**

Use `useStdout()` in `App`, pass `height={getAppHeight(stdout.rows)}` to the outer column, and wrap every non-Composer region in a `flexGrow={1}`, `flexShrink={1}`, `overflow="hidden"`, `justifyContent="flex-end"` chat viewport. Put `InputBar` last.

Wrap InputBar content in:

```tsx
<Box borderStyle="single" borderTop borderBottom flexDirection="column">
  {picker && <OptionPicker ... />}
  {!isApiKeyEntry && <CommandMenu input={input} />}
  <Box>{/* TextInput row */}</Box>
</Box>
```

Do not enable left or right borders.

- [ ] **Step 3: 验证 Green**

Run: `pnpm --filter @pure-agent/cli test -- app-layout.test.ts && pnpm --filter @pure-agent/cli typecheck`

Expected: PASS.

- [ ] **Step 4: 更新教学文档与完整验证**

Document the two-model catalog, picker keyboard contract, Tab completion and fixed Composer. Run:

```bash
pnpm --filter @pure-agent/core test
pnpm --filter @pure-agent/cli test
pnpm typecheck
pnpm build
```

Expected: all commands exit 0.

- [ ] **Step 5: PTY 验收**

Start `pure-agent` in a temporary HOME and verify: Composer remains on the last terminal rows with only horizontal borders; `/model` and `/effort` show selections; arrow keys, Enter and Esc obey the documented contract; `/mo` + Tab becomes `/model `; repeated Tab from `/` cycles commands; no picker key changes chat history.

- [ ] **Step 6: 提交**

```bash
git add packages/cli/src/app.tsx packages/cli/src/components/InputBar.tsx docs/cli/design.md docs/cli/phase-3-session-commands.md docs/cli/phase-4-terminal-ui-and-verification.md packages/cli/src/__tests__/app-layout.test.ts
git commit -m "feat(cli): fix composer layout and selection controls"
```
