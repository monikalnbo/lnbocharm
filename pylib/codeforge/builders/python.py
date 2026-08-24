"""Python 构建器：编译期做语法检查（py_compile），运行直接解释执行。"""
from __future__ import annotations

from pathlib import Path
import sys
from typing import Dict, Optional

from .base import Builder, BuildPlan, builder


@builder
class PythonBuilder(Builder):
    name = "python"
    toolchains = ["python3"]

    def plan(self, source: Path, out_dir: Path,
             tc: Dict[str, str], run_args: Optional[List[str]] = None) -> BuildPlan:
        py = tc.get("python3", sys.executable)
        out_dir.mkdir(parents=True, exist_ok=True)
        pycache = out_dir / "__pycache__" / (source.stem + ".cpython.pyc")
        build_cmd = [py, "-m", "py_compile", str(source)]   # 语法检查即"编译"
        run_cmd = [py] + [str(source)] + list(run_args or [])
        return BuildPlan(language=self.name, build_cmd=build_cmd,
                         run_cmd=run_cmd, artifacts=[str(pycache.parent)])
