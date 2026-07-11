# Config — 配置加载与校验

## 对外接口

配置模块提供 `loadProviderConfig()`、`loadCliConfig()`、`readStoredConfig()` 和
`saveApiKey()`。前两者为应用加载可用配置；后两者为 CLI 的安全配置读写提供边界。

### ProviderConfig

```ts
interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  maxTokens: number;
  temperature: number;
  timeout: number;
  maxRetries: number;
}

type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

interface CliConfig {
  defaultEffort: ReasoningEffort;
}
```

### 加载优先级

```
overrides > environment > config file > defaults
```

1. **overrides**：`loadProviderConfig({ apiKey: '...' })` 传入
2. **environment**：`PURE_AGENT_API_KEY`、`PURE_AGENT_BASE_URL`、`PURE_AGENT_MODEL` 等
3. **config file**：`~/.pure-agent/config.json`
4. **defaults**：代码内置默认值

### 环境变量

| 变量 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `PURE_AGENT_API_KEY` | string | — | **必需**，DeepSeek API Key |
| `PURE_AGENT_BASE_URL` | string | `https://api.deepseek.com` | API 基础 URL |
| `PURE_AGENT_MODEL` | string | `deepseek-v4-pro` | 默认模型 |
| `PURE_AGENT_MAX_TOKENS` | integer | `4096` | 最大输出 token |
| `PURE_AGENT_TEMPERATURE` | float | `0` | 采样温度 |
| `PURE_AGENT_TIMEOUT` | integer | `120000` | 请求超时 (ms) |
| `PURE_AGENT_MAX_RETRIES` | integer | `3` | 最大重试次数 |

### Config 校验

`loadProviderConfig()` 在返回前调用 `validateProviderConfig()`：

- `maxTokens`：必须为正有限数
- `timeout`：必须为正有限数
- `maxRetries`：必须为非负整数
- `temperature`：必须为有限数
- `baseUrl`：必须以 `http://` 或 `https://` 开头
- `apiKey`：缺失时抛出明确错误

### 持久化 API Key

`pure-agent config set api-key` 调用 `saveApiKey()`，而不是把密钥作为命令行参数。
交互式路径使用不回显输入；自动化路径只能通过 `--stdin` 提供密钥。

- 配置目录 `~/.pure-agent` 的权限为 `0700`，配置与临时文件的权限为 `0600`
- 写入先生成临时文件，再原子重命名替换目标文件
- 写入保留未知顶层字段和 `provider` 中的未知字段，兼容手写或未来版本配置
- `redactApiKey()` 只保留安全前缀；`config show` 绝不输出完整密钥
- `readStoredConfig()` 遇到缺失文件返回空对象，遇到无效 JSON 抛错，避免写操作覆盖损坏配置

## 跨模块不变量

- Config 只负责加载/校验，不负责 Provider capability negotiation
- 校验后的 Config 是 immutable 的（调用方不应修改）
- `parseEnvInt()` 使用完整字符串校验，不把 `"3abc"` 解析为 3
- 环境变量优先级始终高于持久化文件，`saveApiKey()` 不会写入环境变量

## 错误与终态

- 缺少 `apiKey` → 抛出 `Error('API key is required...')`
- 校验失败 → 抛出对应 `Error`
- CLI 写入时 API Key 为空或配置 JSON 无效 → 抛出错误且保留原文件

## 状态所有权与生命周期

- Config 由应用入口加载一次，传递给 `createDeepSeekClient()`
- `loadProviderConfig()` 的配置文件解析失败静默跳过（回退到环境变量和默认值）
- `loadCliConfig()` 缺失或无效 `cli.defaultEffort` 时回退到 `medium`
- CLI 的写操作显式读取文件，因此会报告无效 JSON 而不覆盖它

## 当前限制

- 不支持动态配置热加载
- 配置文件只支持 JSON 格式

## 测试证据

- `src/config/__tests__/loader.test.ts` — Provider 校验、原子 API Key 保存、权限、脱敏和 effort 默认值测试
- 验证命令：`pnpm --filter @pure-agent/core test`
