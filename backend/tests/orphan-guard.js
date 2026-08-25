// 测试基建：登记所有 spawn 的子进程，进程退出时强制清理（防孤儿占用端口）
const cp = require("child_process");
const kids = new Set();
const origSpawn = cp.spawn;
cp.spawn = function patchedSpawn(...args) {
  const child = origSpawn.apply(cp, args);
  kids.add(child);
  child.once("exit", () => kids.delete(child));
  return child;
};
function killAll() {
  for (const c of kids) { try { c.kill("SIGKILL"); } catch (_) {} }
}
for (const sig of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(sig, killAll);
}
module.exports = { track() {}, killAll };
