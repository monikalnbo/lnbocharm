/// E2E 加密通道（客户端/服务器共用，Node 端实现；前端用 WebCrypto 同规格实现）：
///   1. ECDH P-256 临时密钥交换（双方各发 SPKI base64）
///   2. 共享密钥 SHA-256 → AES-256-GCM 会话密钥
///   3. 帧 = [12B nonce][ciphertext][16B tag] → base64（与 WebCrypto 密文格式一致）
/// 中继服务器只见密文，不可读。
const crypto = require("crypto");

const CURVE = "prime256v1";

function genEcdh() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: CURVE });
  return {
    publicBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey,
    publicKey,
  };
}

function deriveKey(privateKey, peerPublicBase64) {
  const peer = crypto.createPublicKey({
    key: Buffer.from(peerPublicBase64, "base64"),
    format: "der", type: "spki",
  });
  const secret = crypto.diffieHellman({ privateKey, publicKey: peer });
  return crypto.createHash("sha256").update(secret).digest();   // 32B AES key
}

function seal(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);    // WebCrypto 兼容格式
}

function open(key, sealed) {
  const buf = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed);
  if (buf.length < 12 + 16) throw new Error("frame too short");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** 加密封包：整信封（id/type/payload）进密文，仅保留 {v, e:1, d} —— 防元数据泄露 */
function sealEnvelope(key, envelope) {
  const plain = JSON.stringify({ id: envelope.id, type: envelope.type,
                                 ok: envelope.ok, payload: envelope.payload ?? {},
                                 error: envelope.error });
  const sealed = seal(key, Buffer.from(plain, "utf8"));
  return { v: envelope.v ?? 1, e: 1, d: sealed.toString("base64") };
}

/** 解开封包；非加密帧原样返回。密文内含完整信封（id/type/payload） */
function openEnvelope(key, msg) {
  if (!msg || !msg.e || !msg.d) return msg;
  const plain = open(key, Buffer.from(msg.d, "base64")).toString("utf8");
  const inner = JSON.parse(plain);
  const { e, d, ...cleanMsg } = msg;
  void e; void d;
  return { ...cleanMsg, ...inner };
}

module.exports = { genEcdh, deriveKey, seal, open, sealEnvelope, openEnvelope };
