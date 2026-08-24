# Agent Map

面向编码代理的项目导览。详细规范见 `ARCHITECTURE.md`。

## 首读
- `ARCHITECTURE.md` — 架构、统一信封协议、错误码规范、LSP 层、worker 协议
- `shared/error-codes.json` — 错误码单一来源，两端禁止内联文案
- `skills/codeforge/SKILL.md` — 引擎 CLI/API 用法与扩展指南

## 命令
```bash
python3 -m pytest tests/ -q        # pylib 测试（每次改动必跑）
cd backend && npm test             # 后端测试
```

## 硬规则
- 薄路由：业务逻辑只在 services
- 语言逻辑只存在于 pylib；JS 通过 langregistry 快照消费
- 新增提示先加 shared/error-codes.json
- Builder 只生成命令数组，禁止拼 shell 字符串
- 每个模块：编写 → 测试 → 审查 → 提交推送
