/// 编辑器核心：单实例 Monaco + 多标签 model 切换 + 断点 + lint 触发
import * as monaco from "./monaco.js";
const monacoApi = monaco;
import { api, track } from "./api.js";
import { store, toggleBreakpoint } from "./store.js";
import { i18n } from "./i18n/index.js";
import { openModel, ensureLsp, languageOf, fileUri } from "./monaco.js";

let editor = null;
let decorations = new Map();   // path -> decoration ids

export function mountEditor(container) {
  editor = monacoApi.editor.create(container, {
    theme: "codeforge-dark",
    glyphMargin: true,           // 断点列
    automaticLayout: true,
    fontSize: 14,
    minimap: { enabled: false },
    wordBasedSuggestions: "currentDocument",
  });

  // 点击图标栏切换断点
  editor.onMouseDown((e) => {
    if (e.target.type !== monacoApi.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const path = store.activePath;
    if (!path) return;
    toggleBreakpoint(path, e.target.position.lineNumber);
    renderBreakpoints();
  });

  // 内容变更：防抖触发 lint（定时器挂在 model 上，避免字符串挂属性）
  const lintTimers = new Map();
  editor.onDidChangeModelContent(() => {
    const path = store.activePath;
    if (!path) return;
    clearTimeout(lintTimers.get(path));
    lintTimers.set(path, setTimeout(() => {
      lintTimers.delete(path);
      runLint(path);
    }, 800));
  });

  return editor;
}

export async function openFile(path) {
  track("file.open", path);
  await ensureLsp(languageOf(path) || "");
  const model = await openModel(path);
  if (!store.tabs.find((t) => t.path === path)) store.tabs.push({ path, language: model.getLanguageId(), model });
  store.activePath = path;
  editor.setModel(model);
  renderBreakpoints();
}

/** 打开并跳转到指定行（问题面板/搜索跳转用） */
export async function revealLine(path, line) {
  await openFile(path);
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column: 1 });
  editor.focus();
}

export function closeTab(path) {
  const idx = store.tabs.findIndex((t) => t.path === path);
  if (idx < 0) return;
  store.tabs.splice(idx, 1);
  const model = monacoApi.editor.getModel(monacoApi.Uri.parse(fileUri(path)));
  model?.dispose();
  decorations.delete(path);   // 防止装饰器条目随标签开关无限累积
  if (store.activePath === path) {
    store.activePath = store.tabs[Math.max(0, idx - 1)]?.path || null;
    editor.setModel(store.activePath ? getModelByPath(store.activePath) : null);
    renderBreakpoints();
  }
}

function getModelByPath(path) {
  return monacoApi.editor.getModel(monacoApi.Uri.parse(fileUri(path)));
}

export function getModelByPathSafe(path) {
  try { return getModelByPath(path); } catch { return null; }
}

// ---------- 断点渲染 ----------
export function renderBreakpoints() {
  if (!editor) return;
  for (const [path, olds] of decorations) {
    const m = getModelByPath(path);
    if (m && path !== store.activePath) m.deltaDecorations(olds, []);
  }
  for (const t of store.tabs) {
    const lines = store.breakpoints[t.path] || [];
    const m = getModelByPath(t.path);
    if (!m) continue;
    const ds = m.deltaDecorations(decorations.get(t.path) || [], lines.map((l) => ({
      range: new monacoApi.Range(l, 1, l, 1),
      options: {
        isWholeLine: false,
        glyphMarginClassName: "cf-bp",
        glyphMarginHoverMessage: { value: `断点 @${l} 行` },
        stickiness: monacoApi.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })));
    decorations.set(t.path, ds);
  }
}

// ---------- Lint → markers ----------
export async function runLint(path) {
  const model = getModelByPath(path);
  if (!model) return;
  const opts = store.lintOptions || {};
  const enabled = Object.entries(opts)
    .filter(([, v]) => v?.enabled !== false)
    .map(([k]) => k);   // 未勾选的检查器不执行
  try {
    const { diagnostics } = await api.lint(path, model.getValue(),
      model.getLanguageId(), { options: opts, enabled });
    const markers = diagnostics.map((d) => ({
      severity: d.severity === "error" ? monacoApi.MarkerSeverity.Error
              : d.severity === "warning" ? monacoApi.MarkerSeverity.Warning
              : monacoApi.MarkerSeverity.Info,
      message: `${d.message}\n${i18n.global.t("common.hintPrefix")} ${d.hint}`,   // 不同错误不同提示
      source: d.source,
      startLineNumber: d.line, startColumn: d.col,
      endLineNumber: d.line, endColumn: d.col + 1,
    }));
    monacoApi.editor.setModelMarkers(model, "codeforge", markers);
  } catch {}
}
