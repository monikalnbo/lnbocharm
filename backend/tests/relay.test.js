const test = require("node:test");
const assert = require("node:assert");
const net = require("net");
const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");
require("./orphan-guard.js");
/// 无 keep-alive 的健康检查/状态请求（防 CLOSE_WAIT 悬挂测试进程）
const http = require("http");
function httpProbe(port, p, method = "GET") {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, agent: false },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
    req.on("error", () => resolve(null));
    if (method !== "GET") req.write("{}");
    req.end();
  });
}


/// 端到端：/relay 隧道 → 本机 echo 服务器（模拟任意 TCP 目标）
test("relay 中继往返", async () => {
  // 1. echo 目标服务器
  const echo = net.createServer((sock) => sock.pipe(sock));
  const echoPort = await new Promise((res) => {
    echo.listen(0, "127.0.0.1", () => res(echo.address().port));
  });

  // 2. 启动后端
  const serverPath = path.join(__dirname, "..", "src", "index.js");
  const proc = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: "0" },   // index.js 支持 env.PORT；0=随机端口需读日志，改用固定高位端口
  });
  // PORT=0 时监听随机端口——从 stdout 拿不到端口，改回固定：
  proc.kill();
  const PORT = 8911;
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "ignore", "ignore"],
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await httpProbe(PORT, "/api/health"); if (r && r.status === 200) break; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }

  try {
    // 3. 连接 /relay：控制帧 + 二进制载荷
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/relay`);
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

    ws.send(JSON.stringify({ host: "127.0.0.1", port: echoPort }));

    const got = await new Promise((resolve, reject) => {
      const chunks = [];
      const timer = setTimeout(() => reject(new Error("relay timeout")), 5000);
      ws.on("message", (data, isBinary) => {
        if (!isBinary) return;
        chunks.push(data);
        if (Buffer.concat(chunks).includes("PING")) {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString());
        }
      });
      ws.send(Buffer.from("PING"));
    });
    assert.ok(got.includes("PING"));
    ws.close();
  } finally {
    echo.close();
    child.kill();
  }
}, { timeout: 15_000 });
