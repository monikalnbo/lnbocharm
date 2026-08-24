<template>
  <div class="panel">
    <div class="panel-head">{{ t("problems.title") }} <span class="count">{{ markers.length }}</span></div>
    <ul class="problems">
      <li v-for="(m, i) in markers" :key="i"
          :class="m.sev.toLowerCase()"
          @click="jump(m)">
        <b>{{ m.sev }}</b> [{{ m.source }}] {{ m.path }}:{{ m.startLineNumber }}
        — {{ m.message }}
      </li>
      <li v-if="!markers.length" class="none">{{ t("problems.none") }}</li>
    </ul>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import * as monaco from "../monaco.js";
import { fileUri } from "../monaco.js";
import { store } from "../store.js";
import { revealLine } from "../editor.js";
import { useI18n } from "vue-i18n";

const markers = ref([]);
const { t } = useI18n();
let timer = null;

function collect() {
  const out = [];
  for (const t of store.tabs) {
    const model = monaco.editor.getModel(monaco.Uri.parse(fileUri(t.path)));
    if (!model) continue;
    for (const m of monaco.editor.getModelMarkers({ resource: model.uri })) {
      out.push({
        ...m,
        sev: m.severity === monaco.MarkerSeverity.Error ? "错误"
           : m.severity === monaco.MarkerSeverity.Warning ? "警告" : "提示",
        path: t.path,
      });
    }
  }
  markers.value = out;
}

onMounted(() => {
  timer = setInterval(collect, 1000);   // 轮询 markers（简单可靠）
  collect();
});
onUnmounted(() => clearInterval(timer));

async function jump(m) {
  await revealLine(m.path, m.startLineNumber);
}
</script>
