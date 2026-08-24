<template>
  <div class="filetree">
    <div class="ft-head">
      <span>{{ t("filetree.title") }}</span>
      <button class="icon" :title="t('filetree.newFile')" @click="onCreate">＋</button>
      <button class="icon" :title="t('filetree.refresh')" @click="refresh">⟳</button>
    </div>
    <ul class="ft-list">
      <li v-for="node in flat" :key="node.path"
          :class="{ dir: node.dir, active: node.path === store.activePath }"
          :style="{ paddingLeft: 8 + node._depth * 14 + 'px' }"
          @click="node.dir ? toggle(node) : open(node.path)">
        {{ node.dir ? (collapsed.has(node.path) ? '▸' : '▾') : iconOf(node.name) }}
        {{ node.name }}
        <span class="del" v-if="!node.dir" @click.stop="onDelete(node)">✕</span>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { api } from "../api.js";
import { store } from "../store.js";
import { openFile } from "../editor.js";
import { track } from "../api.js";
import { useI18n } from "vue-i18n";

const raw = ref([]);
const collapsed = ref(new Set());
const { t } = useI18n();

async function refresh() {
  try { raw.value = await api.tree("."); } catch {}
}
onMounted(refresh);
defineExpose({ refresh });

function flatten(nodes, depth = 0) {
  const out = [];
  for (const n of nodes) {
    out.push({ ...n, _depth: depth });
    if (n.dir && n.children && !collapsed.value.has(n.path))
      out.push(...flatten(n.children, depth + 1));
  }
  return out;
}
const flat = computed(() => flatten(raw.value));

function toggle(node) {
  const s = new Set(collapsed.value);
  s.has(node.path) ? s.delete(node.path) : s.add(node.path);
  collapsed.value = s;
}

async function open(path) { await openFile(path); }

async function onCreate() {
  track("file.create_click");
  const p = prompt(t("filetree.newFilePrompt"));
  if (!p) return;
  await api.create(p, false).catch((e) => alert(e.cf?.hint || e.message));
  refresh();
}

async function onDelete(node) {
  if (!confirm(`删除 ${node.path}？`)) return;
  track("file.delete", node.path);
  await api.remove(node.path).catch((e) => alert(e.cf?.hint || e.message));
  refresh();
}

function iconOf(name) {
  const ext = name.slice(name.lastIndexOf(".") + 1);
  const map = { py: "🐍", rs: "🦀", java: "☕", cs: "♯", ts: "🅃𝅿S", js: "JS",
                c: "C", cpp: "C++", cc: "C++", h: "H", hpp: "H++", md: "📄", json: "{}" };
  return map[ext] || "•";
}
</script>
