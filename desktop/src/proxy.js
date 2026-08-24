/// 本地加速器代理（随应用自启，任务 #22）：
/// - 监听 127.0.0.1:7788 处理 HTTP CONNECT —— 覆盖所有 HTTPS 站点（GitHub/X 全兼容）
/// - 每个连接开一条 /relay WS 隧道：控制帧(目标地址) → 双向二进制对拷
/// - 隧道断开自动重连由调用方/前端状态面板感知；连接级失败回 502
const http = require("http");

let relayUrl = process.env.CODEFORGE_RELAY || "ws://localhost:8787/relay";
let status = { running: false, connected: false, port: null, activeConns: 0 };

function configure(opts = {}) {
  if (opts.relayUrl) relayUrl = opts.relayUrl;
}

function getStatus() { return { ...status, relayUrl }; }

/// CONNECT 隧道：clientSocket ⇄ /relay WS ⇄ 目标 TCP
function pipeConnect(clientSocket, host, port, head) {
  const WebSocket = require("ws");
  const ws = new WebSocket(relayUrl);
  let established = false;

  const fail = () => {
    if (established) { try { clientSocket.destroy(); } catch (_) {} return; }
    try { clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch (_) {}
  };

  clientSocket.on("error", () => { try { ws.close(); } catch (_) {} });
  ws.on("error", fail);
  ws.on("close", () => { try { clientSocket.destroy(); } catch (_) {} });

  ws.on("open", () => {
    // 控制帧（TEXT）：告知目标地址
    ws.send(JSON.stringify({ host, port }), () => {
      established = true;
      try { clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); } catch (_) {}
      // CONNECT 头里捎带的首包（少见但规范允许）补发
      if (head?.length) ws.send(head);
    });
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) { try { clientSocket.write(data); } catch (_) {} }
  });

  clientSocket.on("data", (d) => {
    if (established) { try { ws.send(d); } catch (_) {} }
  });
  clientSocket.on("close", () => { try { ws.close(); } catch (_) {} });
}

function startAccelerator(opts = {}) {
  configure(opts);
  if (status.running) return getStatus();
  const port = opts.port ?? 7788;

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("CodeForge accelerator\n");
  });

  server.on("connect", (req, clientSocket, head) => {
    try {
      const u = new URL(`http://${req.url}`);
      const host = u.hostname;
      const port2 = Number(u.port || 443);
      status.activeConns++;
      clientSocket.on("close", () => { status.activeConns--; });
      pipeConnect(clientSocket, host, port2, head);
    } catch {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
  });

  server.listen(port, "127.0.0.1", () => setStatus({ running: true, port }));
  server.on("error", () => setStatus({ running: false }));
  return getStatus();
}

module.exports = { startAccelerator, getStatus };
