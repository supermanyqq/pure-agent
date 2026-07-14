# 阶段 3：会话界面与流式 Markdown

Renderer 初次加载会获取会话列表；没有会话时创建一个。`useSessions` 保存当前选择的 id、订阅所有会话快照，并把更新合并到对应会话，保证用户在流式生成中切换历史不会丢失后台更新。

`Sidebar` 负责创建和选择会话；`ChatView` 负责极简空状态、消息滚动和错误。空状态只保留任务标题和说明，用户通过 Composer 直接发起任务；`MessageBubble` 对助手已完成和流式消息使用 `Streamdown`，流式阶段设置 `isAnimating`；`Composer` 处理 Enter 发送、Shift+Enter 换行和停止。样式遵循 `design.md` 的令牌和信号线，不实现第二张参考图所示的菜单区域。
