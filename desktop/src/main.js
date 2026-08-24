/// CodeForge Electron 主进程
/// - 加载前端（开发: VITE_DEV_URL / 生产: ../../frontend/dist）
/// - IPC: 本机构建（codeforge-py plan → 子进程 argv 数组执行，禁 shell 防注入）
/// - 安全基线(#26)：contextIsolation 开、nodeIntegration 关、渲染层仅经 preload 桥
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

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
    },
  });
  if (process.env.VITE_DEV_URL) win.loadURL(process.env.VITE_DEV_URL);
  else win.loadFile(DIST_INDEX);
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

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

ipcMain.handle("dialog:openFolder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
