# Hermes Agent — Tool System 设计分析

> 项目路径：`open-source/hermes-agent/`
> 语言：Python
> 工具文件数：97 个（`tools/*.py`）
> 核心文件：`tools/registry.py`、`tools/tool_search.py`、`tools/schema_sanitizer.py`、`model_tools.py`、`toolsets.py`

---

## 一、架构概览

Hermes Agent 的工具系统采用**单例 Registry + 模块自注册 + AST 发现**模式。所有工具通过唯一的 `ToolRegistry` 单例管理，工具文件在 import 时自动注册，不需要维护中央工具清单。

```
tools/registry.py          ← 单例 ToolRegistry（线程安全、generation-based cache）
    ↑ register()
tools/file_tools.py        ← 文件操作工具（read_file, write_file, patch, search_files）
tools/terminal_tool.py     ← Shell 终端工具
tools/web_tools.py          ← Web 搜索/抓取工具
tools/browser_tool.py       ← 浏览器自动化（Playwright/CDP）
tools/delegate_tool.py      ← 子 Agent 委派
tools/mcp_tool.py           ← MCP 协议客户端
tools/skills_tool.py        ← 技能管理
tools/memory_tool.py        ← 记忆系统
    ...共 97 个工具模块

toolsets.py                 ← Toolset 组合（coding, safe, hermes-cli 等场景配置）
model_tools.py              ← LLM 交互层（get_tool_definitions + dispatch）
schema_sanitizer.py         ← 多 Provider Schema 适配
tool_search.py              ← 渐进式工具披露（bridge tools）
```

---

## 二、工具定义模式

### 2.1 注册方式：模块级自注册

每个工具文件在模块顶层调用 `registry.register()`：

```python
# tools/file_tools.py (line 2170-2173)
registry.register(
    name="read_file",
    toolset="file",
    schema=READ_FILE_SCHEMA,
    handler=_handle_read_file,
    check_fn=_check_file_reqs,
    emoji="📖",
    max_result_size_chars=100_000,
)
registry.register(
    name="write_file",
    toolset="file",
    schema=WRITE_FILE_SCHEMA,
    handler=_handle_write_file,
    check_fn=_check_file_reqs,
    emoji="✍️",
    max_result_size_chars=100_000,
)
registry.register(
    name="patch",
    toolset="file",
    schema=PATCH_SCHEMA,
    handler=_handle_patch,
    check_fn=_check_file_reqs,
    emoji="🔧",
)
registry.register(
    name="search_files",
    toolset="file",
    schema=SEARCH_FILES_SCHEMA,
    handler=_handle_search_files,
    check_fn=_check_file_reqs,
    emoji="🔎",
)
```

**关键特点**：
- 不需要装饰器、不需要类继承
- 所有注册参数在单一调用点声明
- 工具文件和注册调用在同一个文件中

### 2.2 ToolEntry：工具元数据

```python
class ToolEntry:
    __slots__ = (
        "name", "toolset", "schema", "handler", "check_fn",
        "requires_env", "is_async", "description", "emoji",
        "max_result_size_chars", "dynamic_schema_overrides",
    )
```

| 字段 | 说明 |
|------|------|
| `name` | 工具唯一标识（如 `"read_file"`） |
| `toolset` | 所属分组（如 `"file"`、`"web"`、`"terminal"`） |
| `schema` | 手写 JSON Schema dict（含 name、description、parameters） |
| `handler` | 执行函数 `(args, **kwargs) -> str`（返回 JSON 字符串） |
| `check_fn` | 可用性探针 `() -> bool`（如检测 Docker daemon） |
| `requires_env` | 依赖的环境变量列表 |
| `is_async` | handler 是否异步 |
| `emoji` | UI 展示图标 |
| `max_result_size_chars` | 单次结果字符数上限 |
| `dynamic_schema_overrides` | 零参数回调，返回运行时 schema 覆写 dict |

### 2.3 参数定义

参数使用手写 JSON Schema：

```python
READ_FILE_SCHEMA = {
    "name": "read_file",
    "description": "Read a file from the local filesystem...",
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File path"},
            "offset": {"type": "integer", "description": "Start line (1-based)"},
            "limit": {"type": "integer", "description": "Max lines to read"},
        },
        "required": ["path"],
    },
}
```

工具 handler 自行做运行时参数校验，错误返回 `{"error": "message"}` JSON。

---

## 三、工具注册与发现

### 3.1 单例 Registry

```python
# tools/registry.py
class ToolRegistry:
    def __init__(self):
        self._tools: Dict[str, ToolEntry] = {}
        self._toolset_checks: Dict[str, Callable] = {}
        self._toolset_aliases: Dict[str, str] = {}
        self._plugin_override_policy: Dict[str, bool] = {}
        self._lock = threading.RLock()       # 读写保护
        self._generation: int = 0             # 单调递增，cache invalidation

registry = ToolRegistry()  # 模块级单例
```

**线程安全设计**：
- `threading.RLock` 保护所有读写操作
- `_snapshot_state()` 返回一致性快照（在锁内完成）
- `_generation` 单调递增，外部可 key cache 在 generation 上

### 3.2 AST 扫描发现

工具模块通过静态代码分析发现，而非显式列表：

```python
def _module_registers_tools(module_path: Path) -> bool:
    """检查模块是否包含顶层 registry.register(...) 调用"""
    source = module_path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(module_path))
    return any(_is_registry_register_call(stmt) for stmt in tree.body)

def discover_builtin_tools(tools_dir=None):
    """扫描 tools/*.py → AST 检查 → import → 触发 register()"""
    for path in sorted(tools_path.glob("*.py")):
        if path.name not in {"__init__.py", "registry.py", "mcp_tool.py"}
           and _module_registers_tools(path):
            importlib.import_module(f"tools.{path.stem}")
```

**优点**：
- 新增工具只需创建文件并调用 `registry.register()`
- 无需维护中央工具清单
- 文件删除自动不影响

**缺点**：
- 依赖 import side-effect（隐式注册）
- 错误处理需包装 try/except

### 3.3 Toolset 系统

Toolset 是工具的逻辑分组。每个工具属于一个 toolset：

| Toolset | 示例工具 |
|---------|---------|
| `file` | read_file, write_file, patch, search_files |
| `terminal` | terminal, process |
| `web` | web_search, web_extract |
| `skills` | skills_list, skill_view, skill_manage |
| `browser` | browser_navigate, browser_snapshot, browser_click, ... |
| `memory` | memory |
| `mcp-*` | MCP 服务器工具（动态） |

高层 Toolset 组合定义场景配置：

```python
# toolsets.py
_HERMES_CORE_TOOLS = [
    "web_search", "web_extract",
    "terminal", "process",
    "read_file", "write_file", "patch", "search_files",
    "browser_navigate", "browser_snapshot", "browser_click", ...
    "delegate_task", "execute_code",
    "todo", "memory",
    ...
]
```

### 3.4 注册冲突处理

```python
def register(self, name, toolset, schema, handler, ...):
    existing = self._tools.get(name)
    if existing and existing.toolset != toolset:
        # MCP-to-MCP 覆盖：允许（server 刷新或同名工具）
        if both are mcp-* → allow

        # Plugin override：需要 opt-in
        elif override and plugin has allow_tool_override → allow

        # 其他情况：拒绝
        else → REJECT (log error, return without registration)
```

---

## 四、工具执行

### 4.1 Dispatch 流程

```python
# tools/registry.py
def dispatch(self, name: str, args: dict, **kwargs) -> str:
    entry = self.get_entry(name)
    if not entry:
        return json.dumps({"error": f"Unknown tool: {name}"})

    try:
        if entry.is_async:
            return _run_async(entry.handler(args, **kwargs))
        return entry.handler(args, **kwargs)
    except Exception as e:
        raw = f"Tool execution failed: {type(e).__name__}: {e}"
        sanitized = _sanitize_tool_error(raw)
        return json.dumps({"error": sanitized})
```

**关键设计**：
- **所有错误不抛给调用方**：全部捕获并返回 JSON error
- **同步/异步桥接**：`_run_async()` 提供 3 种策略（主线程、event loop、worker thread）
- **错误消毒**：异常消息中的 framing tokens/CDATA/fences 被移除

### 4.2 工具结果格式

所有 handler 必须返回 JSON 字符串：

```python
# 成功
json.dumps({"result": "...", "success": True})

# 错误（通过 tool_error helper）
tool_error("file not found")  # → '{"error": "file not found"}'
tool_error("bad input", code=400)  # → '{"error": "bad input", "code": 400}'

# 结果（通过 tool_result helper）
tool_result({"files": ["a.txt", "b.txt"]})
tool_result(success=True, data=payload)
```

### 4.3 结果持久化（3 层）

借鉴 Hermes 的 `budget_config.py` + `tool_result_storage.py`：

| 层级 | 默认值 | 说明 |
|------|--------|------|
| Per-result | 100K chars | 单次工具结果上限 |
| Per-turn | 200K chars | 单轮所有工具结果总量上限 |
| Preview | 1,500 chars | 超出上限后的内联预览片段 |

`read_file` 固定为 `inf`，防止无限 persist-read 循环。

---

## 五、可用性门控

### 5.1 check_fn 探针

每个工具可指定 `check_fn`——一个返回 `bool` 的无参回调：

```python
# 文件工具：需要 terminal backend 可用
def _check_file_reqs():
    return check_terminal_requirements()

# 浏览器工具：需要 Playwright
def check_browser_requirements():
    try:
        subprocess.run([playwright_binary, "--version"], timeout=5)
        return True
    except:
        return False
```

### 5.2 TTL 缓存 + 故障宽限期

```python
_CHECK_FN_TTL_SECONDS = 30.0          # 缓存 30 秒
_CHECK_FN_FAILURE_GRACE_SECONDS = 60.0 # 故障宽限期 60 秒

def _check_fn_cached(fn):
    # 30 秒内的缓存结果直接返回
    # 如果探针返回 False，但 60 秒内曾成功过 → 视为瞬态抖动，返回 True
    # 如果超过 60 秒仍未恢复 → 确认不可用，缓存 False
```

**设计理由**：Docker daemon 繁忙、socket 争用、探针超时都可能导致 `check_fn` 暂时返回 False。宽限期防止这些瞬态抖动导致整个 toolset 静默消失。

---

## 六、Schema 管理

### 6.1 多 Provider 适配

`schema_sanitizer.py` 在所有工具 schema 传给 LLM 前做深度 sanitize：

| 问题 | 影响的后端 | 修复方式 |
|------|-----------|---------|
| 空 `properties` 的对象 | llama.cpp | 回填 `"properties": {}` |
| 数组 type（`["string", "null"]`） | llama.cpp | 转为单 type + nullable hint |
| 顶层 `anyOf`/`oneOf` | Anthropic, OpenAI Codex | 剥离为纯 object |
| Nullable union（`anyOf` 含 `{"type": "null"}`） | Anthropic | 合并到非 null 分支 |
| `$ref` 同级 `default` | Fireworks, Kimi | 移除 `default` |
| `pattern` / `format` 在 `$ref` 中 | llama.cpp | 按需移除（仅首次被拒绝后） |

### 6.2 动态 Schema Override

`dynamic_schema_overrides` 回调在每次 `get_definitions()` 时执行，用于反映运行时配置变化：

```python
# delegate_task 的描述需要反映用户配置的 max_concurrent_children
def _delegate_schema_overrides():
    from hermes_cli.config import load_config
    cfg = load_config()
    max_children = cfg.get("delegation", {}).get("max_concurrent_children", 3)
    return {
        "description": f"Delegate a task to a sub-agent (max {max_children} concurrent children)...",
    }
```

### 6.3 缓存策略

```python
# model_tools.py — get_tool_definitions() 缓存
cache_key = (
    frozenset(enabled_toolsets),
    frozenset(disabled_toolsets),
    registry._generation,          # registry 变更自动失效
    config_mtime,                   # 配置文件修改自动失效
    kanban_task_flag,
)
# LRU 上限 8 条目（长生命周期 Gateway 进程友好）
```

---

## 七、安全机制

### 7.1 路径安全

```python
# tools/path_security.py
def validate_within_dir(path, root):
    """确保解析后的路径在允许的根目录内"""
    resolved = root / path
    if not resolved.resolve().is_relative_to(root.resolve()):
        raise PathTraversalError(path)

def has_traversal_component(path):
    """禁止 .. 组件"""
    return ".." in Path(path).parts
```

### 7.2 设备路径阻断

```python
# 禁止读取的路径（防止 hang）
_BLOCKED_PATHS = {
    "/dev/zero", "/dev/random", "/dev/urandom",
    "/dev/stdin", "/dev/tty", "/dev/null",
}
```

### 7.3 危险命令检测

```python
# tools/approval.py
DANGEROUS_PATTERNS = {
    r"rm\s+-rf\s+/",           # rm -rf /
    r"sudo\s+",                 # sudo
    r"chmod\s+777",            # chmod 777
    r">\s*/dev/sd[a-z]",       # 覆写磁盘设备
    r"mkfs\.",                  # 格式化
    r"dd\s+if=",               # dd 磁盘操作
    r":(){ :|:& };:",          # Fork bomb
    # ...
}
```

### 7.4 YOLO 模式

```python
# 环境变量 HERMES_YOLO_MODE 在 import 时冻结
# 运行中无法修改（防止 prompt injection 绕过审批）
YOLO_MODE = os.environ.get("HERMES_YOLO_MODE", "").lower() == "true"
```

### 7.5 Prompt Injection 扫描

Memory 和 Skills 内容在加载到 system prompt 前会扫描：

```python
# tools/threat_patterns.py
INJECTION_PATTERNS = [
    "ignore previous instructions",
    "system prompt:",
    "]]>",          # CDATA 闭合
    "[INST]",       # Llama instruction tags
    "<|im_start|>", # ChatML tags
    # ...
]
```

---

## 八、高级特性

### 8.1 渐进式工具披露（Tool Search）

当 MCP/插件工具超过 context window 的 10% 时，非核心工具被 3 个桥接工具替代：

```
tool_search   → BM25 搜索工具目录（name + description + parameter names）
tool_describe → 加载指定工具的完整参数 schema
tool_call     → 调用延迟工具（路由通过标准 dispatch）
```

**设计保证**：
- 核心工具（`_HERMES_CORE_TOOLS`）**永不延迟**
- 桥接工具的路由通过标准 `handle_function_call` 路径，guardrails 全部生效
- 目录每轮重建，不与 session 绑定（避免 stale catalog bug）

### 8.2 子 Agent 委派（delegate_task）

```python
# tools/delegate_tool.py
class ChildAgentConfig:
    blocked_tools = [
        "delegate_task",    # 默认禁止递归（role='orchestrator' 可解除）
        "clarify", "memory", "send_message",
        "execute_code", "cronjob",
    ]
    max_spawn_depth = 1     # 默认平坦委派
    max_concurrent_children = 3
    subagent_auto_approve = False  # 子 Agent 审批：默认拒绝
```

**隔离机制**：
- 独立会话历史
- 独立 toolset 配置
- 独立 terminal session（`task_id` 隔离）
- 审批 callback 自动选择（非交互式 → auto-deny 或 auto-approve，防止死锁）

### 8.3 MCP 集成

```python
# tools/mcp_tool.py
# 连接模式：stdio / HTTP / SSE
# 架构：独立 daemon 线程运行 event loop，保持 MCP transport 上下文
# 工具注册：MCP server 工具注册到 mcp-{server_name} toolset
# 动态刷新：监听 notifications/tools/list_changed
# 重连：指数退避（上限 5 次）
```

---

## 九、对 Pure Agent 的启示

| Hermes 设计 | Pure Agent 借鉴程度 | 说明 |
|------------|-------------------|------|
| Toolset 分组 | ✅ 直接采纳 | 重构了 Phase 1 的 Registry 设计 |
| check_fn 探针 + TTL | 🔮 后期采纳 | 当前阶段不需要，但架构预留 |
| AST 自注册发现 | ❌ 不采纳 | TypeScript 显式 import 即可，AST 在 Python 中有意义 |
| Schema sanitizer | ✅ 直接采纳 | 设计为可扩展的 pipeline |
| Tool search 渐进披露 | 🔮 后期采纳 | 工具数量 <20 时不需要 |
| 3 层结果持久化 | ✅ 部分借鉴 | 已通过 tool-pruner.ts 实现 |
| 单例 Registry | ❌ 不采纳 | Pure Agent 用工厂函数，更利于测试和多 Agent 场景 |
| 手写 JSON Schema | ❌ 不采纳 | 考虑后期引入 Zod/Effect Schema 自动生成 |

---

## 十、关键文件索引

| 文件 | 行数 | 功能 |
|------|------|------|
| `tools/registry.py` | ~770 | 单例 ToolRegistry + ToolEntry + check_fn TTL 缓存 |
| `tools/tool_search.py` | ~750 | 渐进式工具披露（BM25 + bridge tools） |
| `tools/schema_sanitizer.py` | ~600 | 多 Provider JSON Schema 适配 |
| `tools/file_tools.py` | ~2,200 | 文件读写补丁搜索工具 |
| `tools/terminal_tool.py` | ~3,700 | Shell 终端 + 进程管理 |
| `tools/web_tools.py` | ~1,400 | Web 搜索 + 内容获取 |
| `tools/browser_tool.py` | ~5,600 | 浏览器自动化（Playwright + CDP） |
| `tools/delegate_tool.py` | ~4,200 | 子 Agent 委派 |
| `tools/mcp_tool.py` | ~6,700 | MCP 协议客户端（stdio/HTTP/SSE） |
| `tools/skills_tool.py` | ~1,750 | 技能管理 |
| `tools/approval.py` | ~4,000 | 危险命令检测 + 审批流 |
| `tool_result_storage.py` | ~250 | 3 层结果持久化 |
| `model_tools.py` | ~6,500 | LLM 交互层（get_definitions + dispatch + cache） |
| `toolsets.py` | ~1,500 | Toolset 组合与场景配置 |
