# 调用模型的 API 格式：从一次 HTTP 请求到 Agent 的多轮闭环

> 本文是 Pure Agent 的基础知识读物，不是某一家厂商的完整 API 参考。它解释生成式模型调用中最常见的协议族、请求参数、普通与流式返回格式，以及 Agent 为什么必须正确处理工具调用。
>
> 本项目当前实际接入的是 **DeepSeek 的 OpenAI 兼容 Chat Completions 格式**，并且只使用流式调用。其他格式用于建立迁移和抽象能力，不能据此推断 Pure Agent 已经支持它们。

## 先建立正确的心智模型

调用大模型通常是一次 `HTTP POST`：客户端把模型名、上下文和控制选项编码为 JSON，请求服务端推理；服务端要么一次性返回 JSON，要么通过 SSE（Server-Sent Events）持续推送 JSON 片段。

对 Agent 而言，不能只把它理解为“输入一句话，输出一句话”。一次调用需要同时处理以下五个层面：

1. **传输层**：URL、认证头、超时、重试、HTTP 状态码。
2. **请求格式**：使用 `prompt`、`messages`，还是由多种 `input item` 组成的数组。
3. **生成控制**：输出上限、采样参数、停止词、结构化输出等。
4. **响应格式**：文本、结束原因、token 用量、工具调用、推理相关字段。
5. **会话闭环**：模型提出工具调用后，应用执行工具、把结果带回，再请求模型继续完成任务。

不同厂商的字段名称不完全相同，但这五个层面几乎总是存在。设计 Provider 抽象时，应先统一这些**语义**，再做字段映射；不能只靠“接口名字很像”判断兼容性。

## 常见格式有哪些

这里的“格式”指生成式模型的请求与响应 JSON 结构，而不是 SDK 的函数名称。现实中还会有图片、音频、批处理、实时音频等专用接口；本文聚焦 Agent 最常用的文本/多模态生成接口。

| 协议族 | 典型端点与输入 | 返回的核心结构 | 适用与限制 |
|---|---|---|---|
| 传统 Completions | `POST /completions`，`prompt: string` | `choices[].text` | 最早的补全文本模型格式；没有天然角色、工具结果关系，新的对话/推理模型常不再提供。 |
| Chat Completions / OpenAI compatible | `POST /chat/completions`，`messages[]` | `choices[].message` 或流式 `choices[].delta` | 目前最常见的兼容格式。DeepSeek 等服务提供此类接口；Pure Agent 当前使用这一类。 |
| Messages | `POST /v1/messages`，顶层 `system` + `messages[]` 内容块 | `content[]`，其中可含 `text`、`tool_use` 等块 | Anthropic Claude 的代表性格式；角色与工具结果的字段组织和 Chat Completions 不同。 |
| Responses / 统一 item 格式 | `POST /v1/responses`，`input` 字符串或 item 数组 | `output[]` item；文本、函数调用、推理项可并列 | OpenAI 的统一接口，原生表达多模态输入、内置工具与函数调用，但不能直接当成 Chat Completions 的响应解析。 |

还要区分两件容易混淆的事：

- **请求体格式**决定 JSON 的字段结构，例如 `messages` 还是 `input`。
- **传输模式**决定响应如何到达：`stream: false` 时通常是一份完整 JSON，`stream: true` 时通常是 SSE 事件流。流式不是另一种业务协议，而是同一业务响应的分片传输方式。

## 所有格式共有的 HTTP 外壳

下面是一个抽象后的请求。域名、模型名和认证方式必须以对应服务的文档为准；示例中的值都是占位符。

```http
POST https://api.example.com/v1/chat/completions
Authorization: Bearer $API_KEY
Content-Type: application/json
Accept: text/event-stream

{ "model": "example-chat-model", "messages": [ ... ], "stream": true }
```

关键点：

- API Key 是服务端密钥，应只存放在受控服务端、环境变量或密钥管理系统中，不能放进浏览器渲染进程或提交到仓库。
- `Content-Type: application/json` 表示请求体是 JSON；流式请求的响应通常是 `text/event-stream`。
- 把服务端返回的请求 ID、模型名、HTTP 状态和耗时写入日志，有助于定位超时、限流和供应商问题；日志中不能记录 API Key、完整敏感提示词或工具结果。
- HTTP 成功不等于 Agent 成功。即使得到 `200`，仍要检查模型的 `finish_reason` / `stop_reason`、工具调用和输出格式是否满足本轮任务。

## 1. 传统 Completions：单段文本补全

这是最早的生成接口：把提示词拼成一个字符串，请模型续写。

```json
{
  "model": "example-completion-model",
  "prompt": "把下面的句子翻译成英文：你好，世界。\n译文：",
  "max_tokens": 80,
  "temperature": 0.2,
  "stop": ["\n"]
}
```

典型返回：

```json
{
  "id": "cmpl_example",
  "object": "text_completion",
  "model": "example-completion-model",
  "choices": [
    {
      "index": 0,
      "text": "Hello, world.",
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 18,
    "completion_tokens": 4,
    "total_tokens": 22
  }
}
```

它的缺点是：角色、历史消息、工具调用和工具结果都要由客户端自行拼接成文本，边界脆弱且不利于安全审计。因此，新的 Agent 实现通常优先选择支持结构化消息和工具调用的格式。

## 2. Chat Completions：Pure Agent 当前使用的格式

Chat Completions 将会话写成按顺序排列的 `messages`。每条消息有 `role` 和 `content`；工具调用时还会出现 `tool_calls`、`tool_call_id` 等关联字段。

### 请求示例

```json
{
  "model": "example-chat-model",
  "messages": [
    {
      "role": "system",
      "content": "你是一个严谨的旅行助理。"
    },
    {
      "role": "user",
      "content": "杭州明天适合户外活动吗？"
    }
  ],
  "max_tokens": 500,
  "temperature": 0.2,
  "stream": true,
  "stream_options": {
    "include_usage": true
  }
}
```

最常见的消息角色如下。支持的角色和内容形态以每个服务的模型文档为准。

| 角色 | 含义 | Agent 中的使用方式 |
|---|---|---|
| `system` | 系统级行为约束 | 放置稳定的系统提示词、边界和输出约束。 |
| `developer` | 开发者指令 | 部分 API 支持，优先级通常介于系统与用户之间；不能假定 OpenAI-compatible API 都支持。 |
| `user` | 用户输入 | 每次用户提出新任务时追加。 |
| `assistant` | 过去的模型输出 | 文本回复或工具调用请求；工具调用后必须原样保留其 ID。 |
| `tool` | 应用执行工具后的结果 | 通过 `tool_call_id` 对应上一条 assistant 的某个工具调用。 |

### 常用参数

下面的名称采用 Chat Completions 常见写法。参数是否可用、默认值、取值范围和能否组合都由供应商与模型决定。

| 参数 | 作用 | 实践建议 |
|---|---|---|
| `model` | 指定模型 ID | 必填。将模型能力、上下文窗口和价格视为配置，而非写死在业务逻辑中。 |
| `messages` | 到当前为止的会话历史 | 必填。顺序就是语义；不要把 tool 结果放在与其无关的位置。 |
| `max_tokens` | 限制生成 token 数 | 常见别名有 `max_completion_tokens`、`max_output_tokens`。它们的计数口径可能不同，不能只做字段重命名。 |
| `temperature` | 控制采样随机性 | 值越低通常越稳定，值越高通常越发散。适合在事实抽取、工具决策等任务使用较低值。 |
| `top_p` | 核采样概率阈值 | 通常与 `temperature` 二选一调节，避免同时随意修改两个随机性旋钮。 |
| `stop` | 一个或多个停止序列 | 用于受控的纯文本生成；不要把它当作工具调用或 JSON 完整性的保障。 |
| `stream` | 是否以流式事件返回 | Agent UI 往往设为 `true`；聚合器必须能处理空内容块和最终 usage 块。 |
| `stream_options` | 流式附加选项 | 例如部分服务支持 `include_usage`，在结束前额外发送全量 token 用量。 |
| `tools` | 可供模型选择的函数定义 | 只描述工具的名称、用途与 JSON Schema；不会把执行函数上传给模型。 |
| `tool_choice` | 限制工具选择方式 | 通常包括 `none`、`auto`、`required` 或强制某一个函数。 |
| `response_format` | 约束文本/JSON 输出形态 | `json_object` 只能说明结果是 JSON，不自动保证业务字段齐全；支持时优先使用 JSON Schema 的严格模式。 |
| `user` / `user_id` | 供应商侧的请求归属或隔离标识 | 只传不可反查的内部标识，不能放邮箱、姓名等个人信息。 |
| 推理相关参数 | 开关或调节推理模型的工作方式 | 例如 `thinking`、`reasoning_effort`；它们不是通用标准，必须按模型能力表启用。 |

### 一次性完整返回

当 `stream` 为 `false` 时，Chat Completions 常见的正常返回形状如下：

```json
{
  "id": "chatcmpl_example",
  "object": "chat.completion",
  "created": 1783996800,
  "model": "example-chat-model",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "杭州明天晴到多云，适合户外活动。"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 124,
    "completion_tokens": 22,
    "total_tokens": 146
  }
}
```

应用通常读取第一项的 `choices[0].message`，但仍须显式处理 `choices` 为空、`content` 为 `null`、有多个 choice，或存在工具调用的情况。`usage` 用于计费、容量规划和上下文管理，不能当作模型业务输出。

常见的结束原因：

| `finish_reason` | 含义 | Agent 的典型处理 |
|---|---|---|
| `stop` | 模型正常停止 | 将文本作为最终回复。 |
| `tool_calls` | 模型请求调用工具 | 进入工具执行闭环，而不是直接把它当最终文本。 |
| `length` | 达到输出上限或相关限制 | 标为截断；可在安全条件下让模型续写或提示用户缩小任务。 |
| `content_filter` | 内容被安全机制拦截 | 不把残缺内容当成成功答案，交给应用的安全策略处理。 |
| 厂商专有值 | 资源不足、策略拒绝等 | 保留原始值并映射到内部错误/终态，不能静默伪装成 `stop`。 |

### 流式返回：SSE 中的 JSON 增量

`stream: true` 时，响应不是一个可一次 `JSON.parse()` 的大对象。HTTP body 是多条 SSE 事件，每条的 `data:` 后面是一个 JSON chunk；结束通常由 `data: [DONE]` 标记。不同供应商可能增加 `event:` 名称或其他字段。

```text
data: {"id":"chatcmpl_example","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl_example","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"杭州明天"},"finish_reason":null}]}

data: {"id":"chatcmpl_example","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"适合户外活动。"},"finish_reason":null}]}

data: {"id":"chatcmpl_example","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

流式处理的规则：

1. 逐条解析 SSE，而不是按网络读取块直接解析 JSON；一个网络块可能包含半条或多条 SSE 事件。
2. 按 `choice.index` 与工具调用的 `index` 聚合；`delta.content` 只是文本片段，不能覆盖上一个片段。
3. 允许 `choices` 为空。DeepSeek 在开启 `stream_options.include_usage` 时，会在 `[DONE]` 前发送一个带全量 `usage`、但 `choices: []` 的额外 chunk。
4. 只有收到终态的 `finish_reason` 和流结束标志后，才能认为本轮完整结束。连接中断、缺少终态或 JSON 畸形都应视为不完整响应。

## 3. 工具调用不是“模型执行了函数”

工具调用（Function Calling）的本质是：模型返回一份**调用建议**。模型没有获得本机文件、Shell 或数据库的直接权限；真正执行的是 Agent 所在应用。应用必须负责参数校验、权限判断、超时、审计和错误处理。

### 在请求中声明工具

Chat Completions 常见的工具定义使用 JSON Schema 描述参数：

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询指定城市当天的天气",
        "parameters": {
          "type": "object",
          "properties": {
            "city": { "type": "string", "description": "城市名称" },
            "date": { "type": "string", "description": "ISO 8601 日期" }
          },
          "required": ["city", "date"],
          "additionalProperties": false
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

模型决定调用工具时，一次性响应的 `message` 可能是下面这样。注意 `arguments` 是**JSON 字符串**，不是已经验证过的 JavaScript 对象：

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_weather_01",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": "{\"city\":\"杭州\",\"date\":\"2026-07-15\"}"
      }
    }
  ]
}
```

流式情况下，工具名和 `arguments` 也会被拆成多段；尤其是 JSON 字符串可能在任意字符处断开。必须拼接完整后再 `JSON.parse()` 和 JSON Schema 校验，不能对每个片段单独解析。

### Agent 的多轮闭环

```text
用户消息
  → 调用模型（附带工具定义）
  → 模型返回 tool_calls
  → 应用校验参数、授权并执行工具
  → 追加 assistant 工具调用消息 + tool 结果消息
  → 再次调用模型
  → 模型返回最终文本或新的 tool_calls
```

对应的第二轮 `messages` 至少需要保留关联关系：

```json
[
  {
    "role": "assistant",
    "content": null,
    "tool_calls": [
      {
        "id": "call_weather_01",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"city\":\"杭州\",\"date\":\"2026-07-15\"}"
        }
      }
    ]
  },
  {
    "role": "tool",
    "tool_call_id": "call_weather_01",
    "content": "{\"condition\":\"晴到多云\",\"high_c\":31,\"rain_probability\":10}"
  }
]
```

这两条消息必须成对保存。丢失 `tool_call_id`、改写工具调用 ID、把结果当作普通 `user` 消息，都会破坏模型对上下文的理解。工具结果本身也属于不可信的外部输入：要限制大小、标注来源，并防范提示注入。

## 4. Messages 格式：以内容块表达多模态与工具

Anthropic Messages API 的代表性请求形式如下。它与 Chat Completions 的共同点是都有模型、会话消息、工具和流式开关；区别是系统提示词置于顶层，消息的 `content` 通常是内容块数组，工具参数字段叫 `input_schema`。

```json
{
  "model": "example-claude-model",
  "max_tokens": 500,
  "system": "你是一个严谨的旅行助理。",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "杭州明天适合户外活动吗？" }
      ]
    }
  ],
  "tools": [
    {
      "name": "get_weather",
      "description": "查询天气",
      "input_schema": { "type": "object", "properties": {} }
    }
  ],
  "stream": true
}
```

非流式响应也由内容块构成：

```json
{
  "id": "msg_example",
  "type": "message",
  "role": "assistant",
  "model": "example-claude-model",
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_01",
      "name": "get_weather",
      "input": { "city": "杭州", "date": "2026-07-15" }
    }
  ],
  "stop_reason": "tool_use",
  "usage": { "input_tokens": 120, "output_tokens": 40 }
}
```

与 Chat Completions 的关键映射差异：

| 语义 | Chat Completions | Messages |
|---|---|---|
| 系统提示词 | `messages[{ role: "system" }]` | 顶层 `system` |
| 工具参数 schema | `function.parameters` | `input_schema` |
| 模型提出调用 | `tool_calls[].function.arguments`（JSON 字符串） | `content[{ type: "tool_use" }].input`（对象） |
| 工具执行结果 | `role: "tool"` + `tool_call_id` | 通常作为用户消息内的 `tool_result` 内容块 |
| 结束原因 | `finish_reason` | `stop_reason` |

因此，不能把一个 Chat Completions 的 `Message[]` 不经转换就发送给 Messages API。Provider 的职责正是保存内部语义不变，并在边界上完成这类映射。

## 5. Responses：以输入/输出 item 统一表达

Responses API 使用 `input` 和 `output` item 表达会话。`input` 可以是简单字符串，也可以是带角色和多模态内容块的数组；函数调用、内置工具调用、推理项和文本输出都可能并列在 `output[]` 中。

```json
{
  "model": "example-reasoning-model",
  "instructions": "你是一个严谨的旅行助理。",
  "input": [
    {
      "role": "user",
      "content": [
        { "type": "input_text", "text": "杭州明天适合户外活动吗？" }
      ]
    }
  ],
  "tools": [
    {
      "type": "function",
      "name": "get_weather",
      "description": "查询天气",
      "parameters": { "type": "object", "properties": {} },
      "strict": true
    }
  ],
  "max_output_tokens": 500,
  "stream": true
}
```

简化后的非流式响应示例：

```json
{
  "id": "resp_example",
  "object": "response",
  "status": "completed",
  "model": "example-reasoning-model",
  "output": [
    {
      "type": "message",
      "role": "assistant",
      "content": [
        { "type": "output_text", "text": "我先查询天气。" }
      ]
    },
    {
      "type": "function_call",
      "call_id": "call_weather_01",
      "name": "get_weather",
      "arguments": "{\"city\":\"杭州\",\"date\":\"2026-07-15\"}"
    }
  ],
  "usage": {
    "input_tokens": 120,
    "output_tokens": 40,
    "total_tokens": 160
  }
}
```

这里不能假设“答案总在 `output[0]`”。消费者需要遍历 `output[]`，按 `type` 分别处理文本、函数调用及其他 item。要回传函数结果时，通常以带相同 `call_id` 的 `function_call_output` item 放入下一次请求的 `input` 中。SDK 可能提供聚合后的 `output_text` 便利属性，但底层协议处理仍应以 `output[]` 为准。

## 结构化输出与 JSON 的三个层次

“让模型返回 JSON”至少有三种强度，不能混为一谈：

| 层次 | 常见方式 | 能保证什么 | 仍要做什么 |
|---|---|---|---|
| 提示词约定 | 在 system/user prompt 中写“只返回 JSON” | 没有协议级保证 | 去掉 Markdown 包装、解析、校验、重试。 |
| JSON mode | 例如 `response_format: { "type": "json_object" }` | 通常保证可解析为 JSON 对象 | 业务字段可能缺失、类型可能错；仍须 schema 校验。 |
| Structured Outputs | 传入 JSON Schema 并启用 `strict`（模型支持时） | 在支持范围内更严格地遵从 schema | 仍须处理拒绝、截断、工具调用、供应商限制与业务授权。 |

任何结构化输出都不能替代权限控制。例如模型返回 `{ "path": "/etc/passwd" }` 在语法上完全有效，但文件工具必须根据工作区白名单拒绝它。

## Pure Agent 中的实际映射

Pure Agent 的内部类型使用 camelCase，Provider 边界再翻译为 API 所需的 snake_case。当前边界和支持范围如下：

```text
Message / ToolDefinition / SendMessageParams
  → buildRequestBody()
  → DeepSeekRequestBody（OpenAI-compatible JSON）
  → POST /chat/completions（SSE）
  → DeepSeekStreamChunk
  → StreamEvent
  → Agent Loop / CLI / Desktop
```

当前 `buildRequestBody()` 会发送：

| 内部字段/行为 | DeepSeek wire 字段 | 当前行为 |
|---|---|---|
| `model` | `model` | 从本次请求或 Provider 默认配置取得。 |
| `messages` | `messages` | 映射角色、assistant 的 `tool_calls` 和 tool 的 `tool_call_id`。 |
| `tools` | `tools` | 转成 `type: "function"` 与 `function.parameters`。 |
| 有工具时的固定策略 | `tool_choice: "auto"` | 当前不向调用方暴露强制特定工具的选项。 |
| `maxTokens` | `max_tokens` | 可选，未设置时使用 Provider 配置的默认值。 |
| `temperature` | `temperature` | 可选，未设置时使用 Provider 配置的默认值。 |
| `thinking` | `thinking` | DeepSeek 专有的推理模式开关。 |
| `reasoningEffort` | `reasoning_effort` | DeepSeek 专有的推理强度设置。 |
| 固定流式策略 | `stream: true` | Provider 层没有非流式 `sendMessage()`。 |
| 固定用量请求 | `stream_options: { include_usage: true }` | 读取结束前的 usage-only chunk。 |

`DeepSeekRequestBody` 类型还记录了协议可表达但当前公共 `SendMessageParams` 尚未开放的字段，例如 `top_p`、`response_format`、`stop`、`user_id` 和自定义 `tool_choice`。**类型中存在不代表当前 Pure Agent 会发送它。** 若要新增一个参数，应同步完成：内部契约、Provider 映射、能力/模型校验、测试和文档，而不是只在请求体类型里加字段。

流式响应会被收敛成项目内部事件：

| DeepSeek chunk 字段 | Pure Agent 的 `StreamEvent` | 消费方式 |
|---|---|---|
| `delta.reasoning_content` | `reasoning` | Agent Loop 累积，UI 不直接显示。 |
| `delta.content` | `text` | CLI/Desktop 增量渲染；收集器拼接完整文本。 |
| `delta.tool_calls[].function.name` | `tool_call_start` | 为该调用建立 ID 与工具名。 |
| `delta.tool_calls[].function.arguments` | `tool_call_delta` | 按调用 ID 拼接，完整后再解析 JSON。 |
| `finish_reason` + `usage` | `done` | 确认终态、保存 token 用量。 |
| 本地 abort | `aborted` | 表示调用方取消，不伪造正常完成。 |

对应实现可查看：

- [DeepSeek wire 类型](../../packages/core/src/provider/deepseek-types.ts)
- [请求映射与 SSE 聚合](../../packages/core/src/provider/deepseek-client.ts)
- [内部 Provider 契约](../../packages/core/src/types/provider.ts)
- [共享消息和流事件类型](../types/design.md)

## 实现 Provider 时的检查清单

- 请求前：校验模型能力、上下文长度、工具 schema 与敏感字段；为本次请求分配可追踪 ID。
- 传输中：正确处理取消、超时、限流、网络重试；不要对非幂等的外部工具执行做盲目重试。
- 流解析：按 SSE 事件边界解析，累积文本和工具参数片段，接受空 `choices` 的 usage 终帧。
- 响应后：检查结束原因；把 token 用量与模型名记录到指标；对 JSON/工具参数进行解析和 schema 校验。
- 工具执行：把模型输出当不可信请求；执行前做权限、路径、网络和参数校验，执行结果限制大小并保留审计信息。
- 多轮会话：完整保留 assistant 工具调用与 tool 结果之间的 ID 对；上下文裁剪时也不能拆散这一组消息。
- 兼容性：把厂商专有参数、错误码、推理字段和结束原因放在 Provider 适配层，避免泄漏到 Agent Loop 的通用决策代码。

## 延伸阅读（以官方文档为准）

API 参数会随模型和服务更新。实现或扩展 Provider 前，请以当前官方文档为准：

- [DeepSeek：Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion/)
- [OpenAI：Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI：API overview](https://developers.openai.com/api/reference/overview)
- [Anthropic：Messages API](https://platform.claude.com/docs/en/api/messages)

