<template>
  <div class="app" :data-theme="store.theme"
       :style="bgStyle">
    <!-- 顶栏 -->
    <header class="topbar">
      <span class="logo">⚒ CodeForge</span>
      <span class="conn" :class="{ on: wsState.connected }">
        {{ wsState.connected ? "● 已连接" : "○ 连接中" }}
      </span>
      <label>背景
        <select @change="e => setBackground(e.target.value)"
                :value="store.background">
          <option value="">默认</option>
          <option value="#0d1117">深蓝黑</option>
          <option value="#1a1b26">夜空</option>
          <option value="#f5f5f5">浅色</option>
        </select>
      </label>
      <label>主题
        <select @change="e => setTheme(e.target.value)" :value="store.theme">
          <option value="dark">深色</option>
          <option value="light">浅色</option>
        </select>
      </label>
      <button class="icon" title="设置" @click="settingsOpen = true">⚙ 设置</button>
    </header>

    <!-- 中部三栏 dock：面板挤压代码区，绝不浮层遮挡 -->
    <div class="mid">
      <FileTree v-if="store.panels.left" class="dock-left" ref="treeRef" />
      <div class="dock-center center-tabs">
        <div class="center-tabbar">
          <button :class="{ on: centerView === 'editor' }" @click="centerView = 'editor'">编辑</button>
          <button :class="{ on: centerView === 'browser' }" @click="centerView = 'browser'">🌐 浏览器</button>
        </div>
        <EditorArea v-show="centerView === 'editor'" class="center-body" />
        <BrowserPanel v-if="centerView === 'browser'" class="center-body" />
      </div>
      <aside v-if="store.panels.right" class="dock-right">
        <BuildPanel />
        <ProblemsPanel />
        <LogPanel />
      </aside>
    </div>

    <!-- 底部终端（可折叠） -->
    <TerminalView v-if="store.panels.terminal" class="bottom" />

    <SettingsPanel :open="settingsOpen" @close="settingsOpen = false" />

    <!-- 状态栏 -->
    <footer class="statusbar">
      <span>{{ store.notice }}</span>
      <button @click="togglePanel('left')">◧ 文件</button>
      <button @click="togglePanel('right')">◨ 面板</button>
      <button @click="togglePanel('terminal')">▭ 终端</button>
    </footer>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from "vue";
import { store, setBackground, setTheme, togglePanel } from "./store.js";
import { wsState, wsConnect } from "./ws.js";
import { loadRegistry, initLspDiagnostics } from "./monaco.js";
import FileTree from "./components/FileTree.vue";
import EditorArea from "./components/EditorArea.vue";
import BuildPanel from "./components/BuildPanel.vue";
import ProblemsPanel from "./components/ProblemsPanel.vue";
import TerminalView from "./components/TerminalView.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import BrowserPanel from "./components/BrowserPanel.vue";
import LogPanel from "./components/LogPanel.vue";

const treeRef = ref(null);
const settingsOpen = ref(false);
const centerView = ref("editor");

const bgStyle = computed(() => {
  const bg = store.background;
  if (!bg) return {};
  return {
    background: `linear-gradient(rgba(10,12,18,${1 - store.backgroundOpacity * 0.7}), rgba(10,12,18,${1 - store.backgroundOpacity * 0.7})), ${bg.startsWith("#") ? bg : "url(" + bg + ") center/cover"}`,
  };
});

onMounted(async () => {
  await loadRegistry();
  initLspDiagnostics();
  wsConnect();
});
</script>
