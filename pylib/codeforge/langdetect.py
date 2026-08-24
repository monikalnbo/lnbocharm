"""codeforge-py — 语言注册表与扩展名识别（单一事实来源）。

所有语言相关的元数据只在这里定义；JS 端通过 langregistry.json 快照消费。
支持运行时注册自定义扩展名（供第三方插件调用 register_language）。
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
import json
from pathlib import Path
from typing import Dict, List, Optional

# 内置语言注册表。新增语言 = 加一个条目 + 对应 Builder 插件。
BUILTIN_LANGUAGES: Dict[str, dict] = {
    "c": {
        "ext": [".c", ".h"],
        "monacoId": "c",
        "builder": "c",
        "comment": "//",
        "indent": 4,
        "debugAdapter": "gdb-dap",
        "toolchain": ["gcc"],
    },
    "cpp": {
        "ext": [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h"],
        "monacoId": "cpp",
        "builder": "cpp",
        "comment": "//",
        "indent": 4,
        "debugAdapter": "gdb-dap",
        "toolchain": ["g++"],
    },
    "csharp": {
        "ext": [".cs"],
        "monacoId": "csharp",
        "builder": "csharp",
        "comment": "//",
        "indent": 4,
        "debugAdapter": "netcoredbg",
        "toolchain": ["dotnet"],
    },
    "rust": {
        "ext": [".rs"],
        "monacoId": "rust",
        "builder": "rust",
        "comment": "//",
        "indent": 4,
        "debugAdapter": "lldb-dap",
        "toolchain": ["rustc", "cargo"],
    },
    "python": {
        "ext": [".py", ".pyw"],
        "monacoId": "python",
        "builder": "python",
        "comment": "#",
        "indent": 4,
        "debugAdapter": "debugpy",
        "toolchain": ["python3"],
    },
    "java": {
        "ext": [".java"],
        "monacoId": "java",
        "builder": "java",
        "comment": "//",
        "indent": 4,
        "debugAdapter": "jdwp",
        "toolchain": ["javac"],
    },
    "typescript": {
        # Node 运行时随桌面端内置（Electron 同款），tsc 由工具链包管理器按需装到 tools/
        "ext": [".ts", ".mts", ".cts"],
        "monacoId": "typescript",
        "builder": "typescript",
        "comment": "//",
        "indent": 2,
        "debugAdapter": "node-dap (js-debug)",
        "toolchain": ["node", "tsc"],
    },
    "javascript": {
        "ext": [".js", ".mjs", ".cjs"],
        "monacoId": "javascript",
        "builder": "typescript",   # 复用 node 构建器：直接运行
        "comment": "//",
        "indent": 2,
        "debugAdapter": "node-dap (js-debug)",
        "toolchain": ["node"],
    },
}

# .h 归属歧义：默认给 C，但若同目录存在 cpp 工程文件则归 C++（detect 时处理）
AMBIGUOUS_EXT = {".h": "c"}


@dataclass
class LanguageInfo:
    name: str
    ext: List[str]
    monacoId: str
    builder: str
    comment: str
    indent: int
    debugAdapter: str
    toolchain: List[str]
    custom: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


class LanguageRegistry:
    """语言注册表：内置 + 运行时注册（插件可扩展）。"""

    def __init__(self) -> None:
        self._by_name: Dict[str, LanguageInfo] = {}
        self._by_ext: Dict[str, str] = {}  # ext(lower) -> language name
        for name, meta in BUILTIN_LANGUAGES.items():
            # 内置表 .h 同时出现在 c/cpp：先到先得(c)，cpp 静默跳过，歧义由 resolve_ambiguous 处理
            self.register(name, on_ext_conflict="skip", **meta)

    def register(self, name: str, *, ext: List[str], monacoId: str,
                 builder: str, comment: str, indent: int = 4,
                 debugAdapter: str = "", toolchain: Optional[List[str]] = None,
                 custom: bool = False, overwrite: bool = False,
                 on_ext_conflict: str = "raise") -> None:
        """on_ext_conflict: raise(默认，插件用) | skip(静默跳过被占扩展名，内置表用)"""
        if not name or not ext:
            raise ValueError(f"register_language: name/ext 不能为空 (name={name!r})")
        if name in self._by_name and not overwrite:
            raise ValueError(f"register_language: 语言 {name} 已存在")
        for e in ext:
            e_low = e.lower()
            if not e_low.startswith("."):
                raise ValueError(f"register_language: 扩展名必须以点开头 ({e_low!r})")
            old = self._by_ext.get(e_low)
            if old and old != name:
                if on_ext_conflict == "skip":
                    continue
                raise ValueError(f"register_language: 扩展名 {e_low} 已被 {old} 占用")
            self._by_ext[e_low] = name
            self._by_ext[e_low] = name
        # 能力表保留全部声明扩展名；_by_ext 只是“默认认领”关系，歧义由 resolve_ambiguous 处理
        self._by_name[name] = LanguageInfo(
            name=name, ext=list(ext), monacoId=monacoId, builder=builder,
            comment=comment, indent=indent, debugAdapter=debugAdapter,
            toolchain=list(toolchain or []), custom=custom)

    def detect(self, filename: str) -> Optional[LanguageInfo]:
        """按文件名（扩展名）识别语言。识别失败返回 None，不抛异常。"""
        suffix = Path(filename).suffix.lower()
        if not suffix:
            return None
        lang = self._by_ext.get(suffix)
        if lang is None:
            return None
        info = self._by_name[lang]
        # .h 歧义消解：交给调用方上下文覆盖，这里保持默认
        return info

    def resolve_ambiguous(self, filename: str, context_hint: Optional[str] = None) -> Optional[LanguageInfo]:
        """.h 等歧义扩展名：context_hint 为 'cpp' 时优先 C++。"""
        info = self.detect(filename)
        if info is None:
            return None
        suffix = Path(filename).suffix.lower()
        if suffix in AMBIGUOUS_EXT and context_hint:
            alt = self._by_name.get(context_hint)
            if alt and suffix in [e.lower() for e in alt.ext]:
                return alt
        return info

    def get(self, name: str) -> Optional[LanguageInfo]:
        return self._by_name.get(name)

    def names(self) -> List[str]:
        return list(self._by_name.keys())

    def export_registry(self) -> dict:
        """导出 langregistry.json 结构（供 JS 消费）。"""
        return {n: i.to_dict() for n, i in self._by_name.items()}

    def dump_json(self, path: Path) -> None:
        path.write_text(json.dumps(self.export_registry(), ensure_ascii=False, indent=2), encoding="utf-8")


_default_registry: Optional[LanguageRegistry] = None


def get_registry() -> LanguageRegistry:
    global _default_registry
    if _default_registry is None:
        _default_registry = LanguageRegistry()
    return _default_registry


def detect_language(filename: str, context_hint: Optional[str] = None) -> Optional[dict]:
    reg = get_registry()
    info = reg.resolve_ambiguous(filename, context_hint)
    return info.to_dict() if info else None
