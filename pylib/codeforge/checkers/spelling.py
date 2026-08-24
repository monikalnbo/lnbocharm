"""拼写检查器(CF3003)：常见编程拼写错误词典 + 标识符切词。

轻量实现：内置高频误拼词典，支持用户词典追加（options.user_words / 词典文件）。
不做自然语言校对——只查代码标识符与字符串里的英文词。
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import List, Optional, Set

from ..lint.base import Checker, checker, make_diagnostic

# 高频误拼 -> 正确拼写（可按需扩充）
COMMON_MISSPELLS: Set[str] = {
    "adress": "address", "agian": "again", "alot": "a lot", "arent": "aren't",
    "becuase": "because", "begining": "beginning", "beleive": "believe",
    "calender": "calendar", "cant": "can't", "catagory": "category",
    "collumn": "column", "colour": "color", "comapre": "compare",
    "conatiner": "container", "definately": "definitely", "dependant": "dependent",
    "enviroment": "environment", "existance": "existence", "explicitely": "explicitly",
    "fucntion": "function", "funtion": "function", "gaurd": "guard",
    "hierachy": "hierarchy", "independant": "independent", "informations": "information",
    "langauge": "language", "lenght": "length", "libary": "library",
    "lisence": "license", "mesage": "message", "neccessary": "necessary",
    "occured": "occurred", "ommit": "omit", "paramter": "parameter",
    "persistant": "persistent", "posible": "possible", "recieve": "receive",
    "refrence": "reference", "reguardless": "regardless", "repeatly": "repeatedly",
    "reseive": "reserve", "respone": "response", "retrun": "return",
    "reuslt": "result", "seperate": "separate", "serach": "search",
    "similiar": "similar", "sucess": "success", "supress": "suppress",
    "teh": "the", "tempalte": "template", "thier": "their",
    "tranfer": "transfer", "tryed": "tried", "unkown": "unknown",
    "usefull": "useful", "varient": "variant", "wether": "whether",
    "whitch": "which", "wirte": "write", "wrok": "work",
}

_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_CAMEL_SPLIT = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")


@checker
class SpellingChecker(Checker):
    name = "spelling"
    rule = "CF3003"
    languages = []  # 全语言

    def __init__(self) -> None:
        self._user_words: Set[str] = set()

    def load_user_dict(self, path: Path) -> None:
        """每行一词的自定义词典。"""
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                w = line.strip().lower()
                if w:
                    self._user_words.add(w)
        except OSError:
            pass  # 词典缺失不致命

    def add_user_word(self, word: str) -> None:
        self._user_words.add(word.strip().lower())

    def check(self, filename, text, language=None, options=None) -> List:
        options = options or {}
        user_words = set(self._user_words)
        user_words |= {str(w).lower() for w in options.get("user_words", [])}
        diags: List = []
        seen_spans = set()
        for idx, line in enumerate(text.splitlines(), 1):
            for m in _IDENT_RE.finditer(line):
                ident = m.group(0)
                # 整个标识符在用户词典里则直接放行
                if ident.lower() in user_words:
                    continue
                # 驼峰转空格后，按空白+下划线统一切词
                parts = re.split(r"[\s_]+", _CAMEL_SPLIT.sub(" ", ident))
                for part in parts:
                    low = part.lower()
                    if len(low) < 3 or low in user_words:
                        continue
                    fix = COMMON_MISSPELLS.get(low)
                    if fix:
                        span = (idx, m.start(), ident)
                        if span in seen_spans:
                            continue
                        seen_spans.add(span)
                        col = m.start() + 1
                        diags.append(make_diagnostic(
                            self, filename, idx, col, "info",
                            f"疑似拼写错误：{ident}（{part} → {fix}?）",
                            hint=f"检查单词拼写；如为专有名词可加入自定义词典（add '{ident}'）"))
                        break
        return diags
