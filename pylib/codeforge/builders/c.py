"""C 构建器：gcc -g -O0 -Wall（默认带调试符号，配合断点）。"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional

from .base import Builder, BuildPlan, builder


@builder
class CBuilder(Builder):
    name = "c"
    toolchains = ["gcc"]

    def plan(self, source: Path, out_dir: Path,
             tc: Dict[str, str], run_args: Optional[List[str]] = None) -> BuildPlan:
        out_dir.mkdir(parents=True, exist_ok=True)
        exe = out_dir / source.stem
        if platform_windows():
            exe = exe.with_suffix(".exe")
        build_cmd = [tc["gcc"], "-g", "-O0", "-Wall", "-Wextra",
                     str(source), "-o", str(exe)]
        run_cmd = [str(exe)] + list(run_args or [])
        return BuildPlan(language=self.name, build_cmd=build_cmd,
                         run_cmd=run_cmd, artifacts=[str(exe)])


def platform_windows() -> bool:
    import platform as _p
    return _p.system() == "Windows"
