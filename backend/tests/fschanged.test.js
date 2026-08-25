/// 文件变更监听测试：写文件 → 服务器广播 fs.changed（任务 #4）
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const SERVER_JS = path.join(__dirname, "..", "src", "index.js");
const PORT = 8949;

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server not healthy");
}

test("外部写入触发 fs.changed 广播", async () => {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cf-watch-"));
  const child = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, PORT: String(PORT), CODEFORGE_WS: wsRoot },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitHealth();

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  // 握手
  const ready = new Promise((res) => ws.once("message", () => res()));
  ws.send(JSON.stringify({ v: 1, id: "hello", type: "hello",
    payload: { client: "desktop" } }));
  await ready;

  // 外部直接写文件（不经 API）
  const changed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fs.changed 未在 8 秒内到达")), 3000);
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "fs.changed" && m.payload?.root === wsRoot) {
        clearTimeout(timer);
        resolve(m.payload);
      }
    });
  });
  fs.writeFileSync(path.join(wsRoot, "external.txt"), "changed from outside\n");

  const payload = await changed;
  assert.strictEqual(payload.root, wsRoot);
  ws.close();
  child.kill();
  fs.rmSync(wsRoot, { recursive: true, force: true });
}, { timeout: 20_000 });
