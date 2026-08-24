/// WebSocket 统一信封协议客户端
/// - hello 握手（v:1, client:desktop）
/// - request(type,payload) → Promise（按 id 关联）
/// - on(type, handler) 订阅服务器推送事件
import { reactive } from "vue";

export const wsState = reactive({ connected: false });

let socket = null;
let seq = 0;
const pending = new Map();     // id -> {resolve, reject, timer}
const handlers = new Map();    // type -> [fn]
const queue = [];              // 未连接时的待发帧

function send(obj) {
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
      while (queue.length) send(queue.shift());
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
