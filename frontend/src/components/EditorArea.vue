<template>
  <div class="editor-area">
    <div class="tabs">
      <div v-for="t in store.tabs" :key="t.path"
           class="tab" :class="{ active: t.path === store.activePath }"
           @click="openFile(t.path)">
        {{ t.path.split("/").pop() }}
        <span class="close" @click.stop="closeTab(t.path)">×</span>
      </div>
      <span v-if="!store.tabs.length" class="empty">{{ t("editor.empty") }}</span>
    </div>
    <div ref="el" class="monaco-host"></div>
    <div v-if="meta" class="ed-status">
      <span>{{ meta.name }}</span> · 构建器 {{ meta.builder }} · 缩进 {{ meta.indent }}
      · 调试 {{ meta.debugAdapter || "无" }}
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from "vue";
import { store } from "../store.js";
import { mountEditor, openFile, closeTab } from "../editor.js";
import { useI18n } from "vue-i18n";

const el = ref(null);
const { t } = useI18n();
onMounted(() => mountEditor(el.value));

// 深度定制：状态栏元数据直接取自语言注册表（单一事实来源）
const meta = computed(() => {
  const path = store.activePath;
  if (!path) return null;
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  const name = store.extMap[ext];
  return name ? store.registry[name] : null;
});
</script>

<style scoped>
.ed-status {
  padding: 3px 12px; font-size: 11px; color: var(--dim);
  border-top: 1px solid var(--border); background: var(--panel);
}
</style>
