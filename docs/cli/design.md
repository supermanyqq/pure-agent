# CLI — 多轮对话、运行时模型与思考深度

## 目标

CLI 是 Pure Agent 的交互入口。它必须让用户在一个终端会话中持续对话，并能安全地保存 API Key、在不中断会话的情况下切换模型，以及明确地控制模型的思考深度。

当前版本只实现 DeepSeek/OpenAI 兼容的流式 Provider；模型切换表示在已配置的兼容端点中切换模型 ID，不宣称支持尚未实现的 Provider。

## 交互入口

```text
pure-agent                         # Ink 交互式多轮会话
pure-agent "问题"                  # 单次纯文本调用
echo "问题" | pure-agent           # 管道纯文本调用
pure-agent config set api-key      # 交互式保存 API Key
printf '%s' "$KEY" | pure-agent config set api-key --stdin
pure-agent config show             # 显示脱敏后的持久化配置
```

交互会话用 slash command 管理本次会话状态：

| 命令 | 行为 |
| --- | --- |
| `/help` | 显示所有命令、参数和快捷键。 |
| `/new` | 清空当前会话的消息与上下文压缩状态，保留模型和 effort。 |
| `/model` | 打开模型选择器；↑/↓ 选择、Enter 应用、Esc 取消。 |
| `/model <model-id>` | 切换后续请求的模型，保留已有消息历史。仅接受受支持模型。 |
| `/effort` | 打开思考深度选择器；↑/↓ 选择、Enter 应用、Esc 取消。 |
| `/effort off|low|medium|high` | 切换后续请求的思考深度。 |
| `/config` | 显示 API Key 是否可用以及安全配置方式。 |
| `/config set api-key` | 进入不回显、不保留历史的 API Key 输入模式。 |

命令绝不能进入聊天消息历史，也不能在流式响应或工具执行期间执行。输入以 `/` 开头时，输入栏上方显示可过滤的命令提示；Tab 补全命令名，唯一前缀直接补全，歧义前缀按命令目录顺序循环。状态栏始终显示 `model · effort · 状态`，使当前运行设置可见。`Ctrl+C` 仅中止当前轮次，终端的常规退出行为交给 Ink。

## 配置与密钥安全

持久化配置仍位于 `~/.pure-agent/config.json`，读取优先级保持：调用覆盖值 > 环境变量 > 文件 > 默认值。CLI 写入仅更新它负责的字段并保留未知字段，避免破坏未来或手写配置。

```json
{
  "provider": {
    "apiKey": "sk-...",
    "defaultModel": "deepseek-v4-pro"
  },
  "cli": {
    "defaultEffort": "medium"
  }
}
```

顶层 `config set api-key` 默认从不回显的终端输入读取；非交互环境只能使用 `--stdin`。交互会话中的 `/config set api-key` 同样不接受密钥参数：它切换为掩码输入，且密钥不会进入命令历史、聊天消息或 notice。写入过程创建目录权限 `0700`、临时文件权限 `0600`，随后以原子重命名替换目标文件；`config show` 只输出 `sk-…` 形式的脱敏值。环境变量优先级不变，且不得被写入磁盘。

缺少 API Key 不是启动错误。Ink CLI 以 `required` 配置状态正常启动，显示 `/config set api-key` 引导并保持 slash command 输入可用；普通聊天文本会在创建 `AgentLoop` 或追加消息历史之前被拒绝。保存成功后状态切换为 `configured`，下一条普通消息才会懒初始化 Provider。这样用户不必退出 CLI 才能完成首次配置。

## 会话设置与 Provider 映射

会话运行时设置为：

```ts
type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

interface SessionSettings {
  model: string;
  effort: ReasoningEffort;
}
```

`SessionSettings` 由启动时加载的配置初始化；`/model` 和 `/effort` 只更新内存中的设置。每次发送消息时，CLI 将最新设置转换为 `AgentOptions`，再由 `StepBuilder` 传递给 `ChatProvider`。这样同一个 `AgentLoop`、消息历史和 Provider 连接可继续复用，而修改只影响下一次请求。

DeepSeek 映射必须是显式且可测试的：

| CLI effort | `thinking` | `reasoningEffort` |
| --- | --- | --- |
| `off` | `{ type: 'disabled' }` | 不传递 |
| `low` | `{ type: 'enabled' }` | 不传递 |
| `medium` | `{ type: 'enabled' }` | `'high'` |
| `high` | `{ type: 'enabled' }` | `'max'` |

Provider 返回“不支持 thinking/reasoning”的错误时，错误按现有错误路径显示，不伪造成功或静默降级。

## 模型目录与 Composer

当前 CLI 只支持 DeepSeek 的两个显式模型 ID：`deepseek-v4-pro` 与 `deepseek-v4-flash`。配置文件、命令参数或启动选项中出现其他模型 ID 时，CLI 回退为 `deepseek-v4-pro`；`/model <id>` 对未知 ID 显示可操作错误。

Ink App 占据当前终端高度。聊天区是可收缩视口，消息从标题和配置提示之后的顶部开始排列；内容溢出时从视口底部裁切，Composer 始终位于最后一行区域，并且只渲染顶部和底部边框。命令菜单与选择器显示在 Composer 内部，不会推动它离开终端底部。

## 消息呈现与思考耗时

用户消息显示为整行低对比度背景上的 `› 内容`，助手消息显示为 `● 内容`，不再重复角色名称。每个模型 Step 从 `agent:thinking` 开始计时，到第一个非空文本 delta 或工具调用事件结束；展示值格式为 `Thought for Ns`。工具调用结束的模型 Step 与最终文本回复的模型 Step 分别计时，因此工具执行时间不会被误算为思考时间。

流式文本收到第一个可见 delta 后，立即显示该 Step 的 Thought 标签；Turn 完成后，同一耗时按 assistant 消息顺序附着到历史消息，不重复渲染。Core 继续隐藏 reasoning 原文，时间测量仅属于 CLI 展示层。

## 模块边界

```text
packages/core/src/config/
  loader.ts                 配置读取、校验、原子持久化与脱敏
  types.ts                  ProviderConfig、CliConfig、ReasoningEffort

packages/cli/src/
  commands/parser.ts        将输入解析为聊天文本或命令，不含 UI 状态
  commands/completion.ts    命令匹配与 Tab 循环补全
  commands/handlers.ts      命令参数校验与会话状态变更结果
  runtime-options.ts        两个模型和四档 effort 的只读目录
  session-settings.ts       effort 到 Provider 请求参数的纯映射
  hooks/useAgent.ts         消息历史、AgentLoop、API Key 状态、运行时设置和命令分发
  components/InputBar.tsx   聊天输入、命令发现与不回显的密钥输入
  components/CommandMenu.tsx 斜杠命令的可发现提示
  components/OptionPicker.tsx 键盘驱动的模型/effort 选择器
```

Core 负责配置文件的格式、校验、权限和写入；CLI 只负责输入输出。命令解析与设置映射保持无副作用，以便不渲染 Ink 就能完整测试。`AgentOptions`、`ChatRequest` 与 `ChatProvider.streamMessage()` 共享 `thinking` 和 `reasoningEffort` 字段，避免 CLI 设置在 Agent Loop 边界丢失。

## 错误处理

- 缺少或空 API Key：交互式 CLI 显示可操作引导、允许 `/config`，但不允许创建对话请求；保存命令仍拒绝空值且不创建无效配置文件。
- 未知命令、缺少参数、非法 effort 或目录外模型：显示用法并保持会话设置不变。
- 配置 JSON 不合法或无法写入：保留原文件，显示错误，不覆盖数据。
- 流式生成期间发出命令：输入栏禁用，防止和活跃 Turn 竞态。
- 模型 ID 非法（空白）：在 CLI 层拒绝；端点侧的模型不可用错误由 Provider 原样呈现。

## 验证策略

1. Core 配置测试验证读写、原子更新、权限、脱敏、非法输入与环境变量优先级。
2. CLI 纯函数测试验证模型/effort 目录、命令解析、Tab 循环、选择器边界、帮助文案及 DeepSeek 映射。
3. Agent Loop 与 StepBuilder 测试验证 thinking 和 reasoning effort 从 `AgentOptions` 传到 `ChatProvider`。
4. CLI typecheck/build 以及 Core 完整 Vitest 套件验证跨包类型契约。
5. 使用临时 HOME 的 PTY 验证无 Key 启动、普通消息拦截、掩码保存、固定 Composer、选择器与 Tab 补全。

## 非目标

- 不新增 Anthropic、OpenAI 或其他 Provider 的网络协议实现。
- 不保存聊天记录到磁盘，也不实现跨进程恢复。
- 不实现成本统计、模型远程目录、自动补全的键盘选择或文件引用。
