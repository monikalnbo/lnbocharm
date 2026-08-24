"""Java 构建器：javac -d 输出目录，运行 java -cp。"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional

from .base import Builder, BuildPlan, builder


@builder
class JavaBuilder(Builder):
    name = "java"
    toolchains = ["javac"]

    def plan(self, source: Path, out_dir: Path,
             tc: Dict[str, str], run_args: Optional[List[str]] = None) -> BuildPlan:
        out_dir.mkdir(parents=True, exist_ok=True)
        build_cmd = [tc["javac"], "-d", str(out_dir), str(source)]
        # 无 package 声明的单文件：类名=文件名
        run_cmd = [tc["javac"].replace("javac", "java"), "-cp", str(out_dir),
                   source.stem] + list(run_args or [])
        return BuildPlan(language=self.name, build_cmd=build_cmd,
                         run_cmd=run_cmd, artifacts=[str(out_dir / (source.stem + ".class"))])
