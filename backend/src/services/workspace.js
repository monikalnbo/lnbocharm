/// 工作区文件服务：路径安全校验 + 文件树/读写/重命名/删除。
/// 安全规则：所有路径必须解析到 workspace 根之内（防穿越）。
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { makeError } = require("../protocol");

class Workspace {
  /** root: 工作区绝对路径 */
  constructor(root) {
    this.root = path.resolve(root);
    if (!fs.existsSync(this.root)) fs.mkdirSync(this.root, { recursive: true });
  }

  /** 动态切换工作区根（仅本机回环调用方允许触发）*/
  setRoot(root) {
    const abs = path.resolve(root);
    if (!fs.existsSync(abs)) throw Object.assign(new Error("目录不存在"), { cf: makeError("CF1001") });
    if (!fs.statSync(abs).isDirectory())
      throw Object.assign(new Error("不是目录"), { cf: makeError("CF1002", { message: "工作区必须是目录" }) });
    this.root = abs;
    return { root: abs };
  }
  getRoot() { return this.root; }

  /** 解析并校验相对路径；非法抛 CF1002 */
  safeResolve(rel) {
    const abs = path.resolve(this.root, rel || ".");
    const relFromRoot = path.relative(this.root, abs);
    if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
      throw Object.assign(new Error("非法路径"), { cf: makeError("CF1002") });
    }
    return abs;
  }

  async tree(rel = ".", depth = 6) {
    const dir = this.safeResolve(rel);
    return this._walk(dir, dir, depth);
  }

  async _walk(abs, base, depth) {
    if (depth <= 0) return [];
    let entries;
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); }
    catch { return []; }
    const out = [];
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
      const full = path.join(abs, ent.name);
      const item = {
        name: ent.name,
        path: path.relative(base, full).split(path.sep).join("/"),
        dir: ent.isDirectory(),
      };
      if (ent.isDirectory()) {
        item.children = await this._walk(full, base, depth - 1);
      } else {
        const st = await fsp.stat(full);
        item.size = st.size;
      }
      out.push(item);
    }
    return out;
  }

  async read(rel, maxBytes = 2 * 1024 * 1024) {
    const abs = this.safeResolve(rel);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw Object.assign(new Error("not a file"), { cf: makeError("CF1001") });
    if (st.size > maxBytes) throw Object.assign(new Error("too large"), { cf: makeError("CF1003", { hint: `文件超过 ${maxBytes} 字节，暂不支持在编辑器打开` }) });
    return fsp.readFile(abs, "utf8");
  }

  async write(rel, content) {
    const abs = this.safeResolve(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content ?? "", "utf8");
    return { bytes: Buffer.byteLength(content ?? "") };
  }

  async create(rel, isDir = false) {
    const abs = this.safeResolve(rel);
    if (fs.existsSync(abs)) throw Object.assign(new Error("exists"), { cf: makeError("CF1003", { message: "文件已存在" }) });
    if (isDir) await fsp.mkdir(abs, { recursive: true });
    else { await fsp.mkdir(path.dirname(abs), { recursive: true }); await fsp.writeFile(abs, "", "utf8"); }
    return {};
  }

  async rename(fromRel, toRel) {
    const from = this.safeResolve(fromRel);
    const to = this.safeResolve(toRel);
    if (!fs.existsSync(from)) throw Object.assign(new Error("missing"), { cf: makeError("CF1001") });
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    return {};
  }

  async remove(rel) {
    const abs = this.safeResolve(rel);
    if (abs === this.root) throw Object.assign(new Error("root"), { cf: makeError("CF1002", { message: "不能删除工作区根目录" }) });
    await fsp.rm(abs, { recursive: true, force: true });
    return {};
  }
}

module.exports = { Workspace };
