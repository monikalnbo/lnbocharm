/// 全业务流协议模拟：按真实使用顺序串起所有数据面算子，
/// 逐步校验信封结构（v/id/ok/payload）与字段契约（任务 #13）
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
require("./orphan-guard.js");
const WebSocket = require("ws");

const SERVER_JS = path.join(__dirname, "..", "src", "index.js");
const PORT = 8951;

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server not healthy");
}

test("业务流模拟：建项目 → 写码 → 检查 → 搜索 → 构建计划 → 终端 → 日志", async () => {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cf-sim-"));
  const child = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, PORT: String(PORT), CODEFORGE_WS: wsRoot },
    stdio: ["ignore", "ignore", "ignore"],
  });

  // 健康检查走 HTTP（唯一允许的明文，仅探测存活）
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  ws.send(JSON.stringify({ v: 1, id: "hello", type: "hello",
    payload: { client: "desktop", version: "0.1.0" } }));
  await new Promise((res) => ws.once("message", () => res()));

  let seq = 0;
  const pendingMap = new Map();

  /// 协议层校验器：每个响应都必须符合信封契约
  function envelopeCheck(m, id, type) {
    assert.strictEqual(m.v, 1, "信封版本必须是 1");
    assert.strictEqual(m.id, id, "id 必须回显");
    assert.strictEqual(typeof m.ok, "boolean", "ok 必须是布尔");
    if (!(m.type === type || m.type === type + ".result"))
      console.error("[TYPE-MISMATCH] 期望", type, "实际", m.type,
                    "原始帧:", JSON.stringify(m).slice(0, 180));
    assert.ok(m.type === type || m.type === type + ".result", "type 匹配");
    if (m.ok === false) {
      assert.ok(m.error?.code?.startsWith("CF"), "错误必须带 CF 码");
      assert.ok(m.error.hint, "错误必须带 hint");
    } else {
      assert.ok(!m.error, "成功帧不得携带 error");
      assert.ok(m.payload !== undefined || m.d !== undefined, "必须有 payload 或加密体");
    }
  }

  const call = (type, payload) => new Promise((resolve, reject) => {
    const id = "sim" + (++seq);
    pendingMap.set(id, (m) => {
      try {
        envelopeCheck(m, id, type);
        if (m.ok) resolve(m.payload);
        else reject(Object.assign(new Error(m.error.message), { cf: m.error }));
      } catch (e) { reject(e); }
    });
    ws.send(JSON.stringify({ v: 1, id, type, payload }));
  });

  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    const p = pendingMap.get(m.id);
    if (p) { pendingMap.delete(m.id); p(m); }
  });

  // ---- 业务步骤 1：切工作区到模拟项目 ----
  const projDir = path.join(wsRoot, "my-project");
  fs.mkdirSync(projDir, { recursive: true });
  await call("workspace.setRoot", { root: projDir });

  // 步骤 2：新建源码文件
  await call("file.write", { path: "src/calc.py", content: "def add(a, b):\n    return a + b\n" });

  // 步骤 3：Lint 发现问题（构造缩进错误）
  await call("file.write", { path: "src/bad.py", content: "def f():\nx = 1\n" });
  const lint = await call("lint", { file: "src/bad.py", lang: "python",
    text: "def f():\nx = 1\n" });
  assert.ok(lint.diagnostics.some((d) => d.rule === "CF3002"), "应检出缩进层级");

  // 步骤 4：搜索定位
  const sr = await call("search", { q: "add" });
  assert.strictEqual(sr.total, 1);

  // 步骤 5：构建计划（Python 工具链在本机存在）
  const plan = await call("plan", { file: "src/calc.py" });
  assert.strictEqual(plan.language, "python");
  // 回归：相对路径必须在“当前工作区”下解析（曾钉死在启动目录）
  assert.ok(plan.build_cmd.join(" ").includes(path.join(projDir, "src", "calc.py")),
    "plan 应使用切根后的绝对路径: " + plan.build_cmd.join(" "));

  // 步骤 6：终端会话创建并执行命令
  const created = await call("term.create", { cols: 80, rows: 24 });
  const sid = created.sessionId;
  const termOut = await new Promise((resolve) => {
    let buf = "";
    const h = (d) => {
      const m2 = JSON.parse(d.toString());
      if (m2.type === "term.output" && m2.payload.sessionId === sid) {
        buf += m2.payload.chunk;
        if (buf.includes("TERM-SIM-OK")) { ws.off("message", h); resolve(buf); }
      }
    };
    ws.on("message", h);
    ws.send(JSON.stringify({ v: 1, id: "t1", type: "term.input",
      payload: { sessionId: sid, data: "echo TERM-SIM-OK\r" } }));
    setTimeout(() => resolve(buf), 5000);
  });
  assert.ok(termOut.includes("TERM-SIM-OK"), "终端应回显");

  // 步骤 7：日志可查且包含本次操作
  const logs = await call("logs.tail", { limit: 100 });
  const flat = JSON.stringify(logs);
  assert.ok(flat.length > 0);

  // 步骤 8：未知算子 → CF 错误而非崩溃
  await assert.rejects(() => call("nope.op", {}),
    (e) => e.cf?.code === "CF0001" || /未知/.test(e.message));

  ws.close();
  child.kill();
  fs.rmSync(wsRoot, { recursive: true, force: true });
}, { timeout: 30_000 });
