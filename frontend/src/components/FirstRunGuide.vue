<template>
  <div v-if="visible" class="guide-mask">
    <div class="guide-card">
      <h2><b>Code</b>Forge</h2>
      <p class="sub">{{ t("guide.subtitle") }}</p>

      <div v-if="step === 0" class="g-step">
        <div class="g-num">1</div>
        <p>{{ t("guide.step1") }}</p>
        <button v-if="isDesktop" class="primary" @click="pickFolder">
          {{ t("workspace.openFolder") }}
        </button>
        <p v-else class="dim">{{ t("guide.webHint") }}</p>
      </div>

      <div v-else-if="step === 1" class="g-step">
        <div class="g-num">2</div>
        <p>{{ t("guide.step2a") }}</p>
        <p class="dim">{{ t("guide.step2b") }}</p>
      </div>

      <div v-else class="g-step">
        <div class="g-num">3</div>
        <p>{{ t("guide.step3a") }}</p>
        <p class="dim">{{ t("guide.step3b") }}</p>
      </div>

      <div class="dots">
        <span v-for="i in 3" :key="i" :class="{ on: i - 1 <= step }"></span>
      </div>
      <button class="ghost" @click="finish">
        {{ step < 2 ? t("guide.skip") : t("guide.start") }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { track } from "../api.js";

const { t } = useI18n();
const isDesktop = !!window.codeforge;
const visible = ref(false);
const step = ref(0);
const hint = ref("");

onMounted(async () => {
  if (localStorage.getItem("cf.onboarded")) return;
  visible.value = true;
});

async function pickFolder() {
  try {
    const r = await window.codeforge.workspace.openDialog();
    if (r?.root) {
      hint.value = "";
      finish();
    }
  } catch (e) {
    hint.value = e.message || String(e);
  }
}

function finish() {
  localStorage.setItem("cf.onboarded", "1");
  track("guide.finish", `step${step.value}`);
  visible.value = false;
}
</script>

<style scoped>
.guide-mask { position: fixed; inset: 0; background: rgba(5,6,10,.9); z-index:200;
  display:flex; align-items:center; justify-content:center; }
.guide-card { width: 460px; background: var(--elevated); border:1px solid var(--border-strong);
  border-radius:16px; padding:28px 32px; text-align:center; }
h2 { font-weight:600; letter-spacing:-0.3px; margin-bottom:4px; }
h2 b { color: var(--accent); }
.sub { color: var(--dim); font-size:13px; margin-bottom:22px; }
.g-num { width:30px;height:30px;border-radius:50%;background:var(--accent-bg);color:var(--accent);
  display:flex;align-items:center;justify-content:center;font-weight:600;margin:0 auto 12px;
  border:1px solid var(--accent); }
.g-step p { margin-bottom:14px; line-height:1.7; }
.dim { color: var(--dim); font-size:12px; }
.primary { background: var(--accent); color:#fff; border:none; border-radius:8px;
  padding:8px 20px; cursor:pointer; font-size:14px; }
.primary:hover { background: var(--accent-hover); }
.dots { margin:18px 0 10px; }
.dots span { display:inline-block;width:7px;height:7px;border-radius:50%;
  background:var(--border-strong);margin:0 4px; }
.dots span.on { background: var(--accent); }
.ghost { background:transparent;border:none;color:var(--dim);cursor:pointer;font-size:12px; }
.ghost:hover { color: var(--text); }
</style>
