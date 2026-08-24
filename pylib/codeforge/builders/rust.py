"""Rust 构建器：单文件用 rustc；Cargo 工程(Cargo.toml)自动切换 cargo build。"""
from __future__ import annotations

import platform
from pathlib import Path
from typing import Dict, Optional

from .base import Builder, BuildPlan, builder


@builder
class RustBuilder(Builder):
    name = "rust"
    toolchains = ["rustc"]

    def preflight(self, extra_paths=None, _which=None):
        # Cargo 工程还需要 cargo；此处宽松处理，plan 阶段按工程形态再检
        tcs = {"rustc": None}
        from .base import find_toolchain
        tcs["rustc"] = find_toolchain("rustc", extra_paths, _which=_which)
        try:
            tcs["cargo"] = find_toolchain("cargo", extra_paths, _which=_which)
        except Exception:
            tcs["cargo"] = ""
        return tcs

    def plan(self, source: Path, out_dir: Path,
             tc: Dict[str, str], run_args: Optional[List[str]] = None) -> BuildPlan:
        cargo_toml = source.parent / "Cargo.toml"
        if cargo_toml.is_file():
            assert tc.get("cargo"), "Cargo 工程缺少 cargo"
            build_cmd = [tc["cargo"], "build", "--release", "--manifest-path",
                         str(cargo_toml)]
            exe_name = "target/release/" + source.stem
            run_cmd = [str(source.parent / exe_name)] + list(run_args or [])
            return BuildPlan(language=self.name, build_cmd=build_cmd,
                             run_cmd=run_cmd, artifacts=[str(source.parent / exe_name)])
        out_dir.mkdir(parents=True, exist_ok=True)
        exe = out_dir / source.stem
        if platform.system() == "Windows":
            exe = exe.with_suffix(".exe")
        build_cmd = [tc["rustc"], "-g", "-O0", str(source), "-o", str(exe)]
        run_cmd = [str(exe)] + list(run_args or [])
        return BuildPlan(language=self.name, build_cmd=build_cmd,
                         run_cmd=run_cmd, artifacts=[str(exe)])
