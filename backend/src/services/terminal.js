/// 集成终端服务：每个会话一个 PTY。
/// - 会话上限（防资源耗尽）、输出环形缓冲、空闲自动回收（内存任务 #34）
const os = require("os");
const path = require("path");

const MAX_SESSIONS = 8;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const RING_BUFFER_MAX = 512 * 1024;   // 回放缓冲上限

class TerminalService {
  /**
   * @param ptyModule 注入 node-pty（便于测试）；默认 require
   */
  constructor(ptyModule, { idleTimeoutMs = IDLE_TIMEOUT_MS } = {}) {
    this.pty = ptyModule || require("node-pty");
    this.idleTimeoutMs = idleTimeoutMs;
    this.sessions = new Map();  // id -> {pty, buffer, lastActive, idleTimer, onOutput, onExit}
    this._nextId = 1;
  }

  create({ cols = 80, rows = 24, shell, onOutput, onExit } = {}) {
    if (this.sessions.size >= MAX_SESSIONS) {
      const e = new Error("终端会话已达上限 " + MAX_SESSIONS);
      e.cfError = { code: "CF6001", message: e.message,
                    hint: "关闭不用的终端标签页后再试" };
      throw e;
    }
    const id = "t" + this._nextId++;
    const shellBin = shell || process.env.SHELL ||
                     (os.platform() === "win32" ? "powershell.exe" : "bash");
    const ptyProc = this.pty.spawn(shellBin, [], {
      name: "xterm-256color",
      cols, rows,
      cwd: process.env.CODEFORGE_WS || path.join(process.cwd(), "..", "workspace-demo"),
      env: { ...process.env, TERM: "xterm-256color" },
    });

    const session = {
      id, pty: ptyProc,
      buffer: "",
      lastActive: Date.now(),
      idleTimer: null,
      onOutput: onOutput || (() => {}),
      onExit: onExit || (() => {}),
    };
    ptyProc.onData((data) => {
      session.lastActive = Date.now();
      session.buffer += data;
      if (session.buffer.length > RING_BUFFER_MAX)
        session.buffer = session.buffer.slice(-RING_BUFFER_MAX);
      session.onOutput(data, id);          // 服务端主动带上 sessionId，避免调用方闭包竞态
    });
    ptyProc.onExit(({ exitCode }) => {
      this._clearIdle(session);
      this.sessions.delete(id);
      session.onExit(exitCode ?? 0, id);
    });
    this._armIdle(session);
    this.sessions.set(id, session);
    return { id, shell: shellBin };
  }

  write(id, data) {
    const s = this._get(id);
    s.lastActive = Date.now();
    this._armIdle(s);
    s.pty.write(data);
  }

  resize(id, cols, rows) {
    this._get(id).pty.resize(Math.max(2, cols | 0), Math.max(2, rows | 0));
  }

  /** 断线重连回放 */
  replay(id) {
    return this._get(id).buffer;
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    try { s.pty.kill(); } catch (_) {}
    return true;
  }

  list() {
    return [...this.sessions.keys()];
  }

  _get(id) {
    const s = this.sessions.get(id);
    if (!s) {
      const e = new Error("会话不存在");
      e.cfError = { code: "CF6001", message: `终端会话 ${id} 不存在`,
                    hint: "该会话可能已退出，请新建终端" };
      throw e;
    }
    return s;
  }

  _armIdle(session) {
    this._clearIdle(session);
    session.idleTimer = setTimeout(() => this.kill(session.id), this.idleTimeoutMs);
    if (session.idleTimer.unref) session.idleTimer.unref();
  }

  _clearIdle(session) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
  }
}

module.exports = { TerminalService, MAX_SESSIONS, RING_BUFFER_MAX };
