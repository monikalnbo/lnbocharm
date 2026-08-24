/// 本地加速器代理（随应用自启，任务 #22）：
/// - 监听 127.0.0.1:7788 处理 HTTP CONNECT —— 覆盖所有 HTTPS 站点（GitHub/X 全兼容）
/// - 每个连接开一条 /relay WS 隧道：控制帧(目标地址) → 双向二进制对拷
/// - 隧道断开自动重连由调用方/前端状态面板感知；连接级失败回 502
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");

// ---- E2E（与服务端 crypto-channel.js 同规格）----
function genEcdh() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey,
  };
}
function deriveKey(privateKey, peerB64) {
  const peer = crypto.createPublicKey({ key: Buffer.from(peerB64, "base64"), format: "der", type: "spki" });
  const secret = crypto.diffieHellman({ privateKey, publicKey: peer });
  return crypto.createHash("sha256").update(secret).digest();
}
function seal(key, buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([iv, c.update(buf), c.final(), c.getAuthTag()]);
}
function open(key, frame) {
  const b = Buffer.from(frame);
  const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12), { authTagLength: 16 });
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]);
}

let relayUrl = process.env.CODEFORGE_RELAY || "ws://localhost:8787/relay";
let deviceFingerprint = "";

/// 稳定设备指纹：首启随机生成并持久化 ~/.codeforge/device-id（32位hex）
function loadDeviceFingerprint() {
  const f = require("path").join(require("os").homedir(), ".codeforge", "device-id");
  try { return fs.readFileSync(f, "utf8").trim(); }
  catch {
    const id = crypto.createHash("sha256")
      .update(require("os").hostname() + require("os").platform() +
              require("os").arch() + crypto.randomBytes(16).toString("hex"))
      .digest("hex").slice(0, 32);
    try {
      fs.mkdirSync(require("path").dirname(f), { recursive: true });
      fs.writeFileSync(f, id, { mode: 0o600 });
    } catch {}
    return id;
  }
}

function buildRelayUrl() {
  const u = new URL(relayUrl);
  if (process.env.CODEFORGE_RELAY_TOKEN) u.searchParams.set("token", process.env.CODEFORGE_RELAY_TOKEN);
  if (deviceFingerprint) u.searchParams.set("fp", deviceFingerprint);
  return u.toString();
}
let status = { running: false, connected: false, port: null, activeConns: 0 };

function configure(opts = {}) {
  if (opts.relayUrl) relayUrl = opts.relayUrl;
  deviceFingerprint = loadDeviceFingerprint();
}

function getStatus() { return { ...status, relayUrl, fingerprint: deviceFingerprint }; }

function setStatus(patch) { Object.assign(status, patch); }   // ← 修复：缺失定义导致启动即崩

/// CONNECT 隧道：clientSocket ⇄ /relay WS ⇄ 目标 TCP
function pipeConnect(clientSocket, host, port, head) {
  const WebSocket = require("ws");
  const ws = new WebSocket(buildRelayUrl());
  let established = false;
  let key = null;
  const myKeys = genEcdh();

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
