"""Lint 引擎与内置检查器正式测试。"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pylib"))

from codeforge.lint.base import Checker, checker, make_diagnostic  # noqa: E402
from codeforge.lint.engine import LintEngine  # noqa: E402
from codeforge.errors import CodeForgeError  # noqa: E402


@pytest.fixture(scope="module")
def engine():
    e = LintEngine()
    loaded = e.load_builtin_checkers()
    assert sorted(e.names()) == ["indentation", "line_length", "spelling"]
    assert len(loaded) == 3
    return e


# ---------- 缩进检查器 ----------

def test_mixed_tabs_spaces(engine):
    ds = engine.run("a.py", "def f():\n\tx = 1\n     \ty = 2\n", language="python")
    mixed = [d for d in ds if d.rule == "CF3001"]
    assert mixed and mixed[0].line == 3 and mixed[0].severity == "warning"


def test_python_indent_level_error(engine):
    bad = "def f():\n  x = 1\n\t    y = 2\n   return x\n"
    ds = engine.run("a.py", bad, language="python")
    c2 = [d for d in ds if d.rule == "CF3002"]
    assert c2 and c2[0].severity == "error" and "层级" in c2[0].message


def test_python_valid_code_no_indent_diag(engine):
    assert not [d for d in engine.run("ok.py", "def f():\n    return 1\n",
                                      language="python") if d.rule == "CF3002"]


def test_trailing_whitespace_flagged(engine):
    ds = engine.run("b.js", "let a = 1;   \n", language="cpp")
    assert any("多余空白" in d.message for d in ds)


# ---------- 拼写检查器 ----------

def test_spelling_camel_snake_comment(engine):
    code = "const recieveBuffer = 1;\n// adress book\nString userLenght;"
    msgs = " | ".join(d.message for d in engine.run("c.cs", code, language="csharp"))
    for w in ("recieve", "adress", "userLenght"):
        assert w in msgs, msgs


def test_spelling_clean_code_zero_falses(engine):
    clean = 'def ok():\n    return "address length"\n'
    spelling_diags = [d for d in engine.run("ok.py", clean, language="python")
                      if d.rule == "CF3003"]
    assert spelling_diags == []


def test_spelling_user_dict_full_identifier(engine):
    opts = {"spelling": {"user_words": ["recievebuffer"]}}
    ds = engine.run("c.cs", "const recieveBuffer = 1;", language="csharp",
                    options=opts)
    assert [d for d in ds if d.rule == "CF3003"] == []


def test_spelling_user_dict_single_word(engine):
    opts = {"spelling": {"user_words": ["recieve"]}}
    ds = engine.run("c.cs", "// recieve it\n", language="csharp", options=opts)
    assert [d for d in ds if d.rule == "CF3003"] == []


# ---------- 行长检查器 ----------

def test_line_length_default_120(engine):
    ds = engine.run("d.rs", "// " + "x" * 200, language="rust")
    assert ds and ds[0].rule == "CF3004" and "203 > 120" in ds[0].message


def test_line_length_custom_max(engine):
    opts = {"line_length": {"max": 50}}
    ds = engine.run("d.rs", "// " + "x" * 100, language="rust", options=opts)
    assert ds and "103 > 50" in ds[0].message


# ---------- 引擎行为 ----------

def test_checker_exception_isolated():
    class Boom(Checker):
        name = "boom"
        rule = "CF3004"
        languages = []

        def check(self, *a, **k):
            raise RuntimeError("炸了")

    class Fine(Checker):
        name = "fine"
        rule = "CF3004"
        languages = []

        def check(self, filename, text, language=None, options=None):
            return [make_diagnostic(self, filename, 1, 1, "info", "ok")]

    e = LintEngine()
    e.register(Boom())
    e.register(Fine())
    ds = e.run("x.py", "anything", language="python")   # boom 崩溃不影响 fine
    assert len(ds) == 1


def test_diagnostics_sorted_by_position(engine):
    text = "\t \tx=1\n#" + "y" * 130
    lines = [(d.line, d.col) for d in engine.run("a.py", text, language="python")]
    assert lines == sorted(lines)


def test_duplicate_plugin_load_is_idempotent(engine):
    before = dict(engine._checkers)
    engine.load_builtin_checkers()   # 二次加载
    after = dict(engine._checkers)
    assert set(before) == set(after)


def test_external_plugin_discovery(tmp_path, engine):
    plugin = tmp_path / "todo_plugin.py"
    plugin.write_text(
        "from codeforge.lint.base import Checker, checker, make_diagnostic\n"
        "@checker\n"
        "class Todo(Checker):\n"
        "    name = 'todo'; rule = 'CF3004'; languages = []\n"
        "    def check(self, filename, text, language=None, options=None):\n"
        "        return [make_diagnostic(self, filename, i, 1, 'info', 'TODO found')\n"
        "                for i, l in enumerate(text.splitlines(), 1) if 'TODO' in l]\n",
        encoding="utf-8")
    e2 = LintEngine()
    e2.load_builtin_checkers()
    e2.load_plugin_dir(tmp_path)
    assert "todo" in e2.names()


def test_broken_plugin_degrades_gracefully(tmp_path):
    (tmp_path / "broken.py").write_text("raise RuntimeError('bad')\n", encoding="utf-8")
    e = LintEngine()
    e.load_builtin_checkers()
    e.load_plugin_dir(tmp_path)      # 不应抛异常
    assert {"indentation", "line_length", "spelling"} <= set(e.names())


# ---------- 错误码表 ----------

def test_error_codes_registry_complete():
    meta = CodeForgeError("CF3002").to_dict()
    assert meta["message"] == "缩进层级错误"
    assert meta["severity"] == "error" and meta["hint"]
    unknown = CodeForgeError("CF9999").to_dict()
    assert unknown["message"] == "CF9999"   # 未知码降级不崩
