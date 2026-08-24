"""C# 构建器：.csproj 工程用 dotnet build；裸 .cs 文件给出明确指引(CF2001)。"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, Optional

from ..errors import CodeForgeError
from .base import Builder, BuildPlan, builder


@builder
class CSharpBuilder(Builder):
    name = "csharp"
    toolchains = ["dotnet"]

    def plan(self, source: Path, out_dir: Path,
             tc: Dict[str, str], run_args: Optional[List[str]] = None) -> BuildPlan:
        csproj = _find_csproj(source)
        if csproj is None:
            raise CodeForgeError(
                "CF2001",
                message="C# 需要 dotnet 工程（.csproj）才能构建",
                hint="在源文件同目录创建工程：dotnet new console；或把文件放入已有工程")
        dll_name = csproj.stem + ".dll"
        bin_dir = csproj.parent / "bin"
        build_cmd = [tc["dotnet"], "build", "-c", "Release",
                     "-o", str(out_dir), str(csproj)]
        run_cmd = [tc["dotnet"], str(out_dir / dll_name)] + list(run_args or [])
        return BuildPlan(language=self.name, build_cmd=build_cmd,
                         run_cmd=run_cmd, artifacts=[str(out_dir / dll_name)])


def _find_csproj(source: Path) -> Optional[Path]:
    for parent in [source.parent] + list(source.parents):
        hits = sorted(parent.glob("*.csproj"))
        if hits:
            return hits[0]
    return None
