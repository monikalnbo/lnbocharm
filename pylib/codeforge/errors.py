"""错误码注册表：shared/error-codes.json 是唯一来源。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional

_CACHE: Optional[Dict[str, dict]] = None


def _codes_path() -> Path:
    # pylib/codeforge/errors.py → 仓库根/shared/error-codes.json
    return Path(__file__).resolve().parent.parent.parent / "shared" / "error-codes.json"


def _load() -> Dict[str, dict]:
    global _CACHE
    if _CACHE is None:
        raw = json.loads(_codes_path().read_text(encoding="utf-8"))
        _CACHE = raw.get("codes", {})
    return _CACHE


class CodeForgeError(Exception):
    """带错误码的异常：message/hint 来自注册表，可覆盖补充。"""

    def __init__(self, code: str, message: str = "", hint: str = "",
                 details: Optional[dict] = None) -> None:
        meta = _load().get(code, {})
        self.code = code
        self.message = message or meta.get("message", code)
        self.hint = hint or meta.get("hint", "")
        self.severity = meta.get("severity", "error")
        self.details = details or {}
        super().__init__(f"[{code}] {self.message}")

    def to_dict(self) -> dict:
        return {"code": self.code, "severity": self.severity,
                "message": self.message, "hint": self.hint,
                "details": self.details}


def cf_error(code: str, message: str = "", hint: str = "") -> None:
    """记录/抛出一个错误码事件（stderr，避免污染 serve 模式的 stdout 协议流）。"""
    import sys
    err = CodeForgeError(code, message, hint)
    print(f"LOG {err.to_dict()}", file=sys.stderr, flush=True)


def get_meta(code: str) -> dict:
    return _load().get(code, {})


def all_codes() -> Dict[str, Any]:
    return _load()
