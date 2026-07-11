# CLI 会话命令 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在交互式多轮会话中提供 `/help`、`/new`、`/model` 和 `/effort`，并让切换设置只影响下一次请求。

**Architecture:** slash 解析器和 effort 映射是无 React、无 IO 的纯函数；`useAgent` 保存消息、状态和 `SessionSettings`，在每轮启动时从当前设置生成 `AgentOptions`。命令处理结果作为 notice 返回给 App，而不是伪造为 assistant message。

**Tech Stack:** TypeScript strict、React 19、Ink、Vitest。

## Global Constraints

- 命令输入绝不能追加到 `messagesRef.current` 或 `completedMessages`。
- `/new` 仅清空对话，不能复原用户刚刚选择的模型或 effort。
- `/model` 拒绝空白模型 ID；`/effort` 仅接受 `off|low|medium|high` 小写值。
- `low`、`medium`、`high` 的 DeepSeek 映射必须与 `design.md` 的表格一致。

---

### Task 1: 实现命令解析和 session 设置映射

**Files:**
- Create: `packages/cli/src/commands/parser.ts`
- Create: `packages/cli/src/session-settings.ts`
- Create: `packages/cli/src/__tests__/parser.test.ts`
- Create: `packages/cli/src/__tests__/session-settings.test.ts`

**Interfaces:**
- Produces: `parseInput()`、`SLASH_COMMANDS`、`createSessionSettings()`、`toReasoningOptions()`。

- [ ] **Step 1: 写 parser 失败测试**

```ts
expect(parseInput('解释一下')).toEqual({ kind: 'message', content: '解释一下' });
expect(parseInput('/model deepseek-v4-flash')).toEqual({
  kind: 'command',
  command: { type: 'model', model: 'deepseek-v4-flash' },
});
expect(parseInput('/effort extreme')).toEqual({
  kind: 'invalid-command',
  message: expect.stringMatching(/off.*low.*medium.*high/i),
});
```

覆盖 `/help`、`/new`、无参数 `/model`、无参数 `/effort`、未知命令和带有首尾空白的模型值。

- [ ] **Step 2: 验证 parser Red**

Run:

```bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/parser.test.ts --reporter=verbose
```

Expected: FAIL，因为模块不存在。

- [ ] **Step 3: 定义可判别的解析结果**

```ts
export type ParsedInput =
  | { kind: 'message'; content: string }
  | { kind: 'command'; command: SlashCommand }
  | { kind: 'invalid-command'; message: string };

export type SlashCommand =
  | { type: 'help' }
  | { type: 'new' }
  | { type: 'model'; model?: string }
  | { type: 'effort'; effort?: ReasoningEffort };
```

`SLASH_COMMANDS` 是用于菜单和帮助的一份数据源，每项包含 `name`、`usage`、`description`。`parseInput()` 对普通文本不改变内容，对 command 参数使用 `trim()`。

- [ ] **Step 4: 写 effort 映射失败测试**

```ts
expect(toReasoningOptions('off')).toEqual({ thinking: { type: 'disabled' } });
expect(toReasoningOptions('low')).toEqual({ thinking: { type: 'enabled' } });
expect(toReasoningOptions('medium')).toEqual({
  thinking: { type: 'enabled' }, reasoningEffort: 'high',
});
expect(toReasoningOptions('high')).toEqual({
  thinking: { type: 'enabled' }, reasoningEffort: 'max',
});
```

Run `session-settings.test.ts`，Expected: FAIL，因为函数不存在。

- [ ] **Step 5: 实现最小映射并验证 Green**

```ts
export interface SessionSettings {
  model: string;
  effort: ReasoningEffort;
}

export function toReasoningOptions(effort: ReasoningEffort): ReasoningOptions {
  const enabledThinking = { type: 'enabled' as const };
  if (effort === 'off') return { thinking: { type: 'disabled' } };
  if (effort === 'low') return { thinking: enabledThinking };
  if (effort === 'medium') return { thinking: enabledThinking, reasoningEffort: 'high' };
  return { thinking: enabledThinking, reasoningEffort: 'max' };
}
```

Run:

```bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/parser.test.ts src/__tests__/session-settings.test.ts --reporter=verbose
```

Expected: PASS。

### Task 2: 将当前 session 设置接入 useAgent

**Files:**
- Modify: `packages/cli/src/types.ts`
- Modify: `packages/cli/src/hooks/useAgent.ts`
- Modify: `packages/cli/src/app.tsx`
- Modify: `packages/cli/src/plain.ts`

**Interfaces:**
- Consumes: `ParsedInput`、`SessionSettings` 和 `toReasoningOptions()`。
- Produces: `UseAgentReturn.submit()`、状态内的 `settings` 与 `notice`。

- [ ] **Step 1: 在 UI 状态中加入可渲染的会话信息**

扩展 `AgentState`：

```ts
settings: SessionSettings;
notice: string | null;
```

初始化模型使用已加载的 `config.defaultModel`，effort 使用持久配置的有效默认值或 `DEFAULT_REASONING_EFFORT`。缺失 API Key 时仍显示默认设置和既有配置错误。

- [ ] **Step 2: 将提交入口改为命令分发**

把 public hook 方法从 `send(userInput)` 改为 `submit(input)`：先调用 `parseInput()`；只有 `message` 才调用现有流式发送逻辑。命令的确定行为为：

```ts
case 'model':
  if (command.model) set settings.model and set notice;
  else set notice to current model;
  break;
case 'effort':
  if (command.effort) set settings.effort and set notice;
  else set notice to current effort;
  break;
case 'new':
  clear message/agent/context state but retain settings;
  break;
case 'help':
  set notice to formatted SLASH_COMMANDS;
```

`createDeepSeekClient` 仍只创建一次；修复 lazy initialization 时必须把 `new AgentLoop(...)` 赋入 `agentRef.current`，否则多轮会话没有持久实例。发送每一轮时从 `state` 的最新 `settings` 计算 `model`、`thinking` 和 `reasoningEffort`。

- [ ] **Step 3: 将 App 和非 Ink 路径接入新接口**

`App` 把 `InputBar.onSubmit` 改为 `submit`，而非自行判断 `/new`。`plain.ts` 保持单次与管道语义，但使用 `config.defaultModel` 以及载入的 effort 默认值，不再硬编码模型；非交互路径不能把 slash 命令误当普通问题。

- [ ] **Step 4: 验证类型与现有行为**

Run:

```bash
pnpm --filter @pure-agent/cli typecheck
pnpm --filter @pure-agent/core typecheck
```

Expected: PASS；`/model`、`/effort` 不依赖 React render 才能解析和映射，hook 只编排状态。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/parser.ts packages/cli/src/session-settings.ts packages/cli/src/__tests__/parser.test.ts packages/cli/src/__tests__/session-settings.test.ts packages/cli/src/types.ts packages/cli/src/hooks/useAgent.ts packages/cli/src/app.tsx packages/cli/src/plain.ts
git commit -m "feat(cli): add model and effort session commands"
```
