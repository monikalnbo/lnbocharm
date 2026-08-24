/// 加速器中继：桌面端本地代理 ⇄ 服务器转发出口
///
/// 协议（/relay WebSocket）：
///   1. 首帧必须是 TEXT 控制帧：{"host":"github.com","port":443}
///   2. 之后全部为 BINARY 帧 = 原始 TCP 载荷，双向对拷
///   3. 任一侧关闭即级联关闭
const net = require("net");
const { WebSocketServer } = require("ws");

function attachRelay(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname !== "/relay") return;   // /ws 由主 WSS 处理
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    let target = null;
    let controlDone = false;

    ws.on("message", (data, isBinary) => {
      if (!controlDone) {
        // 控制帧：目标地址
        if (isBinary) { ws.close(4002, "first frame must be control"); return; }
        try {
          const c = JSON.parse(data.toString());
          if (!c.host || !c.port) throw new Error("bad control");
          target = net.connect(c.port, c.host);
          target.on("data", (d) => { try { ws.send(d); } catch (_) {} });
          target.on("error", () => { try { ws.close(4003, "target error"); } catch (_) {} });
          target.on("close", () => { try { ws.close(1000); } catch (_) {} });
          controlDone = true;
        } catch {
          ws.close(4002, "bad control frame");
        }
        return;
      }
      if (!isBinary || !target) return;
      try { target.write(data); } catch (_) {}
    });

    ws.on("close", () => { if (target) target.destroy(); });
    ws.on("error", () => { if (target) target.destroy(); });
  });

  return wss;
}

module.exports = { attachRelay };
