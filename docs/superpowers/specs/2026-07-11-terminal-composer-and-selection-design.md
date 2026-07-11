# 终端底部 Composer、运行时选择器与 Tab 补全设计

## 目标

交互式 CLI 的输入 Composer 固定在终端底部，并以顶部和底部边框与聊天区分隔。用户可通过 `/model` 与 `/effort` 打开键盘可操作的选择列表；slash command 支持 Tab 补全。

## 终端布局

`App` 使用 Ink stdout 的当前行数渲染为全高 column layout。标题、配置提示、聊天视图与状态栏组成可收缩的聊天区；Composer 是末尾的固定子项，聊天区以 `flexGrow` 填充剩余高度。聊天内容超出视口时从顶部裁切，保证最近的消息和 Composer 保持可见。

Composer 使用 `borderStyle="single"`，仅启用 `borderTop` 与 `borderBottom`。命令菜单与选择列表属于 Composer 上方的短暂辅助层：它们会占用聊天区空间，但不会把 Composer 推离底部。

## 运行时选项

模型目录是 CLI 内置的只读配置，不接受任意字符串：

| 标签 | API model ID |
| --- | --- |
| DeepSeek V4 Pro | `deepseek-v4-pro` |
| DeepSeek V4 Flash | `deepseek-v4-flash` |

effort 目录固定为 `off`、`low`、`medium`、`high`。`/model <id>` 和 `/effort <value>` 保留直接切换行为；无参数的 `/model`、`/effort` 不再只显示当前值，而是打开对应列表，当前值默认高亮。

选择列表的键盘契约：↑/↓ 移动选择，Enter 应用，Esc 取消。打开选择器期间，方向键不能触发聊天历史；取消不改变会话设置或聊天消息。

## Tab 补全

只在普通聊天输入模式、且输入的第一个 token 是 slash command 时处理 Tab。补全基于 `SLASH_COMMANDS` 的单一元数据源：

- 唯一前缀补全为完整命令；需要参数的命令追加一个空格。
- 多个匹配项按命令目录顺序循环；第一次 Tab 选中第一个候选，继续按 Tab 选择下一个。
- 用户键入任意非 Tab 字符、切换到密钥输入模式、打开选择器或提交输入后，循环状态重置。
- 不存在候选时保持输入不变。

Tab 只补全命令名，不补全模型参数、effort 参数或 API Key。

## 模块边界

```text
packages/cli/src/
  runtime-options.ts                 模型与 effort 的只读目录和选择器选项
  commands/completion.ts             无 UI 副作用的 slash 匹配与 Tab 循环
  components/OptionPicker.tsx        选择列表展示
  components/InputBar.tsx            输入、历史、Tab 和选择器键盘协调
  hooks/useAgent.ts                  命令意图转换为 picker 状态与会话设置
  app.tsx                            全高布局和固定 Composer
```

命令 parser 与 handler 只表达“打开 model/effort picker”的意图；hook 维护 picker 的可见性和当前会话设置；InputBar 不直接修改 Agent 状态。

## 验证

1. 纯函数单测覆盖两个模型目录、四档 effort、命令匹配和 Tab 循环/重置。
2. parser/handler 单测覆盖无参数 `/model` 和 `/effort` 返回 picker 意图、带参数保持直接切换。
3. CLI typecheck/build 验证 Ink props 与跨模块类型。
4. PTY 验证输入框位于终端底部、上下边框可见、选择器键盘操作、Tab 补全和聊天历史不冲突。

## 非目标

- 不从网络获取模型列表，不支持自定义模型 ID。
- 不实现鼠标点击、模糊搜索或持久化选择器状态。
- 不改变 API Key 的掩码输入和安全持久化流程。
