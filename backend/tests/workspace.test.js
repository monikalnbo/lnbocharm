const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { Workspace } = require("../src/services/workspace");

function tmpWs() {
  return new Workspace(fs.mkdtempSync(path.join(os.tmpdir(), "cf-ws-")));
}

test("safeResolve 拦截路径穿越", () => {
  const ws = tmpWs();
  for (const evil of ["../evil.txt", "..\\evil.txt", "a/../../evil",
                      "/etc/passwd", "sub/../../../x"]) {
    assert.throws(() => ws.safeResolve(evil), /非法路径|ERR/, `应拦截: ${evil}`);
  }
});

test("write/read/rename/delete 往返", async () => {
  const ws = tmpWs();
  await ws.write("src/main.py", "print('hi')\n");
  assert.strictEqual(await ws.read("src/main.py"), "print('hi')\n");
  await ws.rename("src/main.py", "src/renamed.py");
  await assert.rejects(() => ws.read("src/main.py"));
  await ws.remove("src/renamed.py");
  await assert.rejects(() => ws.read("src/renamed.py"));
});

test("tree 忽略隐藏文件与 node_modules", async () => {
  const ws = tmpWs();
  await ws.write(".hidden/x.txt", "x");
  await ws.write("node_modules/pkg/i.js", "i");
  await ws.write("app.ts", "// ts");
  const tree = await ws.tree(".");
  const names = JSON.stringify(tree);
  assert.ok(names.includes("app.ts"));
  assert.ok(!names.includes("node_modules") && !names.includes(".hidden"));
});

test("read 大文件拒绝", async () => {
  const ws = tmpWs();
  await ws.write("big.bin", "a".repeat(3 * 1024 * 1024));
  await assert.rejects(() => ws.read("big.bin", 1024));
});
