/// 全局状态（轻量 reactive store）
import { reactive } from "vue";

export const store = reactive({
  // 语言注册表（来自 /api/languages，单一事实来源）
  registry: {},          // {python: {ext, monacoId, builder, ...}}
  extMap: {},            // {".py": "python"}

  // 编辑器标签页
  tabs: [],              // [{path, language, model}]
  activePath: null,

  // 问题面板（lint + LSP 诊断合并）
  problems: [],          // Diagnostic[]

  // 构建
  buildMode: localStorage.getItem("cf.buildMode") || "server",  // local | server | docker
  buildRunning: false,
  buildOutput: "",       // 尾部 512KB 由服务端保证，前端再留上限

  // 断点：path -> Set(lineNumber)
  breakpoints: JSON.parse(localStorage.getItem("cf.breakpoints") || "{}"),

  // 背景板/主题
  theme: localStorage.getItem("cf.theme") || "dark",
  background: localStorage.getItem("cf.background") || "",   // 纯色或图片URL
  backgroundOpacity: parseFloat(localStorage.getItem("cf.bgOpacity") || "1"),

  // 面板折叠（不遮挡代码区：dock 挤压布局）
  panels: {
    left: true, right: true, terminal: true,
  },

  // 工作区（VSCode 式）
  workspaceRoot: "",
});

export function setBuildMode(m) {
  store.buildMode = m;
  localStorage.setItem("cf.buildMode", m);
}

export function setTheme(t) {
  store.theme = t;
  localStorage.setItem("cf.theme", t);
}

export function setBackground(v) {
  store.background = v;
  localStorage.setItem("cf.background", v);
}

export function togglePanel(name) {
  store.panels[name] = !store.panels[name];
}

export function toggleBreakpoint(path, line) {
  if (!store.breakpoints[path]) store.breakpoints[path] = [];
  const set = new Set(store.breakpoints[path]);
  set.has(line) ? set.delete(line) : set.add(line);
  store.breakpoints[path] = [...set];
  localStorage.setItem("cf.breakpoints", JSON.stringify(store.breakpoints));
}
