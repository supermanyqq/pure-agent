# Desktop 对话界面设计

## 目标

Desktop 是 Pure Agent 的图形化工作台：用户可以创建多个会话、在历史会话之间切换，并在每个会话中与真实的 `@pure-agent/core` Agent Loop 进行多轮、流式对话。界面只保留会话导航与当前对话两个层级，不引入参考图中的额外菜单或右侧面板。

## 用户体验

窗口由 276px 的历史侧栏和一个主对话区组成。侧栏按最近活动时间展示会话，当前会话使用低饱和色块和一条细小的“信号线”标记；主区只展示消息区与固定在底部的输入框。空会话以任务标题和一句说明引导用户直接输入，不显示会话标题栏、状态标签、图标或预设提示卡。

“信号线”是界面的唯一强调元素：会话空闲时为静态蓝紫细线；Agent 产生增量时，它随状态轻微呼吸，并在侧栏活动项、当前流式消息和 Composer 状态之间提供同一条视觉线索。其余元素保持低对比、充分留白，避免抢占对话内容。

## 进程边界

```text
Electron Main                         Renderer
─────────────                         ────────
SessionManager                        React App
  ├─ Session[]                          ├─ Sidebar
  ├─ CoreAgentRuntime                   ├─ ChatView
  │   └─ AgentLoop per session          ├─ MessageBubble + Streamdown
  └─ SessionUpdate events               └─ Composer
          │                                    ▲
          └── ipcRenderer / contextBridge ─────┘
```

主进程拥有所有 `Message[]`、AbortController 与 AgentLoop 实例。渲染进程不能访问 Node API 或 API Key；它仅通过 preload 暴露的最小接口列出/创建会话、发送/停止消息，并订阅会话快照。每次状态变化都发送完整的单会话快照，因此切换历史会话和后台流式生成都不依赖 Renderer 的隐式状态。

## 会话模型

- 新建会话生成随机 id、默认标题“新会话”和空消息列表；Renderer 创建后立即选中它。
- 第一个用户消息会生成截断标题，之后不覆盖用户自定义标题（首版不提供改名 UI）。
- 每个会话都有独立的 `Message[]` 与 `CoreAgentRuntime`，因此连续发送会把该会话完整历史传给 Agent Loop。
- 生成期间，用户可切换到另一会话；生成继续在原会话中进行，返回时可看到最新流式快照。
- 点击停止只中断当前会话正在执行的 AbortController，不影响其他会话。
- 会话仅保存在当前应用进程内；持久化、删除、模型选择和设置面板不属于本阶段。

## 流式 Markdown

主进程将 `agent:stream:delta` 合并为会话的 `streamingMessage.content`，每个增量推送新的快照。Renderer 将该内容直接传给 `Streamdown`，并在会话状态为 `streaming` 时设置 `isAnimating`。这样未闭合的代码块、列表和表格也能够在模型尚未结束时稳定渲染。普通用户文本绝不经过 Markdown 解析。

## 视觉令牌

| Token | 值 | 用途 |
| --- | --- | --- |
| Canvas | `#FAFBFC` | 主背景 |
| Sidebar | `#F2F4F7` | 历史工作台 |
| Ink | `#25272D` | 标题和正文 |
| Muted | `#747B88` | 元数据和占位符 |
| Signal blue | `#4E6DFF` | 会话状态 |
| Signal violet | `#8E67FF` | 流式渐变末端 |
| Success | `#2FA36B` | 已连接状态 |

字体优先使用 `SF Pro Display` 和 `PingFang SC`；代码块与状态数据使用系统等宽字体。提供 `prefers-reduced-motion` 降级，所有按钮都有可见键盘焦点。

## 安全与错误状态

preload 只暴露白名单 IPC 通道，使用 `contextIsolation: true` 和 `sandbox: true`。当 Core 无法读取 API Key 或请求失败时，主进程把可展示错误字符串写入对应会话；UI 在 Composer 上方给出可操作提示，不伪造模型回复。
