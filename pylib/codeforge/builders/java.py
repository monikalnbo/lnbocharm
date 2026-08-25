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
        # package 声明感知：com.x.Main 这样的全限定类名
        fqcn = source.stem
        try:
            import re as _re
            m2 = _re.search(r'^\s*package\s+([\w.]+)\s*;',
                            source.read_text(encoding="utf-8"), _re.M)
            if m2:
                fqcn = m2.group(1).strip() + "." + source.stem
        except OSError:
            pass
        run_cmd = [tc["javac"].replace("javac", "java"), "-cp", str(out_dir),
                   fqcn] + list(run_args or [])
        return BuildPlan(language=self.name, build_cmd=build_cmd,
                         run_cmd=run_cmd, artifacts=[str(out_dir / (source.stem + ".class"))])
