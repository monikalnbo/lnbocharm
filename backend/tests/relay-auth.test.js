/// 加速器安全测试：token + 设备指纹白名单（默认拒绝未知设备）
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");

const SERVER_JS = path.join(__dirname, "..", "src", "index.js");
const PORT = 8941;
const TOKEN = "relay-s3cret";
const GOOD_FP = "a".repeat(32);

async function tryConnect(fp) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/relay?token=${TOKEN}&fp=${fp}`);
  const opened = await new Promise((res) => {
    ws.on("open", () => res(true));
    ws.on("close", () => res(false));
    ws.on("error", () => res(false));
    setTimeout(() => res(false), 2000);
  });
  ws.terminate();
  return opened;   // true=被接受
}

test("加速器白名单：仅允许特定指纹连接", async () => {
  const child = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CODEFORGE_RELAY_TOKEN: TOKEN,
      CODEFORGE_RELAY_FPS: `${GOOD_FP},b${"b".repeat(31)}`,
    },
    stdio: ["ignore", "ignore", "inherit"],   // stderr 直通观察拒绝日志
  });
  await new Promise((r) => setTimeout(r, 1200));

  try {
    assert.strictEqual(await tryConnect(GOOD_FP), true,   // 白名单内 → 放行
      "白名单指纹应放行");
    assert.strictEqual(await tryConnect("c".repeat(32)), false, "未知指纹应拒绝");
    assert.strictEqual(await tryConnect(""), false,        "空指纹应拒绝");
    // 错 token 直接拒绝（即使指纹对）
    const wsBadToken = new WebSocket(
      `ws://127.0.0.1:${PORT}/relay?token=WRONG&fp=${GOOD_FP}`);
    const badOpened = await new Promise((res) => {
      wsBadToken.on("open", () => res(true));
      wsBadToken.on("error", () => res(false));
      wsBadToken.on("close", () => res(false));
      setTimeout(() => res(false), 2000);
    });
    assert.strictEqual(badOpened, false, "错误 token 应拒绝");
    wsBadToken.terminate();
  } finally {
    child.kill();
  }
}, { timeout: 15_000 });

test("未配置白名单时保持原行为（仅 token）", async () => {
  const child = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, PORT: String(PORT), CODEFORGE_RELAY_TOKEN: TOKEN },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await new Promise((r) => setTimeout(r, 1200));
  try {
    assert.strictEqual(await tryConnect("any-fp"), true);   // 无白名单不限制
  } finally {
    child.kill();
  }
}, { timeout: 15_000 });
