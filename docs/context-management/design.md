# Context Management — 总体设计

## 模块定位

Context Management 是 Pure Agent 的**上下文窗口管家**。它负责管理对话消息历史、估算 Token 用量、在消息超出模型上下文窗口时执行**多阶段渐进式压缩**，确保传给 LLM Provider 的消息始终在窗口限制内。

借鉴 hermes-agent 的生产级 `context_compressor.py` 设计（3083 行 Python，经过上百个线上 issue 验证和修复），本模块实现了从廉价预裁剪到 LLM 结构化摘要的完整压缩管线。

一句话：**Context Management 回答"对话历史有多长、会不会超过模型的上下文窗口、超了之后删哪些、怎么删、删了之后上下文还连贯吗"这五个问题。**

---

## 职责边界

Context Management **只做压缩，不做组装**。它和 StepBuilder 之间有明确的分工：

```
Context 请求的完整构建链路：

StepBuilder（agent-loop 模块）          ContextManager（本模块）
═══════════════════════════════        ═══════════════════════════
                                       │
组装师：决定"请求里放什么"              │  量体师：确保"放进去的东西塞得进窗口"
                                       │
├─ System Prompt（拿掉？追加？）        │
├─ 消息历史（传哪些？）                 │  fitToWindow(messages, tools, options)
│    │                                  │    ├─ Phase 1: 工具结果预裁剪
│    └─→ 传入 messages ──────────────→ │    ├─ Phase 2: 边界确定
│                                       │    ├─ Phase 3: LLM 结构化摘要
│    ←── TrimResult ──────────────────  │    └─ Phase 4: 组装 + 清理
│                                       │
├─ 工具定义（传哪些？传多少？）          │
├─ 模型参数（temperature、maxTokens）   │
└─ stream: true（始终流式）             │
                                       │
→ 输出 ChatRequest → Agent Loop         │
```

| 模块 | 做什么 | 不做什么 |
|---|---|---|
| **ContextManager**（本模块） | Token 估算、工具结果预裁剪、Turn 边界裁剪、LLM 摘要、反抖动保护 | 不决定 system prompt 内容、不选择工具、不设置模型参数 |
| **StepBuilder**（agent-loop） | 组装完整 ChatRequest：消息 + 工具 + 模型参数 | 不估算 token、不裁剪消息、不生成摘要 |

---

## 在整体架构中的位置

```
User Input
    │
    ▼
Agent Loop
    │
    ├── StepBuilder ──► contextManager.fitToWindow(messages, tools, options) → TrimResult
    │                        │
    │                        ├── Phase 1: pruneOldToolResults()  → 去重/摘要化 tool 结果
    │                        ├── Phase 2: findTailCutByTokens()  → 确定 head/tail 边界
    │                        ├── Phase 3: summarize()            → LLM 结构化摘要
    │                        └── Phase 4: sanitizeToolPairs()    → 清理孤立 pair
    │
    └── Loop ──► Provider ──► DeepSeek API
                     ▲
                     │  messages 已在窗口内
```

---

## 关键安全机制

在进入核心算法前，必须明确以下三个贯穿全模块的安全机制。这些机制在 hermes-agent 中经过线上 issue 验证，缺失任何一个都可能导致数据丢失或安全漏洞。

### 敏感信息脱敏（Redaction）

所有进入 LLM summarizer 或确定性回退摘要的消息内容**必须先脱敏**，防止 API key、token、密码、JWT 等凭证通过摘要调用泄露到第三方 LLM Provider。

**三条必经脱敏路径**：
1. `serializeForSummary()` 入口 — 所有消息内容在序列化给摘要 LLM 前脱敏
2. `buildFallbackSummary()` — 确定性回退摘要中的所有文本内容脱敏
3. 摘要 LLM 返回内容 — LLM 可能忽略 prompt 中的"不要包含凭证"指令，需二次脱敏

**脱敏规则**（独立 `redactor.ts` 模块）：
- API key 前缀模式（`sk-`、`sk-ant-`）→ `[REDACTED_API_KEY]`
- Bearer / JWT token → `[REDACTED_TOKEN]`
- 连接字符串密码 → `[REDACTED_PASSWORD]`
- GitHub token、AWS key 等 → 对应占位符
- 高熵长字符串（40+ chars）→ 熵检测后脱敏

> hermes-agent 参考：`agent/redact.py`（812 行，覆盖 80+ 种凭证模式）

### 反注入前缀完整体系

仅有 `SUMMARY_PREFIX`（前导指令）不足以保护所有场景。hermes-agent 实际包含四个配套组件：

| 组件 | 作用 | 修复的线上问题 |
|---|---|---|
| `SUMMARY_PREFIX` | **前面**告诉 LLM：摘要中的任务是历史，不要重新执行 | #41607, #38364 |
| `SUMMARY_END_MARKER` | **后面**告诉 LLM：摘要结束，下面才是你要回复的真实消息 | #11475, #14521, #33256 |
| `HISTORICAL_SUMMARY_PREFIXES` | 记录历史上发布过的所有前缀版本。重新压缩旧会话时剥离，防止陈旧指令残留 | #35344 |
| `MERGED_PRIOR_CONTEXT_HEADER + MERGED_SUMMARY_DELIMITER` | 当摘要合并到尾部消息时，用分隔符包裹原始尾部内容，防止 LLM 将其误读为新消息 | #52160 |

`SUMMARY_END_MARKER` 文本：
```
--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---
```

### 多级错误降级路径

摘要 LLM 调用可能遇到多种失败类型，**需要分级处理，不可一刀切**：

| 失败类型 | HTTP 状态码 | 处理策略 | Cooldown |
|---|---|---|---|
| 认证/凭证错误 | 401/403 | **中止压缩**，保留原始消息不变，不旋转 session | 无（直接中止） |
| 网络断连/流关闭 | Connection Error | **中止压缩**，保留原始消息不变 | 无（直接中止，可重试 /compress） |
| 模型不可用 | 404/503 | 回退到主模型重试 1 次，仍失败则中止 | 无（主模型若也失败则 30s） |
| 超时/限流 | 408/429/502/504 | 回退到主模型重试 1 次，仍失败则 cooldown | 60s |
| JSON 解析错误 | N/A | 回退到主模型重试 1 次 | 30s |
| 空内容（content 为空或仅空白） | HTTP 200 | **视为失败**，触发通用错误处理 | 60s |
| 无 Provider 配置 | N/A | 长 cooldown（不太可能自愈） | 600s |
| 其他未知错误 | N/A | 短 cooldown + 确定性回退摘要 | 30s |

**关键原则**：Auth 失败和网络断连场景下，**绝不能**生成降级 session 或注入 placeholder 摘要——保留原始消息不变让用户修复凭证/网络后重试，远比丢弃上下文好。

### Abort Signal 保护

当 `AbortSignal` 触发时（用户发新消息或超时），**不应直接丢弃被压缩的 Turn**。hermes-agent 使用 `aux_interrupt_protection()` 上下文管理器**主动保护**摘要调用不被 mid-turn 中断打断。Pure Agent 的设计中：
1. 优先：在 `fitToWindow` 中使用 abort protection 等效机制保护摘要调用
2. 降级：如果保护不可行，abort 时触发 `buildFallbackSummary()` 生成确定性回退摘要，而非直接丢弃

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
│  contextManager.fitToWindow()  │  provider 保证      │
│  保证这部分 ≤ window - reserve │  ≤ max_tokens       │
└────────────────────────────────┴─────────────────────┘
```

- **有效窗口** = contextWindow - completionReserve - safetyMargin（最小 100 tokens）
- **Prompt Tokens**：所有 messages + tools 定义序列化后的 token 数
- **Completion Tokens**：max_tokens 参数（默认 4096）
- **安全余量（safetyMargin）**：min(total × 10%, 16K)，防止估算偏差

### Token 估算

采用**字符比率近似法**，不依赖任何 tokenizer 库：

| 字符类型 | 近似比率 | 说明 |
|---|---|---|
| 英文/数字 | ~4 字符/token | 常见英文单词 3-5 字符 |
| 中文/日文/韩文 | ~1.5 字符/token | CJK 字符 |
| 代码符号 | ~3 字符/token | {}[]();:= 等 |
| 其他 | ~3.5 字符/token | 默认比率 |

每条消息额外计入 4 token 的 role/结构开销。assistant 消息的 tool_calls 遍历 id、name、arguments 全量计算——仅统计 arguments 字符串会严重低估并行多工具调用（实测偏差可达 2-15x）。

### 压缩算法：多阶段渐进降级

借鉴 hermes-agent 生产验证的设计，压缩分四个阶段，从最廉价的手段开始，逐步升级：

```
fitToWindow(messages, tools, options)
  │
  ├── Phase 1: 工具结果预裁剪（廉价，无 LLM 调用）
  │     ├── 去重：相同内容的 tool 结果只保留最新副本
  │     ├── 摘要化：大 tool 结果 → 信息丰富的单行描述
  │     │     [terminal]    ran `npm test` → exit 0, 47 lines output
  │     │     [read_file]   read config.py from line 1 (3,400 chars)
  │     │     [search_files] search for 'compress' in agent/ → 12 matches
  │     └── 截断：tool_call arguments JSON 保结构截断
  │     ✓ 始终执行
  │
  ├── Phase 2: 边界确定（无 LLM 调用）
  │     ├── 保护 system prompt（永不移除）
  │     ├── 保护头部 N 条消息（首次压缩后衰减为 0）
  │     ├── Token 预算驱动尾部保护（反向行走）
  │     ├── 对齐 Turn 边界（不切割 tool_call/result 组）
  │     ├── 确保最后 user 消息在尾部（防丢失活跃任务）
  │     └── 确保最后 assistant 消息在尾部（防 UI 显示异常）
  │     ✓ 确定 compressStart 和 compressEnd
  │
  ├── Phase 3: LLM 结构化摘要（需要 LLM 调用）
  │     ├── 结构化模板（13 个字段）
  │     ├── 反注入前缀（SUMMARY_PREFIX）
  │     ├── 迭代更新已有摘要
  │     ├── 摘要预算 = content × 20%（min 2000, max 12000 tokens）
  │     └── 失败降级：LLM → 确定性回退 → cooldown
  │     ✓ 可选（enableSummarization 控制）
  │
  ├── Phase 4: 组装 + 清理（无 LLM 调用）
  │     ├── 摘要追加到 system prompt
  │     ├── 清理孤立 tool_call/result 对（防 API 400）
  │     ├── 更新压缩统计
  │     └── 反抖动检查
  │
  └── Return TrimResult { messages, removedTurns, summarized, ... }
```

**裁剪策略的优先级总结**：

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
├── redactor.ts           # 敏感信息脱敏（正则匹配，覆盖 30+ 凭证模式）
├── token-counter.ts      # Token 估算器（字符比率法 + CJK/Latin/Code 分类）
├── history-manager.ts    # 消息历史管理（Turn 分组，纯函数集合）
├── tool-pruner.ts        # 工具结果预裁剪（廉价，无 LLM 调用）
├── summarizer.ts         # LLM 摘要生成器（模板 + 反注入前缀 + 确定性回退）
├── trimmer.ts            # 主编排器（有状态类，实现 ContextManager 接口）
├── index.ts              # 公共 API 导出 + createContextManager() 工厂函数
└── __tests__/
    ├── redactor.test.ts
    ├── token-counter.test.ts
    ├── history-manager.test.ts
    ├── tool-pruner.test.ts
    ├── summarizer.test.ts
    └── trimmer.test.ts
```

### redactor.ts — 敏感信息脱敏

**职责**：在内容进入 LLM summarizer 或回退摘要前，移除敏感凭证。

核心函数：
- `redactSensitiveText(text)`：对文本应用所有脱敏正则规则

**覆盖的凭证模式**（参考 hermes-agent `redact.py`，812 行）：
- OpenAI/Anthropic API keys（`sk-*`、`sk-ant-*`）
- GitHub personal access tokens（`ghp_*`、`gho_*`）
- AWS access keys（`AKIA*`）
- JWT tokens（`eyJ*`）
- Bearer authorization headers
- 数据库连接串中的密码
- 高熵长字符串（40+ chars，字符集多样性 > 10）

**调用位置**：三个强制脱敏点：
1. `serializeForSummary()` — 每个消息 content 序列化前
2. `buildFallbackSummary()` — 每个消息 content 提取前
3. 摘要 LLM 返回内容后（二次脱敏，纵深防御）

### types.ts — 类型定义

- `Turn`：Turn 结构（裁剪原子单位）
- `TrimResult`：fitToWindow 返回结构（含统计信息）
- `TrimOptions`：裁剪配置
- `TokenEstimate`：Token 估算结果
- `Summarizer`：摘要器接口（依赖注入）
- `CompressionStats`：压缩统计（供外部读取）
- `ContextWindowError`：窗口超限错误

### token-counter.ts — Token 估算器

**职责**：估算消息、工具定义的 token 数，用于边界判断和预算分配。

核心函数：
- `estimateMessageTokens(msg)`：单条消息估算（含 tool_calls 全量）
- `estimateMessagesTokens(msgs)`：消息列表估算
- `estimateToolDefinitions(tools)`：工具定义估算
- `estimateTotal(messages, tools)`：总估算（含安全余量）
- `estimateMsgBudgetTokens(msg)`：快速预算估算（用于尾部保护行走）

**不依赖 tiktoken**。通过字符分类（CJK/Latin/Code/Other）应用经验比率。

### history-manager.ts — 消息历史管理

**职责**：按 Turn 分组、裁剪、查询消息历史。**纯函数集合，不持有状态。**

核心函数：
- `groupByTurns(messages)`：按 user 消息边界分组
- `getRecentTurns(messages, n)`：获取最近 N 个 Turn
- `removeOldestTurns(messages, n)`：移除最旧 N 个 Turn
- `alignBoundaryForward/Backward`：边界对齐（不切割 tool 组）
- `findLastUserMessageIdx`：定位最后真实 user 消息
- `findLastAssistantMessageIdx`：定位最后有文本的 assistant 消息

**Turn 边界识别规则**：
- system 消息（如存在）→ Turn 0
- 每个 user 消息 → 新 Turn 开始
- 后续 assistant/tool 消息归属到同一个 Turn

### tool-pruner.ts — 工具结果预裁剪

**职责**：在 LLM 摘要前对旧 tool 结果进行廉价预裁剪。

三阶段：
1. **去重**：相同内容的 tool 结果只保留最新副本（MD5 哈希）
2. **摘要化**：大 tool 结果（>200 chars）替换为信息丰富的单行描述
3. **截断**：assistant 消息的 tool_calls arguments 过长时 JSON 保结构截断

**边界控制**：通过 `protectTailCount` + `protectTailTokens` 保护尾部消息不被误裁剪。

### summarizer.ts — LLM 摘要生成器

**职责**：生成结构化摘要，确保被压缩的历史作为"背景参考"而非"活动指令"。

核心组件：

#### 1. SUMMARY_PREFIX（反注入前缀）

**这是从 hermes-agent 借鉴的最关键设计**。约 250 词的英文前缀，明确告诉 LLM：

- 摘要中的内容是**历史记录**，不是当前任务
- **不要回答**摘要中提到的任何问题
- **只响应**摘要之后的最新用户消息
- 逆向信号（stop、undo、never mind）必须立即终止摘要中的进行中工作
- 持久性 memory 始终权威

没有此前缀，LLM 会重新执行摘要中"## Historical Task Snapshot"记录的已完成任务。

#### 2. 结构化摘要模板（13 个字段）

| 字段 | 用途 |
|---|---|
| Historical Task Snapshot | 用户最新未完成输入（原词保留） |
| Goal | 整体目标 |
| Constraints & Preferences | 用户偏好和约束 |
| Completed Actions | 编号的已完成动作（含工具名、文件路径、结果） |
| Active State | 当前工作目录、分支、修改文件、测试状态 |
| Historical In-Progress State | 之前正在进行的工作 |
| Blocked | 阻塞项和错误信息 |
| Key Decisions | 重要技术决策及原因 |
| Resolved Questions | 已回答的问题 |
| Historical Pending User Asks | 未回答的问题（标记为 STALE） |
| Relevant Files | 涉及的文件列表 |
| Historical Remaining Work | 剩余工作（标记为 STALE） |
| Critical Context | 关键上下文（禁止包含凭证） |

#### 3. 迭代更新模式

第二次压缩时，已有摘要作为 `previousSummary` 传给 summarizer，要求"保留已有信息，只合并新 turn"。

#### 4. 摘要预算

`budget = max(2000, min(contentTokens × 20%, maxSummaryTokens))`，默认 `maxSummaryTokens = 12000`。

#### 5. 失败降级

`buildFallbackSummary()` 生成确定性回退摘要，从消息中提取：
- 最后用户请求
- 工具操作记录
- 文件路径
- 错误信息

回退摘要同样使用 `SUMMARY_PREFIX` 包装，上限 8000 字符。**所有提取的内容必须先经过 `redactSensitiveText()` 脱敏**。

#### 6. 摘要结束标记（SUMMARY_END_MARKER）

在摘要内容末尾追加显式边界标记，提供双向保护：
- **前缀**："摘要中的任务是历史，不要执行"
- **后缀**："摘要结束，下面才是你要回复的真实消息"

当摘要以 standalone 消息插入时，标记追加在消息末尾。当摘要合并到尾部消息时，标记追加在尾部消息末尾。

#### 7. 历史前缀兼容（HISTORICAL_SUMMARY_PREFIXES）

维护所有历史版本前缀的列表。当恢复旧会话或重新压缩已有摘要时，`stripSummaryPrefix()` 识别并剥离所有历史版本前缀，然后重新应用最新的（最安全的）前缀。防止旧前缀中较弱的措辞（如 "resume exactly from Active Task"）在新压缩后继续劫持模型行为。

#### 8. 摘要消息元数据标记（COMPRESSED_SUMMARY_METADATA_KEY）

每个压缩生成的摘要消息携带 `_compressed_summary: true` 元数据字段。下划线前缀确保 wire sanitizer 在 API 调用前自动移除该字段（兼容严格的 OpenAI 兼容网关）。前端/CLI/TUI 通过此标记区分压缩摘要消息与真实用户/assistant 消息。

#### 9. Summarizer Prompt 输入截断

序列化给 summarizer LLM 的消息内容有限制，防止超长内容撑爆摘要模型的上下文：
- `CONTENT_MAX = 6000` chars — 每个消息体上限
- `CONTENT_HEAD = 4000` / `CONTENT_TAIL = 1500` — 头部保留 + 尾部保留策略
- `TOOL_ARGS_MAX = 1500` — tool call arguments 上限

### trimmer.ts — 主编排器

**职责**：编排 Phase 1-4，实现完整的 `fitToWindow()` 算法。trimmer 是**有状态类**（`Trimmer implements ContextManager`），持有所有压缩相关状态。

**持有状态**：
- `compressionCount` — 压缩次数
- `lastSavingsPercent` — 上次压缩节省百分比
- `ineffectiveCompressionCount` — 连续无效压缩计数（反抖动）
- `previousSummary` — 前次摘要文本（迭代更新）
- `effectiveProtectFirstN` — 头部保护条数（首次 3，之后衰减为 0）
- `summaryFailureCooldownUntil` — 摘要失败 cooldown 截止时间戳
- `lastSummaryError` — 最后一次摘要失败的错误信息
- `lastCompressAborted` — 上次压缩是否被中止

**状态生命周期**：

| 事件 | 重置的状态 |
|---|---|
| `new Trimmer()` | 所有状态初始化为默认值 |
| `reset()` | 清除全部 per-session 状态（同构造） |
| 模型切换 (`updateModel()`) | 清除 token 追踪状态、反抖动计数 |
| `onSessionEnd()` | 清除全部 per-session 状态 |

> **设计决策**：不主动持久化状态到磁盘。cooldown 和 previousSummary 在进程生命周期内有效。进程重启后第一次压缩从零开始（首次压缩，无迭代摘要）。这比 hermes-agent 的 SQLite 持久化简化了实现，代价是重启后丢失 cooldown 保护。

关键设计：

#### 反抖动保护

跟踪每次压缩节省的 token 百分比。连续 2 次 < 10% → 跳过压缩。防止无限压缩循环。

#### protectFirstN 衰减

首次压缩时保护头部 3 条非 system 消息。之后衰减为 0（早期 turn 已进入摘要，不需要重复保护）。

#### 尾部保护

`findTailCutByTokens()` 从消息末尾反向行走，累加 token 直到超出预算：
- soft_ceiling = budget × 1.5（防止单条超大消息阻止切割）
- 至少保留 3 条消息（硬下限）
- 确保最后 user 消息在尾部（防活跃任务丢失）
- 确保最后 assistant 消息在尾部（防 UI 显示异常）

#### Tool Pair 完整性

`sanitizeToolPairs()` 在压缩后清理：
- 移除没有对应 assistant tool_call 的孤立 tool result
- 从 assistant 消息中移除没有对应 tool result 的孤立 tool_call
- 如果所有 tool_calls 被移除且无文本 content，填充 "(tool call removed)"

#### 摘要失败 Cooldown

摘要 LLM 调用失败后进入分级 cooldown（见"多级错误降级路径"），期间使用确定性回退摘要，避免连续失败消耗 token。

#### 摘要 Role 选择逻辑

压缩摘要作为消息插入时，必须避免与相邻消息产生 consecutive same-role（API 协议要求 user/assistant 交替）：

1. **默认 role**：避免与 head 最后一条消息撞 role
2. **`force_user_leading`**：当受保护头部只有 system prompt 时，摘要必须为 `role='user'`（Anthropic/某些 Provider 要求首条 visible 消息为 user）
3. **Zero-user-turn guard**：当压缩后 head + tail 中没有任何 `role='user'` 消息时，强制摘要为 user role（防止 vLLM/Qwen 等 OpenAI 兼容后端的 400 错误）
4. **Merge-into-tail**：当两种 role 都会造成 consecutive same-role 时，将摘要合并到第一条 tail 消息中（使用 `MERGED_PRIOR_CONTEXT_HEADER` + `MERGED_SUMMARY_DELIMITER` 分隔原始尾部内容和摘要）
5. **Standalone 摘要末尾追加 `SUMMARY_END_MARKER`**

#### Causal Coupling 守卫

在 `ensureUserMessageInTail` 中实现 hermes-agent #22523 的修复：

```
当最后一条 user 消息恰好位于 headEnd（受保护头部边界）时：
  - 不能将 user 硬拉入尾部（违反 head 保护约束）
  - 不能将 user 留在压缩区（丢失活跃任务）
  → 将整个 turn-pair（user + assistant + tool results）标记为可压缩区域
  → 确保摘要将此 pair 标记为"已完成"，而非"待处理"
```

`findLastAssistantMessageIdx` 需要过滤仅含 `tool_calls` 无文本的 assistant 消息 — 只有用户真正看到的文本回复才需要锚定在尾部（hermes-agent #29824）。

#### 摘要进行中保护

压缩操作内部维护 `_compressionInProgress` 标志位。在 `await summarizer.summarize()` 期间，如果 `fitToWindow` 被再次调用（并发重入），第二次调用应立即返回当前消息（跳过压缩），避免：
- 两个并发的摘要 LLM 调用浪费 token
- `previousSummary` 被覆盖
- `compressionStats` 状态不一致

> hermes-agent 使用 `aux_interrupt_protection()` 保护摘要调用不被用户中断打断（#23975），Pure Agent 以重入检测作为等价保护。

---

## 跨模块共享类型

以下类型同时存在于 `core/src/types/index.ts`（Agent Loop 视角）和 `core/src/context/types.ts`（Context 模块内部），保持一致：

```typescript
interface ContextManager {
  fitToWindow(
    messages: Message[],
    tools: ToolDefinition[],
    options?: TrimOptions,
  ): Promise<TrimResult>;
  estimateTokens(messages: Message[], tools?: ToolDefinition[]): number;
  getCompressionStats(): CompressionStats;
  /** 重置所有 per-session 状态（/new, /reset, session end） */
  reset(): void;
  /** 模型切换时更新配置并清除模型相关的追踪状态 */
  updateModel(model: string, contextLength: number): void;
}

// TrimResult 中的 status 字段让调用方在不查询 CompressionStats 的情况下
// 即可做出正确的 UI 反馈（警告、错误提示、正常继续）
type TrimStatus =
  | 'unchanged'           // 未超限，正常路径
  | 'pruned_only'         // 仅执行了 Phase 1 工具结果裁剪
  | 'summarized'          // 成功生成 LLM 摘要
  | 'fallback_summary'    // LLM 摘要失败，使用了确定性回退
  | 'skipped_thrashing'   // 反抖动跳过压缩
  | 'aborted_auth_error'  // 认证错误导致中止压缩
  | 'aborted_network_error'; // 网络错误导致中止压缩

interface TrimResult {
  messages: Message[];
  removedTurns: number;
  removedMessageCount: number;
  summarized: boolean;
  summary?: string;
  estimatedTokens: number;
  tokensSaved: number;
  /** 压缩结果状态码，调用方据此决定 UI 反馈 */
  status: TrimStatus;
  /** 面向用户或日志的警告信息 */
  warning?: string;
}

// 区分构造配置（ContextManagerConfig）与每次调用选项（TrimOptions）
interface ContextManagerConfig {
  summarizer?: Summarizer;
  contextWindow: number;         // 默认 1_000_000
  safetyMarginRatio: number;     // 默认 0.10
  maxSafetyMargin: number;       // 默认 16_384
  enableSummarization: boolean;  // 默认 true
  protectFirstN: number;         // 默认 3（首次压缩后衰减为 0）
  protectLastN: number;          // 默认 8（实际为硬上限，token budget 优先）
  summaryTargetRatio: number;    // 默认 0.20
  maxSummaryTokens: number;      // 默认 12_000
  abortOnSummaryFailure: boolean; // 默认 false
  tailTokenBudget: number;       // 默认 = contextWindow * summaryTargetRatio
}

interface TrimOptions {
  completionReserve?: number;    // 默认 4_096
  enableSummarization?: boolean; // 覆盖 ContextManagerConfig
  signal?: AbortSignal;
  /** 手动 /compress <topic> 引导摘要聚焦 */
  focusTopic?: string;
  /** 手动 /compress 绕过反抖动和 cooldown */
  force?: boolean;
}
```

---

## 设计决策记录

### 1. 为什么用字符比率估算而不用 tiktoken？

- **零依赖**：tiktoken 的 Node.js 移植需要 WASM 或 native binding
- **足够准确**：10% 安全余量足以覆盖 ±5% 估算误差
- **跨模型通用**：换模型只需换一组比率参数（`TokenizerProfile`）
- **性能**：O(n) 字符串扫描，无额外内存分配

### 2. 为什么以 Turn 为单位裁剪？

- **语义完整性**：Turn 是一个完整的问答循环
- **工具调用完整性**：assistant(tool_calls) + tool(result) 必须共存亡
- **协议要求**：API 要求 tool 消息必须有对应 assistant 消息（含 tool_calls）

### 3. 为什么工具结果要预裁剪？

- **廉价**：纯字符串处理，无网络调用，< 1ms
- **有效**：去重 + 摘要化可减少大量冗余 token（重复读同一文件 5 次只留 1 份）
- **为 LLM 摘要减负**：减少 summarizer 输入大小，提高摘要质量

### 4. 为什么摘要追加到 system prompt？

- **语义正确**：摘要是"背景知识"，不是对话
- **不会被裁剪**：system prompt 是最高优先级保留项
- **不影响 Turn 结构**：不引入"假 Turn"
- **prompt caching**：摘要作为 system prompt 的后缀追加，不影响前缀稳定性

### 5. 为什么需要 SUMMARY_PREFIX？

- **防止僵尸任务**：LLM 读到"## Active Task: refactor auth"会重新开始执行已完成任务
- **防止重复回答**：LLM 读到"## Pending Asks: what is X?"会重新回答
- **明确优先级**：只有摘要之后的最新用户消息才是当前任务

### 6. 为什么需要反抖动？

- **防止无限循环**：如果每次压缩只能移除 1-2 条消息，会陷入连续压缩
- **用户感知**：连续压缩会让 CLI 看起来卡死
- **阈值**：2 次 < 10% → 跳过，提示用户 `/new` 或 `/compress <topic>`

### 7. 为什么需要清理孤立 tool pair？

- **API 400 错误**：tool result 的 call_id 无对应 assistant tool_call → API 拒绝
- **静默失败**：不清理的话请求直接失败，用户看到莫名其妙的错误
- **简单修复**：压缩后遍历一次即可修复，O(n)，成本极低

### 8. 为什么摘要失败要区分 Auth/Network/Transient？

**选择：分级降级，Auth 和 Network 失败必须中止压缩。**

原因：
- **Auth 失败是永久性的**：用无效凭证不断重试只会重复失败。旋转到降级子 session 后每次请求仍会失败——用户必须修复凭证
- **Network 失败可能瞬时**：但重复压缩同样浪费 token。保留原始消息让网络恢复后通过 `/compress` 手动重试
- **Transient 失败**（超时、限流）可能自愈，短 cooldown 防止连续消耗 token

hermes-agent 从真实线上事故（#29559, #25585）中总结出此策略：旋转到降级 session 后网络仍未恢复，用户不仅丢失了上下文，每次请求还继续失败——双重损失。

### 9. 为什么 `_compressed_summary` 用下划线前缀？

**选择：使用 `_compressed_summary` 作为元数据 key。**

原因：
- wire sanitizer 在 API 调用前自动剥离所有下划线前缀的 top-level message key
- 严格的 OpenAI 兼容网关（Fireworks、Mistral、Moonshot/Kimi）拒绝携带未知 key 的请求（"Extra inputs are not permitted"）
- 下划线前缀确保此内部标记永远不会发往 API
- 前端/CLI/TUI 在渲染时检查此标记，区分压缩摘要与真实消息

### 10. 为什么 trimmer 是有状态类而 history-manager 是纯函数？

**选择：trimmer 持有状态，history-manager 纯函数。**

原因：
- 压缩状态（cooldown、previousSummary、反抖动计数）的**生命周期与 session 绑定**，不是单次调用的产物
- 纯函数集合（history-manager, token-counter, redactor, tool-pruner）可独立测试、无副作用
- 有状态编排层（trimmer）组合无状态子模块，依赖方向单一：trimmer → 子模块

这符合依赖倒置原则：高层模块（trimmer）依赖低层工具函数，而非相反。

### 11. 为什么有效窗口负值时回退而非报错？

**选择：`effectiveWindow <= 0` 时回退到 `contextWindow * 0.5`。**

原因：
- `completionReserve` 可能因配置错误大于 `contextWindow`（如用户将 max_tokens 设为 128K 但窗口只有 64K）
- 直接报错会让 agent 完全不可用；回退到保守估算让 agent 至少能运行
- hermes-agent 的回退逻辑（`effective_window = context_length`）在生产中验证有效
- 回退时记录 warning 日志，帮助运维发现配置问题

### 8 (续). Summarizer 为什么用依赖注入？

- **避免循环依赖**：Context → Agent → Provider → Context 会形成循环
- **Provider 独立演进**：换 Provider 不影响 ContextManager
- **可测试性**：测试时注入 mock Summarizer

---

## 边界情况与错误处理

| 场景 | 预期行为 |
|---|---|
| **空消息列表** | 返回空 TrimResult，status='unchanged' |
| **消息未超限** | 原样返回，status='unchanged' |
| **system prompt 超限** | 抛 `ContextWindowError` |
| **有效窗口为负** | 回退到 `contextWindow * 0.5`，记录 warning |
| **单条超大 tool 结果** | Phase 1 摘要化 → 截断 tool content（保留前 8000 + 截断标记）→ 仍超限抛异常 |
| **摘要 LLM 返回空/仅空白** | 视为失败，触发降级路径 |
| **摘要 LLM auth 失败 (401/403)** | **中止压缩**，保留原始消息，status='aborted_auth_error' |
| **摘要 LLM 网络断连** | **中止压缩**，保留原始消息，status='aborted_network_error' |
| **摘要 LLM 其他错误** | 回退主模型重试 1 次 → 仍失败则分级 cooldown + 回退摘要 |
| **abort signal 触发（压缩进行中）** | 检测 `_compressionInProgress` 标志 → 跳过压缩，返回原消息 |
| **abort signal 触发（摘要进行中）** | 摘要调用受保护（不中止），完成后返回压缩结果 |
| **连续无效压缩** | 反抖动：连续 2 次 < 10% 后跳过，status='skipped_thrashing' |
| **孤立 tool pair** | Phase 4 自动清理：去孤 tool result + 去孤 tool_call |
| **并发调用 fitToWindow** | `_compressionInProgress` 检测 → 第二次调用返回原消息 |
| **100+ Turn 长对话** | 迭代摘要 + 反抖动防止退化 |
| **模型切换** | `updateModel()` 清除 token 追踪和反抖动，重新计算阈值 |
| **Session 重置 (/new)** | `reset()` 清除全部 per-session 状态 |
| **摘要追加到 system prompt 后** | 不改变 system prompt 前缀（prompt caching 兼容） |
| **Causal Coupling：user 在 head 边界** | 整个 turn-pair 送入压缩区，标记为已完成 |
| **压缩后 head+tail 中零 user 消息** | 强制摘要为 role='user'（防 Provider 400） |
| **摘要 role 与 head 和 tail 都冲突** | merge-into-tail（使用 delimiter 分隔） |

---

## 与 hermes-agent 的差异

本实现是 hermes-agent `context_compressor.py` 的 TypeScript 移植，但有以下简化：

| 特性 | hermes-agent | Pure Agent | 原因 |
|---|---|---|---|
| 压缩锁（SQLite） | ✓ | ✗ | 单进程 Node.js，重入检测替代 |
| 辅助摘要模型 + fallback 主模型 | ✓ | ✗ | 简化：直接用主模型。TODO: 后续支持辅助模型降级链 |
| Codex app-server 压缩 | ✓ | ✗ | 非 target 场景 |
| 图片/多模态处理 | ✓ | ✗ | TODO: 高优先级，支持后需 `IMAGE_TOKEN_ESTIMATE = 1600` |
| 插件化 ContextEngine | ✓ | ✗ | 保留最小化策略接口 `CompressionStrategy`；插件系统不实现 |
| Cooldown SQLite 持久化 | ✓ | ✗ | 单进程内存实现，重启丢失 cooldown（可接受） |
| 摘要迭代更新 | ✓ | ✓ | 核心能力，已移植 |
| 反注入前缀（SUMMARY_PREFIX） | ✓ | ✓ | 核心能力，已移植 |
| SUMMARY_END_MARKER | ✓ | ✓ | 核心能力，已移植 |
| HISTORICAL_SUMMARY_PREFIXES | ✓ | ✓ | 核心能力，已移植 |
| 结构化摘要模板（13 字段） | ✓ | ✓ | 核心能力，已移植 |
| 工具结果预裁剪（3 阶段） | ✓ | ✓ | 核心能力，已移植 |
| 反抖动保护 | ✓ | ✓ | 核心能力，已移植 |
| Tool pair 清理 | ✓ | ✓ | 核心能力，已移植 |
| 确定性回退摘要 | ✓ | ✓ | 核心能力，已移植 |
| 敏感信息脱敏（Redaction） | ✓ | ✓ | 核心能力，已移植（独立 redactor.ts） |
| 多级错误降级（auth/network/transient） | ✓ | ✓ | 核心能力，已移植 |
| Abort 保护 | ✓ | ✓ | 核心能力，已移植（重入检测） |
| Causal Coupling 守卫 | ✓ | ✓ | 核心能力，已移植 |
| 压缩摘要元数据标记 | ✓ | ✓ | 核心能力，已移植（`_compressed_summary`） |
| Summarizer prompt 输入截断 | ✓ | ✓ | 核心能力，已移植（CONTENT_MAX 等） |
| auto-focus topic 推导 | ✓ | ✗ | TODO: 后续支持 `_derive_auto_focus_topic()` |
| Preflight 压缩（API 前检查） | ✓ | ✗ | TODO: 后续支持，当前依赖 post-response 检查 |
| Session 生命周期管理 | ✓ | ✓ | 核心能力，已移植（reset/updateModel） |
| Reasoning/replay 字段 token 估算 | ✓ | ✗ | TODO: 待支持 reasoning 模型后加入 |

---

## 测试策略

| 层级 | 测试内容 | 文件 |
|---|---|---|
| 单元测试 | Token 估算精度（中英文/代码/JSON/base64） | `token-counter.test.ts` |
| 单元测试 | 脱敏规则（API key, JWT, 连接串, 高熵文本） | `redactor.test.ts` |
| 单元测试 | Turn 分组边界（多工具、无 system prompt、异常序列） | `history-manager.test.ts` |
| 单元测试 | 工具结果去重、摘要化、尾部保护、token budget 边界 | `tool-pruner.test.ts` |
| 单元测试 | 摘要模板、前缀/后缀、回退摘要、脱敏集成 | `summarizer.test.ts` |
| 单元测试 | protectFirstN 衰减（首次 3 → 之后 0） | `trimmer.test.ts` |
| 单元测试 | 反抖动：连续 2 次 < 10% → 第 3 次 skip | `trimmer.test.ts` |
| 集成测试 | fitToWindow 全流程（含 mock summarizer） | `trimmer.test.ts` |
| 集成测试 | 摘要失败 → cooldown → 回退摘要 → cooldown 恢复 | `trimmer.test.ts` |
| 集成测试 | 迭代摘要：previousSummary 合并新 turn | `trimmer.test.ts` |
| 边界测试 | system prompt 超限、空消息、有效窗口负值 | `trimmer.test.ts` |
| 边界测试 | auth 失败 abort、网络错误 abort | `trimmer.test.ts` |
| 边界测试 | Causal Coupling 守卫（user 在 head 边界） | `trimmer.test.ts` |
| 边界测试 | 并发重入检测 | `trimmer.test.ts` |
| 边界测试 | 压缩机后 head+tail 中零 user 消息 | `trimmer.test.ts` |
| 边界测试 | 100 个 Turn → 验证裁剪性能（毫秒级） | `trimmer.test.ts` |
| 精度测试 | 用真实 API 的 `usage.prompt_tokens` 对比 `estimateTotal` 估算值 | 可选（标记 slow） |
| 端到端测试 | 用真实 LLM 验证 SUMMARY_PREFIX + SUMMARY_END_MARKER 防止僵尸任务 | 可选（标记 slow） |

---

## 参考资料

- [hermes-agent context_compressor.py](https://github.com/NousResearch/hermes-agent) — 原始实现参考
- [DeepSeek API — Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)
- [OpenAI Function Calling — Managing Context Window](https://platform.openai.com/docs/guides/function-calling/managing-the-context-window)
