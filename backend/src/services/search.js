/// 全局搜索与替换：工作区内跨文件扫描。
/// - 跳过隐藏目录 / node_modules / 常见二进制扩展名
/// - 结果上限防失控；替换逐文件执行并统计
const fsp = require("fs/promises");
const path = require("path");

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".pytest_cache", "tools"]);
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".zip", ".gz",
  ".tar", ".zst", ".exe", ".dll", ".so", ".dylib", ".pdf", ".woff2", ".mp4"]);
const MAX_FILE = 1024 * 1024;
const MAX_RESULTS = 500;

function isSkipped(name) {
  return name.startsWith(".") || SKIP_DIRS.has(name);
}

async function* walk(root, rel = "") {
  let entries;
  try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); }
  catch { return; }
  for (const ent of entries) {
    if (isSkipped(ent.name)) continue;
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) yield* walk(root, r);
    else {
      const ext = path.extname(ent.name).toLowerCase();
      if (BINARY_EXT.has(ext)) continue;
      const st = await fsp.stat(path.join(root, r)).catch(() => null);
      if (st && st.size <= MAX_FILE) yield r;
    }
  }
}

function buildMatcher(q, { regex = false, caseSensitive = false } = {}) {
  if (!q) return null;
  if (regex) {
    try {
      const re = new RegExp(q, caseSensitive ? "g" : "gi");
      // /g 的 test 会推进 lastIndex，跨行复用必须每次归零，否则漏配
      return { test: (line) => { re.lastIndex = 0; return re.test(line); }, re };
    } catch { return null; }
  }
  const needle = caseSensitive ? q : q.toLowerCase();
  return {
    test: (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle),
    replaceLine: (line) =>
      caseSensitive
        ? line.split(q).join(arguments[1])
        : line.toLowerCase().split(needle).join(arguments[1]),
  };
}

/// 搜索：返回按文件分组的匹配行
async function search(workspace, opts) {
  const matcher = buildMatcher(opts.q, opts);
  if (!matcher) return { matches: [], total: 0 };
  const matches = [];
  let total = 0;
  for await (const rel of walk(workspace.root)) {
    const text = await fsp.readFile(path.join(workspace.root, rel), "utf8").catch(() => null);
    if (text == null) continue;
    const lines = [];
    text.split("\n").forEach((line, i) => {
      if (total >= MAX_RESULTS) return;
      if (matcher.test(line)) {
        total++;
        lines.push({ n: i + 1, text: line.slice(0, 300) });
      }
    });
    if (lines.length) matches.push({ path: rel, lines });
  }
  return { matches, total };
}

/// 替换：返回受影响文件数与替换次数
async function replaceAll(workspace, opts) {
  const { q, replacement = "" } = opts;
  if (!q) return { filesChanged: 0, total: 0 };
  const flags = opts.caseSensitive ? "g" : "gi";
  let re;
  try { re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags); } // 字面量替换：转义正则元字符
  catch { return { filesChanged: 0, total: 0 }; }

  let filesChanged = 0, total = 0;
  for await (const rel of walk(workspace.root)) {
    const abs = workspace.safeResolve(rel);
    const text = await fsp.readFile(abs, "utf8").catch(() => null);
    if (text == null) continue;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const count = (text.match(re) || []).length;
    const updated = text.replace(re, replacement);
    await fsp.writeFile(abs, updated, "utf8");
    filesChanged++; total += count;
  }
  return { filesChanged, total };
}

module.exports = { search, replaceAll, MAX_RESULTS };
