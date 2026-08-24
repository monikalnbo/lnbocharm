const test = require("node:test");
const assert = require("node:assert");
const { makeError, ok, fail, handshake } = require("../src/protocol");

test("makeError 渲染参数化插槽", () => {
  const e = makeError("CF2003", { toolchain: "gcc", install: "apt install gcc" });
  assert.strictEqual(e.code, "CF2003");
  assert.ok(!e.message.includes("{toolchain}"));
  assert.match(e.hint, /gcc/);
  assert.match(e.hint, /apt install gcc/);
});

test("makeError 未知码降级不崩", () => {
  const e = makeError("CF9999");
  assert.strictEqual(e.code, "CF9999");
  assert.ok(e.severity);
});

test("信封结构", () => {
  const r = ok("id1", "x.result", { a: 1 });
  assert.deepStrictEqual([r.v, r.id, r.type, r.ok], [1, "id1", "x.result", true]);
  const f = fail("id2", "x.result", "CF1001");
  assert.strictEqual(f.ok, false);
  assert.ok(f.error.hint.length > 0);   // 不同错误不同提示：必须有 hint
});

test("握手校验", () => {
  assert.ok(handshake({ v: 1, type: "hello", payload: { client: "desktop" } }).ok);
  assert.ok(!handshake({ v: 1, type: "hello", payload: { client: "hacker" } }).ok);
  assert.ok(!handshake({ v: 2, type: "hello" }).ok);
  assert.ok(!handshake({ v: 1, type: "ping" }).ok);
});
