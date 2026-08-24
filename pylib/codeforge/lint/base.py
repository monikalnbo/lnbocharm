"""Lint 检查器插件抽象基类。

第三方扩展一个检查器只需三步：
1. 新建 py 文件放入 codeforge/checkers/（内置）或 ~/.codeforge/plugins/（外部）
2. 写一个继承 Checker 的类，实现 check()
3. 用 @checker 装饰器注册

诊断结构（与 ARCHITECTURE.md 第4节一致）：
    {"file","line","col","severity","rule","message","hint","source"}
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import List, Optional

SEVERITY_ERROR = "error"
SEVERITY_WARNING = "warning"
SEVERITY_INFO = "info"
_VALID_SEV = {SEVERITY_ERROR, SEVERITY_WARNING, SEVERITY_INFO}

#: 待注册队列：@checker 装饰的类暂存于此，由 LintEngine 加载模块后收刈
PENDING: List[Checker] = []


def checker(cls):
    """类装饰器：实例化并加入待注册队列。

    用法：
        @checker
        class MyChecker(Checker):
            name = "my"
            rule = "CF3004"
            def check(self, ...): ...
    """
    if not issubclass(cls, Checker):
        raise TypeError("@checker 只能用于 Checker 子类")
    PENDING.append(cls())
    return cls


@dataclass
class Diagnostic:
    file: str
    line: int          # 1-based
    col: int           # 1-based
    severity: str      # error | warning | info
    rule: str          # 错误码，如 CF3001；必须存在于 shared/error-codes.json
    message: str
    hint: str = ""
    source: str = "codeforge-py"

    def to_dict(self) -> dict:
        return self.__dict__.copy()


class Checker(ABC):
    """检查器基类。子类必须设置 name 与 rule。"""

    #: 唯一短名（注册键），如 "indentation"
    name: str = ""
    #: 使用的错误码（CFxxxx）
    rule: str = ""
    #: 支持的语言；空列表 = 对所有语言生效
    languages: List[str] = []

    def supports(self, language: Optional[str]) -> bool:
        return not self.languages or (language in self.languages)

    @abstractmethod
    def check(self, filename: str, text: str, language: Optional[str] = None,
              options: Optional[dict] = None) -> List[Diagnostic]:
        """对一段源码文本做检查，返回诊断列表（可为空）。不得抛异常外泄。"""


def make_diagnostic(checker: Checker, file: str, line: int, col: int,
                    severity: str, message: str, hint: str = "",
                    rule: Optional[str] = None) -> Diagnostic:
    if severity not in _VALID_SEV:
        severity = SEVERITY_WARNING
    return Diagnostic(file=file, line=max(1, line), col=max(1, col),
                      severity=severity, rule=rule or checker.rule or "CF0000",
                      message=message, hint=hint, source="codeforge-py")
