# 阶段 4：验证

会话主进程逻辑通过 Vitest 验证：创建、切换隔离、多轮历史转发、流式累积、终止和错误。Renderer 的纯会话归约器验证历史快照不会被错误覆盖。构建验证必须运行 desktop 包的 typecheck、单元测试和 production build，并确认 preload 产物为 `out/preload/index.cjs`。开发窗口日志不得出现 `Unable to load preload script`；否则 Renderer 会丢失 `window.desktopAPI` 并错误回退到仅用于独立布局预览的内存 transport。

视觉验证使用 Electron 生产预览或开发窗口：确认参考图的一栏导航 + 单一主会话布局、新建会话、切换保留消息、Markdown 代码块/列表在流式期间正常显示，以及第二张参考图的菜单没有出现在界面中。

当本机没有 Electron 二进制时，可以用独立 Vite Renderer 预览检查布局。该模式使用仅开发环境启用的内存 transport，目的是展示组件结构和 Markdown 样式；Electron preload 存在时始终优先真实 IPC，不会把预览 transport 用于实际 Core 对话。
