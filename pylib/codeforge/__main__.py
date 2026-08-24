"""codeforge CLI 入口。

用法：
    python3 -m codeforge serve                     # 常驻 worker（JSON 行协议）
    python3 -m codeforge detect <file> [--hint L]
    python3 -m codeforge lint --file F [--lang L]  # 源码从 stdin 读
    python3 -m codeforge plan --file F --out-dir D
    python3 -m codeforge registry
"""
from __future__ import annotations

import argparse
import json
import sys


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="codeforge")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("serve", help="常驻 worker（stdin/stdout JSON 行协议）")

    p_detect = sub.add_parser("detect")
    p_detect.add_argument("file")
    p_detect.add_argument("--hint", default=None)

    p_lint = sub.add_parser("lint")
    p_lint.add_argument("--file", required=True)
    p_lint.add_argument("--lang", default=None)

    p_plan = sub.add_parser("plan")
    p_plan.add_argument("--file", required=True)
    p_plan.add_argument("--out-dir", required=True)

    sub.add_parser("registry")

    ns = ap.parse_args(argv)

    if ns.cmd == "serve":
        from .worker import Worker
        Worker().serve_forever()
        return 0

    if ns.cmd == "registry":
        from .langdetect import get_registry
        print(json.dumps(get_registry().export_registry(), ensure_ascii=False, indent=2))
        return 0

    if ns.cmd == "detect":
        from .worker import Worker
        resp = Worker().handle({"id": "cli", "op": "detect",
                                "args": {"file": ns.file, "hint": ns.hint}})
        print(json.dumps(resp, ensure_ascii=False))
        return 0 if resp["ok"] else 1

    if ns.cmd == "lint":
        from .worker import Worker
        text = sys.stdin.read()
        resp = Worker().handle({"id": "cli", "op": "lint",
                                "args": {"file": ns.file, "text": text,
                                         "lang": ns.lang}})
        print(json.dumps(resp, ensure_ascii=False))
        return 0 if resp["ok"] else 1

    if ns.cmd == "plan":
        from .worker import Worker
        resp = Worker().handle({"id": "cli", "op": "plan",
                                "args": {"file": ns.file,
                                         "out_dir": ns.out_dir}})
        print(json.dumps(resp, ensure_ascii=False))
        return 0 if resp["ok"] else 1

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
