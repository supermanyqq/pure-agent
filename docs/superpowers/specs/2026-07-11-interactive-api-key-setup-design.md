# 交互式 API Key 配置设计

## 目标

缺少 API Key 时，`pure-agent` 的 Ink 交互式 CLI 必须正常启动。用户可以在启动后的终端通过 slash command 查看配置状态并安全地保存 API Key；在密钥可用之前，普通聊天消息不得创建 Provider 请求。

## 交互契约

| 用户输入 | 行为 |
| --- | --- |
| 启动时无 API Key | 显示未配置引导和 `/config set api-key` 用法，输入栏仍可用。 |
| `/config` | 显示当前 API Key 是否可用以及如何配置；不显示完整密钥。 |
| `/config set api-key` | 切换到一次性的密钥输入模式。 |
| 密钥输入模式中提交非空文本 | 调用 Core 的 `saveApiKey()`，成功后离开该模式并立即允许对话。 |
| 密钥输入模式中取消 | 不写入文件，回到普通命令输入。 |
| 密钥不可用时输入普通聊天文本 | 不追加聊天历史、不调用 `loadProviderConfig()` 或 Provider，而是显示配置引导。 |

`/config set api-key` 的输入不能回显，不能写入输入历史、UI 消息或 notice。保存仍使用现有的原子写入及 `0600` 文件权限。环境变量中已有 API Key 时，CLI 视为可聊天；该值不写回配置文件。

## 架构

CLI 的 `useAgent` 维护一个独立于 Agent 请求状态的 API Key 可用性标记。它在启动时只检查密钥是否存在，绝不在 effect 中创建 Provider，因此缺少密钥不会把 `AgentStatus` 设为 `error`。

slash parser 增加 `config` 命令；command handler 返回查询或进入密钥输入模式的意图。`useAgent` 将该意图转换为 UI 状态，并在提交密钥时调用 `saveApiKey()`。InputBar 以显式模式渲染：聊天模式保留当前的历史与斜杠菜单，密钥模式使用掩码输入且不记录值。普通聊天在可用性标记为 false 时由 hook 拦截。

普通聊天以外的 Provider 配置错误（例如无效 base URL）仍沿用现有请求错误路径；本次行为只改变“没有 API Key”这一启动前置条件。

## 验证

1. parser/handler 单元测试覆盖 `/config` 和 `/config set api-key`。
2. hook 的行为测试证明：无 Key 初始状态可接收 slash command，普通消息不会创建 Agent，保存 Key 后可进入正常请求路径。
3. InputBar 组件测试或可测的纯函数验证：密钥模式不存入历史，且显示掩码输入。
4. 完整 CLI 与 Core 测试、typecheck、build；在临时 HOME 的 PTY 中验证启动、配置、随后发送对话的完整链路。

## 非目标

- 不把 API Key 作为 `/config` 的命令参数。
- 不修改纯文本模式和现有的顶层 `pure-agent config` 命令。
- 不增加新的 Provider 或改变模型、thinking effort 的映射。
