/// 应用锁（任务 #35）：
/// - macOS：Touch ID（systemPreferences.promptTouchID）
/// - Windows/Linux：主密码回退（SHA-256+盐 存储，绝不存明文）
/// - 空闲自动上锁（可配，默认 10 分钟）；凭据区操作可要求二次验证
const { systemPreferences, safeStorage } = require("electron");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");

const SETTINGS_FILE = () => path.join(os.homedir(), ".codeforge", "lock.json");

function loadState() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8")); }
  catch { return { enabled: false, method: "none", salt: null, hash: null }; }
}

function saveState(st) {
  const dir = path.dirname(SETTINGS_FILE());
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 权限收紧：仅属主可读写
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(st), { mode: 0o600 });
  } catch (_) {}
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString("hex");
}

function capabilities() {
  let touchId = false;
  try {
    touchId = process.platform === "darwin" &&
              systemPreferences.canPromptTouchID();
  } catch {}
  return { touchId, windowsHello: false };   // Win Hello 需额外原生模块，暂以密码回退
}

/// 启用锁：mode = 'touchid' | 'password'
function enable({ mode, password }) {
  if (mode === "touchid" && !capabilities().touchId) {
    return { ok: false, hint: "当前设备不支持 Touch ID" };
  }
  const st = { enabled: true, method: mode };
  if (mode === "password") {
    if (!password || password.length < 4) return { ok: false, hint: "密码至少 4 位" };
    st.salt = crypto.randomBytes(8).toString("hex");
    st.hash = hashPassword(password, st.salt);
  }
  saveState(st);
  return { ok: true };
}

function disable() { saveState({ enabled: false, method: "none" }); return { ok: true }; }

function state() {
  const st = loadState();
  return { ...st, caps: capabilities() };
}

/// 解锁验证：Touch ID 走系统弹窗；密码走哈希比对
async function unlock({ password } = {}) {
  const st = loadState();
  if (!st.enabled) return { ok: true };
  if (st.method === "touchid") {
    try {
      await systemPreferences.promptTouchID("解锁 CodeForge");
      return { ok: true };
    } catch (e) {
      return { ok: false, hint: "指纹验证失败或被取消：" + e.message };
    }
  }
  if (password && hashPassword(password, st.salt) === st.hash) return { ok: true };
  return { ok: false, hint: "密码不正确" };
}

module.exports = { capabilities, enable, disable, unlock, state,
                   SETTINGS_FILE };
