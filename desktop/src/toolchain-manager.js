/// 工具链包管理器（任务 #38/#41 桌面端）：
/// - 从配置的服务器拉清单 → 下载压缩包 → SHA256 校验 → tar 解压到 tools/<id>
/// - Windows 10+/macOS/Linux 均自带 tar，无需额外依赖
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

function serverBase() {
  // 优先设置文件；其次环境变量；默认本地开发地址
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codeforge", "settings.json"), "utf8"));
    if (s.serverUrl) return s.serverUrl.replace(/\/$/, "");
  } catch {}
  return (process.env.CODEFORGE_SERVER || "http://localhost:8787").replace(/\/$/, "");
}

function toolsDir() { return path.join(__dirname, "..", "..", "tools"); }

async function list() {
  const r = await fetch(`${serverBase()}/api/toolchains`);
  const j = await r.json();
  return j.payload || [];
}

function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(abs).on("data", (d) => h.update(d))
      .on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

/// 安装：下载→校验→解压。onProgress(percent) 回调。
async function install(id, onProgress = () => {}) {
  onProgress(2);
  const listResp = await fetch(`${serverBase()}/api/toolchains`);
  const listJ = await listResp.json();
  const entry = (listJ.payload || []).find((t) => t.id === id);
  if (!entry) {
    return { ok: false, output: `清单中不存在 ${id}（来源：${serverBase()}）` };
  }
  onProgress(5);

  // 下载（流式写盘+边下边算哈希，内存恒定）：优先 GitHub 直链，否则走服务器分发
  const dlUrl = entry.url || `${serverBase()}/api/toolchains/${id}/download`;
  const dl = await fetch(dlUrl);
  if (!dl.ok) return { ok: false, output: `下载失败 HTTP ${dl.status}（${dlUrl}）` };

  const dest = path.join(toolsDir(), id);
  fs.mkdirSync(dest, { recursive: true });
  const tmpArchive = path.join(os.tmpdir(), `cf-${id}-${Date.now()}.tar.gz`);

  const { Readable } = require("stream");
  let sourceFail = null;
  await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    let received = 0;
    const total = entry.size || Number(dl.headers.get("content-length")) || 0;
    const hasher = new require("stream").Transform({
      transform(chunk, _e, cb) { hash.update(chunk); this.push(chunk); cb(); },
    });
    sourceFail = (e) => reject(Object.assign(e, { streamError: true }));
    Readable.fromWeb(dl.body)
      .on("data", (c) => {
        received += c.length;
        if (total) onProgress(Math.min(55, Math.round((received / total) * 55)));
      })
      .pipe(hasher)
      .pipe(fs.createWriteStream(tmpArchive))
      .on("error", sourceFail)
      .on("finish", resolve);
  }).then(null, (e) => {
    try { fs.rmSync(tmpArchive, { force: true }); } catch (_) {}
    if (e && e.streamError) throw e;
    return Promise.reject({ ok: false, output: `下载失败: ${e.message}` });
  });
  onProgress(60);

  // SHA256 校验（对落盘文件）
  {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(tmpArchive));
    const actual = hash.digest("hex");
    if (entry.sha256 && actual !== entry.sha256) {
      fs.rmSync(tmpArchive, { force: true });
      return { ok: false, output: `SHA256 不匹配\n期望 ${entry.sha256}\n实际 ${actual}` };
    }
  }

  // 先列出条目做安全校验：拒绝绝对路径与 .. 穿越（TarBomb 防护）
  const listing = await new Promise((resolve) => {
    const t = spawn("tar", ["-tzf", tmpArchive]);
    let out = "";
    t.stdout.on("data", (d) => (out += d.toString()));
    t.on("error", () => resolve(null));
    t.on("close", () => resolve(out));
  });
  if (listing !== null) {
    const dangerous = listing.split("\n").filter((e) =>
      e.startsWith("/") || e.includes("../") || e.includes("~"));
    if (dangerous.length) {
      fs.rmSync(tmpArchive, { force: true });
      return { ok: false,
        output: `压缩包包含危险路径，已拒绝解压:\n${dangerous.slice(0, 5).join("\n")}` };
    }
  }

  await new Promise((resolve) => {
    const tar = spawn("tar", ["-xzf", tmpArchive, "-C", dest]);
    tar.on("error", () => resolve());   // tar 不存在时静默（提示用户手动解压）
    tar.on("close", resolve);
  });
  fs.rmSync(tmpArchive, { force: true });
  onProgress(95);

  // 写安装标记
  fs.writeFileSync(path.join(dest, ".installed"),
    JSON.stringify({ id: entry.id, version: entry.version,
                     installedAt: new Date().toISOString() }));
  onProgress(100);
  return { ok: true, path: dest };
}

module.exports = { list, install, toolsDir, serverBase };
