/// CodeForge 数据面 API —— 全部走加密 WS 信封通道（不走 HTTP）
import { wsRequest, wsNotify } from "./ws.js";

async function jfetch(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json();
  if (!body.ok) {
    const err = new Error(body.error?.message || body.error?.code || "request failed");
    err.cf = body.error;
    throw err;
  }
  return body.payload;
}

export const api = {
  languages: () => wsRequest("languages"),
  tree: (p = ".") => wsRequest("file.tree", { path: p }),
  read: (p) => wsRequest("file.read", { path: p }),
  write: (p, content) => wsRequest("file.write", { path: p, content }),
  create: (p, dir = false) => wsRequest("file.create", { path: p, dir }),
  remove: (p) => wsRequest("file.delete", { path: p }),
  rename: (from, to) => wsRequest("file.rename", { from, to }),

  lint: (file, text, lang, extra = {}) =>
    wsRequest("lint", { file, text, lang, ...extra }),

  search: (opts) => wsRequest("search", opts),
  searchReplace: (opts) => wsRequest("search.replace", opts),
  reloadModel: (p) => wsRequest("file.read", { path: p }),

  logs: (limit = 300, level = "", source = "") =>
    wsRequest("logs.tail", { limit, level, source }),
  reportAction: (event, target, args) => {
    wsNotify("logs.action", { event, target, args });
  },

  /// 兼容保留：大文件下载等特殊场景仍可走 HTTP（明文 REST 在开鉴权后已被封锁）
  jfetch,
};

/// UI 操作埋点：每次关键点击都落日志，fire-and-forget
export function track(event, target, args) {
  api.reportAction(event, target, args);
}
