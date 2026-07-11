# CLI Agent 运行时选项 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让模型与 reasoning 请求参数从 CLI 会话设置完整穿过 Agent Loop 到 DeepSeek Provider。

**Architecture:** `AgentOptions` 是上层设置与 Core 的唯一契约；`StepBuilder` 将可选 thinking 字段复制到 `ChatRequest`，`AgentLoop` 无转换地传给 `ChatProvider`。Provider 继续负责 API 的 snake_case wire 映射，不能让 CLI 依赖 DeepSeek 内部类型。

**Tech Stack:** TypeScript strict、Vitest、现有 Agent Loop/StepBuilder/DeepSeek Client。

## Global Constraints

- 仅传递已经明确设置的可选字段；`undefined` 不得变成 API 请求字段。
- 不能修改或删除既有的 provider thinking/reasoning 测试。
- 所有 Core 请求路径都使用同一个 `AgentOptions` 契约，避免 `ChatRequest` 与 Provider 发生漂移。

---

### Task 1: 扩展 Agent 共享请求契约

**Files:**
- Modify: `packages/core/src/types/index.ts`
- Modify: `packages/core/src/agent/step-builder.ts`
- Modify: `packages/core/src/agent/loop.ts`
- Modify: `packages/core/src/agent/__tests__/step-builder.test.ts`
- Modify: `packages/core/src/agent/__tests__/loop.test.ts`

**Interfaces:**
- Consumes: `AgentOptions`、`ChatRequest`、`ChatProvider.streamMessage()`。
- Produces: thinking 和 reasoning effort 在每个 Agent step 中保持不变。

- [ ] **Step 1: 写 StepBuilder 失败测试**

在 `step-builder.test.ts` 加入：

```ts
it('将 thinking 和 reasoningEffort 放入 ChatRequest', async () => {
  const request = await builder.build(
    [{ role: 'user', content: '思考后回答' }],
    [],
    createTestOptions({
      thinking: { type: 'enabled' },
      reasoningEffort: 'max',
    }),
    new AbortController().signal,
  );

  expect(request.thinking).toEqual({ type: 'enabled' });
  expect(request.reasoningEffort).toBe('max');
});
```

再添加未设置字段时 `not.toHaveProperty` 的断言。

- [ ] **Step 2: 验证 Red**

Run:

```bash
pnpm --filter @pure-agent/core exec vitest run src/agent/__tests__/step-builder.test.ts --reporter=verbose
```

Expected: FAIL，因为当前 `AgentOptions` 和 `ChatRequest` 不含这两个字段。

- [ ] **Step 3: 添加精确的可选类型字段**

在 `types/index.ts` 的 `AgentOptions` 与 `ChatRequest` 中使用相同字段：

```ts
thinking?: { type: 'enabled' | 'disabled' };
reasoningEffort?: 'high' | 'max';
```

`StepBuilder.assembleRequest()` 仅在字段不为 `undefined` 时赋值，保持其它请求字段的组装方式不变。

- [ ] **Step 4: 写 AgentLoop 到 Provider 的失败测试**

在 `loop.test.ts` 的 fake provider 记录最后一个参数：

```ts
expect(provider.requests[0]).toMatchObject({
  thinking: { type: 'enabled' },
  reasoningEffort: 'high',
});
```

运行同一测试文件，Expected: FAIL，因为 `processStream()` 尚未转发两个字段。

- [ ] **Step 5: 转发字段并验证 Green**

在 `AgentLoop.processStream()` 的 `streamMessage()` 参数对象中增加：

```ts
thinking: chatRequest.thinking,
reasoningEffort: chatRequest.reasoningEffort,
```

Run:

```bash
pnpm --filter @pure-agent/core exec vitest run src/agent/__tests__/step-builder.test.ts src/agent/__tests__/loop.test.ts --reporter=verbose
```

Expected: PASS，且现有无 thinking 的测试仍不含额外字段。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types/index.ts packages/core/src/agent/step-builder.ts packages/core/src/agent/loop.ts packages/core/src/agent/__tests__/step-builder.test.ts packages/core/src/agent/__tests__/loop.test.ts
git commit -m "feat(agent): forward reasoning controls to providers"
```
