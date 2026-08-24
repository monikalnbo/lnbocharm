<template>
  <div class="panel term-panel">
    <div class="panel-head">
      {{ t("terminal.title") }}
      <button class="icon" :title="t('terminal.new')" @click="createSession">＋</button>
      <select v-model="current" @change="attach">
        <option v-for="s in sessions" :key="s" :value="s">{{ s }}</option>
      </select>
    </div>
    <div ref="host" class="xterm-host"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { wsRequest, wsNotify, on } from "../ws.js";
import "@xterm/xterm/css/xterm.css";
import { useI18n } from "vue-i18n";

const host = ref(null);
const { t } = useI18n();
const sessions = ref([]);
const current = ref("");
let term = null;
let fit = null;
let attachedTo = "";

on("term.output", ({ sessionId, chunk }) => {
  if (sessionId === current.value && term) term.write(chunk);
});
on("term.exit", ({ sessionId }) => {
  sessions.value = sessions.value.filter((s) => s !== sessionId);
  if (current.value === sessionId) current.value = sessions.value[0] || "";
});

async function createSession() {
  try {
    const r = await wsRequest("term.create", { cols: 100, rows: 26 });
    sessions.value.push(r.sessionId);
    current.value = r.sessionId;
    attach();
  } catch (e) {
    term?.writeln(`\r\n✗ ${e.cf?.hint || e.message}`);
  }
}

function attach() {
  if (!term || !current.value) return;
  attachedTo = current.value;
  term.reset();   // 切换会话清屏；断线回放缓冲后续接入
}

function sendInput(data) {
  if (attachedTo) wsNotify("term.input", { sessionId: attachedTo, data });
}

onMounted(() => {
  term = new Terminal({
    theme: { background: "#10141c" },
    fontSize: 13,
    cursorBlink: true,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host.value);
  fit.fit();
  term.onData(sendInput);
  window.addEventListener("resize", () => fit.fit());
});

onUnmounted(() => term?.dispose());
</script>
