<template>
  <div class="panel">
    <div class="panel-head">
      日志
      <select v-model="level" @change="refresh">
        <option value="">全部级别</option>
        <option value="info">info</option>
        <option value="action">action</option>
        <option value="error">error</option>
      </select>
      <label class="auto"><input type="checkbox" v-model="auto" /> 自动刷新</label>
      <button class="icon" @click="refresh">⟳</button>
    </div>
    <ul class="logs">
      <li v-for="(l, i) in lines" :key="i" :class="'lv-' + l.level">
        <span class="ts">{{ l.ts.slice(11, 23) }}</span>
        <span class="src">{{ l.source }}</span>
        <b>{{ l.event }}</b>
        <span v-if="l.path" class="dim"> {{ l.path }} {{ l.status ? "(" + l.status + ")" : "" }}</span>
        <span v-else-if="l.file || l.target" class="dim"> {{ l.file || l.target }}</span>
      </li>
      <li v-if="!lines.length" class="none">暂无日志</li>
    </ul>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import { api, track } from "../api.js";

const lines = ref([]);
const level = ref("");
const auto = ref(true);
let timer = null;

async function refresh() {
  try {
    const list = await api.logs(300, level.value);
    lines.value = list;
  } catch {}
}

onMounted(() => {
  refresh();
  track("logpanel.open");
  timer = setInterval(() => { if (auto.value) refresh(); }, 3000);
});
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.logs { list-style: none; overflow: auto; flex: 1; font-size: 11px; font-family: Consolas, monospace; max-height: 180px; margin:0; padding:0; }
.logs li { padding: 2px 8px; border-bottom: 1px solid #1c2129; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ts { color: var(--dim); margin-right: 6px; }
.src { color: #58a6ff; margin-right: 6px; }
.lv-error b { color: #f85149; }
.lv-action b { color: #d2a8ff; }
.dim { color: var(--dim); }
.none { color: var(--dim); }
</style>
