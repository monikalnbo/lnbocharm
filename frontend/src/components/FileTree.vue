<template>
  <div class="filetree">
    <div class="ft-head">
      <span :title="store.workspaceRoot">{{ rootName || t("filetree.title") }}</span>
      <button v-if="isDesktop" class="icon" :title="t('workspace.openFolder')" @click="openFolder">打开</button>
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
import { ref, computed, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, track } from "../api.js";
import { store } from "../store.js";
import { openFile } from "../editor.js";
import { on as wsOn } from "../ws.js";

const { t } = useI18n();
const raw = ref([]);
const collapsed = ref(new Set());
const isDesktop = !!window.codeforge;

const rootName = computed(() =>
  store.workspaceRoot ? store.workspaceRoot.split(/[\\/]/).pop() : "");

async function refresh() {
  try { raw.value = await api.tree("."); } catch {}
}
onMounted(refresh);
defineExpose({ refresh });

// 工作区切换后自动刷新
watch(() => store.workspaceRoot, () => refresh());

// 服务器 fs.changed 推送：外部/构建产物改动自动刷新（防抖）
let refreshTimer = null;
wsOn("fs.changed", () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 300);
});

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

async function open(path) {
  track("file.open", path);
  await openFile(path);
}

// 图标由语言注册表驱动
function iconOf(name) {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "•";
  const langName = store.extMap[name.slice(dot).toLowerCase()];
  const id = langName ? store.registry[langName]?.monacoId : null;
  return id ? id.slice(0, 2).toUpperCase() : "•";
}

async function onCreate() {
  track("file.create_click");
  const p = prompt(t("filetree.newFilePrompt"));
  if (!p) return;
  try {
    await api.create(p, false).catch((e) => alert(e.cf?.hint || e.message));
    refresh();
  } catch {}
}

async function onDelete(node) {
  if (!confirm(t("filetree.deleteConfirm", { path: node.path }))) return;
  track("file.delete", node.path);
  try {
    await api.remove(node.path).catch((e) => alert(e.cf?.hint || e.message));
    refresh();
  } catch {}
}

async function openFolder() {
  track("workspace.open_click");
  await window.codeforge.workspace.openDialog();
}
</script>
