/// pyworker 桥：常驻 python3 -m codeforge serve 子进程，JSON 行协议。
/// 崩溃自动重启（≤3 次/分钟，超出抛 CF5003）；请求按 id 关联回包。
const { spawn } = require("child_process");
const path = require("path");
const { makeError } = require("../protocol");

const PYLIB_DIR = path.join(__dirname, "..", "..", "..", "pylib");   // services→src→backend→仓库根
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 3;

let REQ_SEQ = 0;

class PyWorker {
  constructor({ python = "python3" } = {}) {
    this.pythonBin = python;
    this.pending = new Map();   // id -> {resolve, reject, timer}
    this.buffer = "";
    this.restartTimes = [];
    this.stopped = false;
    this._spawn();
  }

  _spawn() {
    if (this._spawning || (this.proc && this.proc.exitCode === null)) return;
    this._spawning = true;
    this.proc = spawn(this.pythonBin, ["-m", "codeforge", "serve"], {
      cwd: PYLIB_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const done = () => { this._spawning = false; };
    this.proc.once("exit", done);
    this.proc.once("error", done);
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (c) => console.error("[pyworker:stderr]", c.trim()));
    // spawn 本身失败(ENOENT 等)：不能让它变成 unhandled error 崩掉服务器
    this.proc.on("error", () => { try { this.proc.kill(); } catch (_) {} });
    // worker 死后写 stdin 会触发 EPIPE：静默吞掉，由 pending 超时/exit 兑现错误
    this.proc.stdin?.on?.("error", () => {});
    this.proc.on("exit", (code) => this._onExit(code));
    // 健康检查：失败即标记未就绪
    this.ready = false;
    this.request("ping", "ping", {}).then(() => { this.ready = true; })
      .catch(() => {});
  }

  _onExit(code) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(makeError("CF5003", { reason: `worker exited (${code})` }));
    }
    this.pending.clear();
    if (this.stopped) return;
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restartTimes.length >= MAX_RESTARTS_PER_WINDOW) return; // 放弃重启，下次请求报错
    this.restartTimes.push(now);
    this._spawn();
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result ?? msg);
      else {
        // 规范化：与 REST 错误通道同构（details 嵌套）
        const { code: ec, message: em, hint: eh, severity: es, ...extra } = msg.error || {};
        p.reject(Object.assign(new Error(em || "error"), {
          cfError: { code: ec || "CF0001", severity: es || "error",
                     message: em || "", hint: eh || "", details: extra },
        }));
      }
    }
  }

  /** op: detect/lint/plan/registry/ping —— id 由内部唯一生成，杜绝调用方碰撞 */
  request(_ignoredId, op, args = {}, timeoutMs = 30_000) {
    const id = "r" + ++REQ_SEQ;
    // 死进程重启同样受 60s/3次 限流约束（此前任意请求可无条件绕过）
    if (!this.proc || this.proc.exitCode !== null) {
      const now = Date.now();
      this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
      if (this.restartTimes.length >= MAX_RESTARTS_PER_WINDOW) {
        const err = makeError("CF5003", { reason: "worker 重启已达限流上限" });
        return Promise.reject(Object.assign(new Error(err.message), { cfError: err }));
      }
      this.restartTimes.push(now);
      try { this._spawn(); } catch (_) {}
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(makeError("CF2002", { timeout: timeoutMs / 1000 }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify({ v: 1, id, op, args }) + "\n");
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(makeError("CF5003", { reason: `写入失败: ${e.message}` }));
      }
    });
  }

  stop() {
    this.stopped = true;
    try { this.proc.stdin.end(); } catch (_) {}
    try { this.proc.kill(); } catch (_) {}
  }
}

let _singleton = null;
function getPyWorker(opts) {
  if (!_singleton) _singleton = new PyWorker(opts);
  return _singleton;
}

module.exports = { PyWorker, getPyWorker };
