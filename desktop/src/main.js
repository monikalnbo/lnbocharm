/// CodeForge Electron 主进程
/// - 加载前端（开发: VITE_DEV_URL / 生产: ../../frontend/dist）
/// - IPC: 本机构建（codeforge-py plan → 子进程 argv 数组执行，禁 shell 防注入）
/// - 安全基线(#26)：contextIsolation 开、nodeIntegration 关、渲染层仅经 preload 桥
const { app, BrowserWindow, ipcMain, dialog, session } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { startAccelerator, getStatus } = require("./proxy");
const applock = require("./applock");
const toolchains = require("./toolchain-manager");

const DIST_INDEX = path.join(__dirname, "..", "..", "frontend", "dist", "index.html");
const PYLIB_DIR = path.join(__dirname, "..", "..", "pylib");
const WORKSPACE_ROOT = path.join(__dirname, "..", "..", "workspace-demo");
const MAX_TAIL = 512 * 1024;

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,        // 内嵌浏览器（Chromium 内核，任务#22）
    },
  });
  if (process.env.VITE_DEV_URL) win.loadURL(process.env.VITE_DEV_URL);
  else win.loadFile(DIST_INDEX);
}

app.whenReady().then(() => {
  // 加速器随应用自启：本地代理 + 内嵌浏览器 session 绑定
  const relay = readRelayUrl();
  const st = startAccelerator({ relayUrl: relay, port: 7788 });
  session.fromPartition("persist:accelerated")
    .setProxy({ proxyRules: `127.0.0.1:${st.port || 7788}` })
    .catch(() => {});
  createWindow();
});
app.on("window-all-closed", () => app.quit());

function readRelayUrl() {
  try {
    const p = path.join(os.homedir(), ".codeforge", "settings.json");
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    return s.relayUrl || process.env.CODEFORGE_RELAY;
  } catch { return process.env.CODEFORGE_RELAY; }
}

function ensureWorkspace() {
  try { fs.accessSync(WORKSPACE_ROOT); }
  catch { fs.mkdirSync(WORKSPACE_ROOT, { recursive: true }); }
  return WORKSPACE_ROOT;
}

// ---------- codeforge serve 单请求往返 ----------
function serveOnce(id, op, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-m", "codeforge", "serve"], { cwd: PYLIB_DIR });
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === id) {
          proc.kill();
          resolve(msg);
          return;
        }
      }
    });
    proc.on("error", reject);
    proc.stdin.write(JSON.stringify({ v: 1, id, op, args }) + "\n");
  });
}

// ---------- 本机构建 ----------
ipcMain.handle("build:local", async (_ev, filePath) => {
  const root = ensureWorkspace();
  const absFile = path.resolve(root, filePath);
  if (!absFile.startsWith(root)) {
    return { ok: false, exitCode: -1, output: "[CF1002] 非法路径", durationMs: 0 };
  }

  // 1) plan：命令数组由 pylib 生成（防注入）
  const resp = await serveOnce("p" + Date.now(), "plan",
    { file: absFile, out_dir: path.join(os.tmpdir(), "cf-local-build") });
  if (!resp.ok) {
    const e = resp.error || {};
    return { ok: false, exitCode: -1,
             output: `[${e.code}] ${e.message}\n💡 ${e.hint}`, durationMs: 0 };
  }
  const plan = resp.result;

  // 2) 顺序执行 build/run
  let output = "";
  const append = (s) => {
    output += s;
    if (output.length > MAX_TAIL) output = output.slice(-MAX_TAIL);
  };
  const steps = [];
  if (plan.build_cmd) steps.push({ cmd: plan.build_cmd, tag: "build" });
  if (plan.run_cmd) steps.push({ cmd: plan.run_cmd, tag: "run" });

  const t0 = Date.now();
  let exitCode = 0;
  for (const step of steps) {
    append(`[${step.tag}] $ ${step.cmd.join(" ")}\n`);
    exitCode = await runStep(step.cmd, root, append);
    if (exitCode !== 0 && step.tag === "build") break;
  }
  return { ok: exitCode === 0, exitCode, output, durationMs: Date.now() - t0 };
});

function runStep(cmd, cwd, append) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd });
    child.stdout?.on("data", (d) => append(d.toString()));
    child.stderr?.on("data", (d) => append(d.toString()));
    child.on("error", (e) => { append(e.message + "\n"); resolve(-1); });
    child.on("close", (code) => resolve(code ?? -1));
  });
}

// ---------- 其他 IPC ----------
ipcMain.handle("workspace:path", () => ensureWorkspace());

ipcMain.handle("accelerator:status", () => getStatus());

// ---------- 应用锁（任务 #35）----------
ipcMain.handle("applock:state", () => applock.state());
ipcMain.handle("applock:enable", (_e, opts) => applock.enable(opts || {}));
ipcMain.handle("applock:disable", () => applock.disable());
ipcMain.handle("applock:unlock", (_e, opts) => applock.unlock(opts || {}));

// ---------- 工具链安装（任务 #38/#41 一键补拉）----------
ipcMain.handle("toolchain:list", async () => {
  try { return { ok: true, list: await toolchains.list() }; }
  catch (e) { return { ok: false, output: e.message }; }
});
ipcMain.handle("toolchain:install", async (_e, id, onProgressChannel) => {
  return toolchains.install(id, (percent) => {
    if (onProgressChannel && win && !win.isDestroyed())
      win.webContents.send(onProgressChannel, { id, percent });
  });
});

// ---------- 内存指标（任务 #34）----------
ipcMain.handle("app:memory", () => {
  const m = process.memoryUsage();
  const procMem = process.getAppMetrics().map((x) => ({
    type: x.type, pid: x.pid,
    memMB: Math.round((x.memory?.workingSize || 0) / 1024 / 1024 * 10) / 10,
  }));
  return { rssMB: Math.round(m.rss / 1048576), procs: procMem };
});

ipcMain.handle("dialog:openFolder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
