/// 全链路日志：内存环形缓冲（查询用）+ 按天滚动文件（持久化）。
/// 统一结构：{ ts, level, source, event, ...data }
/// source: http | ws | build | lint | file | terminal | lsp | ui | pyworker
const fs = require("fs");
const path = require("path");

const RING_MAX = 2000;
const ring = [];
let logDir = null;
let currentStream = null;
let currentDate = null;

const RETENTION_DAYS = 14;

function initFile(dir) {
  logDir = dir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  cleanupOld();
}

/// 保留策略：删除超过 RETENTION_DAYS 的旧日志（任务 #34 磁盘卫生）
function cleanupOld() {
  if (!logDir) return;
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    for (const f of fs.readdirSync(logDir)) {
      const m = /^codeforge-\d{4}-\d{2}-\d{2}\.log$/.exec(f);
      if (!m) continue;
      const abs = path.join(logDir, f);
      if (fs.statSync(abs).mtimeMs < cutoff) fs.unlinkSync(abs);
    }
  } catch (_) {}
}

function _stream() {
  const day = new Date().toISOString().slice(0, 10);
  if (!logDir) return null;
  if (currentDate !== day || !currentStream) {
    try { currentStream?.end(); } catch (_) {}
    currentDate = day;
    currentStream = fs.createWriteStream(path.join(logDir, `codeforge-${day}.log`), { flags: "a" });
  }
  return currentStream;
}

function log(level, source, event, data = {}) {
  const rec = { ts: new Date().toISOString(), level, source, event, ...data };
  ring.push(rec);
  if (ring.length > RING_MAX) ring.shift();
  const s = _stream();
  const line = JSON.stringify(rec) + "\n";
  if (s) s.write(line);
  else process.stdout.write(line);
  return rec;
}

/// 查询：倒序返回，可按级别/来源过滤
function tail({ limit = 300, level, source } = {}) {
  limit = Number.isFinite(+limit) && +limit > 0 ? Math.min(+limit, RING_MAX) : 300;
  let out = [...ring].reverse();
  if (level) out = out.filter((r) => r.level === level);
  if (source) out = out.filter((r) => r.source === source);
  return out.slice(0, limit);
}

module.exports = { log, tail, initFile, ring };
