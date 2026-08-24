# CodeForge (lnbocharm)

<p align="center"><b>A polyglot desktop IDE & compiler harness — C / C++ / C# / Rust / Python / Java / TypeScript.</b><br/>
Local or server builds, LSP-powered completion, pluggable linting, breakpoints, integrated terminal.<br/>
Zero API keys. Portable zip: extract and run.
</p>

---

## Architecture

```
┌────────────────────────── Electron Desktop App ──────────────────────────┐
│  Renderer (Vue3 + Monaco + xterm.js)   │  Main (Node)                    │
│  editor · problems · build · terminal  │  IPC: local build / local pty   │
└───────────────┬────────────────────────┴────────────┬───────────────────┘
                │ unified envelope protocol v1        │ child processes
                ▼                                     ▼
     ┌── Remote Build Server (optional) ──┐    native toolchains on your
     │ REST /api/*  ·  WS /ws             │    machine (gcc, rustc, javac,
     │ builder · lint · LSP pool · relay  │    dotnet, node+tsc …)
     └────────────────────────────────────┘
```

Full spec: [`ARCHITECTURE.md`](ARCHITECTURE.md) — unified message envelope, error-code
registry (`CFxxxx` with parametrized hints), module ownership rules, LSP layer and
resident worker protocol.

## Highlights

| Area | What you get |
| --- | --- |
| Language registry | Extension → language mapping as single source of truth (`codeforge-py`), exported snapshot for JS; `.h` ambiguity resolution; user-registered custom languages |
| Lint engine | Pluggable `@checker` decorators; built-ins: mixed indent CF3001, Python indent-level CF3002, misspells CF3003, long lines CF3004, trailing spaces CF3005; external plugins auto-discovered from `~/.codeforge/plugins/` |
| Builders | 7 builders generating **argv arrays** (never shell strings): gcc/g++ `-g` debug builds, rustc ↔ cargo auto-switch, javac/java, dotnet csproj, tsc+sourceMap |
| Build modes | `local` (desktop IPC) · `server` (streamed via WS) · `docker` (toolchain pool); cancel, timeout CF2002, queue CF2004, tail-truncated output |
| LSP | clangd / rust-analyzer / jdtls / pyright / omnisharp / typescript-language-server pooling, completion proxy, publishDiagnostics forwarding, idle recycle |
| Terminal | node-pty sessions over WS: cap, ring-buffer replay, idle reaping |
| Toolchains | Hosted on your own server: manifest `/api/toolchains` + SHA256-verified download + one-click install-and-rebuild |
| Errors | Every failure carries a code + human hint from a single registry shared by Python & JS |

## Quick start

### Server mode (try in browser)

```bash
git clone https://github.com/monikalnbo/lnbocharm.git && cd lnbocharm
cd frontend && npm i && npm run build && cd ..
cd backend && npm i && npm start          # http://localhost:8787
```

Open the URL, open a file in the tree, hit ▶.

### Desktop app

```bash
cd desktop && npm i && npm start           # dev (needs frontend/dist)
npm run dist                               # portable zip per platform
```

### Full server stack with toolchain containers

```bash
docker compose up -d                       # backend + 6 toolchain pools
```

## Plugin development (extend the core)

```python
# ~/.codeforge/plugins/todo.py
from codeforge.lint.base import Checker, checker, make_diagnostic

@checker
class Todo(Checker):
    name = "todo"; rule = "CF3004"; languages = []
    def check(self, filename, text, language=None, options=None):
        return [make_diagnostic(self, filename, i, 1, "info", "TODO found", "close it")
                for i, l in enumerate(text.splitlines(), 1) if "TODO" in l]
```

Custom languages: `get_registry().register("kotlin", ext=[".kt"], ...)` — see
[`skills/codeforge/SKILL.md`](skills/codeforge/SKILL.md).

## Testing

```bash
python3 -m pytest tests/ -q        # engine: 45 tests
cd backend && npm test             # server: 25 tests
```

## License

MIT
