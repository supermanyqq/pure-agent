# CLI 对话消息呈现 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Tab 补全后的输入光标位置，让消息从聊天视口顶部排列，并以真实模型思考耗时呈现紧凑的用户/Thought/助手消息。

**Architecture:** 保持 Core 事件协议不变。CLI 在 `useAgent` 内以单调时钟追踪每个 `agent:thinking` 阶段，并通过纯函数把已结束的耗时按 assistant 消息顺序配对到 `UIMessage`；组件只渲染该数据。Tab 补全通过更换 `TextInput` 的 React key 强制其以补全文本长度重建内部光标。

**Tech Stack:** TypeScript strict、React 19、Ink 6、ink-text-input 6、Vitest、pnpm workspace。

## Global Constraints

- 只修改 CLI 展示层；不得修改 `packages/core` 的事件载荷、Provider 协议或 reasoning 内容可见性。
- 思考耗时从 `agent:thinking` 到首个非空 text delta 或 `agent:tool_calls`，不得包含工具执行时间。
- 展示秒数为 `Math.max(1, Math.round(milliseconds / 1_000))`，所有数值字面量必须定义为具名常量。
- 禁止 `any`；使用 `unknown` 和既有联合类型；新增文件名使用 kebab-case。
- 每个生产行为先写失败的 Vitest，再运行确认失败，随后再写最小实现。
- 只暂存本计划列出的文件；保留未跟踪的 `docs/superpowers/plans/2026-07-10-implemented-core-documentation-and-contract-repair.md`。

---

### Task 1: 让 Tab 补全后的 TextInput 光标重置到文本末尾

**Files:**
- Create: `packages/cli/src/input-instance.ts`
- Create: `packages/cli/src/__tests__/input-instance.test.ts`
- Modify: `packages/cli/src/components/InputBar.tsx`

**Interfaces:**
- Consumes: `getNextCommandCompletion(input, completionState)` 的可选补全结果。
- Produces: `getNextInputInstanceKey(currentKey, completed)`；只有成功补全时返回递增 key。
- Runtime effect: `TextInput key={inputInstanceKey}` 在成功 Tab 补全后重新挂载，内部 `cursorOffset` 初始化为新 value 的长度。

- [x] **Step 1: 写输入实例键的失败测试**

在 `packages/cli/src/__tests__/input-instance.test.ts` 新建测试，预期辅助函数只在存在补全时递增键：

```ts
import { describe, expect, it } from 'vitest';
import { getNextInputInstanceKey } from '../input-instance.js';

const INITIAL_INPUT_INSTANCE_KEY = 0;

describe('getNextInputInstanceKey', () => {
  it('成功 Tab 补全时递增输入实例键', () => {
    expect(getNextInputInstanceKey(INITIAL_INPUT_INSTANCE_KEY, true)).toBe(1);
  });

  it('未补全时保留输入实例键', () => {
    expect(getNextInputInstanceKey(INITIAL_INPUT_INSTANCE_KEY, false)).toBe(
      INITIAL_INPUT_INSTANCE_KEY,
    );
  });
});
```

- [x] **Step 2: 运行测试，确认失败原因是模块不存在**

Run:

```bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/input-instance.test.ts --reporter=verbose
```

Expected: FAIL，提示无法解析 `../input-instance.js`；不得因测试配置或类型错误失败。

- [x] **Step 3: 实现最小的输入实例键纯函数**

新建 `packages/cli/src/input-instance.ts`：

```ts
const INPUT_INSTANCE_INCREMENT = 1;

/** Returns a new TextInput key only after a programmatic command completion. */
export function getNextInputInstanceKey(currentKey: number, completed: boolean): number {
  return completed ? currentKey + INPUT_INSTANCE_INCREMENT : currentKey;
}
```

- [x] **Step 4: 重新运行新增测试，确认变绿**

Run:

```bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/input-instance.test.ts --reporter=verbose
```

Expected: 2 tests PASS。

- [x] **Step 5: 将实例键接入 InputBar**

在 `InputBar.tsx`：

```ts
import { getNextInputInstanceKey } from '../input-instance.js';

const INITIAL_INPUT_INSTANCE_KEY = 0;

const [inputInstanceKey, setInputInstanceKey] = useState(INITIAL_INPUT_INSTANCE_KEY);
```

替换 Tab 分支为：

```ts
if (key.tab) {
  const completion = getNextCommandCompletion(input, completionState);
  if (completion) {
    setInput(completion.input);
    setCompletionState(completion.state);
    setInputInstanceKey((currentKey) => getNextInputInstanceKey(currentKey, true));
  }
  return;
}
```

并在既有 `TextInput` 上加入：

```tsx
<TextInput
  key={inputInstanceKey}
  value={input}
  onChange={handleChange}
  onSubmit={handleSubmit}
  placeholder={isApiKeyEntry ? 'Paste API key and press Enter…' : 'Type a message or / for commands…'}
  mask={isApiKeyEntry ? '*' : undefined}
/>
```

不要在普通 `handleChange`、历史导航、选择器模式或 API Key 模式中改变 `inputInstanceKey`。

- [x] **Step 6: 验证补全与输入组件测试**

Run:

```bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/input-instance.test.ts src/__tests__/completion.test.ts --reporter=verbose
pnpm --filter @pure-agent/cli typecheck
```

Expected: 所有指定测试 PASS，TypeScript 无错误。

- [x] **Step 7: Commit**

```bash
git add packages/cli/src/input-instance.ts packages/cli/src/__tests__/input-instance.test.ts packages/cli/src/components/InputBar.tsx
git commit -m "fix(cli): place cursor after command completion"
```

### Task 2: 记录并配对每个模型 Step 的真实思考耗时

**Files:**
- Create: `packages/cli/src/thought-timing.ts`
- Create: `packages/cli/src/__tests__/thought-timing.test.ts`
- Modify: `packages/cli/src/types.ts`
- Modify: `packages/cli/src/turn-messages.ts`
- Modify: `packages/cli/src/__tests__/turn-messages.test.ts`
- Modify: `packages/cli/src/hooks/useAgent.ts`

**Interfaces:**
- Consumes: `agent:thinking`、`agent:stream:delta`、`agent:tool_calls` 与 `agent:turn:end`。
- Produces: `ThoughtTimingState`、`startThoughtTiming()`、`finishThoughtTiming()`、`clearThoughtTiming()`、`getNewTurnMessages()` 返回带可选 `thoughtDurationMs` 的新消息包装项。
- State contract: `AgentState` 增加 `streamingThoughtDurationMs: number | null`；`UIMessage` 增加 `thoughtDurationMs?: number`。

- [x] **Step 1: 写纯计时状态的失败测试**

在 `packages/cli/src/__tests__/thought-timing.test.ts` 写入以下时间边界测试：

```ts
import { describe, expect, it } from 'vitest';
import {
  clearThoughtTiming,
  createThoughtTimingState,
  finishThoughtTiming,
  startThoughtTiming,
} from '../thought-timing.js';

const START_TIME_MS = 100;
const END_TIME_MS = 3_450;
const EXPECTED_DURATION_MS = 3_350;

describe('thought timing', () => {
  it('从 thinking 到首个可见结果记录一次耗时', () => {
    const started = startThoughtTiming(createThoughtTimingState(), START_TIME_MS);
    const finished = finishThoughtTiming(started, END_TIME_MS);

    expect(finished.durationMs).toBe(EXPECTED_DURATION_MS);
    expect(finished.state.pendingStartedAtMs).toBeNull();
    expect(finished.state.completedDurationsMs).toEqual([EXPECTED_DURATION_MS]);
  });

  it('同一 Step 第二次结束不会再追加耗时', () => {
    const started = startThoughtTiming(createThoughtTimingState(), START_TIME_MS);
    const first = finishThoughtTiming(started, END_TIME_MS);
    const second = finishThoughtTiming(first.state, END_TIME_MS);

    expect(second.durationMs).toBeNull();
    expect(second.state.completedDurationsMs).toEqual([EXPECTED_DURATION_MS]);
  });

  it('清理时丢弃没有对应 assistant 消息的计时', () => {
    const started = startThoughtTiming(createThoughtTimingState(), START_TIME_MS);
    expect(clearThoughtTiming(started)).toEqual(createThoughtTimingState());
  });
});
```

- [x] **Step 2: 运行测试，确认缺少计时模块导致失败**

Run:

```bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/thought-timing.test.ts --reporter=verbose
```

Expected: FAIL，提示 `thought-timing` 模块不存在。

- [x] **Step 3: 实现不依赖 React 的计时状态机**

新建 `packages/cli/src/thought-timing.ts`：

```ts
export interface ThoughtTimingState {
  pendingStartedAtMs: number | null;
  completedDurationsMs: readonly number[];
}

export interface FinishedThoughtTiming {
  state: ThoughtTimingState;
  durationMs: number | null;
}

const EMPTY_DURATIONS: readonly number[] = [];
const MINIMUM_DURATION_MS = 0;

export function createThoughtTimingState(): ThoughtTimingState {
  return { pendingStartedAtMs: null, completedDurationsMs: EMPTY_DURATIONS };
}

export function startThoughtTiming(
  state: ThoughtTimingState,
  startedAtMs: number,
): ThoughtTimingState {
  return { ...state, pendingStartedAtMs: startedAtMs };
}

export function finishThoughtTiming(
  state: ThoughtTimingState,
  finishedAtMs: number,
): FinishedThoughtTiming {
  if (state.pendingStartedAtMs === null) return { state, durationMs: null };
  const durationMs = Math.max(MINIMUM_DURATION_MS, finishedAtMs - state.pendingStartedAtMs);
  return {
    durationMs,
    state: {
      pendingStartedAtMs: null,
      completedDurationsMs: [...state.completedDurationsMs, durationMs],
    },
  };
}

export function clearThoughtTiming(_state: ThoughtTimingState): ThoughtTimingState {
  return createThoughtTimingState();
}
```

Define `MINIMUM_DURATION_MS = 0` for the `Math.max` literal. Do not format seconds in this module.

- [x] **Step 4: 重新运行计时测试，确认变绿**

Run:

```bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/thought-timing.test.ts --reporter=verbose
```

Expected: 3 tests PASS。

- [x] **Step 5: 写新消息和 assistant 耗时配对的失败测试**

替换 `turn-messages.test.ts` 的断言，使 `getNewTurnMessages()` 接受第三个参数 `thoughtDurationsMs` 并返回包装项：

```ts
const TOOL_CALL = {
  id: 'call-1',
  type: 'function' as const,
  function: { name: 'lookup', arguments: '{}' },
};
const messages: Message[] = [
  { role: 'user', content: 'question' },
  { role: 'assistant', content: 'tool request', toolCalls: [TOOL_CALL] },
  { role: 'tool', toolCallId: 'call-1', content: 'result' },
  { role: 'assistant', content: 'answer' },
];

expect(getNewTurnMessages(messages, 1, [1_000, 2_000])).toEqual([
  { message: messages[1], thoughtDurationMs: 1_000 },
  { message: messages[2] },
  { message: messages[3], thoughtDurationMs: 2_000 },
]);
```

再加入只有 user/tool 消息时不消费数组项目的断言，以及耗时数组不足时 assistant 包装项没有 `thoughtDurationMs` 的断言。

- [x] **Step 6: 运行配对测试，确认现有 API 不满足新契约**

Run:

```bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/turn-messages.test.ts --reporter=verbose
```

Expected: FAIL，因为既有函数只返回 `Message[]` 且不接受第三个参数。

- [x] **Step 7: 实现 assistant 顺序配对**

将 `turn-messages.ts` 调整为：

```ts
export interface NewTurnMessage {
  message: Message;
  thoughtDurationMs?: number;
}

const FIRST_DURATION_INDEX = 0;
const NEXT_DURATION_INDEX = 1;

export function getNewTurnMessages(
  messages: Message[],
  messageCountBeforeTurn: number,
  thoughtDurationsMs: readonly number[],
): NewTurnMessage[] {
  let durationIndex = FIRST_DURATION_INDEX;
  return messages.slice(messageCountBeforeTurn).map((message) => {
    if (message.role !== 'assistant') return { message };
    const thoughtDurationMs = thoughtDurationsMs[durationIndex];
    durationIndex += NEXT_DURATION_INDEX;
    return thoughtDurationMs === undefined ? { message } : { message, thoughtDurationMs };
  });
}
```

- [x] **Step 8: 重新运行配对测试，确认变绿**

Run:

```bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/turn-messages.test.ts --reporter=verbose
```

Expected: 所有配对、耗时不足和原地追加测试 PASS。

- [x] **Step 9: 将计时状态接入 useAgent**

在 `useAgent.ts` 导入 Node 单调时钟和纯函数：

```ts
import { performance } from 'node:perf_hooks';
import {
  clearThoughtTiming,
  createThoughtTimingState,
  finishThoughtTiming,
  startThoughtTiming,
} from '../thought-timing.js';
```

新增：

```ts
const thoughtTimingRef = useRef(createThoughtTimingState());

function finishCurrentThoughtTiming(): number | null {
  const finished = finishThoughtTiming(thoughtTimingRef.current, performance.now());
  thoughtTimingRef.current = finished.state;
  return finished.durationMs;
}
```

在 `agent:thinking` 分支设置：

```ts
thoughtTimingRef.current = startThoughtTiming(thoughtTimingRef.current, performance.now());
streamingThoughtDurationMs: null,
```

在 `agent:stream:delta` 分支中，先在 `setState` 之外计算，避免 React 重放 state updater 时重复消费计时：

```ts
const thoughtDurationMs = streamDelta.content
  ? finishCurrentThoughtTiming()
  : null;
setState((previous) => ({
  ...previous,
  status: 'streaming',
  streamingText: previous.streamingText + streamDelta.content,
  streamingThoughtDurationMs:
    previous.streamingThoughtDurationMs ?? thoughtDurationMs,
}));
```

`finishCurrentThoughtTiming()` 自身在 pending 为 `null` 时返回 `null`，所以后续 delta 不会重复追加。`agent:tool_calls` 分支同样在 `setState` 外调用 `finishCurrentThoughtTiming()`，但不把工具阶段的值放入 `streamingThoughtDurationMs`。

在 `agent:turn:end` 中调用：

```ts
const newMessages = getNewTurnMessages(
  turnEnd.messages,
  messageCountBeforeTurnRef.current,
  thoughtTimingRef.current.completedDurationsMs,
);
const uiMessages = newMessages.map(({ message, thoughtDurationMs }) =>
  messageToUI(message, thoughtDurationMs),
);
thoughtTimingRef.current = clearThoughtTiming(thoughtTimingRef.current);
```

将 `messageToUI()` 签名改为：

```ts
function messageToUI(message: Message, thoughtDurationMs?: number): UIMessage
```

并把第二个参数赋到 `UIMessage.thoughtDurationMs`。在 `resetConversation()`、发送新消息开始和 API Key 保存时调用 `clearThoughtTiming(thoughtTimingRef.current)` 并将 `streamingThoughtDurationMs` 设为 `null`。`agent:abort` 与 `agent:error` 只清空流式展示字段，计时引用保留到紧随其后的 `agent:turn:end`，由该分支配对后清空，避免丢失本 Turn 已完成工具 Step 的耗时。

- [x] **Step 10: 扩展 CLI 类型并运行时间相关测试**

在 `types.ts` 添加：

```ts
thoughtDurationMs?: number;
```

到 `UIMessage`，并在 `AgentState` 添加：

```ts
streamingThoughtDurationMs: number | null;
```

在所有 `createIdleState()` 和状态重置路径填入 `null`。随后运行：

```bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/thought-timing.test.ts src/__tests__/turn-messages.test.ts --reporter=verbose
pnpm --filter @pure-agent/cli typecheck
```

Expected: 全部 PASS，且没有 `any`、未初始化 `AgentState` 字段或 Node 时钟类型错误。

- [x] **Step 11: Commit**

```bash
git add packages/cli/src/thought-timing.ts packages/cli/src/__tests__/thought-timing.test.ts packages/cli/src/types.ts packages/cli/src/turn-messages.ts packages/cli/src/__tests__/turn-messages.test.ts packages/cli/src/hooks/useAgent.ts
git commit -m "feat(cli): track model thinking duration"
```

### Task 3: 渲染顶部对齐的紧凑消息样式和 Thought 标签

**Files:**
- Create: `packages/cli/src/components/message-presentation.ts`
- Create: `packages/cli/src/__tests__/message-presentation.test.ts`
- Modify: `packages/cli/src/components/Message.tsx`
- Modify: `packages/cli/src/components/ChatView.tsx`
- Modify: `packages/cli/src/app-layout.ts`
- Modify: `packages/cli/src/__tests__/app-layout.test.ts`
- Modify: `packages/cli/src/app.tsx`
- Modify: `docs/cli/design.md`

**Interfaces:**
- Consumes: `UIMessage.thoughtDurationMs` 和 `AgentState.streamingThoughtDurationMs`。
- Produces: `formatThoughtDuration(milliseconds)`、`getMessagePresentation(message)` 与 `CHAT_VIEW_LAYOUT`。
- Runtime effect: 用户行使用整行暗背景和 `›`，助手行使用 `●`，Thought 行仅在有真实耗时时显示；聊天区不使用 `justifyContent="flex-end"`。

- [x] **Step 1: 写消息呈现辅助函数的失败测试**

新建 `packages/cli/src/__tests__/message-presentation.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  formatThoughtDuration,
  getMessagePresentation,
} from '../components/message-presentation.js';

describe('message presentation', () => {
  it('将不足一秒的真实耗时展示为 1s', () => {
    expect(formatThoughtDuration(200)).toBe('Thought for 1s');
  });

  it('将毫秒四舍五入为秒', () => {
    expect(formatThoughtDuration(3_450)).toBe('Thought for 3s');
  });

  it('为用户消息返回深色行和 › 前缀', () => {
    expect(getMessagePresentation({ id: 'user-1', role: 'user', content: 'hello' }))
      .toMatchObject({ prefix: '› ', backgroundColor: 'gray', color: 'white' });
  });

  it('为助手消息返回 ● 前缀且保留 Thought 耗时', () => {
    expect(getMessagePresentation({
      id: 'assistant-1',
      role: 'assistant',
      content: '你好',
      thoughtDurationMs: 3_450,
    })).toMatchObject({ prefix: '● ', color: 'white', thoughtLabel: 'Thought for 3s' });
  });
});
```

- [x] **Step 2: 运行测试，确认模块尚不存在**

Run:

```bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/message-presentation.test.ts --reporter=verbose
```

Expected: FAIL，原因是 `message-presentation` 不存在。

- [x] **Step 3: 实现消息展示数据与耗时格式化**

新建 `packages/cli/src/components/message-presentation.ts`：

```ts
import type { UIMessage } from '../types.js';

export interface MessagePresentation {
  prefix: string;
  color: string;
  backgroundColor?: string;
  thoughtLabel?: string;
}

const MILLISECONDS_PER_SECOND = 1_000;
const MINIMUM_DISPLAY_SECONDS = 1;
const USER_PREFIX = '› ';
const ASSISTANT_PREFIX = '● ';
const SYSTEM_PREFIX = '◆ ';
const TOOL_PREFIX = '◆ ';

export function formatThoughtDuration(milliseconds: number): string {
  const seconds = Math.max(
    MINIMUM_DISPLAY_SECONDS,
    Math.round(milliseconds / MILLISECONDS_PER_SECOND),
  );
  return `Thought for ${seconds}s`;
}

export function getMessagePresentation(message: UIMessage): MessagePresentation {
  const thoughtLabel = message.thoughtDurationMs === undefined
    ? undefined
    : formatThoughtDuration(message.thoughtDurationMs);
  if (message.role === 'user') {
    return { prefix: USER_PREFIX, color: 'white', backgroundColor: 'gray' };
  }
  if (message.role === 'assistant') {
    return { prefix: ASSISTANT_PREFIX, color: 'white', thoughtLabel };
  }
  if (message.role === 'tool') return { prefix: TOOL_PREFIX, color: 'yellow' };
  return { prefix: SYSTEM_PREFIX, color: 'gray' };
}
```

- [x] **Step 4: 重新运行消息展示测试，确认变绿**

Run:

```bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/message-presentation.test.ts --reporter=verbose
```

Expected: 4 tests PASS。

- [x] **Step 5: 用展示数据重写 Message 和 ChatView**

在 `Message.tsx` 使用 `getMessagePresentation(msg)`，并渲染：

```tsx
{presentation.thoughtLabel && (
  <Box marginTop={1}>
    <Text backgroundColor="blue" color="white">Thought</Text>
    <Text dimColor>{presentation.thoughtLabel.replace('Thought', '')}</Text>
  </Box>
)}
<Box width="100%" backgroundColor={presentation.backgroundColor} paddingX={msg.role === 'user' ? 1 : 0}>
  <Text color={presentation.color}>{presentation.prefix}{msg.content}</Text>
</Box>
```

不要再渲染 `ROLE_LABELS`、冒号、`paddingLeft={2}` 或独立的 `Agent:`/`You:` 标题。工具调用名称继续紧随工具消息内容，以黄色、低对比度文字显示。

在 `ChatView.tsx` 增加：

```ts
streamingThoughtDurationMs: number | null;
```

当 `streamingText` 非空且 status 为 `thinking` 或 `streaming` 时，构造：

```tsx
<Message
  msg={{
    id: 'streaming-assistant-message',
    role: 'assistant',
    content: streamingText,
    thoughtDurationMs: streamingThoughtDurationMs ?? undefined,
  }}
/>
```

这取代既有带 `paddingLeft={2}` 的裸 `<Text>` 流式输出。

- [x] **Step 6: 写顶部布局的失败测试**

将 `app-layout.test.ts` 扩展为：

```ts
import { CHAT_VIEW_LAYOUT, getAppHeight } from '../app-layout.js';

it('聊天视口不使用底部对齐，消息从顶部开始', () => {
  expect(CHAT_VIEW_LAYOUT).not.toHaveProperty('justifyContent');
  expect(CHAT_VIEW_LAYOUT).toMatchObject({ flexDirection: 'column', flexGrow: 1, flexShrink: 1 });
});
```

- [x] **Step 7: 运行布局测试，确认新布局常量尚不存在**

Run:

```bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/app-layout.test.ts --reporter=verbose
```

Expected: FAIL，提示 `CHAT_VIEW_LAYOUT` 未导出。

- [x] **Step 8: 将 App 聊天视口改为顶部对齐**

在 `app-layout.ts` 定义：

```ts
export const CHAT_VIEW_LAYOUT = {
  flexDirection: 'column',
  flexGrow: 1,
  flexShrink: 1,
  overflow: 'hidden',
} as const;
```

在 `app.tsx`：

```tsx
<Box {...CHAT_VIEW_LAYOUT}>
  <ChatView
    completedMessages={state.completedMessages}
    streamingText={state.streamingText}
    streamingThoughtDurationMs={state.streamingThoughtDurationMs}
    status={state.status}
  />
</Box>
```

删除 `justifyContent="flex-end"`，并删除 completedMessages 为零时的独立流式 `<Box>`；`ChatView` 自己处理空消息和首轮流式输出。标题、notice、状态栏和 InputBar 的顺序不变。

- [x] **Step 9: 更新 CLI 设计文档**

在 `docs/cli/design.md` 的“模型目录与 Composer”段落改为明确：聊天内容从可用视口顶部排列；溢出时从底部裁切；Composer 仍固定在终端底部。新增“消息呈现”小节，记录 `›` 用户行、`Thought for Ns` 真实计时、`●` 助手行，以及计时不包含工具执行时间。

- [x] **Step 10: 运行 UI 相关测试和类型检查**

Run:

```bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/message-presentation.test.ts src/__tests__/app-layout.test.ts src/__tests__/turn-messages.test.ts --reporter=verbose
pnpm --filter @pure-agent/cli typecheck
```

Expected: 所有测试 PASS；`Box` 的 `backgroundColor`、流式 `UIMessage` 和 App 的 `CHAT_VIEW_LAYOUT` 类型全部通过。

- [x] **Step 11: Commit**

```bash
git add packages/cli/src/components/message-presentation.ts packages/cli/src/__tests__/message-presentation.test.ts packages/cli/src/components/Message.tsx packages/cli/src/components/ChatView.tsx packages/cli/src/app-layout.ts packages/cli/src/__tests__/app-layout.test.ts packages/cli/src/app.tsx docs/cli/design.md
git commit -m "feat(cli): present compact chat messages"
```

### Task 4: 完整验证、PTY 光标验收和全局 CLI 更新

**Files:**
- Verify only: `packages/cli/src/**`
- Verify only: `packages/core/src/**`
- Verify only: globally linked `pure-agent`

**Interfaces:**
- Consumes: 已完成的 CLI 构建产物与全局 npm link。
- Produces: 全套 CLI 测试、类型检查、构建和可观察的终端补全验证记录。

- [x] **Step 1: 运行整个 CLI 单元测试套件**

Run:

```bash
pnpm --filter @pure-agent/cli test
```

Expected: 所有 CLI Vitest 测试 PASS，包含既有 API Key、命令、选择器、会话设置和新计时/展示测试。

- [x] **Step 2: 运行工作区类型检查和构建**

Run:

```bash
pnpm typecheck
pnpm build
```

Expected: Turbo 中所有受影响包 PASS，无 TypeScript 错误。

- [x] **Step 3: 在临时 HOME PTY 验证 Tab 末尾光标**

启动：

```bash
temp_home=$(mktemp -d /private/tmp/pure-agent-chat-presentation.XXXXXX)
env -u PURE_AGENT_API_KEY HOME="$temp_home" pure-agent
```

输入 `/co`，按 Tab 补全为 `/config `，随后输入 `x`。验收输出必须显示 `/config x`，而不是 `/cxonfig` 或其他插入到中间的文本。按 Ctrl+C 退出。临时 HOME 不存放真实密钥。

- [x] **Step 4: 重新链接全局 CLI 并检查目标路径**

Run:

```bash
pnpm --filter @pure-agent/cli link --global
readlink "$(command -v pure-agent)"
```

Expected: 全局命令仍指向 `/Users/lihuowang/Documents/pure-agent/packages/cli/dist/index.js` 或该包的全局链接入口；不复制 API Key 到配置或命令历史。

- [x] **Step 5: 检查最终差异与提交状态**

Run:

```bash
git status --short
git log --oneline -3
```

Expected: 只保留用户原有未跟踪的计划文件；本计划涉及的代码和文档均已提交。
