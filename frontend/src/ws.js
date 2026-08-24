/// WebSocket 统一信封协议客户端
/// - hello 握手（v:1, client:desktop）
/// - request(type,payload) → Promise（按 id 关联）
/// - on(type, handler) 订阅服务器推送事件
import { reactive } from "vue";

export const wsState = reactive({ connected: false });

// ---------- E2E 加密（与服务端 crypto-channel.js 同规格）----------
// 帧 = [12B nonce][ct][16B tag] → base64；密文内含完整信封
const subtle = crypto.subtle;
const b64 = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
  dec: (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0)),
};
async function genPair() {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" },
                                        true, ["deriveBits"]);
  const spki = await subtle.exportKey("spki", pair.publicKey);
  return { pair, pubB64: b64.enc(spki) };
}
async function deriveKey(pair, serverPubB64) {
  const peer = await subtle.importKey("spki", b64.dec(serverPubB64),
    { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await subtle.deriveBits({ name: "ECDH", public: peer }, pair.privateKey, 256);
  const hashed = await subtle.digest("SHA-256", bits);   // 与服务端 sha256 对齐
  return subtle.importKey("raw", hashed, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(key, envelope) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(
    { id: envelope.id, type: envelope.type, ok: envelope.ok,
      payload: envelope.payload ?? {}, error: envelope.error }));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const frame = new Uint8Array(iv.length + ct.length);
  frame.set(iv); frame.set(ct, iv.length);
  return { v: envelope.v ?? 1, e: 1, d: b64.enc(frame.buffer) };
}
async function open(key, msg) {
  const frame = b64.dec(msg.d);
  const iv = frame.slice(0, 12);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv }, key, frame.slice(12));
  const inner = JSON.parse(new TextDecoder().decode(pt));
  return { ...msg, ...inner };
}
let e2eKey = null;   // 协商成功后置位

let socket = null;
let seq = 0;
const pending = new Map();     // id -> {resolve, reject, timer}
const handlers = new Map();    // type -> [fn]
const queue = [];              // 未连接时的待发帧

function send(obj) {
  if (socket?.readyState !== WebSocket.OPEN) { queue.push(obj); return; }
  if (e2eKey) { seal(e2eKey, obj).then((f) => socket.send(JSON.stringify(f))).catch(() => {}); }
  else _sendRaw(obj);
}
function _sendRaw(obj) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
  else queue.push(obj);
}

export function wsRequest(type, payload = {}, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const id = "r" + (++seq);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`请求超时: ${type}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    send({ v: 1, id, type, payload });
  });
}

export function wsNotify(type, payload = {}) {
  send({ v: 1, id: "n" + (++seq), type, payload });
}

export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, []);
  handlers.get(type).push(fn);
}

function dispatch(msg) {
  if (msg.id && msg.id.startsWith("r") && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.payload);
    else {
      const e = new Error(msg.error?.message || msg.error?.code || "error");
      e.cf = msg.error;
      p.reject(e);
    }
    return;
  }
  // 推送事件
  for (const fn of handlers.get(msg.type) || []) fn(msg.payload ?? msg);
}

export function wsConnect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/ws`);

  socket.onopen = () => {
    send({ v: 1, id: "hello", type: "hello", payload: { client: "desktop", version: "0.1.0" } });
  };
  socket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "hello.ok" && !wsState.connected) {
      wsState.connected = true;
      if (msg.payload?.e2e?.pub && e2ePending) {
        deriveKey(e2ePending.pair, msg.payload.e2e.pub).then((k) => {
          e2eKey = k;
          while (queue.length) _sendRaw(queue.shift());
        });
        return;   // 密钥就绪后再冲队列，保证队列帧全部加密
      }
      while (queue.length) send(queue.shift());
      return;
    }
    if (msg.e === 1 && e2eKey) {
      open(e2eKey, msg).then(dispatch).catch(() => {});
      return;
    }
    dispatch(msg);
  };
  socket.onclose = () => {
    wsState.connected = false;
    setTimeout(wsConnect, 3000);   // 自动重连
  };
  socket.onerror = () => socket.close();
}
