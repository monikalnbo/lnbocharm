const test = require("node:test");
const assert = require("node:assert");
const { TerminalService, MAX_SESSIONS } = require("../src/services/terminal");

/// ---- 可注入的假 pty（确定性测试）----
function makeFakePtyModule() {
  return {
    spawn(_file, _args, _opts) {
      const listeners = { data: [], exit: [] };
      const proc = {
        write(d) { process.nextTick(() => listeners.data.forEach((f) => f(d))); },
        resize() {},
        kill() { process.nextTick(() => listeners.exit.forEach((f) => f({ exitCode: 0 }))); },
        onData(f) { listeners.data.push(f); },
        onExit(f) { listeners.exit.push(f); },
      };
      return proc;
    },
  };
}

test("创建会话：输出回调携带 sessionId", async () => {
  const svc = new TerminalService(makeFakePtyModule());
  let got = null;
  const { id } = svc.create({ onOutput: (chunk, sid) => { got = { chunk, sid }; } });
  svc.write(id, "echo hi\r");
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(got.sid, id);
  assert.ok(got.chunk.includes("hi"));
});

test("replay 返回环形缓冲内容", async () => {
  const svc = new TerminalService(makeFakePtyModule());
  const { id } = svc.create({});
  svc.write(id, "abc");
  await new Promise((r) => setTimeout(r, 20));   // 等待异步回环
  assert.ok(svc.replay(id).includes("abc"));
});

test("kill 触发退出回调并移除会话", async () => {
  const svc = new TerminalService(makeFakePtyModule());
  let exitCode = null;
  const { id } = svc.create({ onExit: (code) => { exitCode = code; } });
  svc.kill(id);
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(exitCode, 0);
  assert.throws(() => svc.write(id, "x"));
});

test("会话数上限 CF6001", () => {
  const svc = new TerminalService(makeFakePtyModule());
  for (let i = 0; i < MAX_SESSIONS; i++) svc.create({});
  assert.throws(() => svc.create({}),
    (e) => e.cfError?.code === "CF6001");
});

test("环形缓冲截断至上限", async () => {
  const { RING_BUFFER_MAX } = require("../src/services/terminal");
  const svc = new TerminalService(makeFakePtyModule());
  const { id } = svc.create({});
  svc.write(id, "a".repeat(RING_BUFFER_MAX + 100_000));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(svc.replay(id).length <= RING_BUFFER_MAX);
});

test("空闲自动回收（内存任务#34）", async () => {
  const svc = new TerminalService(makeFakePtyModule(), { idleTimeoutMs: 50 });
  const { id } = svc.create({});
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!svc.sessions.has(id), "空闲会话应被回收");
});
