const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const WebSocket = require("ws");

/// 端到端：manifest + 下载 + SHA256 校验（真实 HTTP）
test("工具链清单与下载", async () => {
  // 1. 准备存储目录：假压缩包 + manifest
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-tc-"));
  const archiveName = "gcc-13.2-linux-x64.tar.gz";
  const archiveBody = Buffer.from("FAKE-TAR-GZ-CONTENT");
  fs.writeFileSync(path.join(dir, archiveName), archiveBody);
  const sha = crypto.createHash("sha256").update(archiveBody).digest("hex");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify([
    { id: "gcc-13.2-linux-x64", language: "c", version: "13.2",
      platform: "linux", size: archiveBody.length, sha256: sha, file: archiveName },
    { id: "rust-missing", language: "rust", version: "1", platform: "linux",
      size: 0, sha256: "", file: "not-exist.tar.gz" },   // 清单有但文件丢失
  ]));

  // 2. 启动服务器
  const PORT = 8933;
  const child = spawn(process.execPath,
    [path.join(__dirname, "..", "src", "index.js")],
    { env: { ...process.env, PORT: String(PORT), CODEFORGE_TOOLCHAINS: dir },
      stdio: ["ignore", "inherit", "inherit"] });   // stderr 直通，便于定位崩溃
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }

  try {
    // 3. 清单接口
    const listResp = await fetch(`http://127.0.0.1:${PORT}/api/toolchains`);
    const list = (await listResp.json()).payload;
    assert.strictEqual(list.length, 2);
    assert.ok(!JSON.stringify(list).includes(archiveName));   // 不暴露服务器文件名
    assert.strictEqual(list[0].sha256, sha);

    // 4. 正常下载
    const dl = await fetch(`http://127.0.0.1:${PORT}/api/toolchains/gcc-13.2-linux-x64/download`);
    assert.strictEqual(dl.status, 200);
    const body = Buffer.from(await dl.arrayBuffer());
    assert.ok(body.equals(archiveBody));
    assert.strictEqual(crypto.createHash("sha256").update(body).digest("hex"), sha);

    // 5. 文件缺失 → 404 CF2003
    const miss = await fetch(`http://127.0.0.1:${PORT}/api/toolchains/rust-missing/download`);
    assert.strictEqual(miss.status, 404);
    const errBody = await miss.json();
    assert.strictEqual(errBody.error.code, "CF2003");
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 15_000 });
