# CLI 配置与密钥持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `pure-agent config` 能安全地保存 API Key，并让 Core 与 CLI 使用同一份可测试的配置文件契约；交互式会话可复用该契约在启动后完成首次配置。

**Architecture:** 配置文件解析、校验、权限、原子写入和脱敏全部留在 Core config 模块；CLI 只解析 `config` 子命令、读取输入流并渲染结果。写入 API Key 时保留 JSON 中不属于当前版本的字段，读取链路仍维持 environment 覆盖 file 的既有优先级。

**Tech Stack:** TypeScript strict、Node.js `fs`/`path`/`os`、Vitest、pnpm workspace。

## Global Constraints

- 不接受 API Key 位置参数；TTY 使用不回显输入，管道只能配合 `--stdin`。
- API Key、临时文件和最终配置文件都不可以出现在标准输出、异常文本或测试快照中。
- 所有数值字面量提取为具名常量，禁止 `any`，使用联合类型而非 enum。
- 新行为必须先通过失败测试证明，再写最小实现。
- 只 stage 本阶段实际修改的文件；不要纳入未跟踪的 `docs/superpowers/` 文件。

---

### Task 1: 给 Core config 增加可写、可隔离测试的文件接口

**Files:**
- Modify: `packages/core/src/config/types.ts`
- Modify: `packages/core/src/config/loader.ts`
- Modify: `packages/core/src/config/__tests__/loader.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: 当前 `ProviderConfig` 和 `~/.pure-agent/config.json` 的 `provider` 对象。
- Produces: `ReasoningEffort`、`CliConfig`、`readStoredConfig()`、`hasConfiguredApiKey()`、`saveApiKey()`、`redactApiKey()`。

- [ ] **Step 1: 写 API Key 原子保存的失败测试**

在 `loader.test.ts` 加入临时路径 helper；测试路径由 `mkdtempSync(join(tmpdir(), 'pure-agent-config-'))` 生成，常量命名为 `TEST_DIRECTORY_PREFIX`。测试覆盖：

```ts
const TEST_API_KEY = 'sk-test-1234567890';

it('保存 API Key 时保留未知字段并限制文件权限', () => {
  writeFileSync(configPath, JSON.stringify({ featureFlag: true, provider: { baseUrl: 'https://api.example.com' } }));

  saveApiKey(TEST_API_KEY, { configPath });

  expect(readFileSync(configPath, 'utf8')).toContain('"featureFlag": true');
  expect(readStoredConfig({ configPath }).provider?.apiKey).toBe(TEST_API_KEY);
  expect(statSync(configPath).mode & FILE_PERMISSION_MASK).toBe(CONFIG_FILE_MODE);
});

it('拒绝空白 API Key 且不覆盖已有配置', () => {
  writeFileSync(configPath, ORIGINAL_JSON);
  expect(() => saveApiKey('   ', { configPath })).toThrow(/API key/i);
  expect(readFileSync(configPath, 'utf8')).toBe(ORIGINAL_JSON);
});
```

再验证 `redactApiKey('sk-test-1234567890')` 不包含完整密钥，`redactApiKey(undefined)` 返回“未配置”状态，而不是抛错。

- [ ] **Step 2: 运行 Core 配置测试，确认新增断言失败**

Run:

```bash
pnpm --filter @pure-agent/core exec vitest run src/config/__tests__/loader.test.ts --reporter=verbose
```

Expected: FAIL，原因是 `saveApiKey`、`readStoredConfig` 和 `redactApiKey` 尚未导出。

- [ ] **Step 3: 定义存储格式与 CLI 默认值类型**

在 `types.ts` 增加以下精确类型；`StoredConfig` 的索引签名确保读写时不会丢失未知顶层字段。

```ts
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export interface CliConfig {
  defaultEffort: ReasoningEffort;
}

export interface StoredConfig {
  [key: string]: unknown;
  provider?: { [key: string]: unknown };
  cli?: { [key: string]: unknown };
}

export interface ConfigFileOptions {
  configPath?: string;
}
```

保持 `ProviderConfig` 为已校验的运行时配置，不将可选的 JSON 字段混入它。

- [ ] **Step 4: 实现安全读取、写入和脱敏**

在 `loader.ts` 取代模块初始化时计算的固定路径，使用每次调用都可解析的：

```ts
const JSON_INDENT_SPACES = 2;
const CONFIG_DIRECTORY_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
const TEMP_FILE_SUFFIX = '.tmp';

export function getConfigFilePath(): string {
  return join(homedir(), CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);
}

function resolveConfigPath(options: ConfigFileOptions): string {
  return options.configPath ?? getConfigFilePath();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function saveApiKey(apiKey: string, options: ConfigFileOptions = {}): void {
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) throw new Error('API key must not be empty');

  const configPath = resolveConfigPath(options);
  const current = readStoredConfig({ configPath });
  const provider = isRecord(current.provider) ? current.provider : {};
  const next: StoredConfig = { ...current, provider: { ...provider, apiKey: normalizedApiKey } };
  const directoryPath = dirname(configPath);
  const temporaryPath = `${configPath}${TEMP_FILE_SUFFIX}`;

  mkdirSync(directoryPath, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
  chmodSync(directoryPath, CONFIG_DIRECTORY_MODE);
  writeFileSync(temporaryPath, `${JSON.stringify(next, null, JSON_INDENT_SPACES)}\n`, {
    encoding: 'utf8', mode: CONFIG_FILE_MODE,
  });
  chmodSync(temporaryPath, CONFIG_FILE_MODE);
  renameSync(temporaryPath, configPath);
  chmodSync(configPath, CONFIG_FILE_MODE);
}

export function redactApiKey(apiKey: string | undefined): string {
  if (!apiKey) return 'not configured';
  if (apiKey.length <= API_KEY_DISPLAY_PREFIX_LENGTH) return '***';
  return `${apiKey.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH)}…`;
}
```

定义 `CONFIG_DIRECTORY_MODE`、`CONFIG_FILE_MODE`、`FILE_PERMISSION_MASK`、`TEMP_FILE_SUFFIX` 与 `API_KEY_DISPLAY_PREFIX_LENGTH`。`loadProviderConfig()` 仍对缺失/损坏文件静默回退，但调用 `readStoredConfig()` 的 CLI 写操作遇到损坏 JSON 必须抛出、不得覆盖原文件。

- [ ] **Step 5: 导出并重新运行 Core 配置测试**

从 `packages/core/src/index.ts` 导出新增类型与函数：

```ts
export type { CliConfig, ConfigFileOptions, ReasoningEffort, StoredConfig } from './config/types.js';
export { getConfigFilePath, loadProviderConfig, readStoredConfig, redactApiKey, saveApiKey } from './config/loader.js';
```

Run:

```bash
pnpm --filter @pure-agent/core exec vitest run src/config/__tests__/loader.test.ts --reporter=verbose
```

Expected: PASS；原有的覆盖优先级和校验测试也必须继续通过。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config/types.ts packages/core/src/config/loader.ts packages/core/src/config/__tests__/loader.test.ts packages/core/src/index.ts
git commit -m "feat(config): persist API keys securely"
```

## 交互会话复用

后续 CLI 会话阶段不会在启动时创建 Provider。它先调用 `hasConfiguredApiKey()` 得到 `configured` 或 `required` 状态：`required` 时仍渲染 Ink 输入栏，只允许 slash command；用户通过 `/config set api-key` 输入的密钥直接调用本阶段的 `saveApiKey()`。因此所有持久化、权限、原子替换与空值校验继续只有 Core 一处实现，而密钥不会出现在命令参数、输入历史或聊天记录中。

### Task 2: 增加顶层 `config` 子命令

**Files:**
- Create: `packages/cli/src/config-command.ts`
- Create: `packages/cli/src/__tests__/config-command.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/package.json`
- Create: `packages/cli/vitest.config.ts`

**Interfaces:**
- Consumes: `saveApiKey()`、`readStoredConfig()`、`redactApiKey()`。
- Produces: `runConfigCommand(args, dependencies)`，返回可由入口转换为 exit code 的 `Promise<void>`。

- [ ] **Step 1: 写 CLI `config` 命令失败测试**

在 CLI 测试中以 `PassThrough` 模拟 stdin，以自定义 `Writable` 捕获 stdout/stderr。声明：

```ts
const dependencies: ConfigCommandDependencies = {
  input: Readable.from(['sk-piped-key\\n']),
  output,
  errorOutput,
  configPath,
  isInteractive: false,
};
```

测试：`set api-key --stdin` 保存密钥而 stdout 不包含原文；`show` 输出脱敏值；无 `--stdin` 的非 TTY `set api-key` 拒绝；`set api-key unexpected` 显示用法而不写文件。

- [ ] **Step 2: 运行 CLI 测试，确认失败**

先在 `package.json` 增加 `"test": "vitest run"` 和开发依赖 Vitest，增加：

```ts
export default defineConfig({ test: { environment: 'node', include: ['src/**/*.test.ts'] } });
```

再运行：

```bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/config-command.test.ts --reporter=verbose
```

Expected: FAIL，原因是模块不存在。

- [ ] **Step 3: 实现无副作用依赖注入边界**

在 `config-command.ts` 声明：

```ts
export interface ConfigCommandDependencies {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  errorOutput: NodeJS.WritableStream;
  configPath?: string;
  isInteractive: boolean;
}

export async function runConfigCommand(
  args: string[],
  dependencies: ConfigCommandDependencies,
): Promise<void>;
```

`--stdin` 分支必须执行以下确定流程：异步迭代收集 `dependencies.input`，连接后 `trim()`，空值抛出 `API key must not be empty`，调用 `saveApiKey(apiKey, { configPath })`，最后只写入 `API key saved.`。TTY 分支先拒绝 `isInteractive === false`，然后用 `setRawMode(true)` 收集字符；`Backspace` 删除最后一个字符，`Ctrl+C` 抛 `AbortError`，`Enter` 完成；finally 必须恢复此前的 raw-mode 状态。定义控制字符为 `ENTER_CHARACTER`、`CARRIAGE_RETURN_CHARACTER`、`BACKSPACE_CHARACTER`、`DELETE_CHARACTER` 和 `CTRL_C_CHARACTER`。

- [ ] **Step 4: 在入口分流且保持聊天调用兼容**

在 `index.ts` 最先识别 `args[0] === 'config'`，调用 `runConfigCommand(args.slice(CONFIG_ARGUMENT_OFFSET), dependencies)` 后退出。其余参数和 TTY 判定继续转交现有纯文本或 Ink 路径；API Key 不可配置时仍由原聊天路径报告原有错误。

- [ ] **Step 5: 验证命令行为与 CLI 测试**

Run:

```bash
pnpm --filter @pure-agent/cli exec vitest run src/__tests__/config-command.test.ts --reporter=verbose
pnpm --filter @pure-agent/cli typecheck
```

Expected: PASS。测试输出只能出现脱敏 API Key。

- [ ] **Step 6: Commit**

```bash
git add packages/cli/package.json packages/cli/vitest.config.ts packages/cli/src/index.ts packages/cli/src/config-command.ts packages/cli/src/__tests__/config-command.test.ts
git commit -m "feat(cli): add API key configuration command"
```
