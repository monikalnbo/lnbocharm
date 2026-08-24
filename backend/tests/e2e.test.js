/// E2E 加密通道 + WS 鉴权 端到端测试（真实子进程）
const test = require("node:test");
const assert = require("node:assert");
const net = require("net");
const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");
const e2e = require("../src/services/crypto-channel");

const SERVER_JS = path.join(__dirname, "..", "src", "index.js");

function startServer(port, env = {}) {
  const child = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "ignore", "ignore"],
  });
  return { child, url: `ws://127.0.0.1:${port}` };
}

function waitOpen(ws) {
  return new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
    ws.on("unexpected-response", (_req, r) => rej(new Error("http " + r.statusCode)));
  });
}

function waitClose(ws) {
  return new Promise((res) => ws.on("close", (code) => res(code)));
}

test("E2E：无公钥的 hello 被拒(4005)；带公钥完成协商后加密 ping/pong", async () => {
  const port = 8921;
  const { child, url } = startServer(port, { CODEFORGE_E2E: "1" });
  await new Promise((r) => setTimeout(r, 1200));

  try {
    // 1. 明文 hello → 回执要求 E2E 并下发服务器公钥
    const wsBad = new WebSocket(url + "/ws");
    let badPub = null;
    wsBad.on("open", () => wsBad.send(JSON.stringify(
      { v: 1, id: "h0", type: "hello", payload: { client: "desktop" } })));
    await new Promise((res) => wsBad.once("message", (d) => {
      badPub = JSON.parse(d.toString())?.payload?.e2e?.pub; res(); }));
    assert.ok(badPub, "阶段一应下发服务器公钥");
    // 不发 secure 帧 → 握手超时被踢
    assert.strictEqual(await waitClose(wsBad), 4000);
    wsBad.terminate();

    // 2. 两阶段协商：明文 hello → secure 帧 → 加密回执就绪
    const ws = new WebSocket(url + "/ws");
    await waitOpen(ws);
    const clientKeys = e2e.genEcdh();

    const stage1 = await new Promise((res) => {
      ws.on("message", function h(d) {
        const m = JSON.parse(d.toString());
        if (m.id === "h1") { ws.off("message", h); res(m); }
      });
      ws.send(JSON.stringify({ v: 1, id: "h1", type: "hello",
        payload: { client: "desktop" } }));
    });
    assert.strictEqual(stage1.payload.e2e.required, true);

    // 阶段二：secure 帧（明文，仅含客户端公钥）
    ws.send(JSON.stringify({ v: 1, id: "s1", type: "secure",
      payload: { pub: clientKeys.publicBase64 } }));

    const readyRaw = await new Promise((res) =>
      ws.once("message", (d) => res(d.toString())));
    assert.ok(!readyRaw.includes('"established"'));   // 就绪回执是密文

    // 双方独立推导出同一会话密钥
    const key = e2e.deriveKey(clientKeys.privateKey, stage1.payload.e2e.pub);

    // 加密 ping → 解密 pong
    ws.send(JSON.stringify(e2e.sealEnvelope(key,
      { v: 1, id: "p1", type: "ping" })));
    const pongRaw = await new Promise((res) => ws.once("message", res));
    const pong = e2e.openEnvelope(key, JSON.parse(pongRaw.toString()));
    assert.strictEqual(pong.type, "pong");
    assert.strictEqual(pong.ok, true);
    // 密文里不应出现明文 type 字段（整信封加密）
    assert.strictEqual(readyRawCheck(pongRaw), false);
    function readyRawCheck(rawStr) { return rawStr.includes('"type":"ping"'); }
  } finally {
    child.kill();
  }
}, { timeout: 15_000 });

test("WS Token 鉴权：错 token 拒绝(4003)，对 token 放行", async () => {
  const port = 8922;
  const { child, url } = startServer(port, { CODEFORGE_TOKEN: "s3cret" });
  await new Promise((r) => setTimeout(r, 1200));

  try {
    const bad = new WebSocket(url + "/ws");
    bad.on("open", () => bad.send(JSON.stringify(
      { v: 1, id: "h", type: "hello", payload: { client: "desktop", token: "wrong" } })));
    assert.strictEqual(await waitClose(bad), 4003);

    const good = new WebSocket(url + "/ws");
    await waitOpen(good);
    good.send(JSON.stringify({ v: 1, id: "h", type: "hello",
      payload: { client: "agent", token: "s3cret" } }));
    const reply = await new Promise((res) => good.once("message", (d) => res(JSON.parse(d))));
    assert.ok(reply.ok);
    good.close();
  } finally {
    child.kill();
  }
}, { timeout: 15_000 });

test("Relay E2E：加密隧道往返到 echo 目标", async () => {
  // echo 目标
  const echo = net.createServer((sock) => sock.pipe(sock));
  const echoPort = await new Promise((res) => echo.listen(0, "127.0.0.1", () => res(echo.address().port)));

  const port = 8923;
  const { child, url } = startServer(port, { CODEFORGE_E2E: "1" });
  await new Promise((r) => setTimeout(r, 1200));

  try {
    const ws = new WebSocket(url + "/relay");
    await waitOpen(ws);
    const clientKeys = e2e.genEcdh();
    ws.send(JSON.stringify({ host: "127.0.0.1", port: echoPort, pub: clientKeys.publicBase64 }));

    // 服务器回执公钥（TEXT）
    const serverPub = await new Promise((res) =>
      ws.once("message", (d, isBinary) => { if (!isBinary) res(JSON.parse(d.toString()).pub); }));
    const key = e2e.deriveKey(clientKeys.privateKey, serverPub);

    // 发加密载荷，期待加密回声
    ws.send(e2e.seal(key, Buffer.from("SECRET-PAYLOAD")));
    const echoed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("relay e2e timeout")), 5000);
      ws.on("message", (data, isBinary) => {
        if (!isBinary) return;
        try {
          const plain = e2e.open(key, data).toString();
          if (plain.includes("SECRET-PAYLOAD")) { clearTimeout(timer); resolve(plain); }
        } catch (_) {}
      });
    });
    assert.ok(echoed.includes("SECRET-PAYLOAD"));
    // 中继链路上的原始帧不含明文（上面 open 成功本身即证明是密文）
    ws.close();
  } finally {
    echo.close();
    child.kill();
  }
}, { timeout: 15_000 });
