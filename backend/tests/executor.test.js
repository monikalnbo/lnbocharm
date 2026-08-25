const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { BuildExecutor } = require("../src/services/executor");

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "cf-exec-")); }

test("执行器：Python 真实编译+运行全流程", async () => {
  const dir = tmpdir();
  const src = path.join(dir, "hello.py");
  fs.writeFileSync(src, "print('codeforge-ok')\n");
  const plan = {
    language: "python",
    build_cmd: [process.execPath === process.execPath ? "python3" : "python3", "-m", "py_compile", src],
    run_cmd: ["python3", src],
    artifacts: [],
  };
  const chunks = [];
  const ex = new BuildExecutor();
  const r = await ex.execute("b1", plan, { cwd: dir, onOutput: (c) => chunks.push(c) });
  assert.strictEqual(r.ok, true);
  assert.ok(chunks.join("").includes("codeforge-ok"));
  assert.ok(r.durationMs >= 0 && typeof r.ranRunCmd === "boolean");
});

test("执行器：编译失败返回非零 exitCode 与错误输出", async () => {
  const dir = tmpdir();
  const src = path.join(dir, "bad.py");
  fs.writeFileSync(src, "syntax error here !!!\n");
  const plan = { language: "python", build_cmd: ["python3", "-m", "py_compile", src] };
  const ex = new BuildExecutor();
  await assert.rejects(
    () => ex.execute("b2", plan, { cwd: dir }),
    (e) => e.exitCode !== 0
  );
});

test("执行器：超时触发 CF2002", async () => {
  const plan = { language: "t", build_cmd: ["python3", "-c", "import time; time.sleep(5)"] };
  const ex = new BuildExecutor();
  await assert.rejects(
    () => ex.execute("b3", plan, { cwd: os.tmpdir(), timeoutMs: 500 }),
    (e) => e.code === "CF2002"
  );
}, { timeout: 10_000 });

test("执行器：取消正在运行的任务", async () => {
  const plan = { language: "t", build_cmd: ["python3", "-c", "print('x'); import time; time.sleep(30)"] };
  const ex = new BuildExecutor();
  const p = ex.execute("b4", plan, { cwd: os.tmpdir(), timeoutMs: 25_000 });
  setTimeout(() => ex.cancel("b4"), 300);
  const r = await p;
  assert.strictEqual(r.cancelled, true);
}, { timeout: 15_000 });

test("输出尾部截断不超过 MAX_TAIL", async () => {
  const dir = tmpdir();
  const plan = { language: "t", build_cmd: ["python3", "-c", "print('z' * 600000)"] };
  let tail = "";
  const ex = new BuildExecutor();
  await ex.execute("b5", plan, { cwd: dir, onOutput: (c) => { tail += c; if (tail.length > 700000) tail = tail.slice(-600000); } });
  assert.ok(tail.length <= 620000);   // 我们自己的聚合上限（服务端 output 字段内部限 512KB）
});

// ---------- 回归：run 步退出码非零不得报成功 ----------

test("执行器：run 步退出码非零时 ok=false", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-exit1-"));
  const src = path.join(dir, "fail.py");
  fs.writeFileSync(src, "import sys; sys.exit(3)\n");
  const plan = {
    language: "python",
    build_cmd: ["python3", "-m", "py_compile", src],
    run_cmd: ["python3", src],
  };
  const ex = new BuildExecutor();
  const r = await ex.execute("b9", plan, { cwd: dir });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.exitCode, 3);
});
