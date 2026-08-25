<template>
  <div class="app" :data-theme="store.theme" :style="bgStyle">
    <!-- 顶栏 -->
    <header class="topbar">
      <span class="logo"><b>Code</b>Forge</span>
      <span class="conn" :class="{ on: wsState.connected }">
        {{ wsState.connected ? t("topbar.connected") : t("topbar.connecting") }}
      </span>
      <label>{{ t("topbar.background") }}
        <select @change="e => setBackground(e.target.value)" :value="store.background">
          <option value="">—</option>
          <option value="#0d1117">Dark Blue</option>
          <option value="#1a1b26">Night</option>
          <option value="#f5f5f5">Light</option>
        </select>
      </label>
      <label>{{ t("topbar.theme") }}
        <select @change="e => setTheme(e.target.value)" :value="store.theme">
          <option value="dark">{{ t("topbar.dark") }}</option>
          <option value="light">{{ t("topbar.light") }}</option>
        </select>
      </label>
      <select @change="e => setLocale(e.target.value)" :value="$i18n.locale">
        <option value="zh-CN">中文</option>
        <option value="en">English</option>
      </select>
      <button class="icon" :title="t('settings.title')" @click="settingsOpen = true">
        {{ t("settings.title") }}
      </button>
    </header>

    <!-- 中部三栏 dock：面板挤压代码区，绝不浮层遮挡 -->
    <div class="mid">
      <FileTree v-if="store.panels.left" class="dock-left" ref="treeRef" />

      <div class="dock-center center-tabs">
        <!-- 标签栏常驻：无论是否打开工作区，编辑/浏览器入口始终可见 -->
        <div class="center-tabbar">
          <button :class="{ on: centerView === 'welcome' }" @click="centerView = 'welcome'">
            {{ t("welcome.start") }}
          </button>
          <button :class="{ on: centerView === 'editor' }" @click="centerView = 'editor'">
            {{ t("centerTabs.editor") }}
          </button>
          <button :class="{ on: centerView === 'browser' }" @click="centerView = 'browser'">
            {{ t("centerTabs.browser") }}
          </button>
          <span style="flex:1"></span>
          <button v-if="isDesktop" @click="openFolderFlow">
            {{ t("workspace.openFolder") }}
          </button>
        </div>
        <WelcomeView v-show="centerView === 'welcome'" class="center-body" />
        <EditorArea v-show="centerView === 'editor' && !showWelcome" class="center-body" />
        <BrowserPanel v-show="centerView === 'browser'" class="center-body" />
      </div>

      <aside v-if="store.panels.right" class="dock-right">
        <SearchPanel @jump="(m) => revealLine(m.path, m.line)" />
        <BuildPanel />
        <ProblemsPanel />
        <LogPanel />
      </aside>
    </div>

    <!-- 底部终端（可折叠） -->
    <TerminalView v-if="store.panels.terminal" class="bottom" />

    <SettingsPanel :open="settingsOpen" @close="settingsOpen = false" />
    <LockScreen />
    <FirstRunGuide />

    <!-- 状态栏 -->
    <footer class="statusbar">
      <span v-if="memMB">内存 {{ memMB }} MB</span>
      <span v-if="store.workspaceRoot" :title="store.workspaceRoot">
        {{ store.workspaceRoot.split(/[\\/]/).pop() }}
      </span>
      <span :style="wsState.fatal ? 'color:#eb5757' : ''">
        {{ wsState.fatal || store.notice }}
      </span>
      <button @click="togglePanel('left')">{{ t("statusbar.files") }}</button>
      <button @click="togglePanel('right')">{{ t("statusbar.panels") }}</button>
      <button @click="togglePanel('terminal')">{{ t("statusbar.terminal") }}</button>
    </footer>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { store, setBackground, setTheme, togglePanel } from "./store.js";
import { wsState, wsConnect, wsRequest } from "./ws.js";
import { loadRegistry, initLspDiagnostics } from "./monaco.js";
import { revealLine, resetWorkspaceState, openFile } from "./editor.js";
import { setLocale } from "./i18n/index.js";
import FileTree from "./components/FileTree.vue";
import EditorArea from "./components/EditorArea.vue";
import BuildPanel from "./components/BuildPanel.vue";
import ProblemsPanel from "./components/ProblemsPanel.vue";
import TerminalView from "./components/TerminalView.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import LockScreen from "./components/LockScreen.vue";
import BrowserPanel from "./components/BrowserPanel.vue";
import LogPanel from "./components/LogPanel.vue";
import SearchPanel from "./components/SearchPanel.vue";
import WelcomeView from "./components/WelcomeView.vue";
import FirstRunGuide from "./components/FirstRunGuide.vue";

const { t } = useI18n();
const settingsOpen = ref(false);
const welcomeClosed = ref(false);
// 无打开标签且未关闭欢迎页时显示（打开任意文件自动隐藏）
const showWelcome = computed(() =>
  store.tabs.length === 0 && !welcomeClosed.value && !store.workspaceRoot.endsWith("workspace-demo"));
const memMB = ref(0);
const centerView = ref("editor");
const isDesktop = !!window.codeforge;

/// 打开文件夹流程（桌面端）：对话框 → 主进程切根 → workspace.changed 推送
/// 会触发 resetWorkspaceState（见 onChanged 订阅）
async function openFolderFlow() {
  if (!isDesktop) return;
  await window.codeforge.workspace.openDialog();
}

function switchRecent(root) {
  if (isDesktop) window.codeforge.workspace.switchTo(root);
}

function onWorkspaceOpened(root) {
  resetWorkspaceState();
  store.workspaceRoot = root;
  centerView.value = "editor";
}

async function onProjectCreated(file) {
  // 新建项目后打开生成的入门文件并切到编辑视图
  try { await openFile(file); } catch {}
  centerView.value = "editor";
}

const bgStyle = computed(() => {
  const c = store.customColors || {};
  const style = {};
  if (c.bg) style["--bg"] = c.bg;
  if (c.panel) style["--panel"] = c.panel;
  if (c.accent) style["--accent"] = c.accent;
  const bg = store.background;
  if (bg) {
    const veil = `rgba(8,9,10,${1 - (store.backgroundOpacity ?? 0.3)})`;
    style["background"] =
      `linear-gradient(${veil}, ${veil}), ${bg.startsWith("#") ? bg : "url(" + bg + ") center/cover no-repeat"}`;
  }
  return style;
});

async function pollMemory() {
  if (window.codeforge?.appMemory) {
    try { memMB.value = (await window.codeforge.appMemory()).rssMB; } catch {}
  }
}

onMounted(async () => {
  wsRequest("workspace.getRoot").then((r) => {
    store.workspaceRoot = r.root || "";
  }).catch(() => {});
  // 菜单加速器 Ctrl+, → 打开设置
  window.codeforge?.onUiSettings?.(() => { settingsOpen.value = true; });
  window.codeforge?.workspace?.onChanged?.((root) => {
    resetWorkspaceState();
    store.workspaceRoot = root;
  });
  // 层2 窗口级按键映射（任务：按键-系统-运行三层对齐）
  window.addEventListener("keydown", (e) => {
    // 终端内的按键属于 PTY 输入，不劫持
    const el = e.target;
    if (el && (el.closest?.(".xterm") || el.classList?.contains("xterm-helper-textarea"))) return;
    if (e.key === "F5") {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("cf-run"));
    }
    if (e.key === "Escape" && settingsOpen.value) {
      settingsOpen.value = false;
    }
  });
  pollMemory();
  setInterval(pollMemory, 5000);
  await loadRegistry();
  initLspDiagnostics();
  wsConnect();
});
</script>
