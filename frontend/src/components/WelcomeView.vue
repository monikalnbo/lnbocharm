<template>
  <div class="welcome">
    <h1><b>Code</b>Forge</h1>
    <p class="sub">{{ t("welcome.subtitle") }}</p>

    <div class="actions">
      <button class="big primary" @click="openFolder">{{ t("welcome.openFolder") }}</button>

      <div class="newproj">
        <p class="np-label">{{ t("welcome.newProject") }}</p>
        <div class="langs">
          <button v-for="l in langs" :key="l.name" @click="createProject(l)">
            {{ l.label }}
          </button>
        </div>
        <p v-if="hint" class="hint">{{ hint }}</p>
      </div>
    </div>

    <div v-if="recents.length" class="recents">
      <p class="np-label">{{ t("welcome.recent") }}</p>
      <ul>
        <li v-for="r in recents" :key="r" @click="$emit('open-recent', r)">
          📁 {{ r.split(/[\\/]/).pop() }} <span class="dim">{{ r }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { track } from "../api.js";

const { t } = useI18n();
const emit = defineEmits(["opened", "open-recent"]);
const isDesktop = !!window.codeforge;
const hint = ref("");
const recents = ref([]);

const LANGS = [
  { name: "python",     ext: ".py",   label: "Python",     file: "main.py",
    tmpl: 'print("Hello, CodeForge!")\n' },
  { name: "javascript", ext: ".js",   label: "JavaScript", file: "index.js",
    tmpl: 'console.log("Hello, CodeForge!");\n' },
  { name: "typescript", ext: ".ts",   label: "TypeScript", file: "index.ts",
    tmpl: 'const msg: string = "Hello, CodeForge!";\nconsole.log(msg);\n' },
];

async function openFolder() {
  if (!isDesktop) { hint.value = t("guide.webHint"); return; }
  track("welcome.open_folder");
  const r = await window.codeforge.workspace.openDialog();
  if (r?.root) emit("opened", r.root);
}

async function createProject(lang) {
  if (!isDesktop) { hint.value = t("guide.webHint"); return; }
  track("welcome.new_project", lang.name);
  const r = await window.codeforge.workspace.openDialog();
  if (!r?.root) return;
  // 在所选目录写入入门文件
  try {
    const { api } = await import("../api.js");
    await api.write(lang.file, lang.tmpl);
  } catch {}
  emit("opened", r.root);
  emit("created", lang.file);
}

</script>
