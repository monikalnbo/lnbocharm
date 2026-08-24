"""TypeScript/JavaScript 构建器：.js 直接 node 运行；.ts 先 tsc 编译。

node 运行时随桌面端内置；tsc 由工具链管理器提供。
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, Optional

from .base import Builder, BuildPlan, builder


@builder
class TypeScriptBuilder(Builder):
    name = "typescript"
    toolchains = ["node"]

    def plan(self, source: Path, out_dir: Path,
             tc: Dict[str, str], run_args: Optional[List[str]] = None) -> BuildPlan:
        out_dir.mkdir(parents=True, exist_ok=True)
        if source.suffix.lower() in (".js", ".mjs", ".cjs"):
            run_cmd = [tc["node"], str(source)] + list(run_args or [])
            return BuildPlan(language="javascript", build_cmd=None,
                             run_cmd=run_cmd)
        tsc = tc.get("tsc")
        assert tsc, "缺少 tsc"
        js_out = out_dir / (source.stem + ".js")
        build_cmd = [tsc, str(source), "--target", "es2020", "--module", "commonjs",
                     "--outDir", str(out_dir), "--sourceMap"]
        run_cmd = [tc["node"], str(js_out)] + list(run_args or [])
        return BuildPlan(language=self.name, build_cmd=build_cmd,
                         run_cmd=run_cmd, artifacts=[str(js_out)])
