# 阶段 1：Electron 与 React 壳

使用 `electron-vite` 统一构建 main、preload 和 React renderer。入口保持 `src/main/index.ts`、`src/preload/index.ts` 和 `src/renderer/index.html`，生产产物放在 desktop 包的 `out/` 目录。

窗口必须启用 `contextIsolation` 和 sandbox，禁止在 Renderer 中直接使用 Electron 或 Node。由于 sandboxed preload 不能作为 ESM 脚本执行，构建产物必须是 CommonJS `out/preload/index.cjs`；除 Electron 自身的受限 preload API 外，所有 preload 依赖必须内联在该单文件中，不能把 npm 的 Electron 启动器代码或 Node 内置模块带入沙箱。主进程加载该文件后，preload 才能把版本化的 `desktopAPI` 暴露给 `window`。类型声明位于 `src/shared/ipc.ts`，让三层在编译期共享同一份会话快照和命令接口。
