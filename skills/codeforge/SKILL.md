---
name: codeforge
description: "CodeForge 多语言 IDE 编译器：按扩展名识别语言、Lint(缩进/拼写/行长)、六语言构建(C/C++/C#/Rust/Python/Java)与调试桥。"
version: 0.1.0
author: monikalnbo
license: MIT
platforms: [linux, macos, windows]
prerequisites:
  commands: [python3]
metadata:
  codeforge:
    tags: [ide, compiler, lint, build, debugger, multi-language]
    homepage: https://github.com/monikalnbo/lnbocharm
    protocol: ARCHITECTURE.md v1（统一信封协议 + CF 错误码）
---

# CodeForge — 多语言 IDE 构建与检查核心

`codeforge-py` 是 CodeForge IDE 的核心引擎库（零第三方依赖，纯标准库）。
Agent 可直接用 CLI 或 import 两种方式使用。

Use this skill for:
- 按文件扩展名识别编程语言（含 `.h` 歧义消解、自定义语言注册）
- 对源码做 Lint：缩进混用(CF3001)/Python缩进层级(CF3002)/拼写可疑(CF3003)/行超长(CF3004)
- 生成六语言的编译/运行命令（Builder 插件），产出统一 BuildResult JSON
- 以插件方式扩展新检查器或新语言（放 `~/.codeforge/plugins/` 即生效）

所有错误都使用 `shared/error-codes.json` 定义的 CF 错误码，并带面向用户的 `hint`。

---

## CLI 用法

```bash
# 语言识别（输出 JSON）
python3 -m codeforge detect main.py [--hint cpp]

# Lint 一段源码（JSON 诊断数组，含 message+hint）
python3 -m codeforge lint --file a.py --lang python < a.py

# 生成构建命令预览（不执行）
python3 -m codeforge plan --file main.cpp

# 执行构建
python3 -m codeforge build --file main.cpp [--out /tmp/build]

# 导出语言注册表快照（供 JS 前端消费）
python3 -m codeforge registry > langregistry.json
```

## Python API 用法

```python
from codeforge.langdetect import detect_language
from codeforge.lint.engine import get_engine

info = detect_language("app.rs")            # -> {"name":"rust", ...}
engine = get_engine()
engine.load_builtin_checkers()              # 幂等；外部插件再 load_plugin_dir(dir)
diags = engine.run("a.py", text, language="python")
```

## 扩展开发（可拓展核心）

自定义检查器三步：

```python
# ~/.codeforge/plugins/my_checker.py
from codeforge.lint.base import Checker, checker, make_diagnostic

@checker
class TodoChecker(Checker):
    name = "todo"          # 唯一键
    rule = "CF3004"        # 必须是 shared/error-codes.json 里存在的码
    languages = []         # 空 = 全语言

    def check(self, filename, text, language=None, options=None):
        out = []
        for i, line in enumerate(text.splitlines(), 1):
            if "TODO" in line:
                out.append(make_diagnostic(self, filename, i, 1, "info",
                                           "发现 TODO", "尽快处理或转为任务"))
        return out
```

自定义语言两步：

```python
from codeforge.langdetect import get_registry
get_registry().register("kotlin", ext=[".kt"], monacoId="kotlin",
                        builder="kotlin", comment="//")
```

## 硬性规则（Agent 必读）

- **绝不**在 JS/前端硬编码语言表——一切以 `GET /api/languages` 下发的注册表为准
- 新增错误提示必须先加 `shared/error-codes.json`，两端禁止内联文案
- Checker.check() 不允许抛异常外泄、不做 IO、不修改输入文本
- Builder 只生成命令数组（execFile 风格），禁止拼 shell 字符串
