<template>
  <div class="panel">
    <div class="panel-head">
      构建
      <select v-model="store.buildMode" @change="setBuildMode(store.buildMode)">
        <option value="server">服务器构建</option>
        <option value="local">本机构建（桌面端）</option>
        <option value="docker">Docker 构建</option>
      </select>
      <button :disabled="store.buildRunning || !store.activePath" @click="run">
        ▶ 运行
      </button>
    </div>
    <pre v-if="notice" class="notice">{{ notice }}</pre>
    <pre ref="out" class="build-out">{{ store.buildOutput || "选择构建模式，打开文件后点击运行" }}</pre>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from "vue";
import { store, setBuildMode } from "../store.js";
import { wsRequest, wsNotify, on } from "../ws.js";

const out = ref(null);
const notice = ref("");

const isElectron = !!window.codeforge;   // Electron 预加载注入（任务#21）

on("build.output", ({ chunk }) => {
  append(chunk);
});
on("build.result", (r) => {
  store.buildRunning = false;
  const tail = r.ok ? `✓ 成功（${r.durationMs}ms，退出码 ${r.exitCode}）`
                    : `✗ 失败（退出码 ${r.exitCode}）`;
  append(`\n=== ${tail} ===\n`);
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
      notice.value = "本机构建需要在桌面应用中运行；当前为浏览器模式，已切换为服务器构建。";
      store.buildMode = "server";
    } else {
      store.buildRunning = true;
      try {
        const r = await window.codeforge.localBuild(store.activePath);
        append(r.output);
        append(`\n=== ${r.ok ? "✓ 成功" : "✗ 失败"}（${r.durationMs}ms）===\n`);
      } finally { store.buildRunning = false; }
    }
    return;
  }
  if (store.buildMode === "docker") {
    notice.value = "Docker 构建模式需要服务器端工具链容器池（docker-compose up），当前先用服务器模式。";
    store.buildMode = "server";
    return;
  }
  // 服务器模式：WS build.start 流式输出
  store.buildRunning = true;
  store.buildOutput = "";
  wsNotify("build.start", { file: store.activePath });
}
</script>
