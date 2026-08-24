"""常驻 worker 协议测试：真实子进程往返。"""
import json
import subprocess
import sys
from pathlib import Path

PYLIB = Path(__file__).resolve().parent.parent / "pylib"


class WorkerClient:
    def __init__(self):
        self.p = subprocess.Popen(
            [sys.executable, "-m", "codeforge", "serve"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, cwd=str(PYLIB),
            text=True, encoding="utf-8")

    def req(self, rid, op, args=None):
        self.p.stdin.write(json.dumps({"v": 1, "id": rid, "op": op,
                                       "args": args or {}}, ensure_ascii=False) + "\n")
        self.p.stdin.flush()
        return json.loads(self.p.stdout.readline())

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=5)


def test_worker_ping_and_registry():
    w = WorkerClient()
    try:
        r = w.req("a", "ping")
        assert r["ok"] and r["result"]["pong"] is True and r["id"] == "a"
        r = w.req("b", "registry")
        assert r["ok"] and {"python", "typescript"} <= set(r["result"])
    finally:
        w.close()


def test_worker_detect_ok_and_fail():
    w = WorkerClient()
    try:
        r = w.req("1", "detect", {"file": "x.py"})
        assert r["ok"] and r["result"]["name"] == "python"
        r = w.req("2", "detect", {"file": "x.unknown"})
        assert not r["ok"] and r["error"]["code"] == "CF1001"
    finally:
        w.close()


def test_worker_lint_returns_diagnostics():
    w = WorkerClient()
    try:
        r = w.req("3", "lint", {"file": "a.py",
                                "text": "def f():\n  x=1\n\t y=2\n",
                                "lang": "python"})
        assert r["ok"]
        codes = [d["rule"] for d in r["result"]["diagnostics"]]
        assert "CF3001" in codes and "CF3002" in codes
    finally:
        w.close()


def test_worker_unknown_op_and_bad_json():
    w = WorkerClient()
    try:
        r = w.req("4", "nope")
        assert not r["ok"] and r["error"]["code"] == "CF0001"
        # 坏 JSON 行不杀死进程，下一条请求仍可用
        w.p.stdin.write("not-json\n")
        w.p.stdin.flush()
        bad = json.loads(w.p.stdout.readline())
        assert not bad["ok"]
        r = w.req("5", "ping")
        assert r["ok"]
    finally:
        w.close()


def test_worker_plan_missing_toolchain_cf2003():
    # 用隔离 PATH 确保触发 CF2003；验证插槽已渲染（不再有字面 {toolchain}）
    import os
    env = dict(os.environ)
    env["PATH"] = "/nonexistent"
    p = subprocess.Popen(
        [sys.executable, "-m", "codeforge", "serve"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, cwd=str(PYLIB), env=env,
        text=True, encoding="utf-8")
    try:
        req = {"v": 1, "id": "9", "op": "plan",
               "args": {"file": "main.c", "out_dir": "/tmp/out"}}
        p.stdin.write(json.dumps(req) + "\n")
        p.stdin.flush()
        resp = json.loads(p.stdout.readline())
        assert not resp["ok"] and resp["error"]["code"] == "CF2003"
        blob = json.dumps(resp["error"], ensure_ascii=False)
        assert "{toolchain}" not in blob and "{install}" not in blob
        assert "gcc" in blob          # 插槽已填充工具名
    finally:
        p.stdin.close(); p.wait(timeout=5)


def test_cli_detect_and_lint_roundtrip(tmp_path):
    src = tmp_path / "hello.py"
    src.write_text("def f():\n    return 1\n", encoding="utf-8")
    r = subprocess.run([sys.executable, "-m", "codeforge", "detect", str(src)],
                       capture_output=True, text=True, cwd=str(PYLIB))
    assert r.returncode == 0 and json.loads(r.stdout)["result"]["name"] == "python"

    lint_in = "def f():\n  x = 1\n\t    y = 2\n   return x\n"   # 真缩进错误
    r = subprocess.run([sys.executable, "-m", "codeforge", "lint",
                        "--file", "b.py", "--lang", "python"],
                       input=lint_in, capture_output=True, text=True,
                       cwd=str(PYLIB))
    body = json.loads(r.stdout)
    rules = [d["rule"] for d in body["result"]["diagnostics"]]
    assert body["ok"] and "CF3002" in rules
