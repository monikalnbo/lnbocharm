/// LSP 管理器：按语言启动/池化语言服务器，LSP JSON-RPC(stdio) ↔ 统一信封协议转换。
/// - 服务器缺失 → CF2003 参数化提示（前端可一键补拉，任务#41）
/// - 空闲自动回收；崩溃拒绝挂起请求并在下次请求时重启
/// - 自研 codeforge-py 检查器为补充规则层，诊断在面板按 source 合并
const { spawn } = require("child_process");
const { makeError } = require("../protocol");

/// 各语言语言服务器定义（二进制可在设置/工具链包中覆盖）
const SERVER_DEFS = {
  cpp:        { cmd: "clangd", args: ["--background-index"] },
  c:          { cmd: "clangd", args: ["--background-index"] },   // 与 cpp 共享实例池（按 language 分键）
  rust:       { cmd: "rust-analyzer", args: [] },
  java:       { cmd: "jdtls", args: [] },
  python:     { cmd: "pyright-langserver", args: ["--stdio"] },
  csharp:     { cmd: "omnisharp", args: ["-lsp"] },
  typescript: { cmd: "typescript-language-server", args: ["--stdio"] },
};

const INSTALL_HINTS = {
  clangd: { linux: "sudo apt install clangd", darwin: "brew install llvm",
            win32: "winget install LLVM.LLVM" },
  "rust-analyzer": { linux: "rustup component add rust-analyzer",
                     darwin: "rustup component add rust-analyzer",
                     win32: "rustup component add rust-analyzer" },
  jdtls: { linux: "下载 eclipse.jdt.ls 或使用内置工具链包", darwin: "brew install jdtls",
           win32: "使用内置工具链包" },
  "pyright-langserver": { linux: "npm install -g pyright", darwin: "npm install -g pyright",
                          win32: "npm install -g pyright" },
  omnisharp: { linux: "使用内置工具链包", darwin: "使用内置工具链包", win32: "使用内置工具链包" },
  "typescript-language-server": { linux: "npm install -g typescript typescript-language-server",
                                  darwin: "npm install -g typescript typescript-language-server",
                                  win32: "npm install -g typescript typescript-language-server" },
};

function platKey() {
  return { Windows: "win32", Darwin: "darwin" }[require("os").platform()] || "linux";
}

/// LSP Content-Length 帧解析器
class FrameParser {
  constructor(onFrame) {
    this.buf = Buffer.alloc(0);
    this.onFrame = onFrame;
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const sep = this.buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const header = this.buf.slice(0, sep).toString();
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buf = this.buf.slice(sep + 4); continue; }
      const len = parseInt(m[1], 10);
      const total = sep + 4 + len;
      if (this.buf.length < total) return;
      const body = this.buf.slice(sep + 4, total).toString();
      this.buf = this.buf.slice(total);
      try { this.onFrame(JSON.parse(body)); } catch (_) {}
    }
  }
}

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
    body,
  ]);
}

/// 单个语言服务器进程
class LspProcess {
  constructor(language, def, rootUri, onNotify) {
    this.language = language;
    this.def = def;
    this.rootUri = rootUri;
    this.onNotify = onNotify;         // (method, params) => void
    this.pending = new Map();
    this.nextId = 1;
    this.lastUsed = Date.now();
    this.exited = false;

    this.proc = spawn(def.cmd, def.args, { cwd: rootUri ? require("url").fileURLToPath(rootUri) : undefined });
    const parser = new FrameParser((msg) => this._onMessage(msg));
    // 注意：不设 encoding，保持 Buffer 流入帧解析器
    this.proc.stdout.on("data", (chunk) => parser.push(chunk));
    this.proc.on("exit", () => {
      this.exited = true;
      for (const [, p] of this.pending) {
        p.reject(makeError("CF5003", { reason: `${this.def.cmd} 已退出` }));
      }
      this.pending.clear();
    });
  }

  _onMessage(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)
        && this.pending.has(msg.id)) {
      // 响应
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(makeError("CF0001", {}, { message: msg.error.message || "LSP error" }));
      else p.resolve(msg.result);
    } else if (msg.id !== undefined && msg.method) {
      // 服务器主动请求：一律回空结果防挂起
      this._write({ jsonrpc: "2.0", id: msg.id, result: null });
    } else if (msg.method) {
      // 服务器通知：publishDiagnostics 等
      this.onNotify(msg.method, msg.params);
    }
  }

  _write(obj) { try { this.proc.stdin.write(frame(obj)); } catch (_) {} }

  request(method, params, timeoutMs = 15_000) {
    if (this.exited) throw makeError("CF5003", { reason: `${this.def.cmd} 未运行` });
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(makeError("CF2002", { timeout: timeoutMs / 1000 }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.lastUsed = Date.now();
      this._write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.lastUsed = Date.now();
    this._write({ jsonrpc: "2.0", method, params });
  }

  async initialize() {
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri: this.rootUri || null,
      capabilities: {},
    }, 20_000);
    this.notify("initialized", {});
    return result;
  }

  kill() {
    try { this.proc.kill(); } catch (_) {}
  }
}

/// 语言服务器池
class LspManager {
  /**
   * @param opts.servers 覆盖 SERVER_DEFS（测试注入 fake server）
   * @param opts.which   注入 which 函数（测试）
   * @param opts.idleTimeoutMs 空闲回收
   */
  constructor(opts = {}) {
    this.serversDef = { ...SERVER_DEFS, ...(opts.servers || {}) };
    this.which = opts.which || ((c) => require("child_process").spawnSync(c, { silent: true }).status === 0 || undefined);
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000;
    this.pool = new Map();          // language -> LspProcess
    this.notifyHandler = null;
    if (opts.sweepIntervalMs) setInterval(() => this._sweep(), opts.sweepIntervalMs).unref?.();
  }

  onNotification(cb) { this.notifyHandler = cb; }

  ensureRunning(language, rootUri) {
    const existing = this.pool.get(language);
    if (existing && !existing.exited) return Promise.resolve({ language, reused: true, capabilities: existing.capabilities || {} });

    const def = this.serversDef[language];
    if (!def) return Promise.reject(makeError("CF4002", { adapter: language }));
    // 二进制存在性预检 → CF2003 参数化（可触发一键补拉 #41）
    const found = this.which(def.cmd);
    if (!found) {
      return Promise.reject(makeError("CF2003", {
        toolchain: def.cmd,
        install: INSTALL_HINTS[def.cmd]?.[platKey()] || "查看官方文档",
      }));
    }
    const proc = new LspProcess(language, { ...def, cmd: found }, rootUri,
      (method, params) => this.notifyHandler?.({ language, method, params }));
    this.pool.set(language, proc);
    return proc.initialize().then((capabilities) => {
      proc.capabilities = capabilities || {};
      return { language, reused: false, capabilities: proc.capabilities };
    }).catch((e) => {
      this.pool.delete(language);
      proc.kill();
      throw e;
    });
  }

  async request(language, method, params) {
    let proc = this.pool.get(language);
    if (!proc || proc.exited) await this.ensureRunning(language, proc?.rootUri);
    proc = this.pool.get(language);
    return proc.request(method, params);
  }

  notify(language, method, params) {
    const proc = this.pool.get(language);
    if (proc && !proc.exited) proc.notify(method, params);
  }

  stopAll() {
    for (const [, p] of this.pool) p.kill();
    this.pool.clear();
  }

  _sweep() {
    const now = Date.now();
    for (const [lang, p] of this.pool) {
      if (p.pending && p.pending.size) continue;   // 初始化/请求中，不可回收
      if (!p.exited && now - p.lastUsed > this.idleTimeoutMs) {
        p.kill();
        this.pool.delete(lang);
      }
    }
  }
}

module.exports = { LspManager, LspProcess, FrameParser, SERVER_DEFS, INSTALL_HINTS };
