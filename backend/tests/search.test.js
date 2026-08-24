const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Workspace } = require("../src/services/workspace");
const { search, replaceAll } = require("../src/services/search");

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-search-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/a.py"), "def hello():\n    return 'hello world'\n");
  fs.writeFileSync(path.join(root, "b.md"), "# hello doc\nnothing here\nhello again\n");
  fs.mkdirSync(path.join(root, "node_modules/x"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules/x/c.js"), "hello from node_modules\n"); // 必须被跳过
  fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50]));
  return new Workspace(root);
}

test("搜索：跨文件匹配并跳过 node_modules/二进制", async () => {
  const ws = setup();
  const r = await search(ws, { q: "hello" });
  assert.strictEqual(r.total, 4);   // a.py×2 + b.md×2
  const paths = r.matches.map((m) => m.path);
  assert.ok(paths.includes("src/a.py") && paths.includes("b.md"));
  assert.ok(!paths.some((p) => p.includes("node_modules")));
});

test("搜索：大小写敏感开关", async () => {
  const ws = setup();
  const ci = await search(ws, { q: "HELLO" });
  const cs = await search(ws, { q: "HELLO", caseSensitive: true });
  assert.strictEqual(ci.total, 4);
  assert.strictEqual(cs.total, 0);
});

test("搜索：空查询安全返回", async () => {
  const ws = setup();
  assert.deepStrictEqual(await search(ws, { q: "" }), { matches: [], total: 0 });
});

test("替换：字面量替换（含正则元字符）+ 计数", async () => {
  const ws = setup();
  const r = await replaceAll(ws, { q: "hello", replacement: "hi" });
  assert.strictEqual(r.filesChanged, 2);
  assert.strictEqual(r.total, 4);
  assert.ok(fs.readFileSync(path.join(ws.root, "src/a.py"), "utf8").includes("'hi world'"));
  // 再搜原词应为 0
  const after = await search(ws, { q: "hello" });
  assert.strictEqual(after.total, 0);
});

test("替换：正则元字符按字面处理不炸", async () => {
  const ws = setup();
  fs.writeFileSync(path.join(ws.root, "d.txt"), "a.c matches\n");
  const r = await replaceAll(ws, { q: "a.c", replacement: "XYZ" });
  assert.strictEqual(r.total, 1);
  assert.ok(fs.readFileSync(path.join(ws.root, "d.txt"), "utf8").includes("XYZ"));
});
