"""构建器包：导入即完成 @builder 收割准备。"""
from .base import Builder, BuildPlan, BuilderRegistry, builder  # noqa: F401

# 导入各内置构建器触发装饰器登记
from . import python, c, cpp, rust, java, csharp, typescript  # noqa: F401,E402


def get_default_registry() -> BuilderRegistry:
    global _default
    try:
        return _default
    except NameError:
        pass
    reg = BuilderRegistry()
    reg.harvest_builtin()
    globals()["_default"] = reg
    return reg
