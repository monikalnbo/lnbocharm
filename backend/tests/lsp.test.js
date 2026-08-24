const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FrameParser, LspManager } = require("../src/services/lsp");

// ---------- 帧解析器 ----------
test("FrameParser 粘包/分包", () => {
  const frames = [];
  const p = new FrameParser((m) => frames.push(m));
  const mk = (body) => Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  const whole = Buffer.concat([mk('{"a":1}'), mk('{"b":2}'), mk('{"c":3}')]);
  p.push(whole.slice(0, 5));    // 半个 header
  p.push(whole.slice(5, 20));   // 跨帧
  p.push(whole.slice(20));      // 剩余
  assert.deepStrictEqual(frames, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

// ---------- 与真实 LSP 子进程往返（fake server，Node 内置运行）----------
function writeFakeServer(dir) {
  const serverJs = `
    let buf = Buffer.alloc(0);
    process.stdin.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      for (;;) {
        const sep = buf.indexOf('\\r\\n\\r\\n');
        if (sep < 0) return;
        const m = /Content-Length:\\s*(\\d+)/i.exec(buf.slice(0, sep).toString());
        const len = parseInt(m[1], 10);
        if (buf.length < sep + 4 + len) return;
        const msg = JSON.parse(buf.slice(sep + 4, sep + 4 + len).toString());
        buf = buf.slice(sep + 4 + len);
        const reply = (obj) => {
          const b = Buffer.from(JSON.stringify(obj));
          process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n' + b.toString());
        };
        if (msg.id !== undefined && msg.method === 'initialize') {
          reply({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { fake: true } } });
        } else if (msg.id !== undefined && msg.method === 'textDocument/completion') {
          reply({ jsonrpc: '2.0', id: msg.id, result: [{ label: 'fakeItem' }] });
        } else if (msg.method === 'textDocument/didOpen') {
          reply({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
                  params: { uri: msg.params.textDocument.uri, diagnostics: [{ message: 'fake-diag' }] } });
        }
      }
    });
  `;
  const file = path.join(dir, "fake-lsp.js");
  fs.writeFileSync(file, serverJs);
  return file;
}

function setupManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-lsp-"));
  const fake = writeFakeServer(dir);
  const mgr = new LspManager({
    servers: { python: { cmd: process.execPath, args: [fake] } },
    which: (cmd) => (cmd === process.execPath ? cmd : null),
    sweepIntervalMs: 60_000,
  });
  return { mgr, dir };
}

test("LSP 往返：initialize → completion → didOpen 触发诊断转发", async () => {
  const { mgr, dir } = setupManager();
  const notifications = [];
  mgr.onNotification((n) => notifications.push(n));

  const start = await mgr.ensureRunning("python", "file://" + dir);
  assert.strictEqual(start.reused, false);

  // 复用已启动实例
  const again = await mgr.ensureRunning("python");
  assert.strictEqual(again.reused, true);

  // completion 请求往返
  const items = await mgr.request("python", "textDocument/completion",
    { textDocument: { uri: "file:///a.py" }, position: { line: 0, character: 0 } });
  assert.strictEqual(items[0].label, "fakeItem");

  // didOpen 通知 → fake server 回推 publishDiagnostics → 转发回调
  mgr.notify("python", "textDocument/didOpen",
    { textDocument: { uri: "file:///a.py", text: "" } });
  await new Promise((r) => setTimeout(r, 150));
  const diag = notifications.find((n) => n.method === "textDocument/publishDiagnostics");
  assert.ok(diag && diag.params.diagnostics[0].message === "fake-diag");

  mgr.stopAll();
});

test("LSP 服务器缺失报 CF2003 且插槽已渲染", async () => {
  const mgr = new LspManager({
    servers: { rust: { cmd: "definitely-not-exist-rust-analyzer", args: [] } },
    which: () => null,
  });
  await assert.rejects(
    () => mgr.ensureRunning("rust"),
    (e) => e.code === "CF2003" && !e.hint.includes("{install}")
  );
});

test("空闲回收", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-lsp2-"));
  const fake = writeFakeServer(dir);
  const mgr = new LspManager({
    servers: { python: { cmd: process.execPath, args: [fake] } },
    which: () => process.execPath,
    idleTimeoutMs: 100,
    sweepIntervalMs: 80,
  });
  await mgr.ensureRunning("python", "file://" + dir);
  await new Promise((r) => setTimeout(r, 300));
  // _sweep 后池应清空（下次请求会自动重启，属预期行为）
  assert.strictEqual(mgr.pool.size, 0);
  mgr.stopAll();
});
