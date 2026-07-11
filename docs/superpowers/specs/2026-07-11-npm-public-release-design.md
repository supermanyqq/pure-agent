# npm 公开发布设计

## 目标

把 Pure Agent 作为可公开安装的 npm CLI 发布，使用户通过下面的命令获得 `pure-agent` 可执行文件：

```bash
npm install -g @pure-agent/cli
```

首个公开版本为 `0.1.0`，发布到默认 npm registry，访问级别为 `public`。

## 发布拓扑

CLI 的编译产物保留对 `@pure-agent/core` 的运行时导入，因此两个包必须一起发布：

```text
@pure-agent/core@0.1.0  ── public npm dependency ──►  @pure-agent/cli@0.1.0
                                                           └── bin: pure-agent
```

发布顺序固定为 Core 在前、CLI 在后。CLI 的生产依赖从 workspace 协议改为 `^0.1.0`，以便 npm 安装器能解析已经发布的 Core。根 `package.json` 继续保持 `private: true`，不发布 monorepo 根包或 Desktop 包。

不采用把 Core 打包进 CLI 的方案：这会改变当前明确的模块边界、需要引入新的 bundle 构建工具，并且不必要地阻止用户直接使用 Core。也不单独发布 CLI：其依赖在安装后无法解析。

## 包内容与元数据

`packages/core/package.json` 和 `packages/cli/package.json` 都移除 `private: true`，并使用：

```json
{
  "license": "MIT",
  "engines": { "node": ">=20" },
  "publishConfig": { "access": "public" },
  "files": ["dist", "README.md", "LICENSE"]
}
```

Node 20 是 Ink 6 的最低运行时要求。两个包补充 description、keywords、repository、bugs 和 homepage，均指向 `https://github.com/supermanyqq/pure-agent`。

每个发布目录拥有自身的 `README.md` 与 `LICENSE`，因为 npm 打包不会从 monorepo 根目录自动带入父目录文件。许可证文本为 MIT，版权行固定为：

```text
Copyright (c) 2026 Pure Agent contributors
```

根目录也保存同一份 `LICENSE`，使源码仓库和两个 npm tarball 使用一致的公开许可。

CLI README 是最终用户入口，包含安装命令、首次运行、`/config set api-key` 安全配置、`/model`、`/effort`、`/new` 和卸载命令。它不包含真实 API Key、npm 凭据或本地绝对路径。Core README 只说明它是 CLI 的运行时依赖，并链接到仓库与 CLI 包，避免把内部 API 误承诺为稳定的独立 SDK。

## 干净构建与 tarball 边界

两个包的 TypeScript 配置显式排除 `src/**/__tests__/**`，避免测试 JavaScript、声明和 source map 被生成到 `dist`。每个包在 `prepack` 生命周期先清理、再构建，确保不会把此前遗留的测试输出带入 tarball。

`files` 白名单阻止发布 `src`、`.turbo`、`tsconfig.tsbuildinfo`、工作区文档和开发配置。Core 的 tokenizer JSON 不会发布：当前运行时未自动从包路径加载该文件，且未初始化时沿用已有的估算 token 路径。任何将来新增的运行时资产都必须先被显式加入 `files`，并在 tarball 验收中覆盖。

## 发布前验证

所有打包和 npm 操作使用临时 `NPM_CONFIG_CACHE`，避免当前用户目录中 root-owned npm cache 文件阻塞发布，同时不修改 `~/.npm` 的权限或内容。

发布前必须完成：

1. `pnpm clean && pnpm build && pnpm typecheck`，以及 Core 和 CLI 的完整 Vitest 测试。
2. 对 Core、CLI 分别运行 `npm pack --dry-run --ignore-scripts --json`；断言 tarball 只含 `dist/`、README、LICENSE 和 package.json，且没有 `src/`、`__tests__/`、`.turbo/` 或 `.tsbuildinfo`。
3. 用生成的本地 Core 和 CLI tarball 在全新临时目录执行 `npm install`，确认 CLI 能解析 Core 依赖并且 bin 文件存在。
4. `npm login` 后执行 `npm whoami`，再确认该账号拥有 `@pure-agent` scope 的发布权限。若 scope 未创建或账号不属于该组织，停止发布，让用户先在 npm 完成组织/权限配置。

## 公开发布与回读验证

通过全部本地验证并确认 npm 登录、scope 权限后，使用默认 registry 依次执行：

```bash
npm publish --access public     # packages/core
npm publish --access public     # packages/cli
```

任何一步失败都停止；不得重试同一版本或通过修改版本号掩盖失败。Core 成功、CLI 失败时，报告 Core 已公开而 CLI 未发布，等待用户决定下一步。

两个发布成功后，使用 `npm view @pure-agent/core@0.1.0`、`npm view @pure-agent/cli@0.1.0` 读取 registry 元数据；在新的临时 prefix 执行 `npm install -g @pure-agent/cli@0.1.0`，确认 `pure-agent` 命令存在并可在无 API Key 状态下显示安全配置引导。随后卸载临时 prefix，不改动用户当前全局链接。

## 非目标

- 不发布 `@pure-agent/desktop`、monorepo 根包或任何 GitHub Release。
- 不创建 npm 组织、不修改 npm 账户、不开启 npm 2FA 或更改 registry 默认配置。
- 不自动上传 provenance、签名或 changelog；这些需要单独的发布基础设施与用户授权。
- 不将 API Key、npm token、OTP 或其他凭据写入仓库、tarball、日志或测试快照。
