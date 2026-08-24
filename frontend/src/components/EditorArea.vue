<template>
  <div class="editor-area">
    <div class="tabs">
      <div v-for="t in store.tabs" :key="t.path"
           class="tab" :class="{ active: t.path === store.activePath }"
           @click="openFile(t.path)">
        {{ t.path.split("/").pop() }}
        <span class="close" @click.stop="closeTab(t.path)">✕</span>
      </div>
      <span v-if="!store.tabs.length" class="empty">{{ t("editor.empty") }}</span>
    </div>
    <div ref="el" class="monaco-host"></div>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { store } from "../store.js";
import { mountEditor, openFile, closeTab } from "../editor.js";
import { useI18n } from "vue-i18n";

const el = ref(null);
const { t } = useI18n();
onMounted(() => mountEditor(el.value));
</script>
