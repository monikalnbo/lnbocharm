<template>
  <div class="filetree">
    <div class="ft-head">
      <span>资源管理器</span>
      <button class="icon" title="新建文件" @click="onCreate">＋</button>
      <button class="icon" title="刷新" @click="refresh">⟳</button>
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

const raw = ref([]);
const collapsed = ref(new Set());

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
  const p = prompt("新文件路径（如 src/main.py）：");
  if (!p) return;
  await api.create(p, false).catch((e) => alert(e.cf?.hint || e.message));
  refresh();
}

async function onDelete(node) {
  if (!confirm(`删除 ${node.path}？`)) return;
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
