/// CodeForge Electron 主进程
/// - 加载前端（开发: VITE_DEV_URL / 生产: ../../frontend/dist）
/// - IPC: 本机构建（codeforge-py plan → 子进程 argv 数组执行，禁 shell 防注入）
/// - 安全基线(#26)：contextIsolation 开、nodeIntegration 关、渲染层仅经 preload 桥
const { app, BrowserWindow, ipcMain, dialog, session, Menu } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { startAccelerator, getStatus } = require("./proxy");
const applock = require("./applock");
const toolchains = require("./toolchain-manager");

const DIST_INDEX = path.join(__dirname, "..", "..", "frontend", "dist", "index.html");
function pylibDir() {
  // 打包后 app.asar 是虚拟文件系统，子进程无法读取——必须用解压后的 resources 路径
  return app.isPackaged
    ? path.join(process.resourcesPath, "pylib")
    : path.join(__dirname, "..", "..", "pylib");
}
const PYLIB_DIR = path.join(__dirname, "..", "..", "pylib");   // 仅开发模式使用
const WORKSPACE_ROOT = path.join(__dirname, "..", "..", "workspace-demo");
const MAX_TAIL = 512 * 1024;

let win = null;
let serverProc = null;

// 单实例锁：重复启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

app.setName("CodeForge");

function readRecentsMenu() {
  try {
    const list = (readSettings().workspaces || []).slice(0, 6);
    if (!list.length) return [];
    return [
      { label: "最近打开：", enabled: false },
      ...list.map((p) => ({
        label: path.basename(p) + "  (" + p + ")",
        click: () => switchWorkspace(p),
      })),
      { type: "separator" },
    ];
  } catch { return []; }
}

/// 极简菜单：Windows/Linux 无菜单栏（功能全部在应用内）；macOS 保留系统必需项
function buildAppMenu() {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name,
      submenu: [
        { role: "about", label: "关于 CodeForge" },
        { type: "separator" },
        { role: "hide", label: "隐藏 CodeForge" },
        { type: "separator" },
        { role: "quit", label: "退出 CodeForge" },
      ] },
    { role: "editMenu", label: "编辑" },
    { label: "窗口", submenu: [{ role: "minimize", label: "最小化" }, { role: "close", label: "关闭" }] },
  ]));
}

/// 内嵌后端：打包/源码运行都拉起本地构建服务器（REST+WS 同源，前端零改动）
async function startEmbeddedBackend() {
  const port = process.env.PORT || "8787";
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (r.ok) return port;                       // 已有实例，复用
  } catch {}
  const entry = app.isPackaged
    ? path.join(process.resourcesPath, "backend", "src", "index.js")
    : path.join(__dirname, "..", "..", "backend", "src", "index.js");
  serverProc = spawn(process.execPath, [entry], {
    env: { ...process.env,
           ELECTRON_RUN_AS_NODE: "1",          // 关键：以纯 Node 模式运行，否则变成第二个 GUI 实例
           PORT: port,
           CODEFORGE_WS: path.join(os.tmpdir(), "codeforge-workspace") },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return port;
    } catch {}
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error("embedded backend failed to start");
}

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
  win.setTitle("CodeForge");
  if (process.env.VITE_DEV_URL) {
    win.loadURL(process.env.VITE_DEV_URL);          // 开发模式：vite + 自行启动的后端
    return;
  }
  startEmbeddedBackend()
    .then(async (port) => {
      // 恢复上次工作区（VSCode 行为）
      const lastRoot = readSettings().lastRoot;
      if (lastRoot && fs.existsSync(lastRoot)) {
        await fetch(`http://127.0.0.1:${port}/api/workspace/setRoot`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ root: lastRoot }),
        }).catch(() => {});
      }
      win.loadURL(`http://127.0.0.1:${port}`);
    })
    .catch((e) => {
      if (win && !win.isDestroyed())
        dialog.showErrorBox("CodeForge", "内置服务启动失败：\n" + e.message);
    });
}

app.whenReady().then(() => {
  if (!gotLock) return;
  buildAppMenu();
  // 加速器随应用自启：本地代理 + 内嵌浏览器 session 绑定
  const relay = readRelayUrl();
  const st = startAccelerator({ relayUrl: relay, port: 7788 });
  session.fromPartition("persist:accelerated")
    .setProxy({ proxyRules: `127.0.0.1:${st.port || 7788}` })
    .catch(() => {});
  createWindow();
});
app.on("second-instance", () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { try { serverProc?.kill(); } catch (_) {} });

function readRelayUrl() {
  try {
    const p = path.join(os.homedir(), ".codeforge", "settings.json");
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    return s.relayUrl || process.env.CODEFORGE_RELAY;
  } catch { return process.env.CODEFORGE_RELAY; }
}

function readSettings() {
  const f = path.join(os.homedir(), ".codeforge", "settings.json");
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; }
}
function writeSettings(patch) {
  const f = path.join(os.homedir(), ".codeforge", "settings.json");
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  cur = { ...cur, ...patch };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cur, null, 2));
  return cur;
}

function ensureWorkspace() {
  try { fs.accessSync(WORKSPACE_ROOT); }
  catch { fs.mkdirSync(WORKSPACE_ROOT, { recursive: true }); }
  return WORKSPACE_ROOT;
}

/// 探测可用的 Python 解释器（Windows 上通常只有 python/py）
function pickPython() {
  for (const cand of ["python3", "python", "py"]) {
    const r = require("child_process").spawnSync(cand, ["-V"], { encoding: "utf8" });
    if (!r.error) return cand;
  }
  return "python3";   // 兜底，让上层给出统一的 CF2003 风格错误
}

// ---------- codeforge serve 单请求往返 ----------
function serveOnce(id, op, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pickPython(), ["-m", "codeforge", "serve"], { cwd: pylibDir() });
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

// ---------- 工作区切换（VSCode 式，任务 #2）----------
async function switchWorkspace(root) {
  const port = process.env.PORT || "8787";
  await fetch(`http://127.0.0.1:${port}/api/workspace/setRoot`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root }),
  });
  const cur = writeSettings({ lastRoot: root });
  const recents = [...new Set([root, ...(cur.workspaces || [])])].slice(0, 8);
  writeSettings({ workspaces: recents });
  if (win && !win.isDestroyed()) win.webContents.send("workspace.changed", root);
  return { root };
}

ipcMain.handle("workspace:openDialog", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openDirectory"], title: "打开工作区文件夹",
    defaultPath: readSettings().lastRoot,
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return switchWorkspace(r.filePaths[0]);
});

ipcMain.handle("workspace:switchTo", (_e, root) => switchWorkspace(root));
ipcMain.handle("workspace:recents", () => readSettings().workspaces || []);

ipcMain.handle("settings:setServer", (_e, cfg = {}) => {
  const file = path.join(os.homedir(), ".codeforge", "settings.json");
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  if (cfg.serverUrl) {
    cur.serverUrl = cfg.serverUrl;
    // 联动派生加速器隧道地址：http://host:port → ws://host:port/relay
    try {
      const u = new URL(cfg.serverUrl);
      cur.relayUrl = `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}/relay`;
    } catch {}
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cur, null, 2));
  return { ok: true };
});

ipcMain.handle("accelerator:status", () => getStatus());
ipcMain.handle("accelerator:fingerprint", () => {
  const { loadDeviceFingerprint } = require("./proxy");
  return loadDeviceFingerprint();
});

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
