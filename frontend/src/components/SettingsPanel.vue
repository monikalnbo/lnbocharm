<template>
  <div v-if="open" class="settings-mask">
    <div class="settings" @keydown.esc="$emit('close')">
      <div class="s-head">
        <b>{{ t("settings.title") }}</b>
        <button class="icon" @click="$emit('close')">×</button>
      </div>

      <section>
        <h4>连接</h4>
        <label>WS 访问令牌（服务器设置 CODEFORGE_TOKEN 时填写）</label>
        <input v-model="s.wsToken" placeholder="留空表示无鉴权" />
        <label>构建/加速器服务器地址（桌面端）</label>
        <input v-model="s.serverUrl" placeholder="http://your-server:8787" />
      </section>

      <section>
        <h4>{{ t("settings.buildSection") }}</h4>
        <label>{{ t("settings.extraPaths") }}</label>
        <textarea rows="3" v-model="s.extraPaths"></textarea>

        <label>{{ t("settings.timeout") }}</label>
        <input type="number" v-model.number="s.buildTimeoutSec" min="5" max="600" />
      </section>

      <section>
        <h4>{{ t("settings.lintSection") }}</h4>
        <label> {{ t("settings.maxLineLength") }} <input type="number" v-model.number="s.maxLineLength" min="40" max="500" style="width:80px" /></label><br/>
        <label><input type="checkbox" v-model="s.checkSpelling" /> {{ t("settings.spelling") }}</label><br/>
        <label><input type="checkbox" v-model="s.checkIndent" /> {{ t("settings.indentCheck") }}</label>
        <label>{{ t("settings.dict") }}</label>
        <input v-model="s.userWords" placeholder="recievebuffer, myapi" />
      </section>

      <section>
        <h4>{{ t("settings.lookSection") }}</h4>
        <label>{{ t("topbar.theme") }}
          <select :value="store.theme" @change="e => setTheme(e.target.value)">
            <option value="dark">{{ t("topbar.dark") }}</option><option value="light">{{ t("topbar.light") }}</option>
          </select>
        </label>
        <label>背景板
          <select :value="store.background" @change="e => setBackground(e.target.value)">
            <option value="">默认</option>
            <option value="#0d1117">深蓝黑</option>
            <option value="#1a1b26">夜空</option>
            <option value="#f5f5f5">浅灰</option>
          </select>
        </label>
      </section>

      <footer>
        <button @click="save">{{ t("settings.save") }}</button>
        <span class="hint">{{ t("settings.savedNote") }}</span>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { reactive } from "vue";
import { store, setTheme, setBackground } from "../store.js";
import { track } from "../api.js";
import { useI18n } from "vue-i18n";

const props = defineProps({ open: Boolean });
const emit = defineEmits(["close"]);

const DEFAULTS = {
  wsToken: "", serverUrl: "",
  extraPaths: "", buildTimeoutSec: 60,
  maxLineLength: 120, checkSpelling: true, checkIndent: true,
  userWords: "",
};
const saved = JSON.parse(localStorage.getItem("cf.settings") || "{}");
const s = reactive({ ...DEFAULTS, ...saved });
const { t } = useI18n();

function save() {
  track("settings.save");
  localStorage.setItem("cf.settings", JSON.stringify(s));
  localStorage.setItem("cf.token", s.wsToken || "");
  // 桥接到桌面主进程（工具链安装/加速器隧道从 settings.json 读取）
  if (window.codeforge?.setServerConfig)
    window.codeforge.setServerConfig({ serverUrl: s.serverUrl });
  store.lintOptions = {
    line_length: { max: s.maxLineLength },
    spelling: { enabled: s.checkSpelling, user_words: s.userWords.split(/[,，\s]+/).filter(Boolean) },
    indentation: { enabled: s.checkIndent },
  };
  emit("close");
}
// 启动时也应用一次
(function apply() {
  store.lintOptions = {
    line_length: { max: s.maxLineLength },
    spelling: { enabled: s.checkSpelling, user_words: s.userWords.split(/[,，\s]+/).filter(Boolean) },
    indentation: { enabled: s.checkIndent },
  };
})();
</script>

<style scoped>
.settings-mask { position: fixed; inset: 0; background: rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; z-index:50; }
.settings { width: 480px; max-height: 82vh; overflow:auto; background: var(--panel); border:1px solid var(--border); border-radius:8px; padding:14px 18px; }
.s-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
section { border-top: 1px solid var(--border); padding: 10px 0; }
h4 { margin-bottom: 8px; color: var(--accent); }
label { display:block; font-size:12px; color:var(--dim); margin:6px 0 2px; }
textarea, input[type=text], input:not([type]) { width:100%; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:4px; padding:4px 8px; }
footer { margin-top: 10px; text-align:right; }
.hint { font-size:11px; color:var(--dim); margin-left:10px; }
</style>
