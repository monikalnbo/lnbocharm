/// 协议工具：统一信封 + 错误码单一来源加载（shared/error-codes.json）
const fs = require("fs");
const path = require("path");

const PROTOCOL_VERSION = 1;

let _codes = null;
function errorCodes() {
  if (!_codes) {
    const p = path.join(__dirname, "..", "..", "shared", "error-codes.json");
    _codes = JSON.parse(fs.readFileSync(p, "utf8")).codes;
  }
  return _codes;
}

/** 构造错误对象：插槽渲染 {key}，未知码降级不崩 */
function makeError(code, details = {}, override = {}) {
  const meta = errorCodes()[code] || {};
  let message = override.message || meta.message || code;
  let hint = override.hint || meta.hint || "";
  if (Object.keys(details).length) {
    for (const [k, v] of Object.entries(details)) {
      message = message.split(`{${k}}`).join(String(v));
      hint = hint.split(`{${k}}`).join(String(v));
    }
  }
  // details 随错误下发：前端一键补拉等交互需要结构化字段（如 toolchain 名）
  return { code, severity: meta.severity || "error", message, hint,
           details: Object.keys(details).length ? details : undefined };
}

/** 信封：成功响应 */
function ok(id, type, result) {
  return { v: PROTOCOL_VERSION, id, type, ok: true, payload: result ?? {} };
}

/** 信封：错误响应（type 为对应请求的响应类型） */
function fail(id, type, code, details = {}, override = {}) {
  return { v: PROTOCOL_VERSION, id, type, ok: false,
           error: makeError(code, details, override) };
}

/** 校验握手帧；返回 {ok, info} 或 {ok:false, reason} */
function handshake(msg) {
  if (!msg || msg.v !== PROTOCOL_VERSION || msg.type !== "hello") {
    return { ok: false, reason: "first frame must be hello" };
  }
  const c = msg.payload?.client;
  if (!["desktop", "agent"].includes(c)) return { ok: false, reason: "bad client" };
  return { ok: true, client: c, version: msg.payload.version || "unknown" };
}

module.exports = { PROTOCOL_VERSION, errorCodes, makeError, ok, fail, handshake };
