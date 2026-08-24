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
        <span class="del" v-if="!node.dir" @click.stop="onDelete(node)">×</span>
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
  // 目录优先，同级按名称排序
  const sorted = [...nodes].sort((a, b) =>
    (b.dir - a.dir) || a.name.localeCompare(b.name));
  const out = [];
  for (const n of sorted) {
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

// 图标/标签由语言注册表驱动（不再硬编码映射表）
function iconOf(name) {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "•";
  const langName = store.extMap[name.slice(dot).toLowerCase()];
  if (!langName) return "•";
  const m = store.registry[langName];
  return m?.monacoId === "python" ? "PY"
       : m?.monacoId === "rust" ? "RS"
       : m?.monacoId === "java" ? "JV"
       : m?.monacoId === "csharp" ? "C#"
       : (m?.monacoId === "cpp") ? "C+"
       : (m?.monacoId === "c") ? "C"
       : (m?.monacoId === "typescript") ? "TS"
       : (m?.monacoId === "javascript") ? "JS"
       : (m?.monacoId || langName).slice(0, 2).toUpperCase();
}
</script>
