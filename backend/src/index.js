/// CodeForge 远程构建服务器入口。
/// REST: /api/languages /api/files/* /api/lint /api/plan
/// WS:   /ws 统一信封协议（hello 握手 → build/term/debug 通道，逐步接入）
const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const { ok, fail, handshake, makeError } = require("./protocol");
const { getPyWorker } = require("./services/pyworker");
const { Workspace } = require("./services/workspace");
const { BuildExecutor } = require("./services/executor");
const { TerminalService } = require("./services/terminal");
const { LspManager } = require("./services/lsp");
const { attachRelay } = require("./services/relay");
const logger = require("./services/logger");

const PORT = process.env.PORT || 8787;
const WORKSPACE = process.env.CODEFORGE_WS || path.join(__dirname, "..", "..", "workspace-demo");

const app = express();
app.use(express.json({ limit: "4mb" }));
// 全链路访问日志（任务 #32）
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    if (req.path === "/api/health") return;
    logger.log("info", "http", req.method.toLowerCase(), {
      path: req.path, status: res.statusCode, ms: Date.now() - t0 });
  });
  next();
});
logger.initFile(path.join(__dirname, "..", "..", "logs"));
app.use(express.static(path.join(__dirname, "..", "..", "frontend", "dist")));

const worker = getPyWorker();
const workspace = new Workspace(WORKSPACE);
const executor = new BuildExecutor();
const terminals = new TerminalService();
const lsp = new LspManager();

// ---------- REST ----------
app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.get("/api/languages", async (_req, res) => {
  try {
    const registry = await worker.request("lang-" + Date.now(), "registry", {});
    res.json(ok("rest", "languages.result", registry));
  } catch (e) {
    const err = e.cfError || makeError("CF5003");
    res.status(503).json(fail("rest", "languages.result", err.code));
  }
});

// 文件树
app.get("/api/files/tree", async (req, res) => {
  try { res.json(ok("rest", "files.tree", await workspace.tree(req.query.path || "."))); }
  catch (e) { const err = e.cfError || makeError("CF1001"); res.status(err.severity === "error" ? 400 : 400).json(fail("rest", "files.tree", err.code)); }
});

app.get("/api/files/read", async (req, res) => {
  try { res.json(ok("rest", "files.read", await workspace.read(req.query.path))); }
  catch (e) { const err = e.cfError || makeError("CF1001"); res.status(400).json(fail("rest", "files.read", err.code)); }
});

app.put("/api/files/write", async (req, res) => {
  try { res.json(ok("rest", "files.write",
    await workspace.write(req.body.path, req.body.content ?? ""))); }
  catch (e) { const err = e.cfError || makeError("CF1003"); res.status(400).json(fail("rest", "files.write", err.code)); }
});

app.post("/api/files/create", async (req, res) => {
  try { res.json(ok("rest", "files.create",
    await workspace.create(req.body.path, !!req.body.dir))); }
  catch (e) { const err = e.cfError || makeError("CF1003"); res.status(400).json(fail("rest", "files.create", err.code)); }
});

app.post("/api/files/rename", async (req, res) => {
  try { res.json(ok("rest", "files.rename",
    await workspace.rename(req.body.from, req.body.to))); }
  catch (e) { const err = e.cfError || makeError("CF1001"); res.status(400).json(fail("rest", "files.rename", err.code)); }
});

app.post("/api/files/delete", async (req, res) => {
  try { res.json(ok("rest", "files.delete", await workspace.remove(req.body.path))); }
  catch (e) { const err = e.cfError || makeError("CF1002"); res.status(400).json(fail("rest", "files.delete", err.code)); }
});

// 日志查询（任务 #33）
app.get("/api/logs", (req, res) => {
  res.json(ok("rest", "logs.tail", logger.tail({
    limit: parseInt(req.query.limit || "300"),
    level: req.query.level || undefined,
    source: req.query.source || undefined,
  })));
});

// UI 操作埋点上报
app.post("/api/logs/action", (req, res) => {
  logger.log("action", "ui", req.body?.event || "unknown", {
    target: req.body?.target, args: req.body?.args,
  });
  res.json(ok("rest", "logs.action", {}));
});

// Lint（经 pyworker）
app.post("/api/lint", async (req, res) => {
  try {
    const result = await worker.request("lint-" + Date.now(), "lint", {
      file: req.body.file, text: req.body.text,
      lang: req.body.lang, options: req.body.options,
      enabled: req.body.enabled,
    });
    res.json(ok("rest", "lint.result", result));
  } catch (e) {
    const err = e.cfError || makeError("CF5003");
    res.status(503).json(fail("rest", "lint.result", err.code));
  }
});

// 构建计划预览
app.post("/api/plan", async (req, res) => {
  try {
    const result = await worker.request("plan-" + Date.now(), "plan", {
      file: req.body.file, out_dir: req.body.outDir || "/tmp/cf-out",
      run_args: req.body.runArgs, extra_paths: req.body.extraPaths,
    });
    res.json(ok("rest", "plan.result", result));
  } catch (e) {
    const err = e.cfError || makeError("CF2003");
    res.status(400).json(fail("rest", "plan.result", err.code, err.details || {}));
  }
});

// ---------- WS ----------
// 双路径：/ws 统一信封协议；/relay 加速器 TCP 隧道
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
attachRelay(server);

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/ws") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  // /relay 已由 attachRelay 内部处理
});

wss.on("connection", (socket, req) => {
  let handshaken = false;
  const kick = setTimeout(() => socket.close(4000, "handshake timeout"), 10_000);

  // LSP 服务器通知（publishDiagnostics 等）转发到该连接
  lsp.onNotification(({ language, method, params }) => {
    if (socket.readyState === socket.OPEN)
      socket.send(JSON.stringify(ok("lsp", "lsp.notification", { language, method, params })));
  });

  socket.on("message", (raw, isBinary) => {
    // 二进制帧：终端/调试通道后续接入
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (!handshaken) {
      const hs = handshake(msg);
      if (!hs.ok) { socket.close(4001, hs.reason); return; }
      handshaken = true;
      clearTimeout(kick);
      logger.log("info", "ws", "hello", { client: hs.client, version: hs.version });
      socket.send(JSON.stringify(ok(msg.id, "hello.ok",
        { server: "codeforge", protocol: msg.v, client: hs.client, version: hs.version })));
      return;
    }

    switch (msg.type) {
      case "ping":
        socket.send(JSON.stringify(ok(msg.id, "pong")));
        break;
      case "build.start": {
        // plan → 执行 → 流式输出。服务器原生模式（local/docker 模式由桌面端/容器层接入）
        const p = msg.payload || {};
        const outDir = "/tmp/cf-build/" + (msg.id || String(Date.now()));
        logger.log("info", "build", "start", { id: msg.id, file: p.file, mode: "server" });
        worker.request(msg.id + ":plan", "plan", {
          file: p.file, out_dir: outDir, run_args: p.runArgs,
        }).then((plan) => {
          socket.send(JSON.stringify(ok(msg.id, "build.plan", plan)));
          return executor.execute(String(msg.id), plan, {
            cwd: WORKSPACE,
            timeoutMs: p.timeoutMs,
            onOutput: (chunk) => socket.send(JSON.stringify(
              ok(msg.id, "build.output", { chunk, stream: "stdout" }))),
          });
        }).then((result) => {
          if (result !== undefined) {
            logger.log(result.ok ? "info" : "error", "build", "done",
              { id: msg.id, ok: result.ok, ms: result.durationMs });
            socket.send(JSON.stringify(ok(msg.id, "build.result", result)));
          }
        }).catch((e) => {
          const err = e.cfError || makeError("CF2001", {}, { message: e.message });
          // 编译失败带 exitCode 的普通错误：走 result 而非 error
          if (err.code === "CF2001" && typeof e.exitCode === "number") {
            socket.send(JSON.stringify(ok(msg.id, "build.result",
              { ok: false, exitCode: e.exitCode, durationMs: 0 })));
          } else {
            socket.send(JSON.stringify(fail(msg.id, "build.result", err.code, err.details || {})));
          }
        });
        break;
      }
      case "build.cancel": {
        socket.send(JSON.stringify(ok(msg.id, "build.cancel",
          { cancelled: executor.cancel(String(msg.payload?.buildId || msg.id)) })));
        break;
      }
      case "term.create": {
        try {
          const { id } = terminals.create({
            cols: msg.payload?.cols, rows: msg.payload?.rows,
            onOutput: (chunk, sessionId) => socket.send(JSON.stringify(
              ok(msg.id, "term.output", { sessionId, chunk }))),
            onExit: (code, sessionId) => socket.send(JSON.stringify(
              ok(msg.id, "term.exit", { sessionId, exitCode: code }))),
          });
          logger.log("info", "terminal", "create", { sessionId: id });
          socket.send(JSON.stringify(ok(msg.id, "term.created", { sessionId: id })));
        } catch (e) {
          const err = e.cfError || makeError("CF6001");
          socket.send(JSON.stringify(fail(msg.id, "term.create", err.code,
            { message: e.cfError?.message || err.message })));
        }
        break;
      }
      case "term.input": {
        terminals.write(msg.payload?.sessionId, msg.payload?.data ?? "");
        break;
      }
      case "term.resize": {
        terminals.resize(msg.payload?.sessionId, msg.payload?.cols || 80, msg.payload?.rows || 24);
        break;
      }
      case "term.kill": {
        socket.send(JSON.stringify(ok(msg.id, "term.killed",
          { killed: terminals.kill(msg.payload?.sessionId) })));
        break;
      }
      case "lsp.start": {
        lsp.ensureRunning(msg.payload?.language, msg.payload?.root)
          .then((r) => socket.send(JSON.stringify(ok(msg.id, "lsp.started", r))))
          .catch((e) => {
            const err = e.cfError || makeError("CF4002");
            socket.send(JSON.stringify(fail(msg.id, "lsp.start", err.code, err.details || {})));
          });
        break;
      }
      case "lsp.request": {
        lsp.request(msg.payload?.language, msg.payload?.method, msg.payload?.params)
          .then((result) => socket.send(JSON.stringify(ok(msg.id, "lsp.result", { result }))))
          .catch((e) => {
            const err = e.cfError || makeError("CF0001", {}, { message: e.message });
            socket.send(JSON.stringify(fail(msg.id, "lsp.result", err.code, err.details || {})));
          });
        break;
      }
      case "lsp.notify": {
        lsp.notify(msg.payload?.language, msg.payload?.method, msg.payload?.params);
        break;
      }
      default:
        socket.send(JSON.stringify(fail(msg.id, msg.type + ".ack", "CF0001",
          { message: `未知类型 ${msg.type}` })));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[codeforge-server] http://localhost:${PORT}  ws://localhost:${PORT}/ws`);
});
