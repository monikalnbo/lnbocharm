"""构建器包：导入即完成 @builder 收割准备。"""
from .base import Builder, BuildPlan, BuilderRegistry  # noqa: F401 (再导出)

# 导入各内置构建器触发装饰器登记
from . import python, c, cpp, rust, java, csharp, typescript  # noqa: F401,E402

_default: BuilderRegistry | None = None


def get_default_registry() -> BuilderRegistry:
    global _default
    if _default is None:
        reg = BuilderRegistry()
        reg.harvest_builtin()
        _default = reg
    return _default
