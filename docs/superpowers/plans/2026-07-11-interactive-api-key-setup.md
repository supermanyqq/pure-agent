# 交互式 API Key 配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让无 API Key 的交互式 CLI 正常启动，并通过 slash command 安全配置后再允许对话。

**Architecture:** Core 新增只检查密钥可用性的无副作用函数；CLI 将 API Key 可用性建模为独立状态，而非 `AgentStatus = 'error'`。parser/handler 只表达 `/config` 意图，hook 负责状态转换与持久化，InputBar 负责掩码输入且不记录密钥。

**Tech Stack:** TypeScript strict、React 19、Ink 6、Vitest、现有 `@pure-agent/core` 配置持久化模块。

## Global Constraints

- 不使用 `any`；新增状态使用联合类型。
- API Key 不作为 slash command 参数，不回显，不写入输入历史、聊天历史或 notice。
- 目录和文件权限、原子写入复用 `saveApiKey()`；环境变量优先级不变。
- 仅改变 Ink 交互式 CLI；`pure-agent config` 和纯文本模式不在本次范围内。

---

### Task 1: 提供无副作用的 API Key 可用性查询

**Files:**
- Modify: `packages/core/src/config/loader.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/config/__tests__/loader.test.ts`

**Interfaces:**
- Produces: `hasConfiguredApiKey(options?: ConfigFileOptions): boolean`
- Consumes: `readStoredConfig()` 和 `process.env.PURE_AGENT_API_KEY`

- [ ] **Step 1: 写失败测试**

```ts
it('配置文件或环境变量包含非空 API Key 时返回 true', () => {
  writeFileSync(configPath, JSON.stringify({ provider: { apiKey: 'file-key' } }));
  expect(hasConfiguredApiKey({ configPath })).toBe(true);
});

it('没有有效 API Key 或配置文件不可读时返回 false', () => {
  writeFileSync(configPath, JSON.stringify({ provider: { apiKey: '  ' } }));
  expect(hasConfiguredApiKey({ configPath })).toBe(false);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm --filter @pure-agent/core test -- loader.test.ts`

Expected: FAIL because `hasConfiguredApiKey` is not exported.

- [ ] **Step 3: 实现最小查询函数**

```ts
export function hasConfiguredApiKey(options: ConfigFileOptions = {}): boolean {
  if (process.env.PURE_AGENT_API_KEY?.trim()) return true;
  try {
    const config = readStoredConfig(options);
    const provider = isRecord(config.provider) ? config.provider : {};
    return typeof provider['apiKey'] === 'string' && provider['apiKey'].trim().length > 0;
  } catch {
    return false;
  }
}
```

Export it from the Core barrel next to `loadCliConfig` and `saveApiKey`.

- [ ] **Step 4: 运行通过测试**

Run: `pnpm --filter @pure-agent/core test -- loader.test.ts`

Expected: PASS.

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/config/loader.ts packages/core/src/config/__tests__/loader.test.ts packages/core/src/index.ts
git commit -m "feat(config): expose API key availability"
```

### Task 2: 解析并表达 `/config` 的无副作用命令意图

**Files:**
- Modify: `packages/cli/src/commands/parser.ts`
- Modify: `packages/cli/src/commands/handlers.ts`
- Test: `packages/cli/src/__tests__/parser.test.ts`
- Test: `packages/cli/src/__tests__/handlers.test.ts`

**Interfaces:**
- Produces: `SlashCommand = { type: 'config'; action: 'show' | 'set-api-key' }`
- Produces: `SlashCommandResult = { kind: 'config'; action: 'show' | 'set-api-key'; settings: SessionSettings }`
- Consumes: current slash command parser and `applySlashCommand()`.

- [ ] **Step 1: 写失败测试**

```ts
expect(parseInput('/config')).toEqual({
  kind: 'command',
  command: { type: 'config', action: 'show' },
});
expect(parseInput('/config set api-key')).toEqual({
  kind: 'command',
  command: { type: 'config', action: 'set-api-key' },
});
expect(parseInput('/config set api-key secret')).toEqual({
  kind: 'invalid-command',
  message: expect.stringMatching(/Usage: \/config set api-key/),
});
```

```ts
expect(applySlashCommand({ type: 'config', action: 'set-api-key' }, INITIAL_SETTINGS))
  .toEqual({ kind: 'config', action: 'set-api-key', settings: INITIAL_SETTINGS });
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm --filter @pure-agent/cli test -- parser.test.ts handlers.test.ts`

Expected: FAIL because `/config` is currently unknown.

- [ ] **Step 3: 实现最小 parser 与 handler**

Add `/config` to `SLASH_COMMANDS` with both forms in its description. Parse only zero arguments and exactly `set api-key`; reject every other argument sequence. Let the handler return `kind: 'config'` without modifying `SessionSettings` or emitting secret-bearing text.

- [ ] **Step 4: 运行通过测试**

Run: `pnpm --filter @pure-agent/cli test -- parser.test.ts handlers.test.ts`

Expected: PASS.

- [ ] **Step 5: 提交**

```bash
git add packages/cli/src/commands/parser.ts packages/cli/src/commands/handlers.ts packages/cli/src/__tests__/parser.test.ts packages/cli/src/__tests__/handlers.test.ts
git commit -m "feat(cli): add interactive config commands"
```

### Task 3: 将密钥可用性和安全输入接入 Ink 会话

**Files:**
- Modify: `packages/cli/src/types.ts`
- Modify: `packages/cli/src/hooks/useAgent.ts`
- Modify: `packages/cli/src/components/InputBar.tsx`
- Modify: `packages/cli/src/app.tsx`
- Test: `packages/cli/src/__tests__/parser.test.ts`

**Interfaces:**
- Produces: `ApiKeyStatus = 'configured' | 'required' | 'entering'` in `AgentState`.
- Consumes: `hasConfiguredApiKey()` and `saveApiKey()` from Core, Task 2’s `kind: 'config'` result.

- [ ] **Step 1: 写失败行为测试**

Add an assertion that `/help` exposes `/config`, then run the CLI parser/handler suite. This proves the command needed to configure a missing key is discoverable before hook/UI integration.

```ts
const result = applySlashCommand({ type: 'help' }, INITIAL_SETTINGS);
expect(result.kind).toBe('notice');
if (result.kind === 'notice') expect(result.message).toContain('/config');
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm --filter @pure-agent/cli test -- handlers.test.ts`

Expected: FAIL until Task 2’s command list is updated.

- [ ] **Step 3: 实现状态门和密钥输入模式**

In `types.ts`, add:

```ts
export type ApiKeyStatus = 'configured' | 'required' | 'entering';
```

Add `apiKeyStatus` to `AgentState`. In `useAgent`, determine initial status with `hasConfiguredApiKey()` but remove the eager `useEffect(() => getAgent())`: Provider creation must only occur for an allowed chat message. Route `kind: 'config'` results as follows:

```ts
if (result.action === 'set-api-key') {
  setState((previous) => ({ ...previous, apiKeyStatus: 'entering', notice: null }));
  return;
}
setState((previous) => ({
  ...previous,
  notice: hasConfiguredApiKey()
    ? 'API key is configured. Use /config set api-key to replace it.'
    : 'API key is not configured. Run /config set api-key.',
}));
```

When `apiKeyStatus === 'entering'`, submit must call `saveApiKey(input)`, clear the input mode, and set `apiKeyStatus: 'configured'` only after success. Catch persistence failures as a generic notice without including the submitted value. When in normal mode and `hasConfiguredApiKey()` is false, leave `messagesRef` and `agentRef` unchanged, set the configuration notice, and return before `getAgent()`.

Extend `InputBar` with `mode: 'chat' | 'api-key'`. In API-key mode, pass a masking character supported by `ink-text-input`, use a configuration-specific prompt, skip the history update, and map Ctrl+C to a supplied cancel callback. Do not put the submitted string in any React state outside the input component.

In `App`, render an informational configuration panel when `apiKeyStatus === 'required'` (not `status === 'error'`) and pass the new InputBar mode/cancel callback. Remove the previous startup `Configuration Error` conditional.

- [ ] **Step 4: 运行类型与测试验证**

Run: `pnpm --filter @pure-agent/cli test && pnpm --filter @pure-agent/cli typecheck`

Expected: PASS. The UI is checked in Task 5 because this repository has no Ink render-test harness.

- [ ] **Step 5: 提交**

```bash
git add packages/cli/src/types.ts packages/cli/src/hooks/useAgent.ts packages/cli/src/components/InputBar.tsx packages/cli/src/app.tsx packages/cli/src/__tests__/handlers.test.ts
git commit -m "feat(cli): configure API key from chat"
```

### Task 4: 更新教学文档与执行端到端验证

**Files:**
- Modify: `docs/cli/design.md`
- Modify: `docs/cli/phase-1-configuration.md`
- Modify: `docs/cli/phase-3-session-commands.md`

**Interfaces:**
- Documents the behavior implemented in Tasks 1–3.

- [ ] **Step 1: 更新文档**

Document `/config` and `/config set api-key`, the non-blocking `required` state, masked/no-history input, and the fact that ordinary text is rejected before a Provider is created. Retain the existing top-level `pure-agent config` documentation as an automation/standalone alternative.

- [ ] **Step 2: 运行相关自动化验证**

Run:

```bash
pnpm --filter @pure-agent/core test
pnpm --filter @pure-agent/cli test
pnpm typecheck
pnpm build
```

Expected: all commands exit 0.

- [ ] **Step 3: PTY 手工验收**

With a temporary `HOME` containing no config and a local fake streaming Provider:

1. Start the built CLI and confirm it displays the configuration guide, not a configuration error or `Processing…`.
2. Submit ordinary chat text; confirm no request reaches the fake Provider and the guide remains visible.
3. Enter `/config set api-key`; confirm entered characters are masked and no visible transcript includes the key.
4. Submit a key, then ordinary chat text; confirm exactly one request reaches the fake Provider.

- [ ] **Step 4: 提交**

```bash
git add docs/cli/design.md docs/cli/phase-1-configuration.md docs/cli/phase-3-session-commands.md
git commit -m "docs(cli): explain in-session API key setup"
```
