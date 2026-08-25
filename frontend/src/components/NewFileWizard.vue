<template>
  <div v-if="open" class="nf-mask" @keydown.esc="close">
    <div class="nf-card">
      <div class="nf-head">{{ t("filetree.newFileTitle") }}</div>

      <div class="nf-langs">
        <button v-for="lang in langList" :key="lang.name"
                :class="{ on: picked === lang }"
                @click="picked = lang">
          {{ lang.label }}
        </button>
      </div>

      <input ref="nameInput" v-model="fileName"
             :placeholder="t('filetree.fileNamePlaceholder')"
             spellcheck="false" @keydown.enter="create" />

      <p class="hint">{{ t("filetree.autoExtHint") }}</p>

      <div class="nf-foot">
        <span class="dim">{{ t("filetree.templateHint") }}</span>
        <button :disabled="!canCreate" @click="create">{{ t("filetree.createBtn") }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { api, track } from "../api.js";

const props = defineProps({ root: String });
const emit = defineEmits(["created"]);

const { t } = useI18n();
const open = ref(false);
const picked = ref(null);
const fileName = ref("");
const nameInput = ref(null);

const LANGS = [
  { name: "python",     ext: ".py",   label: "Python",      tmpl: 'print("Hello, CodeForge!")\n' },
  { name: "javascript", ext: ".js",   label: "JavaScript",  tmpl: 'console.log("Hello, CodeForge!");\n' },
  { name: "typescript", ext: ".ts",   label: "TypeScript",  tmpl: 'const msg: string = "Hello, CodeForge!";\nconsole.log(msg);\n' },
  { name: "c",          ext: ".c",    label: "C",           tmpl: '#include <stdio.h>\n\nint main(void) {\n    printf("Hello, CodeForge!\\n");\n    return 0;\n}\n' },
  { name: "cpp",        ext: ".cpp",  label: "C++",         tmpl: '#include <iostream>\n\nint main() {\n    std::cout << "Hello, CodeForge!" << std::endl;\n    return 0;\n}\n' },
  { name: "rust",       ext: ".rs",   label: "Rust",        tmpl: 'fn main() {\n    println!("Hello, CodeForge!");\n}\n' },
  { name: "java",       ext: ".java", label: "Java",        tmpl: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, CodeForge!");\n    }\n}\n' },
  { name: "csharp",     ext: ".cs",   label: "C#",          tmpl: 'using System;\n\nclass Program {\n    static void Main() {\n        Console.WriteLine("Hello, CodeForge!");\n    }\n}\n' },
];

function show() {
  open.value = true;
  picked.value = null;
  fileName.value = "";
  nextTick(() => nameInput.value?.focus());
}
defineExpose({ show });

async function create() {
  const lang = picked.value;
  if (!lang) return;
  let name = fileName.value.trim();
  if (!name) return;
  if (!name.toLowerCase().endsWith(lang.ext)) name += lang.ext;
  // 简单路径安全：仅允许字母数字/_-/子目录
  if (!/^[\w\-\/]+$/.test(name.replace(/\.\w+$/, ""))) {
    alert(t("filetree.invalidName"));
    return;
  }
  track("file.create", name, { language: lang.name });
  await api.write(name, lang.tmpl);
  open.value = false;
  emit("created", name);
}
const canCreate = computed(() => !!picked.value && !!fileName.value.trim());
</script>

<style scoped>
.nf-mask { position: fixed; inset: 0; background: rgba(5,6,10,.6); z-index: 60;
  display:flex; align-items:center; justify-content:center; }
.nf-card { width: 420px; background: var(--elevated); border:1px solid var(--border-strong);
  border-radius:12px; padding:18px 22px; }
.nf-head { font-weight:600; margin-bottom:14px; }
.nf-langs { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; }
.nf-langs button { padding:4px 12px; border-radius:16px; }
.nf-langs button.on { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }
.hint { font-size:11px; color: var(--dim); margin:8px 0; }
.nf-foot { display:flex; justify-content:space-between; align-items:center; margin-top:10px; }
.dim { color: var(--dim); font-size:11px; }
.nf-foot button { background: var(--accent); color:#fff; border:none; border-radius:6px;
  padding:5px 16px; cursor:pointer; }
.nf-foot button:disabled { opacity:.4; }
</style>
