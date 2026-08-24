"""langdetect 模块正式测试。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pylib"))

from codeforge.langdetect import (  # noqa: E402
    LanguageRegistry, detect_language, get_registry,
)


def test_basic_detection():
    assert detect_language("main.py")["name"] == "python"
    assert detect_language("app.CS")["name"] == "csharp"      # 大小写不敏感
    assert detect_language("lib.rs")["builder"] == "rust"
    assert detect_language("Main.java")["monacoId"] == "java"
    assert detect_language("kernel.c")["toolchain"] == ["gcc"]
    assert detect_language("prog.cpp")["builder"] == "cpp"


def test_no_extension_returns_none():
    assert detect_language("Makefile") is None
    assert detect_language("") is None


def test_ambiguous_h_header():
    assert detect_language("a.h")["name"] == "c"              # 默认 C
    assert detect_language("a.h", context_hint="cpp")["name"] == "cpp"


def test_capability_vs_ownership():
    reg = get_registry()
    # 能力表：c 和 cpp 都声明能处理 .h
    assert ".h" in reg.get("c").ext and ".h" in reg.get("cpp").ext
    # 所有权表：.h 默认归 c
    assert reg._by_ext[".h"] == "c"


def test_register_conflict_raises_for_plugins():
    reg = get_registry()
    try:
        reg.register("go", ext=[".py"], monacoId="go", builder="go", comment="//")
        raise AssertionError("应拒绝占用已存在扩展名")
    except ValueError:
        pass


def test_register_custom_language_extensible():
    reg = LanguageRegistry()  # 独立实例，避免污染全局
    reg.register("kotlin", ext=[".kt"], monacoId="kotlin", builder="kotlin",
                 comment="//", toolchain=["kotlinc"], custom=True)
    assert reg.detect("t.kt").name == "kotlin"
    # 重复注册默认拒绝
    try:
        reg.register("kotlin", ext=[".kt"], monacoId="kotlin", builder="kotlin",
                     comment="//")
        raise AssertionError("重复注册应失败")
    except ValueError:
        pass


def test_register_invalid_ext():
    reg = LanguageRegistry()
    try:
        reg.register("bad", ext=["py"], monacoId="bad", builder="bad", comment="#")
        raise AssertionError("无点扩展名应被拒绝")
    except ValueError:
        pass


def test_export_registry_snapshot():
    snap = json.dumps(get_registry().export_registry(), ensure_ascii=False)
    data = json.loads(snap)
    for lang in ("c", "cpp", "csharp", "rust", "python", "java"):
        assert lang in data
        assert all(k in data[lang] for k in ("ext", "monacoId", "builder",
                                             "comment", "indent", "debugAdapter"))


# ---------- TypeScript / JavaScript 内置环境 ----------

def test_typescript_detection():
    info = detect_language("app.ts")
    assert info["name"] == "typescript" and info["monacoId"] == "typescript"
    assert detect_language("server.mjs")["name"] == "javascript"


def test_ts_js_share_builder():
    reg = get_registry()
    assert reg.get("typescript").builder == reg.get("javascript").builder == "typescript"
