# Tokenizer — DeepSeek V3 BPE 实现

## 对外接口

```ts
// 初始化
initTokenizer(data: TokenizerData): void

// 编码/解码
encode(text: string): number[]
decode(tokenIds: number[]): string

// 计数
countTokensBpe(text: string): number

// 状态
isTokenizerInitialized(): boolean
```

## 数据流

```
tokenizer.json (128K vocab, 127K merges, 818 added tokens)
  → loadTokenizerData()
  → initTokenizer()
  → setBpeCounter()  // 注入到 context/token-counter
```

## 预分词行为

`preTokenize()` 按以下顺序处理：
1. 按换行符分割
2. 过滤空白行

⚠️ 当前预分词实现简化：未完整实现 CJK 逐字分割、数字分组和 GPT-2 通用文本分割模式。

## 测试能证明的内容

- encode/decode round-trip 自洽
- 相同输入产生稳定 token IDs
- 特殊 added token 使用单个 token ID
- countTokens 与 encode 实现一致

## 测试不能证明的内容

- ❌ 与官方 DeepSeek tokenizer 输出等价
- ❌ 中文/CJK 文本的精确 token 边界
- ❌ 数字和特殊字符的精确处理

## 真实性门禁

只有通过以下验证后，才能声称"精确 tokenizer"：

1. 至少 100 个由官方 tokenizer 生成的输入/ID fixtures
2. 覆盖：中文、英文、混合文本、代码、emoji、数字、空白和 special tokens
3. 要求 token ID 数组完全一致

## 当前能力状态

⚠️ **已实现实验性本地 BPE；尚未通过官方 golden vectors 等价性验证；Context Trimmer 生产热路径仍使用字符估算 + safety margin。**

## 跨模块不变量

- Context Trimmer 热路径使用 `estimateTotal()`（字符比率估算），不依赖 BPE tokenizer
- 本地 BPE 用于诊断和校准，不承担"保证不超窗"的强契约
- `countTokensBestEffort()` 优先 BPE，不可用时回退估算
- 只有通过官方 golden vectors 后才允许恢复"精确"命名

## 错误与终态

- 未初始化调用 encode/decode → `Error('Tokenizer not initialized...')`

## 当前限制

- 预分词未完整实现 CJK/数字/文本分割
- 未通过官方 golden vectors 验证
- 公共 API 名称使用 `Bpe` 而非 `Exact`
- 旧名称通过向后兼容别名保留

## 测试证据

- `src/tokenizer/__tests__/deepseek-tokenizer.test.ts` — 11 个 characterization tests
- 验证命令：`pnpm --filter @pure-agent/core test`
