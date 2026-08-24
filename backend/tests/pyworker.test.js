const test = require("node:test");
const assert = require("node:assert");
const { PyWorker } = require("../src/services/pyworker");

test("pyworker 真实子进程往返", async () => {
  const w = new PyWorker();
  try {
    const ping = await w.request("t1", "ping");
    assert.deepStrictEqual(ping, { pong: true });

    const det = await w.request("t2", "detect", { file: "x.ts" });
    assert.strictEqual(det.name, "typescript");   // TS 内置环境

    // 并发请求 id 隔离
    const [a, b] = await Promise.all([
      w.request("c1", "detect", { file: "a.py" }),
      w.request("c2", "detect", { file: "b.rs" }),
    ]);
    assert.strictEqual(a.name, "python");
    assert.strictEqual(b.name, "rust");
  } finally {
    w.stop();
  }
}, { timeout: 30_000 });

test("pyworker lint 全链路", async () => {
  const w = new PyWorker();
  try {
    const r = await w.request("l1", "lint", {
      file: "a.py",
      text: "def f():\n  x = 1\n\t    y = 2\n   return x\n",
      lang: "python",
    });
    const codes = r.diagnostics.map((d) => d.rule);
    assert.ok(codes.includes("CF3001") && codes.includes("CF3002"));
    for (const d of r.diagnostics) assert.ok(d.hint);   // 每条诊断必须带 hint
  } finally {
    w.stop();
  }
}, { timeout: 30_000 });
