/// 构建执行器：按 BuildPlan 依次执行 build_cmd / run_cmd（execFile 数组，禁 shell）。
/// - 流式输出回调（尾部截断至 MAX_TAIL，防内存膨胀）
/// - 全局并发 ≤2，超出排队；排队 >20 拒绝 CF2004
/// - 超时 CF2002；支持取消
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { makeError } = require("../protocol");

const MAX_CONCURRENT = 2;
const MAX_QUEUE = 20;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TAIL = 512 * 1024;

class BuildExecutor {
  constructor() {
    this.active = new Map();     // buildId -> child process（用于取消）
    this.queue = [];
    this.running = 0;
  }

  /**
   * 执行计划。
   * @returns {Promise<{ok, exitCode, output, durationMs, ranRunCmd}>}
   */
  execute(buildId, plan, opts = {}) {
    const cwd = opts.cwd || path.dirname(plan.artifacts?.[0] || ".") || ".";
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const onOutput = opts.onOutput || (() => {});
    const workdirRoot = opts.workdirRoot || null; // 若提供，命令在此目录下执行

    return new Promise((resolve, reject) => {
      if (this.running >= MAX_CONCURRENT) {
        if (this.queue.length >= MAX_QUEUE) {
          const err = makeError("CF2004", { limit: MAX_QUEUE });
          return reject(Object.assign(new Error(err.message), { cfError: err }));
        }
        this.queue.push({ buildId, run: () => this._start(buildId, plan, { cwd: workdirRoot || cwd, timeoutMs, onOutput }, resolve, reject), reject });
        onOutput(`[queue] 排队中（前方 ${this.queue.length} 个任务）`);
        return;
      }
      this._start(buildId, plan, { cwd: workdirRoot || cwd, timeoutMs, onOutput }, resolve, reject);
    });
  }

  _start(buildId, plan, { cwd, timeoutMs, onOutput }, resolve, reject) {
    this.running++;
    let output = "";
    const state = { cancelled: false };          // 构建级取消状态（cancel() 置位）
    const t0 = Date.now();
    const append = (s) => {
      output += s;
      if (output.length > MAX_TAIL) output = output.slice(-MAX_TAIL);
      onOutput(s);
    };
    const steps = [];
    if (plan.build_cmd) steps.push({ cmd: plan.build_cmd, tag: "build" });
    if (plan.run_cmd) steps.push({ cmd: plan.run_cmd, tag: "run" });

    const finish = (err) => {
      this.running--;
      this.active.delete(buildId);
      const next = this.queue.shift();
      if (next) next.run();
      if (err) reject(err);
      else resolve({
        // 语义修正：run 步退出码非零 = 程序运行失败，不得报成功
        ok: !state.cancelled && (!ranRun || lastExit === 0),
        exitCode: err ? err.exitCode : lastExit,
        output,
        durationMs: Date.now() - t0,
        cancelled: state.cancelled,
        ranRunCmd: ranRun,
      });
    };

    let lastExit = 0;
    let ranRun = false;
    let stepIdx = 0;
    const activeChildRef = { current: null };

    const runNextStep = () => {
      if (state.cancelled) return finish(null);
      const step = steps[stepIdx++];
      if (!step) return finish(null);
      ranRun = step.tag === "run";
      append(`[${step.tag}] $ ${step.cmd.join(" ")}\n`);

      let child;
      try {
        child = spawn(step.cmd[0], step.cmd.slice(1), { cwd });
      } catch (e) {
        return finish(Object.assign(e, { exitCode: -1 }));
      }
      this.active.set(buildId, { child, state });
      activeChildRef.current = child;

      // 业务规则：编译步限时防卡死；运行步不限时（常驻服务程序合法），
      // 用户可随时取消。timeoutMs 仅作用于 build。
      let timer = null;
      if (step.tag === "build") {
        timer = setTimeout(() => {
          state.cancelled = true;   // 超时也算取消路径，避免误报 compile failed
          try { child.kill("SIGKILL"); } catch (_) {}
          finish(makeError("CF2002", { timeout: Math.round(timeoutMs / 1000) }));
        }, timeoutMs);
      }

      child.stdout.on("data", (d) => append(d.toString()));
      child.stderr.on("data", (d) => append(d.toString()));
      child.on("error", (e) => { clearTimeout(timer); append(`${e.message}\n`); finish(makeError("CF2003", { toolchain: step.cmd[0], install: e.message })); });
      child.on("close", (code) => {
        clearTimeout(timer);
        lastExit = code ?? -1;
        if (state.cancelled) return finish(null);
        if (code !== 0 && step.tag === "build") {
          append(`\n[exit ${code}] 编译失败\n`);
          return finish(Object.assign(new Error("compile failed"), { exitCode: code }));
        }
        runNextStep();
      });
    };
    runNextStep();
  }

  cancel(buildId) {
    const entry = this.active.get(buildId);
    if (entry) {
      entry.state.cancelled = true;               // 改共享状态对象，close 据此判定
      try { entry.child.kill("SIGKILL"); } catch (_) {}
      return true;
    }
    // 还在排队：直接移除
    const qi = this.queue.findIndex((q) => q.buildId === buildId);
    if (qi >= 0) {
      const [removed] = this.queue.splice(qi, 1);
      removed.reject(Object.assign(new Error("已取消"),
        { cfError: makeError("CF2004", { message: "已取消（尚未开始）" }) }));
      return true;
    }
    return false;
  }
}

module.exports = { BuildExecutor, MAX_CONCURRENT, MAX_QUEUE };
