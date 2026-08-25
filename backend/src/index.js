/// CodeForge 远程构建服务器入口。
/// REST: /api/languages /api/files/* /api/lint /api/plan
/// WS:   /ws 统一信封协议（hello 握手 → build/term/debug 通道，逐步接入）
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const { ok, fail, handshake, makeError } = require("./protocol");
const { getPyWorker } = require("./services/pyworker");
const { Workspace } = require("./services/workspace");
const { BuildExecutor } = require("./services/executor");
const { TerminalService } = require("./services/terminal");
const { LspManager } = require("./services/lsp");
const { attachRelay } = require("./services/relay");
const e2e = require("./services/crypto-channel");
const E2E_REQUIRED = process.env.CODEFORGE_E2E === "1";
const WS_TOKEN = process.env.CODEFORGE_TOKEN || "";
function safeEqual(a, b) {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && require("crypto").timingSafeEqual(ab, bb);
}
const logger = require("./services/logger");
const { search, replaceAll } = require("./services/search");
const toolchainStore = require("./services/toolchains");

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
    const registry = await worker.request(null, "registry", {});
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

// 工具链分发（任务 #38/#41）
const TOOLCHAIN_DIR = process.env.CODEFORGE_TOOLCHAINS || path.join(__dirname, "..", "..", "toolchains");
app.get("/api/toolchains", (_req, res) => {
  res.json(ok("rest", "toolchains.list", toolchainStore.list(TOOLCHAIN_DIR)));
});
app.get("/api/toolchains/:id/download", async (req, res) => {
  const entry = toolchainStore.findById(TOOLCHAIN_DIR, req.params.id);
  const abs = entry && toolchainStore.filePathOf(TOOLCHAIN_DIR, entry);
  if (!abs) return res.status(404).json(fail("rest", "toolchains.download", "CF2003",
    { toolchain: req.params.id }));
  res.setHeader("Content-Type", "application/octet-stream");
  fs.createReadStream(abs).pipe(res);
});

// 全局搜索与替换（任务 #27）
app.post("/api/search", async (req, res) => {
  try {
    res.json(ok("rest", "search.result", await search(workspace, req.body || {})));
  } catch (e) { res.status(400).json(fail("rest", "search.result", "CF1002")); }
});

app.post("/api/search/replace", async (req, res) => {
  try {
    res.json(ok("rest", "search.replaced", await replaceAll(workspace, req.body || {})));
  } catch (e) { res.status(400).json(fail("rest", "search.replaced", "CF1002")); }
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
    const result = await worker.request(null, "lint", {
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
    const result = await worker.request(null, "plan", {
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

function wsSendPlain(socket, envelope) {
  socket.send(JSON.stringify(envelope));
}

function wsSend(socket, envelope) {
  socket.send(JSON.stringify(
    socket._key ? e2e.sealEnvelope(socket._key, envelope) : envelope));
}

wss.on("connection", (socket, req) => {
  let handshaken = false;
  const kick = setTimeout(() => socket.close(4000, "handshake timeout"), 10_000);

  // LSP 服务器通知（publishDiagnostics 等）转发到该连接
  lsp.onNotification(({ language, method, params }) => {
    if (socket.readyState === socket.OPEN)
      wsSend(socket, ok("lsp", "lsp.notification", { language, method, params }));
  });

  socket.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try { msg = socket._key ? e2e.openEnvelope(socket._key, msg) : msg; }
    catch { socket.close(4006, "decrypt error"); return; }

    if (!handshaken) {
      // ===== E2E 两阶段握手（任务 #36）：先于标准校验处理 =====

      // 阶段二：客户端 secure 帧（明文，仅含公钥；token 已在阶段一验证）
      if (socket._serverPriv) {
        if (msg.type === "secure" && msg.payload?.pub) {
          try {
            socket._key = e2e.deriveKey(socket._serverPriv, msg.payload.pub);
            delete socket._serverPriv;
            handshaken = true;
            clearTimeout(kick);
            logger.log("info", "ws", "hello", { client: "desktop", e2e: true });
            // 加密回执会话就绪标记
            socket.send(JSON.stringify(
              e2e.sealEnvelope(socket._key, ok(msg.id, "hello.ok",
                { e2e: { established: true } }))));
          } catch { socket.close(4006, "key derivation failed"); }
          return;
        }
        socket.close(4005, "e2e secure frame required"); return;
      }

      // 阶段一：明文 hello（标准校验在此之后）
      const hs = handshake(msg);
      if (!hs.ok) { socket.close(4001, hs.reason); return; }
      if (WS_TOKEN && !safeEqual(String(msg.payload?.token || ""), WS_TOKEN)) {
        logger.log("error", "ws", "auth-failed");
        socket.close(4003, "bad token"); return;
      }
      if (E2E_REQUIRED) {
        const serverKeys = e2e.genEcdh();
        socket._serverPriv = serverKeys.privateKey;
        wsSendPlain(socket, ok(msg.id, "hello.ok",
          { server: "codeforge", protocol: 1, client: hs.client,
            e2e: { required: true, pub: serverKeys.publicBase64 } }));
        return;                       // 等待 secure 帧，握手仍未完成
      }

      handshaken = true;
      clearTimeout(kick);
      logger.log("info", "ws", "hello", { client: hs.client, version: hs.version });
      wsSend(socket, ok(msg.id, "hello.ok",
        { server: "codeforge", protocol: msg.v, client: hs.client, version: hs.version }));
      return;
    }

    switch (msg.type) {
      case "ping":
        wsSend(socket, ok(msg.id, "pong"));
        break;

      case "build.start": {
        const p = msg.payload || {};
        const outDir = "/tmp/cf-build/" + (msg.id || String(Date.now()));
        logger.log("info", "build", "start", { id: msg.id, file: p.file, mode: "server" });
        worker.request(msg.id, "plan", {
          file: p.file, out_dir: outDir, run_args: p.runArgs,
        }).then((plan) => {
          wsSend(socket, ok(msg.id, "build.plan", plan));
          return executor.execute(String(msg.id), plan, {
            cwd: WORKSPACE,
            timeoutMs: p.timeoutMs,
            onOutput: (chunk) => wsSend(socket, ok(msg.id, "build.output",
              { chunk, stream: "stdout" })),
          });
        }).then((result) => {
          if (result !== undefined) {
            logger.log(result.ok ? "info" : "error", "build", "done",
              { id: msg.id, ok: result.ok, ms: result.durationMs });
            wsSend(socket, ok(msg.id, "build.result", result));
          }
        }).catch((e) => {
          const err = e.cfError || makeError("CF2001", {}, { message: e.message });
          if (err.code === "CF2001" && typeof e.exitCode === "number") {
            wsSend(socket, ok(msg.id, "build.result",
              { ok: false, exitCode: e.exitCode, durationMs: 0 }));
          } else {
            wsSend(socket, fail(msg.id, "build.result", err.code, err.details || {}));
          }
        });
        break;
      }

      case "build.cancel":
        wsSend(socket, ok(msg.id, "build.cancel",
          { cancelled: executor.cancel(String(msg.payload?.buildId || msg.id)) }));
        break;

      case "term.create": {
        try {
          const { id } = terminals.create({
            cols: msg.payload?.cols, rows: msg.payload?.rows,
            onOutput: (chunk, sessionId) => wsSend(socket, ok(msg.id, "term.output",
              { sessionId, chunk })),
            onExit: (code, sessionId) => wsSend(socket, ok(msg.id, "term.exit",
              { sessionId, exitCode: code })),
          });
          logger.log("info", "terminal", "create", { sessionId: id });
          wsSend(socket, ok(msg.id, "term.created", { sessionId: id }));
        } catch (e) {
          const err = e.cfError || makeError("CF6001");
          wsSend(socket, fail(msg.id, "term.create", err.code,
            { message: e.cfError?.message || err.message }));
        }
        break;
      }

      case "term.input":
        terminals.write(msg.payload?.sessionId, msg.payload?.data ?? "");
        break;

      case "term.resize":
        terminals.resize(msg.payload?.sessionId, msg.payload?.cols || 80, msg.payload?.rows || 24);
        break;

      case "term.kill":
        wsSend(socket, ok(msg.id, "term.killed",
          { killed: terminals.kill(msg.payload?.sessionId) }));
        break;

      case "lsp.start":
        lsp.ensureRunning(msg.payload?.language, msg.payload?.root)
          .then((r) => wsSend(socket, ok(msg.id, "lsp.started", r)))
          .catch((e) => {
            const err = e.cfError || makeError("CF4002");
            wsSend(socket, fail(msg.id, "lsp.start", err.code, err.details || {}));
          });
        break;

      case "lsp.request":
        lsp.request(msg.payload?.language, msg.payload?.method, msg.payload?.params)
          .then((result) => wsSend(socket, ok(msg.id, "lsp.result", { result })))
          .catch((e) => {
            const err = e.cfError || makeError("CF0001", {}, { message: e.message });
            wsSend(socket, fail(msg.id, "lsp.result", err.code, err.details || {}));
          });
        break;

      case "lsp.notify":
        lsp.notify(msg.payload?.language, msg.payload?.method, msg.payload?.params);
        break;

      default:
        wsSend(socket, fail(msg.id, msg.type + ".ack", "CF0001",
          { message: `未知类型 ${msg.type}` }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[codeforge-server] http://localhost:${PORT}  ws://localhost:${PORT}/ws`);
});
