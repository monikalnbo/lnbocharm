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
});
