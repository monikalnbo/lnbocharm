"""行长度检查器(CF3004)。默认上限 120，可按语言/用户设置覆盖。"""
from __future__ import annotations

from typing import List, Optional

from ..lint.base import Checker, checker, make_diagnostic


@checker
class LineLengthChecker(Checker):
    name = "line_length"
    rule = "CF3004"
    languages = []

    def check(self, filename, text, language=None, options=None) -> List:
        options = options or {}
        max_len = int(options.get("max", 120))
        diags: List = []
        for idx, line in enumerate(text.splitlines(), 1):
            width = len(line.expandtabs(4))  # Tab 按 4 列计
            if width > max_len:
                diags.append(make_diagnostic(
                    self, filename, idx, max_len + 1, "info",
                    f"第 {idx} 行超长（{width} > {max_len}）",
                    hint="建议拆分表达式或换行；可在设置中调整最大行长"))
        return diags
