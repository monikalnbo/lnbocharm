"""Builder 插件正式测试（不依赖真实工具链，_which 注入）。"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pylib"))

from codeforge.builders import get_default_registry  # noqa: E402
from codeforge.builders.base import find_toolchain  # noqa: E402
from codeforge.errors import CodeForgeError  # noqa: E402


@pytest.fixture(scope="module")
def reg():
    return get_default_registry()


def test_all_builtin_builders_registered(reg):
    assert set(["python", "c", "cpp", "rust", "java", "csharp",
                "typescript"]) <= set(reg.names())


def _fake_which(tools):
    def _which(t):
        return f"/fake/bin/{t}" if t in tools else None
    return _which


def test_c_plan_argv_array_no_shell(reg, tmp_path):
    b = reg.get("c")
    tc = b.preflight(_which=_fake_which(["gcc"]))
    src = tmp_path / "hello.c"
    plan = b.plan(src, tmp_path / "out", tc)
    assert isinstance(plan.build_cmd, list)          # 数组而非字符串
    assert "-g" in plan.build_cmd                    # 默认带调试符号（断点用）
    assert plan.build_cmd[0] == "/fake/bin/gcc"
    assert plan.artifacts and plan.run_cmd[0] == plan.artifacts[0]


def test_cpp_plan_std17(reg, tmp_path):
    b = reg.get("cpp")
    tc = {"g++": "/fake/bin/g++"}
    plan = b.plan(tmp_path / "app.cpp", tmp_path / "out", tc)
    assert any(a.startswith("-std=c++17") for a in plan.build_cmd)


def test_python_plan_syntax_check_and_run(reg, tmp_path):
    b = reg.get("python")
    tc = {"python3": "/fake/bin/python3"}
    plan = b.plan(tmp_path / "m.py", tmp_path / "out", tc, run_args=["--x"])
    assert plan.build_cmd[:3] == ["/fake/bin/python3", "-m", "py_compile"]
    assert plan.run_cmd == ["/fake/bin/python3", str(tmp_path / "m.py"), "--x"]


def test_rust_single_file_vs_cargo_project(reg, tmp_path):
    b = reg.get("rust")
    tc = {"rustc": "/fake/bin/rustc", "cargo": "/fake/bin/cargo"}
    single = b.plan(tmp_path / "main.rs", tmp_path / "out", tc)
    assert single.build_cmd[0] == "/fake/bin/rustc"

    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "Cargo.toml").write_text("[package]\nname='a'\n")
    cargo = b.plan(proj / "main.rs", tmp_path / "out2", tc)
    assert cargo.build_cmd[:2] == ["/fake/bin/cargo", "build"]


def test_java_plan_classpath(reg, tmp_path):
    b = reg.get("java")
    tc = {"javac": "/fake/bin/javac"}
    plan = b.plan(tmp_path / "Main.java", tmp_path / "out", tc)
    assert plan.build_cmd[:2] == ["/fake/bin/javac", "-d"]
    assert plan.run_cmd[0] == "/fake/bin/java"
    assert plan.run_cmd[-1] == "Main"


def test_typescript_js_runs_directly_ts_compiles(reg, tmp_path):
    b = reg.get("typescript")
    js = b.plan(tmp_path / "s.js", tmp_path / "out", {"node": "/fake/bin/node"})
    assert js.build_cmd is None and js.run_cmd[0] == "/fake/bin/node"

    ts = b.plan(tmp_path / "s.ts", tmp_path / "out",
                {"node": "/fake/bin/node", "tsc": "/fake/bin/tsc"})
    assert ts.build_cmd[0] == "/fake/bin/tsc"
    assert "--sourceMap" in ts.build_cmd             # 断点调试需要 sourcemap


def test_csharp_without_csproj_raises_clear_error(reg, tmp_path):
    b = reg.get("csharp")
    with pytest.raises(CodeForgeError) as ei:
        b.plan(tmp_path / "loose.cs", tmp_path / "out", {"dotnet": "/fake/bin/dotnet"})
    assert ei.value.code == "CF2001" and "dotnet new console" in ei.value.hint


def test_find_toolchain_missing_raises_cf2003_with_parametrized_hint():
    with pytest.raises(CodeForgeError) as ei:
        find_toolchain("gcc", _which=lambda t: None)
    err = ei.value
    assert err.code == "CF2003"
    # hint 参数化：包含工具名与安装命令
    rendered = err.message + err.details.get("install", "")
    assert "gcc" in err.details["toolchain"]


def test_find_toolchain_extra_paths_priority(tmp_path):
    fake = tmp_path / "gcc"
    fake.write_text("#!/bin/sh\n")
    found = find_toolchain("gcc", extra_paths=[tmp_path], _which=lambda t: None)
    assert found == str(fake)


def test_toolchain_missing_hint_has_install_command():
    from codeforge.errors import CodeForgeError
    try:
        find_toolchain("javac", _which=lambda t: None)
        raise AssertionError("should raise")
    except CodeForgeError as e:
        assert e.code == "CF2003"
        assert "install" in e.details and e.details["install"]
