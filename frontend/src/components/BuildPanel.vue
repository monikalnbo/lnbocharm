<template>
  <div class="panel">
    <div class="panel-head">
      {{ t("build.title") }}
      <select v-model="store.buildMode" @change="setBuildMode(store.buildMode)">
        <option value="server">{{ t("build.modes.server") }}</option>
        <option value="local">{{ t("build.modes.local") }}</option>
        <option value="docker">{{ t("build.modes.docker") }}</option>
      </select>
      <button :disabled="store.buildRunning || !store.activePath" @click="run">
        {{ t("build.run") }}
      </button>
    </div>
    <pre v-if="notice" class="notice">{{ notice }}</pre>
    <details class="history">
      <summary>{{ t("build.history", { n: history.length }) }}</summary>
      <ul>
        <li v-for="(h, i) in history" :key="i">
          <span :class="h.ok ? 'ok' : 'bad'">{{ h.ok ? '✓' : '✗' }}</span>
          {{ new Date(h.ts).toLocaleTimeString() }} · {{ h.mode }} · {{ h.file.split('/').pop() }} · {{ h.ms }}ms
          <button class="icon" :title="t('build.viewOutput')" @click="viewHistory(h)">👁</button>
          <button class="icon" :title="t('build.rerun')" @click="rerun(h)">↻</button>
        </li>
      </ul>
    </details>
    <pre ref="out" class="build-out">{{ store.buildOutput || t("build.emptyHint") }}</pre>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from "vue";
import { store, setBuildMode } from "../store.js";
import { wsRequest, wsNotify, on } from "../ws.js";
import { track } from "../api.js";
import { useI18n } from "vue-i18n";

const out = ref(null);
const { t } = useI18n();
const notice = ref("");
const history = ref([]);
const _histFile = ref("");
const _histMode = ref("");

function loadHistory() {
  try { history.value = JSON.parse(localStorage.getItem("cf.history") || "[]"); } catch {}
}
function viewHistory(h) {
  store.buildOutput = `[历史] ${h.file} @ ${new Date(h.ts).toLocaleString()}\n\n` + h.output;
}
async function rerun(h) {
  await openAndRun(h.file);
}
async function openAndRun(file) {
  const { openFile } = await import("../editor.js");
  await openFile(file);
  setTimeout(run, 100);
}
loadHistory();

const isElectron = !!window.codeforge;   // Electron 预加载注入（任务#21）

on("build.output", ({ chunk }) => {
  append(chunk);
});
// 构建历史（任务 #31）：最近 20 条，持久化
function recordHistory(file, mode, r) {
  try {
    const h = JSON.parse(localStorage.getItem("cf.history") || "[]");
    h.unshift({ ts: Date.now(), file, mode, ok: !!r.ok,
                ms: r.durationMs, exitCode: r.exitCode,
                output: (r.output || "").slice(-2000) });
    localStorage.setItem("cf.history", JSON.stringify(h.slice(0, 20)));
  } catch {}
}

on("build.result", (r) => {
  store.buildRunning = false;
  track("build.done", store.activePath, { ok: r.ok });
  const tail = r.ok ? `✓ 成功（${r.durationMs}ms，退出码 ${r.exitCode}）`
                    : `✗ 失败（退出码 ${r.exitCode}）`;
  append(`\n=== ${tail} ===\n`);
  if (_histFile.value) {
    recordHistory(_histFile.value, _histMode.value,
      { ...r, output: store.buildOutput });
    loadHistory();
  }
});

function append(s) {
  store.buildOutput += s;
  if (store.buildOutput.length > 600_000) store.buildOutput = store.buildOutput.slice(-500_000);
  nextTick(() => { if (out.value) out.value.scrollTop = out.value.scrollHeight; });
}

async function run() {
  if (!store.activePath) return;
  if (store.buildMode === "local") {
    // 本机构建走 Electron IPC；纯网页环境给出明确提示
    if (!isElectron || !window.codeforge?.localBuild) {
      notice.value = t("build.localNeedsDesktop");
      store.buildMode = "server";
    } else {
      store.buildRunning = true;
      track("build.start", store.activePath, { mode: "local" });
      const f0 = store.activePath;
      try {
        const r = await window.codeforge.localBuild(store.activePath);
        append(r.output);
        append(`\n=== ${r.ok ? "✓ 成功" : "✗ 失败"}（${r.durationMs}ms）===\n`);
        recordHistory(f0, "local", { ...r, output: r.output || store.buildOutput });
        loadHistory();
      } finally { store.buildRunning = false; }
    }
    return;
  }
  if (store.buildMode === "docker") {
    notice.value = t("build.dockerNeedsCompose");
    store.buildMode = "server";
    return;
  }
  // 服务器模式：WS build.start 流式输出
  track("build.start", store.activePath, { mode: "server" });
  store.buildRunning = true;
  store.buildOutput = "";
  wsNotify("build.start", { file: store.activePath });
  _histFile.value = store.activePath;
  _histMode.value = "server";
}
</script>

<style scoped>
.history { font-size: 12px; color: var(--dim); border-bottom: 1px solid var(--border); padding: 4px 10px; }
.history ul { list-style: none; margin: 4px 0 0; padding: 0; max-height: 120px; overflow: auto; }
.history li { display: flex; gap: 6px; align-items: center; padding: 2px 0; }
.history .ok { color: #3fb950; } .history .bad { color: #f85149; }
</style>
