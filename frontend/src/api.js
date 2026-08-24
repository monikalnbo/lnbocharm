/// REST API 客户端
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
  languages: () => jfetch("/api/languages"),
  tree: (p = ".") => jfetch("/api/files/tree?path=" + encodeURIComponent(p)),
  read: (p) => jfetch("/api/files/read?path=" + encodeURIComponent(p)),
  write: (p, content) => jfetch("/api/files/write", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: p, content }),
  }),
  create: (p, dir = false) => jfetch("/api/files/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: p, dir }),
  }),
  remove: (p) => jfetch("/api/files/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: p }),
  }),
  lint: (file, text, lang, extra = {}) => jfetch("/api/lint", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file, text, lang, ...extra }),
  }),
};
