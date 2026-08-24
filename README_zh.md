# CodeForge（lnbocharm）

<p align="center"><b>多语言桌面 IDE 编译器 — C / C++ / C# / Rust / Python / Java / TypeScript。</b><br/>
本机或服务器构建、LSP 智能补全、可插拔 Lint、断点调试、集成终端。<br/>
零 API key。绿色便携 zip，解压即用。
</p>

---

## 架构

```
┌────────────────────────── Electron 桌面应用 ──────────────────────────────┐
│  渲染层 (Vue3 + Monaco + xterm.js)      │  主进程 (Node)                  │
│  编辑器 · 问题面板 · 构建 · 终端          │  IPC：本机构建 / 本地 PTY        │
└───────────────┬─────────────────────────┴──────────────┬────────────────┘
                │ 统一信封协议 v1                         │ 子进程
                ▼                                        ▼
     ┌── 远程构建服务器（可选部署） ──┐        本机工具链（gcc/rustc/javac/
     │ REST /api/*  ·  WS /ws       │        dotnet/node+tsc…）
     │ builder · lint · LSP池 · 中继 │
     └──────────────────────────────┘
```

完整规范见 [`ARCHITECTURE.md`](ARCHITECTURE.md)：统一消息信封、错误码注册表
（`CFxxxx` 带参数化提示）、模块所有权规则、LSP 层、常驻 worker 协议。

## 功能总览

| 领域 | 能力 |
| --- | --- |
| 语言注册表 | 扩展名→语言映射单一事实来源（codeforge-py），导出快照供 JS 消费；`.h` 歧义消解；支持注册自定义语言 |
| Lint 引擎 | `@checker` 插件化；内置：缩进混用 CF3001、Python 缩进层级 CF3002、拼写可疑 CF3003、行超长 CF3004、行尾空白 CF3005；外部插件放 `~/.codeforge/plugins/` 自动发现 |
| 构建器 | 7 个构建器只生成 **argv 数组**（禁止 shell 字符串防注入）：gcc/g++ 默认 `-g` 调试构建、rustc↔cargo 自适应、javac/java、dotnet csproj、tsc+sourceMap |
| 构建模式 | `local`（桌面 IPC）· `server`（WS 流式输出）· `docker`(工具链容器池)；支持取消、超时 CF2002、队列 CF2004、尾部截断输出 |
| LSP | clangd / rust-analyzer / jdtls / pyright / omnisharp / typescript-language-server 池化管理、补全代理、诊断转发、空闲回收 |
| 集成终端 | node-pty 会话经 WS：数量上限、环形缓冲回放、空闲回收 |
| 工具链分发 | 托管在自己的服务器：清单 `/api/toolchains` + SHA256 校验下载 + 一键安装后自动重跑构建 |
| 错误体系 | 每个失败都带错误码+人类可读提示，注册表由 Python 与 JS 两端共享 |

## 快速开始

### 浏览器模式

```bash
git clone https://github.com/monikalnbo/lnbocharm.git && cd lnbocharm
cd frontend && npm i && npm run build && cd ..
cd backend && npm i && npm start          # http://localhost:8787
```

打开页面 → 左侧树点开文件 → 点 ▶ 运行。

### 桌面应用

```bash
cd desktop && npm i && npm start           # 开发模式（需先构建 frontend/dist）
npm run dist                               # 各平台绿色 zip
```

### 服务器全家桶（含工具链容器）

```bash
docker compose up -d                       # 后端 + 工具链容器池
```

## 插件开发（拓展核心）

```python
# ~/.codeforge/plugins/todo.py
from codeforge.lint.base import Checker, checker, make_diagnostic

@checker
class Todo(Checker):
    name = "todo"; rule = "CF3004"; languages = []
    def check(self, filename, text, language=None, options=None):
        return [make_diagnostic(self, filename, i, 1, "info", "发现 TODO", "尽快处理")
                for i, l in enumerate(text.splitlines(), 1) if "TODO" in l]
```

自定义语言：`get_registry().register("kotlin", ext=[".kt"], ...)` ——
详见 [`skills/codeforge/SKILL.md`](skills/codeforge/SKILL.md)。

## 测试

```bash
python3 -m pytest tests/ -q        # 引擎：45 项
cd backend && npm test             # 服务器：25 项
```

## 许可证

MIT
