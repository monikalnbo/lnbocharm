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
// 数据面去HTTP化：设置 token 后封锁明文 REST，仅保留健康检查与工具链公开分发
app.use("/api", (req, res, next) => {
  if (!WS_TOKEN) return next();
  if (req.path === "/health" || req.path.startsWith("/toolchains")) return next();
  // 本机回环的管理接口豁免（桌面端切工作区用；已有回环+目录白名单双重限制）
  if (req.path.startsWith("/workspace") && isLocalRequest(req)) return next();
  return res.status(401).json({ v: 1, id: "rest", type: "blocked", ok: false,
    error: { code: "CF9001", severity: "error",
             message: "明文 REST 已禁用",
             hint: "请使用加密 WS 通道（ws://…/ws）访问数据接口" } });
});
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

function isLocalRequest(req) {
  const addr = req?.socket?.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
function isLocalAddr(addr) {
  addr = String(addr || "");
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
function isLocalSocket(sockOrReq) {
  // 兼容：Node 26 下 ws 的 socket.remoteAddress 可能为 undefined，
  // 优先从 HTTP upgrade 层的 req.socket 取
  return isLocalAddr(sockOrReq?.socket?.remoteAddress ?? sockOrReq?.remoteAddress);
}
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
// url 型条目（GitHub Release 等外链）：302 重定向，服务器零带宽
// 本地型条目：流式输出。任务 #38/#41
app.get("/api/toolchains/:id/download", async (req, res) => {
  const entry = toolchainStore.findById(TOOLCHAIN_DIR, req.params.id);
  if (!entry) return res.status(404).json(fail("rest", "toolchains.download", "CF2003",
    { toolchain: req.params.id }));
  if (entry.url) return res.redirect(302, entry.url);
  const abs = toolchainStore.filePathOf(TOOLCHAIN_DIR, entry);
  if (!abs) return res.status(404).json(fail("rest", "toolchains.download", "CF2003",
    { toolchain: req.params.id }));
  res.setHeader("Content-Type", "application/octet-stream");
  fs.createReadStream(abs).pipe(res);
});

// 工作区切根：仅限本机回环（桌面端主进程调用）
app.post("/api/workspace/setRoot", (req, res) => {
  if (!isLocalRequest(req))
    return res.status(403).json(fail("rest", "workspace.setRoot", "CF1002"));
  try {
    const r = workspace.setRoot(req.body?.root);
    watchWorkspace();
    res.json(ok("rest", "workspace.setRoot", r));
  }
  catch (e) { const err = e.cf || makeError("CF1001"); res.status(400).json(fail("rest", "workspace.setRoot", err.code)); }
});
app.get("/api/workspace/root", (_req, res) => {
  res.json(ok("rest", "workspace.root", { root: workspace.getRoot() }));
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

/// 异步算子包装：统一 try/catch → fail 信封
function wrap(socket, msg, fn) {
  Promise.resolve().then(fn)
    .then((result) => wsSend(socket, ok(msg.id, msg.type + ".result", result)))
    .catch((e) => {
      const err = e.cfError || makeError("CF0001", {}, { message: e.message });
      wsSend(socket, fail(msg.id, msg.type + ".result", err.code, err.details || {}));
    });
}

// ---- 文件变更监听（任务 #4）：递归 watch + 防抖广播 fs.changed ----
let workspaceWatcher = null;
let watchDebounce = null;

function watchWorkspace() {
  try { workspaceWatcher?.close(); } catch (_) {}
  workspaceWatcher = null;
  try {
    workspaceWatcher = fs.watch(workspace.getRoot(), { recursive: true }, () => {
      clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        const frame = JSON.stringify(
          ok("fs", "fs.changed", { root: workspace.getRoot() }));
        for (const c of wss.clients) {
          // 已加密会话：fs.changed 也走密文
          if (c.readyState === c.OPEN) {
            try {
              c._key ? c.send(JSON.stringify(e2e.sealEnvelope(c._key,
                ok("fs", "fs.changed", { root: workspace.getRoot() }))))
                     : c.send(frame);
            } catch (_) {}
          }
        }
      }, 400);
    });
  } catch (e) {
    console.error("[watch] 当前平台不支持递归监听:", e.message);
  }
}

function wsSendPlain(socket, envelope) {
  socket.send(JSON.stringify(envelope));
}

function wsSend(socket, envelope) {
  socket.send(JSON.stringify(
    socket._key ? e2e.sealEnvelope(socket._key, envelope) : envelope));
}

wss.on("connection", (socket, req) => {
  const peerAddr = req?.socket?.remoteAddress || "";   // upgrade 层取地址（Node26 下 socket.remoteAddress 可能 undefined）
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
            cwd: workspace.getRoot(),
            onOutput: (chunk, sessionId) => wsSend(socket, ok(msg.id, "term.output",
              { sessionId, chunk })),
            onExit: (code, sessionId) => wsSend(socket, ok(msg.id, "term.exit",
              { sessionId, exitCode: code })),
          });
          logger.log("info", "terminal", "create", { sessionId: id });
          wsSend(socket, ok(msg.id, "term.create.result", { sessionId: id }));
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

      // ===== 数据面业务算子（客户端⇄服务器只走加密WS，不走HTTP）=====
      case "languages":
        worker.request(null, "registry").then((r) =>
          wsSend(socket, ok(msg.id, "languages.result", r))
        ).catch((e) => wsSend(socket, fail(msg.id, "languages.result", (e.cfError || makeError("CF5003")).code)));
        break;

      case "file.tree":
        wrap(socket, msg, () => workspace.tree(msg.payload?.path || "."));
        break;
      case "file.read":
        wrap(socket, msg, () => workspace.read(msg.payload?.path));
        break;
      case "file.write":
        wrap(socket, msg, async () =>
          workspace.write(msg.payload?.path, msg.payload?.content ?? ""));
        break;
      case "file.create":
        wrap(socket, msg, async () =>
          workspace.create(msg.payload?.path, !!msg.payload?.dir));
        break;
      case "file.rename":
        wrap(socket, msg, async () =>
          workspace.rename(msg.payload?.from, msg.payload?.to));
        break;
      case "file.delete":
        wrap(socket, msg, async () => workspace.remove(msg.payload?.path));
        break;

      case "lint":
        wrap(socket, msg, () => worker.request(null, "lint", {
          file: msg.payload?.file, text: msg.payload?.text,
          lang: msg.payload?.lang, options: msg.payload?.options,
          enabled: msg.payload?.enabled,
        }));
        break;

      case "plan":
        wrap(socket, msg, () => worker.request(null, "plan", {
          file: msg.payload?.file,
          out_dir: "/tmp/cf-build/" + (msg.id || String(Date.now())),
          run_args: msg.payload?.runArgs,
        }));
        break;

      case "search":
        wrap(socket, msg, async () => search(workspace, msg.payload || {}));
        break;
      case "search.replace":
        wrap(socket, msg, async () => replaceAll(workspace, msg.payload || {}));
        break;

      case "logs.tail":
        wrap(socket, msg, async () => logger.tail(msg.payload || {}));
        break;
      case "logs.action":
        logger.log("action", "ui", msg.payload?.event || "unknown",
          { target: msg.payload?.target, args: msg.payload?.args });
        wsSend(socket, ok(msg.id, "logs.action.result", {}));
        break;

      case "toolchain.list":
        wrap(socket, msg, async () => toolchainStore.list(TOOLCHAIN_DIR));
        break;

      // 工作区切根：仅本机回环连接允许（远程连接禁止切到服务器任意目录）
      case "workspace.setRoot":
        if (!isLocalAddr(peerAddr)) {
          wsSend(socket, fail(msg.id, "workspace.setRoot.result", "CF1002",
            { message: "远程连接不允许切换工作区根" }));
          break;
        }
        wrap(socket, msg, async () => {
          const r = workspace.setRoot(msg.payload?.root);
          watchWorkspace();
          return r;
        });
        break;
      case "workspace.getRoot":
        wrap(socket, msg, async () => ({ root: workspace.getRoot() }));
        break;

      default:
        wsSend(socket, fail(msg.id, msg.type + ".result", "CF0001",
          {}, { message: `未知类型 ${msg.type}` }));
    }
  });
});

watchWorkspace();

server.listen(PORT, () => {
  console.log(`[codeforge-server] http://localhost:${PORT}  ws://localhost:${PORT}/ws`);
});
