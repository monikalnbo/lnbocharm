/// 本地代理端到端测试：CONNECT 隧道 → fake relay → echo 目标
/// 同时回归 setStatus 未定义导致的启动崩溃（任务#22 引入）
const test = require("node:test");
const assert = require("node:assert");
const net = require("net");
const { WebSocketServer } = require("ws");
const { startAccelerator, stopAccelerator, getStatus } = require("../src/proxy");

test("加速器 CONNECT 隧道往返 + 状态对象", async () => {
  // 1. echo 目标服务器
  const echo = net.createServer((sock) => sock.pipe(sock));
  const echoPort = await new Promise((res) => {
    echo.listen(0, "127.0.0.1", () => res(echo.address().port));
  });

  // 2. fake relay（与服务器 relay.js 同协议：控制帧 TEXT + 二进制对拷）
  const wss = new WebSocketServer({ port: 0 });
  const relayClients = new Set();
  const relayPort = wss.address().port;
  wss.on("connection", (ws) => {
    relayClients.add(ws);
    ws.on("close", () => relayClients.delete(ws));
    let target = null;
    ws.on("message", (data, isBinary) => {
      if (!controlDone(data, isBinary)) return;
      if (isBinary && target) target.write(data);
    });
    function controlDone(data, isBinary) {
      if (target) return true;
      const c = JSON.parse(data.toString());
      target = net.connect(c.port, c.host);
      target.on("data", (d) => ws.send(d));
      return false;
    }
  });

  // 3. 启动本地加速器
  const st = await startAccelerator({ port: 17890, relayUrl: `ws://127.0.0.1:${relayPort}/relay` });
  assert.strictEqual(st.running, true);           // 回归：setStatus 崩溃点

  // 4. 走 CONNECT 隧道发数据，期待回声
  const result = await new Promise((resolve, reject) => {
    let sock;
    const timer = setTimeout(() => reject(new Error("timeout")), 5000);
    sock = net.connect(17890, "127.0.0.1", () => {
      sock.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\n\r\n`);
    });
    let buf = "";
    let stage = "connect";
    sock.on("data", (d) => {
      buf += d.toString();
      if (stage === "connect" && buf.includes("200")) {
        stage = "tunnel";
        sock.write("PING-THROUGH-PROXY");
        return;
      }
      if (stage === "tunnel" && buf.includes("PING-THROUGH-PROXY")) {
        clearTimeout(timer);
        resolve(buf);
      }
    });
    const _unusedTimer = null;
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
  });

  assert.ok(result.includes("HTTP/1.1 200"));
  assert.ok(result.includes("PING-THROUGH-PROXY"));
  assert.strictEqual(getStatus().running, true);

  stopAccelerator();
  try { sock.destroy(); } catch (_) {}
  echo.close();
  for (const c of relayClients) { try { c.terminate(); } catch (_) {} }
  wss.close();
  // 隧道相关 TCP 句柄的对端关闭有延迟，主动结束测试进程
  setTimeout(() => process.exit(0), 300);
}, { timeout: 15_000 });
