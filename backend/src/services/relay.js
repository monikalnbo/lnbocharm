/// 加速器中继：桌面端本地代理 ⇄ 服务器转发出口
///
/// 协议（/relay WebSocket）：
///   1. 首帧必须是 TEXT 控制帧：{"host":"github.com","port":443}
///   2. 之后全部为 BINARY 帧 = 原始 TCP 载荷，双向对拷
///   3. 任一侧关闭即级联关闭
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const e2e = require("./crypto-channel");

/// 设备指纹白名单：CODEFORGE_RELAY_FPS 环境变量(CSV) 优先，
/// 否则读 ~/.codeforge/relay-fps.json {"fps":[...]}。均未配置 = 不启用白名单。
function loadAllowlist() {
  if (process.env.CODEFORGE_RELAY_FPS) {
    return process.env.CODEFORGE_RELAY_FPS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  try {
    const f = path.join(os.homedir(), ".codeforge", "relay-fps.json");
    return JSON.parse(fs.readFileSync(f, "utf8")).fps || [];
  } catch { return []; }
}

function attachRelay(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  const E2E_REQUIRED = process.env.CODEFORGE_E2E === "1";

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname !== "/relay") return;   // /ws 由主 WSS 处理
    // ① token 鉴权（常量时间比较）
    if (process.env.CODEFORGE_RELAY_TOKEN) {
      const token = new URL(req.url, "http://localhost").searchParams.get("token") || "";
      const expect = process.env.CODEFORGE_RELAY_TOKEN;
      const okEq = token.length === expect.length &&
        crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expect));
      if (!okEq) { socket.destroy(); return; }
    }

    // ② 设备指纹白名单：配置了就强制，未列入即拒绝（默认拒绝未知设备）
    const fps = loadAllowlist();
    if (fps.length) {
      const fp = new URL(req.url, "http://localhost").searchParams.get("fp") || "";
      if (!fps.includes(fp)) {
        console.error(`[relay] ⛔ 拒绝未知设备指纹: "${fp || "(空)"}" — 将其加入白名单以放行`);
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const ipConns = new Map();           // ip -> 当前连接数
  const MAX_PER_IP = Number(process.env.CODEFORGE_RELAY_MAX_CONN || 32);

  wss.on("connection", (ws, req) => {
    const ip = req?.socket?.remoteAddress || "unknown";
    const cur = ipConns.get(ip) || 0;
    if (cur >= MAX_PER_IP) {
      console.error(`[relay] ⛔ ${ip} 连接数超限 (${cur})`);
      ws.close(4008, "too many connections");
      return;
    }
    ipConns.set(ip, cur + 1);
    ws.once("close", () => {
      const n = (ipConns.get(ip) || 1) - 1;
      if (n <= 0) ipConns.delete(ip); else ipConns.set(ip, n);
    });
    let target = null;
    let controlDone = false;
    let key = null;                      // E2E 会话密钥（可选）

    ws.on("message", (data, isBinary) => {
      try {
        if (!controlDone) {
          if (isBinary) { ws.close(4002, "first frame must be control"); return; }
          let plain = data.toString();
          // 控制帧本身可能是加密的（{"e":1,"d":...}）——但首帧无共享密钥，
          // 因此控制帧明文携带客户端公钥，服务器回执服务器公钥，此后二进制帧加密
          const c = JSON.parse(plain);
          c.port = Number(c.port);
          if (!c.host || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
            throw new Error("bad port");
          // 目标白名单（任务 #14）：配置 CODEFORGE_RELAY_HOSTS 后仅允许列出的主机
          // 支持 .example.com 后缀通配；未配置 = 允许全部（本地开发）
          if (process.env.CODEFORGE_RELAY_HOSTS) {
            const allowed = process.env.CODEFORGE_RELAY_HOSTS.split(",").map((x) => x.trim().toLowerCase());
            const host = String(c.host).toLowerCase();
            const okHost = allowed.some((a) =>
              host === a || (a.startsWith(".") && (host.endsWith(a) || host === a.slice(1))));
            if (!okHost) {
              console.error(`[relay] ⛔ 目标不在白名单: ${host}:${c.port}`);
              ws.close(4007, "host not allowed");
              return;
            }
          }
          if (E2E_REQUIRED || c.pub) {
            if (!c.pub) { ws.close(4005, "e2e required"); return; }
            const serverKeys = e2e.genEcdh();
            key = e2e.deriveKey(serverKeys.privateKey, c.pub);
            ws.send(JSON.stringify({ pub: serverKeys.publicBase64 }));
          }
          target = net.connect(c.port, c.host);
          target.on("data", (d) => {
            try { ws.send(key ? e2e.seal(key, d) : d); } catch (_) {}
          });
          target.on("error", () => { try { ws.close(4003, "target error"); } catch (_) {} });
          target.on("close", () => { try { ws.close(1000); } catch (_) {} });
          controlDone = true;
          return;
        }
        if (!isBinary || !target) return;
        const plain = key ? e2e.open(key, data) : data;
        target.write(plain);
      } catch {
        try { ws.close(4006, "decrypt error"); } catch (_) {}
      }
    });

    ws.on("close", () => { if (target) target.destroy(); });
    ws.on("error", () => { if (target) target.destroy(); });
  });

  return wss;
}

module.exports = { attachRelay };
