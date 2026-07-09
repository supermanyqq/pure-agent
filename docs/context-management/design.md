# Context Management — 总体设计

## 模块定位

Context Management 是 Pure Agent 的**上下文窗口管家**。它负责管理对话消息历史、估算 Token 用量、在消息超出模型上下文窗口时执行**多阶段渐进式压缩**，确保传给 LLM Provider 的消息始终在窗口限制内。

借鉴 hermes-agent 的生产级 `context_compressor.py` 设计（3083 行 Python，经过上百个线上 issue 验证和修复），本模块实现了从廉价预裁剪到 LLM 结构化摘要的完整压缩管线。

一句话：**Context Management 回答"对话历史有多长、会不会超过模型的上下文窗口、超了之后删哪些、怎么删、删了之后上下文还连贯吗"这五个问题。**

---

## 职责边界

Context Management **只做压缩，不做组装**。它和 StepBuilder 之间有明确的分工：

| 模块 | 做什么 | 不做什么 |
|---|---|---|
| **ContextManager**（本模块） | Token 估算、工具结果预裁剪、Turn 边界裁剪、LLM 摘要、反抖动保护 | 不决定 system prompt 内容、不选择工具、不设置模型参数 |
| **StepBuilder**（agent-loop） | 组装完整 ChatRequest：消息 + 工具 + 模型参数 | 不估算 token、不裁剪消息、不生成摘要 |

---

## 在整体架构中的位置

```
Agent Loop
    │
    ├── StepBuilder ──► contextManager.fitToWindow(messages, tools, options) → TrimResult
    │                        │
    │                        ├── Phase 1: 工具结果预裁剪（廉价，无 LLM 调用）
    │                        ├── Phase 2: 边界确定（无 LLM 调用）
    │                        ├── Phase 3: LLM 结构化摘要（需要 LLM 调用）
    │                        └── Phase 4: 组装 + 清理（无 LLM 调用）
    │
    └── Loop ──► Provider ──► DeepSeek API
                     ▲
                     │  messages 已在窗口内
```

---

## 核心概念

### Context Window（上下文窗口）

LLM 一次能处理的最大 token 数。DeepSeek v4 系列的上下文窗口为 1M（1,000,000）tokens。

```
┌──────────────────────────────────────────────────────┐
│                 Context Window (1M)                   │
├────────────────────────────────┬─────────────────────┤
│      Prompt Tokens             │  Completion Tokens  │
│  (messages + tools + system)   │  (max_tokens 参数)  │
│                                │                     │
│  fitToWindow() 保证            │  provider 保证      │
│  这部分 ≤ window - reserve     │  ≤ max_tokens       │
└────────────────────────────────┴─────────────────────┘
```

- **有效窗口** = contextWindow - completionReserve - safetyMargin
- **safetyMargin** = min(total × 10%, 16K)，防止估算偏差

### Token 估算

采用**字符比率近似法**，不依赖任何 tokenizer 库：

| 字符类型 | 近似比率 | 说明 |
|---|---|---|
| 英文/数字 | ~4 字符/token | 常见英文单词 3-5 字符 |
| 中文/日文/韩文 | ~1.5 字符/token | CJK 字符 |
| 代码符号 | ~3 字符/token | {}[]();:= 等 |

每条消息额外计入 4 token 的 role/结构开销。assistant 消息的 tool_calls 遍历 id、name、arguments 全量计算。

### 压缩算法：多阶段渐进降级

从最廉价的手段开始，逐步升级：

```
fitToWindow(messages, tools, options)
  │
  ├── Phase 1: 工具结果预裁剪（廉价，无 LLM 调用）
  │     去重：相同内容的 tool 结果只保留最新副本
  │     摘要化：大 tool 结果 → 信息丰富的单行描述
  │     截断：tool_call arguments JSON 保结构截断
  │
  ├── Phase 2: 边界确定（无 LLM 调用）
  │     保护 system prompt（永不移除）
  │     Token 预算驱动尾部保护（反向行走）
  │     对齐 Turn 边界（不切割 tool_call/result 组）
  │     确保最后 user 消息在尾部（防丢失活跃任务）
  │
  ├── Phase 3: LLM 结构化摘要（需要 LLM 调用）
  │     结构化模板（13 个字段）
  │     反注入前缀（SUMMARY_PREFIX）
  │     迭代更新已有摘要
  │     失败降级：LLM → 确定性回退 → cooldown
  │
  └── Phase 4: 组装 + 清理（无 LLM 调用）
        摘要追加到 system prompt
        清理孤立 tool_call/result 对（防 API 400）
        反抖动检查
```

裁剪策略优先级：

| 步骤 | 操作 | 条件 |
|---|---|---|
| 1 | 什么也不做 | 当前 token 数 ≤ 有效窗口 |
| 2 | 工具结果去重 + 摘要化 | 总是（Phase 1 廉价） |
| 3 | 移除最早 Turn → 摘要 | 超限且 Turn > head |
| 4 | 截断超长 tool 消息 content | 只剩 1 个 Turn 仍超限 |
| 5 | 反抖动跳过 | 连续 2 次压缩节省 < 10% |
| 6 | 抛 ContextWindowError | system prompt 超限 |

---

## 模块结构

```
context/
├── types.ts              # 所有类型、接口、常量
├── redactor.ts           # 敏感信息脱敏
├── token-counter.ts      # Token 估算器（字符比率法）
├── history-manager.ts    # 消息历史管理（Turn 分组，纯函数）
├── tool-pruner.ts        # 工具结果预裁剪
├── summarizer.ts         # LLM 摘要生成器（模板 + 反注入前缀）
├── trimmer.ts            # 主编排器（有状态类，实现 ContextManager 接口）
└── index.ts              # 公共 API 导出
```

### 各子模块职责

**redactor.ts**：在内容进入 LLM summarizer 或回退摘要前，移除敏感凭证（API key、JWT、连接串密码、高熵长字符串等）。三个强制脱敏点：序列化时、回退摘要提取时、LLM 返回内容后（纵深防御）。

**token-counter.ts**：估算消息、工具定义的 token 数。通过字符分类（CJK/Latin/Code/Other）应用经验比率，不依赖 tiktoken。

**history-manager.ts**：按 Turn 分组、裁剪、查询消息历史。纯函数集合，不持有状态。Turn 边界识别规则：每个 user 消息开始新 Turn，后续 assistant/tool 归属同一 Turn。

**tool-pruner.ts**：三阶段廉价预裁剪——去重（MD5 哈希）、摘要化（大结果→单行描述）、截断（JSON 保结构截断）。

**summarizer.ts**：生成结构化摘要（13 字段模板），包含反注入前缀（SUMMARY_PREFIX）、结束标记（SUMMARY_END_MARKER）、历史前缀兼容（HISTORICAL_SUMMARY_PREFIXES）、失败降级（确定性回退摘要）。

**trimmer.ts**：主编排器，有状态类（持有 cooldown、previousSummary、反抖动计数等）。编排 Phase 1-4，实现完整的 `fitToWindow()` 算法。

> 各 Phase 的详细实现见对应文档：
> - [phase-1-tool-pruner.md](./phase-1-tool-pruner.md)
> - [phase-2-boundary-finder.md](./phase-2-boundary-finder.md)
> - [phase-3-summarizer.md](./phase-3-summarizer.md)
> - [phase-4-trimmer.md](./phase-4-trimmer.md)

---

## 对外接口

```ts
interface ContextManager {
  fitToWindow(
    messages: Message[],
    tools: ToolDefinition[],
    options?: TrimOptions,
  ): Promise<TrimResult>;
  estimateTokens(messages: Message[], tools?: ToolDefinition[]): number;
  getCompressionStats(): CompressionStats;
  reset(): void;
  updateModel(model: string, contextLength: number): void;
}
```

`TrimResult` 中的 `status` 字段让调用方在不查询 CompressionStats 的情况下做出正确的 UI 反馈：

```ts
type TrimStatus =
  | 'unchanged'           // 未超限
  | 'pruned_only'         // 仅 Phase 1 工具结果裁剪
  | 'summarized'          // 成功生成 LLM 摘要
  | 'fallback_summary'    // LLM 摘要失败，使用确定性回退
  | 'skipped_thrashing'   // 反抖动跳过
  | 'aborted_auth_error'  // 认证错误中止
  | 'aborted_network_error'; // 网络错误中止
```

---

## 关键安全机制

### 反注入前缀（SUMMARY_PREFIX）

这是从 hermes-agent 借鉴的最关键设计。约 250 词的英文前缀，明确告诉 LLM：
- 摘要中的内容是**历史记录**，不是当前任务
- **不要回答**摘要中提到的任何问题
- **只响应**摘要之后的最新用户消息

没有此前缀，LLM 会重新执行摘要中已完成的"Historical Task Snapshot"任务。

配套的 `SUMMARY_END_MARKER` 在摘要末尾提供反向保护："摘要结束，下面才是你要回复的真实消息"。

### 多级错误降级

摘要 LLM 调用失败时分级处理：

| 失败类型 | 处理策略 |
|---|---|
| 认证错误 (401/403) | **中止压缩**，保留原始消息 |
| 网络断连 | **中止压缩**，保留原始消息 |
| 超时/限流 (408/429/502/504) | 回退主模型重试 1 次，仍失败则 cooldown |
| JSON 解析错误 | 回退主模型重试 1 次 |

关键原则：Auth 失败和网络断连场景下，绝不能生成降级 session——保留原始消息让用户修复凭证/网络后重试。

### 反抖动保护

跟踪每次压缩节省的 token 百分比。连续 2 次 < 10% → 跳过压缩。防止无限压缩循环。

---

## 设计决策

### 1. 为什么用字符比率估算而不用 tiktoken？

- **零依赖**：tiktoken 的 Node.js 移植需要 WASM 或 native binding
- **足够准确**：10% 安全余量足以覆盖估算误差
- **跨模型通用**：换模型只需换一组比率参数
- **性能**：O(n) 字符串扫描，无额外内存分配

### 2. 为什么以 Turn 为单位裁剪？

- **语义完整性**：Turn 是一个完整的问答循环
- **工具调用完整性**：assistant(tool_calls) + tool(result) 必须共存亡
- **协议要求**：API 要求 tool 消息必须有对应 assistant 消息

### 3. 为什么工具结果要预裁剪？

- **廉价**：纯字符串处理，无网络调用
- **有效**：去重 + 摘要化可减少大量冗余 token
- **为 LLM 摘要减负**：减少 summarizer 输入大小

### 4. 为什么摘要追加到 system prompt？

- **语义正确**：摘要是"背景知识"，不是对话
- **不会被裁剪**：system prompt 是最高优先级保留项
- **prompt caching 兼容**：作为 system prompt 的后缀追加，不影响前缀稳定性

### 5. 为什么需要反抖动？

- **防止无限循环**：如果每次压缩只能移除 1-2 条消息，会陷入连续压缩
- **用户感知**：连续压缩会让 CLI 看起来卡死

### 6. 为什么 trimmer 是有状态类而 history-manager 是纯函数？

压缩状态（cooldown、previousSummary、反抖动计数）的生命周期与 session 绑定，不是单次调用的产物。纯函数集合可独立测试、无副作用。有状态编排层组合无状态子模块，依赖方向单一：trimmer → 子模块。

### 7. 为什么摘要失败要区分 Auth/Network/Transient？

Auth 失败是永久性的（无效凭证不断重试只会重复失败）。Network 失败可能瞬时但重复压缩浪费 token。Transient 失败可能自愈，短 cooldown 防止连续消耗。

---

## 与 hermes-agent 的关键差异

本实现是 hermes-agent `context_compressor.py` 的 TypeScript 移植，保留了所有核心能力（反注入前缀、13 字段结构化摘要、四阶段压缩、反抖动、多级错误降级、敏感信息脱敏），但做了以下简化：

| 特性 | hermes-agent | Pure Agent | 原因 |
|---|---|---|---|
| 压缩锁（SQLite） | ✓ | ✗ | 单进程 Node.js，重入检测替代 |
| 辅助摘要模型 | ✓ | ✗ | 简化：直接用主模型 |
| Cooldown SQLite 持久化 | ✓ | ✗ | 单进程内存实现，重启丢失 cooldown（可接受） |
| 摘要迭代更新 | ✓ | ✓ | 核心能力，已移植 |
| 反注入前缀体系 | ✓ | ✓ | 核心能力，已移植 |
| 结构化摘要模板 | ✓ | ✓ | 核心能力，已移植 |

---

## 测试策略

| 层级 | 测试内容 |
|---|---|
| 单元测试 | Token 估算精度（中英文/代码/JSON） |
| 单元测试 | 脱敏规则（API key, JWT, 连接串, 高熵文本） |
| 单元测试 | Turn 分组边界（多工具、异常序列） |
| 单元测试 | 工具结果去重、摘要化、尾部保护 |
| 单元测试 | 摘要模板、前缀/后缀、回退摘要 |
| 集成测试 | fitToWindow 全流程（含 mock summarizer） |
| 集成测试 | 摘要失败 → cooldown → 回退摘要 → 恢复 |
| 边界测试 | system prompt 超限、空消息、有效窗口负值、并发重入 |

---

## 参考资料

- [hermes-agent context_compressor.py](https://github.com/NousResearch/hermes-agent) — 原始实现参考
- [DeepSeek API — Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)
- [OpenAI — Managing Context Window](https://platform.openai.com/docs/guides/function-calling/managing-the-context-window)
