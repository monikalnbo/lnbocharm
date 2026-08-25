/// 预加载桥：渲染层唯一可用的桌面能力入口（window.codeforge）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codeforge", {
  isDesktop: true,
  platform: process.platform,

  /// 本机构建：返回 { ok, exitCode, output, durationMs }
  localBuild: (filePath) => ipcRenderer.invoke("build:local", filePath),

  /// 工作区路径 / 文件夹选择
  workspacePath: () => ipcRenderer.invoke("workspace:path"),
  openFolderDialog: () => ipcRenderer.invoke("dialog:openFolder"),

  /// 加速器状态（随应用自启）
  acceleratorStatus: () => ipcRenderer.invoke("accelerator:status"),
  deviceFingerprint: () => ipcRenderer.invoke("accelerator:fingerprint"),

  /// 应用锁（任务 #35）
  applock: {
    state: () => ipcRenderer.invoke("applock:state"),
    enable: (opts) => ipcRenderer.invoke("applock:enable", opts),
    disable: () => ipcRenderer.invoke("applock:disable"),
    unlock: (opts) => ipcRenderer.invoke("applock:unlock", opts),
  },

  /// 工具链一键安装（任务 #38/#41）
  toolchainList: () => ipcRenderer.invoke("toolchain:list"),
  installToolchain: (id) => ipcRenderer.invoke("toolchain:install", id),
  onToolchainProgress: (fn) => {
    ipcRenderer.removeAllListeners("toolchain:progress");
    ipcRenderer.on("toolchain:progress", (_e, data) => fn(data));
  },

  /// 内存指标（任务 #34）
  appMemory: () => ipcRenderer.invoke("app:memory"),

  /// 设置桥接：serverUrl 写入 ~/.codeforge/settings.json 供主进程读取
  setServerConfig: (cfg) => ipcRenderer.invoke("settings:setServer", cfg),

  /// 工作区（VSCode 式，任务 #2）
  workspace: {
    openDialog: () => ipcRenderer.invoke("workspace:openDialog"),
    switchTo: (root) => ipcRenderer.invoke("workspace:switchTo", root),
    recents: () => ipcRenderer.invoke("workspace:recents"),
    onChanged: (fn) => ipcRenderer.on("workspace.changed", (_e, root) => fn(root)),
    getRoot: () => fetch("/api/workspace/root").then((r) => r.json()).then((j) => j.payload?.root),
  },
});
