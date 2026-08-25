/// 工具链分发（任务 #38/#41）：
/// - 服务器上存一份各平台压缩包 + manifest.json
/// - GET /api/toolchains           → 清单（含 SHA256）
/// - GET /api/toolchains/:id/download → 流式下载压缩包
///
/// 存储布局（TOOLCHAIN_DIR，默认 <repo>/toolchains/）：
///   toolchains/
///     manifest.json   ← [{id, language, version, platform, file, size, sha256}]
///     gcc-13.2-linux-x64.tar.gz
///     ...
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function manifestPath(dir) { return path.join(dir, "manifest.json"); }

const DEFAULT_MANIFEST = path.join(__dirname, "..", "..", "..", "shared", "default-toolchain-manifest.json");

function loadManifest(dir) {
  // 用户目录优先（管理员可自定义）；缺失时回退内置默认清单（七语言开箱可见）
  for (const f of [manifestPath(dir), DEFAULT_MANIFEST]) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) {}
  }
  return [];
}

function findById(dir, id) {
  return loadManifest(dir).find((t) => t.id === id);
}

function list(dir) {
  return loadManifest(dir).map(({ file, ...pub }) => pub);   // 不暴露服务器文件名
}

function filePathOf(dir, entry) {
  const abs = path.resolve(dir, entry.file);
  if (!abs.startsWith(path.resolve(dir))) return null;       // 防穿越
  if (!fs.existsSync(abs)) return null;
  return abs;
}

function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(abs)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

module.exports = { loadManifest, findById, list, filePathOf, sha256File };
