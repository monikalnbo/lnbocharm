"""常驻 worker：stdin/stdout JSON 行协议，消除每请求起进程的开销。

协议（ARCHITECTURE.md 第9节）：
    请求：{"v":1,"id":"r1","op":"lint","args":{...}}
    响应：{"v":1,"id":"r1","ok":true,"result":{...}}
         {"v":1,"id":"r1","ok":false,"error":{"code","message","hint"}}

支持的 op：
    ping      -> {"pong": true}
    registry  -> 语言注册表快照
    detect    {file, hint?}
    lint      {file, text, lang?, options?, plugin_dirs?}
    plan      {file, out_dir, run_args?, extra_paths?}
"""
from __future__ import annotations

import json
from pathlib import Path
import sys
from typing import Optional

from .builders import get_default_registry
from .errors import CodeForgeError
from .langdetect import detect_language
from .lint.engine import LintEngine


class Worker:
    def __init__(self, stdin=None, stdout=None) -> None:
        self._stdin = stdin or sys.stdin
        self._stdout = stdout or sys.stdout
        self._lint_engine: Optional[LintEngine] = None
        self._plugins_loaded = False

    # ---------- op 实现 ----------
    def handle(self, req: dict) -> dict:
        rid = req.get("id", "")
        op = req.get("op", "")
        try:
            handler = getattr(self, f"op_{op}", None)
            if handler is None:
                raise CodeForgeError("CF0001", message=f"未知操作 {op!r}",
                                     hint="可用: ping/registry/detect/lint/plan")
            result = handler(req.get("args") or {})
            return {"v": 1, "id": rid, "ok": True, "result": result}
        except CodeForgeError as e:
            return {"v": 1, "id": rid, "ok": False,
                    "error": {"code": e.code, "message": e.message,
                              "hint": e.hint, "details": e.details}}
        except Exception as exc:   # 单请求异常不杀死 worker 进程
            return {"v": 1, "id": rid, "ok": False,
                    "error": {"code": "CF0001",
                              "message": f"内部错误: {type(exc).__name__}: {exc}",
                              "hint": "查看日志诊断包"}}

    def op_ping(self, args: dict) -> dict:
        return {"pong": True}

    def op_registry(self, args: dict) -> dict:
        from .langdetect import get_registry
        return get_registry().export_registry()

    def op_detect(self, args: dict) -> dict:
        info = detect_language(args["file"], context_hint=args.get("hint"))
        if info is None:
            raise CodeForgeError("CF1001", message=f"无法识别语言: {args['file']}",
                                 hint="扩展名未注册；可在插件中注册自定义语言")
        return info

    def _ensure_lint_engine(self, plugin_dirs: Optional[list]) -> LintEngine:
        if self._lint_engine is None:
            self._lint_engine = LintEngine()
            self._lint_engine.load_builtin_checkers()
        if not self._plugins_loaded and plugin_dirs:
            for d in plugin_dirs:
                self._lint_engine.load_plugin_dir(Path(d).expanduser())
            self._plugins_loaded = True
        return self._lint_engine

    def op_lint(self, args: dict) -> dict:
        engine = self._ensure_lint_engine(args.get("plugin_dirs"))
        diags = engine.run(args["file"], args.get("text", ""),
                           language=args.get("lang"),
                           options=args.get("options"),
                           enabled=args.get("enabled"))
        return {"diagnostics": [d.to_dict() for d in diags]}

    def op_plan(self, args: dict) -> dict:
        reg = get_default_registry()
        info = detect_language(args["file"], context_hint=args.get("hint"))
        if info is None:
            raise CodeForgeError("CF2001", message=f"无法识别语言: {args['file']}",
                                 hint="扩展名未注册")
        b = reg.get(info["builder"])
        tc = b.preflight(extra_paths=[Path(p) for p in args.get("extra_paths", [])])
        plan = b.plan(Path(args["file"]), Path(args["out_dir"]), tc,
                      run_args=args.get("run_args"))
        return {"language": plan.language, "build_cmd": plan.build_cmd,
                "run_cmd": plan.run_cmd, "artifacts": plan.artifacts}

    # ---------- 主循环 ----------
    def serve_forever(self) -> None:
        for line in self._stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError as exc:
                resp = {"v": 1, "id": "", "ok": False,
                        "error": {"code": "CF0001",
                                  "message": f"JSON 解析失败: {exc}",
                                  "hint": "每行一个完整 JSON"}}
            else:
                resp = self.handle(req)
            self._stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            self._stdout.flush()
