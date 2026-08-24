/// 加速器中继：桌面端本地代理 ⇄ 服务器转发出口
///
/// 协议（/relay WebSocket）：
///   1. 首帧必须是 TEXT 控制帧：{"host":"github.com","port":443}
///   2. 之后全部为 BINARY 帧 = 原始 TCP 载荷，双向对拷
///   3. 任一侧关闭即级联关闭
const net = require("net");
const { WebSocketServer } = require("ws");
const e2e = require("./crypto-channel");

function attachRelay(server) {
  const wss = new WebSocketServer({ noServer: true });
  const E2E_REQUIRED = process.env.CODEFORGE_E2E === "1";

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname !== "/relay") return;   // /ws 由主 WSS 处理
    // 隧道鉴权（任务#26）：CODEFORGE_TOKEN 设置时必须 ?token= 匹配
    if (process.env.CODEFORGE_RELAY_TOKEN) {
      const token = new URL(req.url, "http://localhost").searchParams.get("token") || "";
      const expect = process.env.CODEFORGE_RELAY_TOKEN;
      const okEq = token.length === expect.length &&
        require("crypto").timingSafeEqual(Buffer.from(token), Buffer.from(expect));
      if (!okEq) { socket.destroy(); return; }
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
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
          if (!c.host || !c.port) throw new Error("bad control");
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
