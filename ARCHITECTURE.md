# CodeForge（lnbocharm）架构与内部协议 v1

> 单一事实来源。所有模块实现必须遵守本文协议；改协议先改这里。
> 设计原则：**模块化可独立修复审查；错误分类分级，不同错误不同提示。**

## 1. 总体架构

```
┌─────────────────────────── Electron 桌面应用 ───────────────────────────┐
│  Renderer (Vue3 + Vite)          │  Main (Node.js)                      │
│  ├─ MonacoEditor(六语言)         │  ├─ ipc/*  ← 统一信封协议             │
│  ├─ XtermView(本地终端)          │  ├─ localBuilder(child_process)      │
│  ├─ ProblemsPanel                │  ├─ localPty(node-pty)               │
│  ├─ BuildPanel                   │  └─ workspaceFs(主进程独占)           │
│  └─ DebugBar                     │                                      │
└──────────────┬────────────────────────────┬────────────────────────────┘
               │ IPC (renderer↔main)        │ WebSocket / REST
               ▼                            ▼
      本机工具链(gcc/rustc/...)     ┌── Remote Build Server (可选部署) ──┐
      codeforge-py CLI(JSON)        │ Express REST + WS(同一信封协议)     │
                                    │ services: builder/lint/terminal    │
                                    │ docker 工具链容器池                 │
                                    └────────────────────────────────────┘
```

## 2. 模块边界（谁拥有什么，禁止越界）

| 模块 | 拥有 | 禁止 |
|---|---|---|
| `pylib/codeforge` | 语言注册表、Lint 引擎+检查器、Builder 插件、CLI | 不碰网络、不碰文件系统写操作 |
| `backend/src/routes` | HTTP 参数校验、调用 service | 不含业务逻辑（薄路由） |
| `backend/src/services` | 全部业务行为 | 不直接读 req/res |
| `frontend/src/components` | 视图与交互 | 不自己判断语言/不拼编译命令，一切以协议返回为准 |
| `desktop/main` | 本机构建执行、本地 PTY、文件对话框 | 不解析代码语义 |

规则：语言相关的任何逻辑只存在于 pylib（运行时）与其生成的 `langregistry.json`（供 JS 消费的快照）。JS 端零硬编码语言表。

## 3. 统一消息信封（IPC / WS / Agent 三通道共用）

```jsonc
// 请求
{ "v": 1, "id": "u1", "type": "build.start", "payload": { "file": "main.py", "mode": "local" } }
// 响应/事件：type 相同命名空间，ok=false 时必带 error
{ "v": 1, "id": "u1", "type": "build.output", "payload": { "chunk": "..." }, "ok": true }
{ "v": 1, "id": "u2", "type": "build.result", "payload": { "...": "" }, "ok": false,
  "error": { "code": "CF2003", "message": "未找到 rustc", "hint": "安装 Rust 或在设置中指定工具链路径" } }
```

### 命名空间
- `file.*` open/save/tree/create/rename/delete
- `lint.*` request → diagnostics
- `build.*` start/cancel/output/result/modes
- `term.*` create/input/resize/output/exit
- `debug.*` start/breakpoints/output/stopped/exited（透传 DAP）
- `agent.*` register/exec/result（本机 Agent 与服务器间）

## 4. 错误分类与提示规范（不同错误不同提示）

错误码五段式 `CF<类别><序号>`，支持**参数化 hint 插槽**（如 `{toolchain}`、`{timeout}s`），每个码必须配 `hint`（面向用户的修复建议），前端按 severity 分色展示：

| 类别 | 码段 | 示例 |
|---|---|---|
| 文件系统 | CF1xxx | `CF1001 文件不存在` hint:"检查路径或刷新文件树" |
| 构建/工具链 | CF2xxx | `CF2001 编译失败`(带行号跳转)、`CF2002 超时`、`CF2003 工具链缺失`(hint 附安装命令) |
| Lint 诊断 | CF3xxx | `CF3001 缩进混用`、`CF3002 Python 缩进层级`、`CF3003 拼写可疑`、`CF3004 行超长` |
| 调试 | CF4xxx | `CF4001 断点未绑定`(hint:"目标未编译出调试符号，加 -g")、`CF4002 适配器缺失` |
| Agent/连接 | CF5xxx | `CF5001 本地 Agent 未运行`(hint:"启动桌面端即自动运行")、`CF5002 版本不匹配` |
| 终端 | CF6xxx | `CF6001 PTY 创建失败` |

severity 三级：`error`红 / `warning`黄 / `info`蓝。诊断对象统一：
```jsonc
{ "file":"a.py","line":3,"col":1,"severity":"error","rule":"CF3002",
  "message":"缩进层级错误","hint":"此行应比上一行多缩进 4 个空格","source":"codeforge-py" }
```

## 5. 语言注册表（唯一事实来源）

pylib 启动时聚合内置 + 用户插件，导出 `langregistry.json`：

```jsonc
{
  "python": { "ext":[".py"], "monacoId":"python", "builder":"python",
              "comment":"#", "indent":4, "debugAdapter":"debugpy" },
  "cpp":    { "ext":[".cpp",".cc",".hpp",".h"], "monacoId":"cpp", "builder":"cpp",
              "comment":"//", "indent":4, "debugAdapter":"gdb-dap" }
  // c / csharp / rust / java ...
}
```

REST `GET /api/languages` 直接下发该 JSON；前端 Monaco 配置、图标、构建模式全部由此驱动。

## 6. 构建三模式

| 模式 | 执行位置 | 通道 |
|---|---|---|
| `local` | Electron 主进程 child_process | IPC `build.*` |
| `server` | 远程服务器原生工具链 | WS `build.*` |
| `docker` | 服务器上按语言选容器 | WS `build.*` |

三种模式产出同一个 `BuildResult`：`{ ok, cmd, exitCode, output[], durationMs, diagnostics[] }`。

### 工具链分发（服务器托管 + 一键补拉）

所有工具链压缩包**在服务器上存一份**，桌面端按需拉取：

- `GET /api/toolchains` → 清单：`[{id, version, platform, size, sha256, url}]`
- `GET /api/toolchains/:id/download` → 便携压缩包（tar.zst/zip），下载后校验 SHA256 → 解压到 `tools/<toolchain>/<version>/` → 注册进 PATH
- **一键补拉流程**：构建报 CF2003（缺工具链）→ 前端弹出"一键下载安装"按钮 → 从服务器拉包安装 → 自动重跑构建；下载进度走 WS `toolchain.progress`

## 7. 插件扩展点（codeforge-py）

- Lint 检查器：继承 `Checker`，用 `@checker("name")` 注册，放入 `checkers/` 或用户 `plugins/`
- Builder：继承 `Builder`，按注册表 builder 名绑定新语言
- 插件目录：`~/.codeforge/plugins/*.py` 自动发现加载，加载失败降级并报 `CF0001 插件加载失败`（含 traceback 摘要）

## 8. 内置加速器（服务器转发中继）

```
内嵌浏览器/系统代理 ──► 本地代理(127.0.0.1:7788 HTTP CONNECT/SOCKS5)
                          │ WS 二进制隧道(proxy.tunnel, 同一鉴权)
                          ▼
                    远程服务器转发出口 ──► github.com / x.com / ...
```

- 桌面端启动本地混合代理；隧道 WS 帧格式：`[4B 目标地址长度][目标地址][payload]`
- 内嵌浏览器面板用独立 session 绑定该代理，预设 GitHub/X 入口
- 错误码 CF7xxx：CF7001 隧道未连接 / CF7002 目标被拒 / CF7003 鉴权失败

## 8. LSP 层（智能补全与语法诊断核心）

自研检查器只覆盖浅层规则（缩进/拼写/行长）；**符号级补全与语法级诊断必须走语言服务器**：

```
Renderer(Monaco) ──统一信封(WS/IPC)──► LspManager
                                         ├─ clangd        (c/cpp)
                                         ├─ rust-analyzer (rust)
                                         ├─ jdt.ls        (java)
                                         ├─ pyright       (python)
                                         ├─ OmniSharp     (csharp)
                                         └─ 池化/按项目启停/空闲回收
```

- `lsp.start {language, root}` → 返回能力集；`lsp.completion` / `lsp.diagnostics` 双向代理
- LSP 诊断与自研诊断在 ProblemsPanel 合并展示，source 字段区分（`clangd` vs `codeforge-py`）
- 工具链缺失 → CF2003 参数化提示（含检测到的平台与安装命令）

## 9. 常驻 worker 协议（pylib serve 模式）

消除每请求起 Python 进程的开销：

```jsonc
// stdin/stdout，每行一个 JSON（行协议）
{"v":1,"id":"r1","op":"lint","args":{"file":"a.py","text":"...","lang":"python"}}
{"v":1,"id":"r1","ok":true,"result":{"diagnostics":[...]}}
{"v":1,"id":"ping","op":"ping"}          // 健康检查
```

- backend 为每个工作区长驻一个 worker 子进程，崩溃自动重启（≤3 次/分钟，超出报 CF5003）
- 引擎内部加锁，保证单 worker 内串行（避免线程安全问题）

## 10. 版本握手

WS/IPC/Agent 连接建立后第一帧必须为：

```jsonc
{"v":1,"id":"hello","type":"hello","payload":{"client":"desktop|agent","version":"0.1.0"}}
```

服务端回 `hello.ok` 或 `hello.mismatch`（CF5002）。未握手的连接 10s 后踢除。

## 11. 技术栈锁定

Electron 33 · Vue3 + Vite · Monaco Editor · xterm.js + node-pty · Express + ws · Python ≥3.10（pylib 零三方依赖，标准库实现）· pytest
