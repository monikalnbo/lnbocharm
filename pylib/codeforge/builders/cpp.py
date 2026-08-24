"""C++ 构建器：g++ -std=c++17 -g -O0 -Wall（带调试符号）。"""
from __future__ import annotations

import platform
from pathlib import Path
from typing import Dict, Optional

from .base import Builder, BuildPlan, builder


@builder
class CppBuilder(Builder):
    name = "cpp"
    toolchains = ["g++"]

    def plan(self, source: Path, out_dir: Path,
             tc: Dict[str, str], run_args: Optional[List[str]] = None) -> BuildPlan:
        out_dir.mkdir(parents=True, exist_ok=True)
        exe = out_dir / source.stem
        if platform.system() == "Windows":
            exe = exe.with_suffix(".exe")
        build_cmd = [tc["g++"], "-std=c++17", "-g", "-O0", "-Wall", "-Wextra",
                     str(source), "-o", str(exe)]
        run_cmd = [str(exe)] + list(run_args or [])
        return BuildPlan(language=self.name, build_cmd=build_cmd,
                         run_cmd=run_cmd, artifacts=[str(exe)])
