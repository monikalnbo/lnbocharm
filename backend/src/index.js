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

const PORT = process.env.PORT || 8787;
const WORKSPACE = process.env.CODEFORGE_WS || path.join(__dirname, "..", "..", "workspace-demo");

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "..", "frontend", "dist")));

const worker = getPyWorker();
const workspace = new Workspace(WORKSPACE);

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

// Lint（经 pyworker）
app.post("/api/lint", async (req, res) => {
  try {
    const result = await worker.request("lint-" + Date.now(), "lint", {
      file: req.body.file, text: req.body.text,
      lang: req.body.lang, options: req.body.options,
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
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket, req) => {
  let handshaken = false;
  const kick = setTimeout(() => socket.close(4000, "handshake timeout"), 10_000);

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
      socket.send(JSON.stringify(ok(msg.id, "hello.ok",
        { server: "codeforge", protocol: msg.v, client: hs.client, version: hs.version })));
      return;
    }

    switch (msg.type) {
      case "ping":
        socket.send(JSON.stringify(ok(msg.id, "pong")));
        break;
      case "build.start": {
        // 服务器原生构建：先 plan 再执行（执行器任务 #13 接入）
        worker.request(msg.id, "plan", {
          file: msg.payload?.file, out_dir: "/tmp/cf-build/" + (msg.id || "x"),
        }).then((plan) => {
          socket.send(JSON.stringify(ok(msg.id, "build.plan", plan)));
        }).catch((e) => {
          const err = e.cfError || makeError("CF2003");
          socket.send(JSON.stringify(fail(msg.id, "build.plan", err.code, err.details || {})));
        });
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
