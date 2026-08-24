"""Builder 抽象基类与注册表。

设计约束（ARCHITECTURE.md）：
- 只生成**命令数组**（execFile 风格），禁止拼 shell 字符串——防注入
- 三模式（local/server/docker）共用同一套 plan() 输出
- 工具链缺失抛 CodeForgeError("CF2003")，hint 带参数化安装命令
"""
from __future__ import annotations

import platform
import shutil
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

from ..errors import CodeForgeError

#: 安装提示表：工具名 -> 各平台安装命令（CF2003 hint 参数化用）
INSTALL_HINTS: Dict[str, Dict[str, str]] = {
    "gcc":    {"linux": "sudo apt install gcc", "darwin": "brew install gcc",
               "win32": "winget install BrechtSanders.WinLibs 或下载 winlibs.com"},
    "g++":    {"linux": "sudo apt install g++", "darwin": "brew install gcc",
               "win32": "winget install BrechtSanders.WinLibs"},
    "rustc":  {"linux": "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
               "darwin": "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
               "win32": " winget install Rustlang.Rustup"},
    "cargo":  {"linux": "同 rustc（rustup 自带）", "darwin": "同 rustc（rustup 自带）",
               "win32": "同 rustc（rustup 自带）"},
    "javac":  {"linux": "sudo apt install default-jdk", "darwin": "brew install openjdk",
               "win32": "winget install Microsoft.OpenJDK.21"},
    "dotnet": {"linux": "见 https://dot.net/download", "darwin": "brew install dotnet-sdk",
               "win32": "winget install Microsoft.DotNet.SDK.8"},
    "tsc":    {"linux": "npm install -g typescript（或由应用内置）",
               "darwin": "npm install -g typescript（或由应用内置）",
               "win32": "npm install -g typescript（或由应用内置）"},
    "node":   {"linux": "桌面端已内置；或 https://nodejs.org", "darwin": "桌面端已内置；或 brew install node",
               "win32": "桌面端已内置；或 winget install OpenJS.NodeJS.LTS"},
}


def _platform_key() -> str:
    return {"Windows": "win32", "Darwin": "darwin"}.get(platform.system(), "linux")


@dataclass
class BuildPlan:
    """一次构建的完整计划。commands 为 execFile 风格参数数组。"""
    language: str
    build_cmd: Optional[List[str]] = None      # 编译命令（None=解释型无需编译）
    run_cmd: Optional[List[str]] = None        # 运行命令
    artifacts: List[str] = field(default_factory=list)  # 预期产物路径


def find_toolchain(tool: str, extra_paths: Optional[List[Path]] = None,
                   _which=shutil.which) -> str:
    """定位工具链可执行文件：设置路径 > 应用内 tools/ > PATH。

    找不到抛 CF2003（message/hint 参数化）。_which 参数供测试注入。
    """
    for base in (extra_paths or []):
        cand = Path(base) / tool
        if cand.is_file():
            return str(cand)
        if platform.system() != "Windows":
            continue
    found = _which(tool)
    if found:
        return found
    raise CodeForgeError(
        "CF2003",
        message=f"未找到 {tool}",
        hint="未找到 {toolchain}。安装命令：{install}",
        details={"toolchain": tool,
                 "install": INSTALL_HINTS.get(tool, {}).get(_platform_key(), "查看官网")})


class Builder(ABC):
    """语言构建器基类。子类通过 @builder 注册。"""

    #: 对应 langregistry 的 builder 名
    name: str = ""
    #: 声明依赖的工具链名（用于预检与缺失提示）
    toolchains: List[str] = []

    @abstractmethod
    def plan(self, source: Path, out_dir: Path,
             tc: Dict[str, str], run_args: Optional[List[str]] = None) -> BuildPlan:
        """生成构建计划。tc 为 工具名->可执行路径 映射（已解析好）。"""

    def preflight(self, extra_paths: Optional[List[Path]] = None,
                  _which=shutil.which) -> Dict[str, str]:
        """预检全部工具链，返回 工具名->路径；任一缺失即抛 CF2003。"""
        return {t: find_toolchain(t, extra_paths, _which=_which) for t in self.toolchains}


_BUILDER_CLASSES: List[type] = []


def builder(cls):
    """类装饰器：登记 Builder 子类（模块加载时收集，由注册表收割）。"""
    if not issubclass(cls, Builder):
        raise TypeError("@builder 只能用于 Builder 子类")
    _BUILDER_CLASSES.append(cls)
    return cls


class BuilderRegistry:
    def __init__(self) -> None:
        self._builders: Dict[str, Builder] = {}

    def register(self, inst: Builder, replace: bool = False) -> None:
        key = getattr(inst, "name", "")
        if not key:
            raise ValueError("builder.name 不能为空")
        if key in self._builders and not replace:
            raise ValueError(f"builder {key} 已注册")
        self._builders[key] = inst

    def harvest_builtin(self) -> List[str]:
        """收割 @builder 装饰的内置构建器（幂等）。"""
        registered = []
        for cls in _BUILDER_CLASSES:
            inst = cls()
            replace = inst.name in self._builders
            self.register(inst, replace=replace)
            registered.append(inst.name)
        return registered

    def load_plugin_dir(self, directory: Path) -> List[str]:
        """加载外部 Builder 插件（~/.codeforge/plugins/）。失败降级。"""
        import importlib.util
        import sys
        from ..errors import cf_error
        loaded: List[str] = []
        directory = Path(directory)
        if not directory.is_dir():
            return loaded
        for py in sorted(directory.glob("*.py")):
            if py.name.startswith("_"):
                continue
            try:
                mod_name = f"codeforge.ext_builders.{py.stem}"
                spec = importlib.util.spec_from_file_location(mod_name, py)
                module = importlib.util.module_from_spec(spec)
                before = len(_BUILDER_CLASSES)
                sys.modules[mod_name] = module
                spec.loader.exec_module(module)
                new_classes = _BUILDER_CLASSES[before:]
                del _BUILDER_CLASSES[before:]
                for cls in new_classes:
                    inst = cls()
                    self.register(inst, replace=True)
                    loaded.append(inst.name)
            except Exception as exc:
                cf_error("CF0001", message=f"Builder 插件 {py.name} 加载失败",
                         hint=f"{type(exc).__name__}: {exc}")
        return loaded

    def get(self, name: str) -> Builder:
        b = self._builders.get(name)
        if b is None:
            raise CodeForgeError("CF0001", message=f"未注册的构建器 {name}",
                                 hint="检查 langregistry 与插件目录")
        return b

    def names(self) -> List[str]:
        return list(self._builders.keys())
