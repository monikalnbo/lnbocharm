<template>
  <div class="panel browser">
    <div class="panel-head">
      <button class="icon" @click="back">◀</button>
      <button class="icon" @click="forward">▶</button>
      <button class="icon" @click="reload">⟳</button>
      <input class="url" v-model="addr" @keydown.enter="go(addr)" spellcheck="false" />
      <button :class="{ quick: true, on: addr.startsWith('https://github.com') }" @click="go('https://github.com')">GitHub</button>
      <button :class="{ quick: true, on: addr.startsWith('https://x.com') }" @click="go('https://x.com')">𝕏</button>
    </div>

    <div v-if="!isDesktop" class="webonly">
      内嵌浏览器需要桌面应用（Electron Chromium 内核 + 加速器隧道）。<br/>
      当前为浏览器模式，请运行 desktop 端。
    </div>
    <div v-else class="wv-host">
      <webview ref="wv" :src="src" partition="persist:accelerated"
               allowpopups style="width:100%;height:100%"></webview>
    </div>

    <div class="status">
      加速器：{{ accel.running ? `已启用 (127.0.0.1:${accel.port})` : "未启用" }}
      · 活动连接 {{ accel.activeConns || 0 }}
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";

const isDesktop = !!window.codeforge;
const src = ref("https://github.com");
const addr = ref("https://github.com");
const wv = ref(null);
const accel = ref({});

function go(u) {
  const url = /^https?:\/\//.test(u) ? u : "https://" + u;
  src.value = url;
  addr.value = url;
}
function back() { wv.value?.goBack(); }
function forward() { wv.value?.goForward(); }
function reload() { wv.value?.reload(); }

onMounted(async () => {
  if (isDesktop) {
    try { accel.value = await window.codeforge.acceleratorStatus(); } catch {}
  }
  // webview 内部导航同步地址栏
  wv.value?.addEventListener("did-navigate", (e) => { addr.value = e.url; });
});
</script>

<style scoped>
.browser { flex: 1; }
.url { flex: 1; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; }
.quick.on { border-color: var(--accent); color: var(--accent); }
.wv-host { flex: 1; min-height: 0; display: flex; }
.webonly { padding: 20px; color: var(--dim); font-size: 13px; line-height: 1.8; }
.status { padding: 3px 10px; font-size: 11px; color: var(--dim); border-top: 1px solid var(--border); }
</style>
