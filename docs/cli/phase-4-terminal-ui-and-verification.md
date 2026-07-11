# CLI 终端交互与验证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让模型/effort 状态和 slash commands 在 Ink TUI 中可发现，并以自动化、构建和实际 CLI 调用证明全部入口可用。

**Architecture:** 命令元数据由 parser 模块单一维护，`CommandMenu` 只过滤并显示它，`StatusBar` 只渲染状态。验证分层覆盖纯函数、Core 契约、构建，以及使用临时 HOME 的编译后 CLI 冒烟路径。

**Tech Stack:** React 19、Ink、Vitest、TypeScript、pnpm、Node.js。

## Global Constraints

- 不引入额外 TUI 框架或全屏终端控制库。
- 命令菜单不能改变历史上下箭头行为，也不能泄露 API Key。
- 终端 smoke test 必须使用临时 HOME，绝不读取或修改真实用户配置。
- 不以 typecheck 代替行为测试；不以单测代替编译后 CLI 验证。

---

### Task 1: 增加命令可发现性和会话状态呈现

**Files:**
- Create: `packages/cli/src/components/CommandMenu.tsx`
- Modify: `packages/cli/src/components/InputBar.tsx`
- Modify: `packages/cli/src/components/StatusBar.tsx`
- Modify: `packages/cli/src/app.tsx`
- Create: `packages/cli/src/__tests__/command-menu.test.ts`

**Interfaces:**
- Consumes: `SLASH_COMMANDS`、`AgentStatus` 和 `SessionSettings`。
- Produces: `/` 前缀的菜单、常驻模型/effort 信息、可清除的 session notice。

- [ ] **Step 1: 写命令菜单筛选失败测试**

将菜单筛选逻辑导出为纯函数：

```ts
expect(getVisibleCommands('/mo')).toEqual([
  expect.objectContaining({ name: '/model' }),
]);
expect(getVisibleCommands('question')).toEqual([]);
expect(getVisibleCommands('/')).toHaveLength(SLASH_COMMANDS.length);
```

Run:

```bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/command-menu.test.ts --reporter=verbose
```

Expected: FAIL，因为 `CommandMenu` 和筛选函数尚不存在。

- [ ] **Step 2: 实现最小菜单组件**

`CommandMenu` 接收 `input: string`。仅当 `input.trimStart().startsWith('/')` 时渲染，逐行显示命令 `usage` 和 `description`，颜色与现有绿色标题、dim 辅助信息保持一致。`InputBar` 在 `<TextInput>` 上方渲染菜单并继续持有输入状态；不添加新的键盘劫持。

- [ ] **Step 3: 显示实时设置与通知**

将 `settings: SessionSettings` 加入 `StatusBarProps`，idle 时也渲染：

```tsx
<Text dimColor>{`Model: ${settings.model} · Effort: ${settings.effort}`}</Text>
```

App 标题提示更新为 `Ctrl+C 中止当前轮次，输入 / 查看命令`。把 `state.notice` 作为一条与 assistant message 样式不同的 `Text dimColor` 渲染，使 `/model`、`/effort`、`/help` 有可见反馈。

- [ ] **Step 4: 验证 CLI 测试与类型检查**

Run:

```bash
pnpm --filter @pure-agent/cli exec vitest run --reporter=verbose
pnpm --filter @pure-agent/cli typecheck
```

Expected: PASS，且命令菜单测试证明普通问题不会显示菜单。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/components/CommandMenu.tsx packages/cli/src/components/InputBar.tsx packages/cli/src/components/StatusBar.tsx packages/cli/src/app.tsx packages/cli/src/__tests__/command-menu.test.ts
git commit -m "feat(cli): improve command discoverability"
```

### Task 2: 更新教学文档并运行全量验证

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/cli/design.md`

**Interfaces:**
- Consumes: 已实现 CLI 命令、配置格式和测试结果。
- Produces: 与实际能力一致的架构索引和教学阶段文档。

- [ ] **Step 1: 核对文档中的 CLI 声明**

在 `architecture.md` 将 CLI 结构、示例命令、配置文件字段更新为已实现名称；不要保留不存在的 `run` 子命令或把多 Provider 声称为当前能力。链接 `docs/cli/design.md` 与四个 phase 文档。

- [ ] **Step 2: 运行完整自动化验证**

Run:

```bash
pnpm --filter @pure-agent/core test
pnpm --filter @pure-agent/cli test
pnpm typecheck
pnpm build
```

Expected: 每个命令 exit 0；记录测试文件数与失败数，而不是只报告命令已执行。

- [ ] **Step 3: 运行临时 HOME 的编译产物冒烟测试**

Run:

```bash
TEMP_HOME="$(mktemp -d)"
printf '%s' 'sk-smoke-test' | HOME="$TEMP_HOME" node packages/cli/dist/index.js config set api-key --stdin
HOME="$TEMP_HOME" node packages/cli/dist/index.js config show
```

Expected: 第一条不回显 `sk-smoke-test`；第二条仅显示脱敏值；`$TEMP_HOME/.pure-agent/config.json` 存在且权限为 `600`。不要把该临时目录加入 git。

- [ ] **Step 4: 完成 requirement-by-requirement audit**

使用下表逐项核对并记录证据：

| 用户目标 | 证明证据 |
| --- | --- |
| CLI 多轮对话 | `useAgent` 持久化 `messagesRef`、`/new` 行为测试、现有 Agent tests。 |
| API Key 配置命令 | `config-command.test.ts` 和编译后 `config set/show` smoke test。 |
| 模型切换 | parser/session-settings tests、状态栏渲染和 `AgentLoop` 参数转发测试。 |
| 思考深度 | 四档映射单测与 `StepBuilder`/AgentLoop 转发测试。 |
| CLI UI 优化 | `CommandMenu` 单测、`StatusBar` 设置展示与手工 TTY 检查。 |

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md docs/cli/design.md
git commit -m "docs(cli): document interactive runtime controls"
```
