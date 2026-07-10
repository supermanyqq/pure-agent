# Tokenizer Phase 1: 实验性 BPE 实现

## 目标

实现 DeepSeek V3 tokenizer 的本地 BPE 编码/解码。

## 实现文件

- `packages/core/src/tokenizer/deepseek-tokenizer.ts` — BPE 核心
- `packages/core/src/tokenizer/types.ts` — TokenizerData, BPEConfig 类型
- `packages/core/src/tokenizer/index.ts` — 文件加载辅助

## 关键实现细节

### Byte-Level Encoding

使用 GPT-2 风格的 byte↔unicode 映射：
- Bytes 33-126（printable ASCII）映射到自身
- Bytes 0-32, 127-255 映射到 Unicode PUA (U+0100+)

### BPE 合并

- 127,741 merge rules，按优先级排序
- 从最优（最低 rank）pair 开始贪心合并
- 未知 token 的 byte-level fallback

### 预分词

`preTokenize()` 当前实现：
- 按换行符分割
- 过滤空白行

⚠️ 未完整实现 tokenizer_config.json 中的 CJK 逐字分割、数字分组和通用文本分割。

### 词汇表

- 128,000 基础词汇
- 818 added (special) tokens
- 支持 exact match 优先于 BPE 编码

## Characterization Tests

当前测试验证：
- encode/decode round-trip 正确性
- 相同输入产生稳定输出
- 特殊 token 处理
- 中英文混合文本

测试文件：`src/tokenizer/__tests__/deepseek-tokenizer.test.ts` (11 tests)

## 当前限制

- 预分词未完整实现
- 未通过官方 golden vectors 验证
- API 使用 `Bpe` 命名而非 `Exact`
