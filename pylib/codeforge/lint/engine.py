"""Lint 引擎：检查器注册、插件自动发现、统一执行入口。"""
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import traceback
from typing import Dict, List, Optional

from .base import Checker, Diagnostic, PENDING
from ..errors import cf_error  # 统一错误构造


class LintEngine:
    def __init__(self) -> None:
        self._checkers: Dict[str, Checker] = {}

    # ---------- 注册 ----------
    def register(self, checker: Checker, replace: bool = False) -> None:
        key = getattr(checker, "name", "")
        if not key:
            raise ValueError("checker.name 不能为空")
        if key in self._checkers and not replace:
            raise ValueError(f"checker {key} 已注册（如需覆盖传 replace=True）")
        self._checkers[key] = checker

    def unregister(self, name: str) -> None:
        self._checkers.pop(name, None)

    def names(self) -> List[str]:
        return list(self._checkers.keys())

    # ---------- 插件发现 ----------
    def load_builtin_checkers(self) -> List[str]:
        """加载 codeforge/checkers/ 下全部内置检查器模块。"""
        pkg_dir = Path(__file__).resolve().parent.parent / "checkers"
        return self._load_dir(pkg_dir)

    def load_plugin_dir(self, plugin_dir: Path) -> List[str]:
        """加载外部插件目录（~/.codeforge/plugins/）。失败降级不中断，返回错误列表。"""
        return self._load_dir(Path(plugin_dir), external=True)

    def _load_dir(self, directory: Path, external: bool = False) -> List[str]:
        loaded: List[str] = []
        if not directory.is_dir():
            return loaded
        for py in sorted(directory.glob("*.py")):
            if py.name.startswith("_"):
                continue
            mod_name = f"codeforge.{'ext_plugins' if external else 'checkers'}.{py.stem}"
            try:
                spec = importlib.util.spec_from_file_location(mod_name, py)
                module = importlib.util.module_from_spec(spec)
                before_pending = len(PENDING)
                sys.modules[mod_name] = module
                spec.loader.exec_module(module)  # 模块顶层 @checker 自动入队
                new = PENDING[before_pending:]
                del PENDING[before_pending:]
                registered_here: List[str] = []
                for inst in new:
                    if inst.name in self._checkers:
                        # 重复加载同一插件：替换而非报错（幂等）
                        self._checkers[inst.name] = inst
                        registered_here.append(inst.name)
                        continue
                    try:
                        self.register(inst)
                        registered_here.append(inst.name)
                    except ValueError as exc:
                        cf_error("CF0001", message=f"插件 {py.name} 的检查器 {inst.name!r} 注册被拒",
                                 hint=str(exc))
                loaded.extend(registered_here or [f"{py.stem}(无注册检查器)"])
            except Exception as exc:  # 插件失败降级：CF0001，含 traceback 摘要
                detail = f"{type(exc).__name__}: {exc}"
                tb_last = traceback.format_exc().strip().splitlines()[-1]
                cf_error("CF0001", message=f"插件 {py.name} 加载失败",
                         hint=f"{detail} | {tb_last}")
        return loaded

    # ---------- 执行 ----------
    def run(self, filename: str, text: str, language: Optional[str] = None,
            options: Optional[dict] = None,
            enabled: Optional[List[str]] = None) -> List[Diagnostic]:
        """跑全部适用检查器；单个检查器异常不影响其他检查器。"""
        options = options or {}
        diagnostics: List[Diagnostic] = []
        for name, checker in sorted(self._checkers.items()):
            if enabled is not None and name not in enabled:
                continue
            if not checker.supports(language):
                continue
            try:
                diags = checker.check(filename, text, language=language,
                                      options=options.get(name, {}))
                diagnostics.extend(diags or [])
            except Exception as exc:
                cf_error("CF0001", message=f"检查器 {name} 执行失败",
                         hint=f"{type(exc).__name__}: {exc}")
        diagnostics.sort(key=lambda d: (d.line, d.col))
        return diagnostics


_engine: Optional[LintEngine] = None


def get_engine() -> LintEngine:
    global _engine
    if _engine is None:
        _engine = LintEngine()
    return _engine


def lint_text(filename: str, text: str, language: Optional[str] = None,
              options: Optional[dict] = None,
              plugin_dirs: Optional[List[Path]] = None) -> List[Diagnostic]:
    """便捷入口：初始化内置+外部插件后执行检查（幂等，可重复调用）。"""
    engine = get_engine()
    if not engine.names():
        engine.load_builtin_checkers()
        for d in (plugin_dirs or []):
            engine.load_plugin_dir(Path(d).expanduser())
    return engine.run(filename, text, language=language, options=options)
