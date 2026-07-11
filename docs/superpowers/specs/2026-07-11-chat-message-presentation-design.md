# CLI 对话消息呈现设计

## 目标

修复 Slash Command 的 Tab 补全后光标停留在旧位置的问题；让消息区从可用视口顶部开始排列；以紧凑的终端对话样式展示用户消息、真实思考耗时和助手消息。

## 范围

- Tab 补全命令名后，光标必须位于补全结果的末尾。
- 有消息时，聊天记录从标题和配置提示之后的视口顶部向下排列，Composer 仍固定在终端底部。
- 用户消息显示为整行深色底的 `› 内容`，不显示 `You:`。
- 助手文本显示为 `● 内容`，不显示 `Agent:`。
- 每一个模型 Step 都展示真实的 `Thought for Ns`：从 `agent:thinking` 到该 Step 首个可见结果的耗时。普通回复以第一个非空 text delta 为结束；工具调用回复以 `agent:tool_calls` 为结束。
- 流式文本开始时立即显示已结束的思考耗时；Turn 完成后将同一耗时附着到对应历史助手消息，避免重复渲染。

## 非目标

- 不展示模型返回的 reasoning 原文。
- 不改变 Core 的 `AgentEventMap`、Provider 协议或事件时间戳格式。
- 不新增消息持久化、滚动行为、主题配置或 Markdown 渲染。
- 不将工具执行时长计入模型思考耗时。

## 设计选择

### 在 CLI 记录时间，而不是扩展 Core 事件

`agent:thinking`、`agent:stream:delta` 和 `agent:tool_calls` 已足以在 CLI 中界定一次模型调用的可见思考阶段。`useAgent` 使用单调时钟记录开始时间；收到第一个非空文本 delta 或工具调用事件时结束该阶段。这样不会扩展 Core 的公开事件载荷，也不会让 Provider 或 Agent Loop 知晓展示层时间单位。

每个结束的思考阶段按 Agent Step 顺序放入一个等待配对的列表。Turn 结束时，CLI 只为新追加的 assistant 消息按顺序取出一个持续时间；tool 和 user 消息不消费持续时间。工具调用产生的 assistant 消息也获得对应耗时，后续模型调用则获得自己的独立耗时。

显示值以秒为单位四舍五入，并设最小值为 `1s`。时间测量使用毫秒，展示格式化是唯一的舍入点。

### 让流式和完成态共享消息语义

`UIMessage` 增加可选的 `thoughtDurationMs`。`Message` 负责一条完成消息的角色布局和可选 Thought 标签；`ChatView` 为流式文本创建相同的助手视觉结构，并传入已完成的本 Step 耗时。Turn 结束后流式结构消失，由带有相同计时值的完成消息替代，因此终端不会出现两个 Thought 标签。

用户消息用全宽、低对比度背景承载 `›` 前缀，助手消息使用白色 `●` 前缀。系统和工具消息保留各自的语义颜色，但不再使用冗长角色标题。多行文本与现有 Ink 文本换行行为保持一致。

### 顶部对齐与固定 Composer

`App` 的聊天视口继续拥有可收缩高度和隐藏溢出，以保护底部 Composer；移除其中的 `justifyContent="flex-end"`，使普通 flex column 流从顶部开始。没有消息时仍保持空白视口，API Key 提示和 notice 的位置不改变。

### 使用输入控件重建修正补全光标

`ink-text-input` 只会在自身光标偏移超出新值范围时将其移到末尾。命令从 `/` 补成 `/config` 时，旧偏移仍在范围内，因此光标停在中间。

`InputBar` 为程序化 Tab 补全维护一个递增的输入实例键。每次成功补全时，更新值并递增该键；`TextInput` 以新 key 挂载，初始光标偏移等于新文本长度。普通键入、历史记录、API Key 模式和选择器切换不递增该键。

## 模块边界

```text
packages/cli/src/
  hooks/useAgent.ts                 记录每个模型 Step 的开始和结束时间，配对到 UIMessage
  types.ts                           UIMessage 的可选 thoughtDurationMs 契约
  turn-messages.ts                   纯函数：将新 Agent 消息与等待中的思考耗时配对
  components/Message.tsx             用户、Thought、助手、工具和系统消息的紧凑布局
  components/ChatView.tsx            完成态与流式助手消息的统一渲染
  components/InputBar.tsx            Tab 补全后重建 TextInput，确保光标在尾部
  app.tsx                            聊天视口顶部对齐
```

计时和消息配对只属于 CLI 会话状态。Core 仍只负责发出语义事件；组件只消费已格式化的 `UIMessage` 和流式状态。

## 错误与边界

- 收到空 text delta 时不结束思考计时；只有首个非空文本可见内容才结束。
- Tool 调用没有文本时，在 `agent:tool_calls` 结束计时，避免计时跨越工具执行。
- aborted、error 或没有最终 assistant 消息的 Turn 丢弃未配对计时，不显示伪造 Thought。
- 若事件顺序异常或缺少开始时间，消息仍正常显示，只是不显示 Thought 标签。
- 每次 `/new`、API Key 保存后重新初始化 Agent，或收到 Turn 结束时，清理等待中的计时状态，避免串到下一轮。
- TextInput 的实例键只在成功的 Tab 补全后变化，避免干扰手工光标导航和密钥掩码输入。

## 验证策略

1. 为 TextInput 实例键增加纯函数测试：仅成功 Tab 补全递增键，确保补全逻辑有可回归的状态边界。
2. 为思考耗时队列和消息配对增加 Vitest：文本 Step、工具调用 Step、空 delta、缺失开始时间、Turn 取消和多 Step 顺序。
3. 为消息展示辅助函数或组件输入增加测试：用户、助手带 Thought、工具和系统消息使用预期前缀/标签；流式回复收到耗时后展示单一 Thought。
4. 扩展 App 布局测试，断言聊天视口不再使用底部对齐语义。
5. 运行 `pnpm --filter @pure-agent/cli test`、`pnpm --filter @pure-agent/cli typecheck` 和 `pnpm --filter @pure-agent/cli build`。
6. 在临时 HOME 的 PTY 中验证：`/co` + Tab 后继续输入字符落在 `/config` 尾部；发送一条消息后记录从顶部显示，且最终只出现一个真实 `Thought for Ns` 标签。
