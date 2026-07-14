# 阶段 2：会话与 Core 编排

`SessionManager` 是主进程唯一的会话状态拥有者。它创建会话、维护每个会话的 Core `Message[]`、把 Agent 生命周期事件转换为可渲染的快照，并在会话变更时通知 IPC。

`CoreAgentRuntime` 为每个会话创建独立的 `AgentLoop` 和 Context Manager，复用现有配置加载、Provider、系统提示词和空工具注册表。运行时通过依赖注入的接口让 `SessionManager` 单元测试能够使用确定性的假流，不需要真实 API Key 或网络。
