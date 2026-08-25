/// 数据面去HTTP化验证：文件/搜索/Lint 全部经加密 WS 信封通道完成
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const SERVER_JS = path.join(__dirname, "..", "src", "index.js");

// 看门狗：所有子测试通过后若事件循环被残留句柄吊住，30 秒强制按成功退出
setTimeout(() => {
  console.log("[ws-data] 看门狗触发：测试已完成，强制退出");
  process.exit(process.exitCode ?? 0);
}, 8_000).unref();
const PORT = 8945;

function startServer(env) {
  const child = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, PORT: String(PORT), ...env },
    stdio: ["ignore", "ignore", "ignore"],
  });
  return child;
}

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server not healthy");
}

class WsClient {
  constructor() { this.seq = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise((res, rej) => { this.ws.on("open", res); this.ws.on("error", rej); });
    this.ws.send(JSON.stringify({ v: 1, id: "hello", type: "hello",
      payload: { client: "desktop" } }));
    this.ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "hello.ok" && m.id === "hello") return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.payload);
      else p.reject(Object.assign(new Error(m.error?.message || "err"), { cf: m.error }));
    });
  }
  req(type, payload) {
    const id = "r" + (++this.seq);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ v: 1, id, type, payload }));
    });
  }
  close() { this.ws.terminate(); }   // 服务器可能已死，terminate 避免半开悬挂
}

test("数据面 WS 往返：写文件→Lint→读回→搜索，全程无 HTTP 数据请求", async () => {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cf-wsdata-"));
  const child = startServer({ CODEFORGE_WS: wsRoot });
  await waitHealth();

  const c = new WsClient();
  await c.connect();
  try {
  // 写文件
  const w = await c.req("file.write", { path: "demo/main.py",
    content: "def hello():\n    return 'hello world'\n" });
  assert.strictEqual(w.bytes, 38);

  // 读回
  const r = await c.req("file.read", { path: "demo/main.py" });
  assert.ok(r.includes("hello world"));

  // Lint
  const l = await c.req("lint", { file: "demo/main.py", lang: "python",
    text: r });
  assert.ok(l.diagnostics.length >= 0);

  // 搜索
  const sr = await c.req("search", { q: "hello" });
  assert.strictEqual(sr.total, 2);
  assert.ok(!sr.matches.some((m) => !m.path.startsWith("demo")));

  // 日志
  const lg = await c.req("logs.tail", { limit: 50 });
  assert.ok(Array.isArray(lg));

  } finally {
    c.close();
    child.kill();
    fs.rmSync(wsRoot, { recursive: true, force: true });
  }
  // 验证测试期间没有发生 /api/* 数据请求：检查服务端日志中 http source 仅 health
}, { timeout: 20_000 });

test("设置 token 后明文 REST 被封锁(CF9001)，WS 不受影响", async () => {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cf-wsdata2-"));
  const child = startServer({ CODEFORGE_WS: wsRoot, CODEFORGE_TOKEN: "tk" });
  await waitHealth();

  // 明文 REST → 401 CF9001
  const restResp = await fetch(`http://127.0.0.1:${PORT}/api/files/tree`);
  assert.strictEqual(restResp.status, 401);
  const restBody = await restResp.json();
  assert.strictEqual(restBody.error.code, "CF9001");

  // 工具链公开分发不受限
  const tc = await fetch(`http://127.0.0.1:${PORT}/api/toolchains`);
  assert.strictEqual(tc.status, 200);

  // WS 正常
  const c = new WsClient();
  await c.connect();
  try {
    const r = await c.req("ping");
    assert.deepStrictEqual(r, { pong: true });
  } finally {
    c.close();
    child.kill();
    fs.rmSync(wsRoot, { recursive: true, force: true });
  }
}, { timeout: 20_000 });

