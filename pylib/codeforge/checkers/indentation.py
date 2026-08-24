"""缩进检查器：混用空格/Tab(CF3001)、Python 缩进层级错误(CF3002)。"""
from __future__ import annotations

import ast
from typing import List, Optional

from ..lint.base import Checker, checker, make_diagnostic


@checker
class IndentationChecker(Checker):
    name = "indentation"
    rule = "CF3001"           # 主规则码；Python 层级错误单独发 CF3002
    languages = []            # 全语言生效（层级检查仅 Python 触发）

    def check(self, filename, text, language=None, options=None) -> List:
        options = options or {}
        diags: List = []
        lines = text.splitlines()
        for idx, line in enumerate(lines, 1):
            stripped = line.lstrip()
            if not stripped or stripped.startswith(self._comment_prefix(language)):
                continue
            lead = line[: len(line) - len(stripped)]
            if " " in lead and "\t" in lead:
                col = len(lead) + 1
                diags.append(make_diagnostic(
                    self, filename, idx, col, "warning",
                    f"第 {idx} 行缩进混用了空格与 Tab",
                    hint="统一改为空格缩进；可在设置中开启保存时自动转换"))
            if line != line.rstrip():
                col = len(line.rstrip()) + 1
                diags.append(make_diagnostic(
                    self, filename, idx, col, "info",
                    f"第 {idx} 行行尾有多余空白",
                    hint="删除行尾空格；可开启保存时自动清理"))

        if language == "python":
            diags.extend(self._python_indent_errors(filename, text))
        return diags

    def _python_indent_errors(self, filename: str, text: str) -> List:
        try:
            ast.parse(text)
        except IndentationError as exc:
            return [make_diagnostic(
                self, filename, exc.lineno or 1, (exc.offset or 0) + 1, "error",
                f"缩进层级错误：{exc.msg}",
                hint="此行的缩进量不符合语法要求的层级关系；检查上一行的块结构",
                rule="CF3002")]
        except SyntaxError:
            pass  # 非缩进类语法错误不属于本检查器职责
        return []

    @staticmethod
    def _comment_prefix(language: Optional[str]) -> str:
        return {"python": "#", "rust": "//", "c": "//", "cpp": "//",
                "csharp": "//", "java": "//"}.get(language or "", "#")
