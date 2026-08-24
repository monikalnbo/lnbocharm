/// Monaco 编辑器初始化、语言注册表接入、LSP 补全代理、断点装饰
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { api } from "./api.js";
import { wsRequest, on as wsOn } from "./ws.js";
import { store } from "./store.js";

// ---------- workers ----------
self.MonacoEnvironment = {
  getWorker() {
    return new Worker(
      new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url),
      { type: "module" }
    );
  },
};

export { monaco };

// ---------- 主题 ----------
monaco.editor.defineTheme("codeforge-dark", {
  base: "vs-dark", inherit: true,
  rules: [],
  colors: { "editor.background": "#14182100" },   // 透明：让背景板透出（不遮挡代码）
});
monaco.editor.defineTheme("codeforge-light", {
  base: "vs", inherit: true,
  rules: [],
  colors: { "editor.background": "#ffffff00" },
});

// ---------- 语言注册表 ----------
export async function loadRegistry() {
  const reg = await api.languages();
  store.registry = reg;
  const map = {};
  for (const [name, meta] of Object.entries(reg))
    for (const ext of meta.ext || []) map[ext.toLowerCase()] = name;
  store.extMap = map;
}

export function languageOf(filename) {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return store.extMap[ext] || null;
}

function fileUri(path) {
  return "inmemory://workspace/" + path;
}

// ---------- 模型管理（打开文件 → model） ----------
export async function openModel(path) {
  let model = monaco.editor.getModel(monaco.Uri.parse(fileUri(path)));
  if (!model) {
    const text = await api.read(path);
    const lang = languageOf(path) || "plaintext";
    model = monaco.editor.createModel(text, lang, monaco.Uri.parse(fileUri(path)));
    model.updateOptions({ tabSize: store.registry[lang]?.indent || 4 });
    // didOpen → LSP
    wsNotifySafe(lang, "textDocument/didOpen", {
      textDocument: { uri: fileUri(path), languageId: lang, version: 1, text },
    });
  }
  return model;
}

export function getModel(path) {
  return monaco.editor.getModel(monaco.Uri.parse(fileUri(path)));
}

// ---------- LSP 补全代理（失败静默回退到 Monaco 词法补全） ----------
let lspTried = new Set();

export async function ensureLsp(language) {
  if (!store.registry[language] || lspTried.has(language)) return;
  lspTried.add(language);
  try {
    await wsRequest("lsp.start", { language, root: null }, 15_000);
  } catch (e) {
    // CF2003：语言服务器缺失。基础补全仍可用；提示走状态栏
    store.notice = `智能补全不可用（${e.cf?.hint || e.message}），已回退词法补全`;
    setTimeout(() => { if (store.notice?.startsWith("智能补全不可用")) store.notice = ""; }, 8000);
  }
}

for (const lang of ["c", "cpp", "csharp", "rust", "python", "java",
                    "typescript", "javascript"]) {
  monaco.languages.registerCompletionItemProvider(lang, {
    triggerCharacters: [".", ":", "<", '"', "/", "->"],
    async provideCompletionItems(model, position) {
      try {
        const items = await wsRequest("lsp.request", {
          language: lang,
          method: "textDocument/completion",
          params: {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          },
        }, 5_000);
        const list = Array.isArray(items) ? items : items?.items || [];
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
          startColumn: word.startColumn, endColumn: word.endColumn,
        };
        return {
          suggestions: list.map((it) => ({
            label: it.label ?? it.insertText ?? "",
            kind: (it.kind ?? 1),
            insertText: it.insertText ?? it.label ?? "",
            detail: it.detail || "LSP",
            range,
          })),
        };
      } catch {
        return { suggestions: [] };   // LSP 未就绪时回退词法补全
      }
    },
  });
}

// ---------- LSP 诊断转发（publishDiagnostics → Monaco markers） ----------
export function initLspDiagnostics() {
  wsOn("lsp.notification", ({ language, method, params }) => {
    if (method !== "textDocument/publishDiagnostics") return;
    const prefix = "inmemory://workspace/";
    const path = decodeURIComponent((params.uri || "").slice(prefix.length));
    const model = monaco.editor.getModel(monaco.Uri.parse(prefix + path));
    if (!model) return;
    const markers = (params.diagnostics || []).map((d) => ({
      severity: d.severity === 1 ? monaco.MarkerSeverity.Error
              : d.severity === 2 ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
      message: d.message,
      source: "lsp:" + language,
      startLineNumber: (d.range?.start?.line ?? 0) + 1,
      startColumn: (d.range?.start?.character ?? 0) + 1,
      endLineNumber: (d.range?.end?.line ?? 0) + 1,
      endColumn: (d.range?.end?.character ?? 0) + 1,
    }));
    monaco.editor.setModelMarkers(model, "lsp", markers);
  });
}
