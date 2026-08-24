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
  installToolchain: (id, progressChannel) =>
    ipcRenderer.invoke("toolchain:install", id, progressChannel),
  onToolchainProgress: (channel, fn) =>
    ipcRenderer.on(channel, (_e, data) => fn(data)),

  /// 内存指标（任务 #34）
  appMemory: () => ipcRenderer.invoke("app:memory"),
});
