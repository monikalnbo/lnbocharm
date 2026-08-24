<template>
  <div class="panel">
    <div class="panel-head">
      全局搜索
      <button class="icon" :class="{ on: useRegex }" title="正则模式" @click="useRegex = !useRegex">.*</button>
      <button class="icon" :class="{ on: caseSensitive }" title="区分大小写" @click="caseSensitive = !caseSensitive">Aa</button>
    </div>
    <div class="s-body">
      <input v-model="q" placeholder="搜索工作区…" @keydown.enter="doSearch" />
      <div class="row" v-if="replaceMode">
        <input v-model="replacement" placeholder="替换为…" />
        <button @click="doReplace">全部替换</button>
        <button class="icon" @click="replaceMode = false">✕</button>
      </div>
      <div class="row" v-else>
        <button @click="doSearch" :disabled="!q">搜索</button>
        <button @click="replaceMode = true" :disabled="!total">替换…</button>
      </div>

      <div class="summary" v-if="searched">
        {{ total }} 处匹配 / {{ matches.length }} 个文件
        <span v-if="lastReplace"> · 替换：{{ lastReplace.total }} 处 / {{ lastReplace.filesChanged }} 文件</span>
      </div>

      <ul class="results">
        <template v-for="f in matches" :key="f.path">
          <li class="file">{{ f.path }}</li>
          <li v-for="l in f.lines" :key="f.path + ':' + l.n" class="line"
              @click="$emit('jump', { path: f.path, line: l.n })">
            <span class="ln">{{ l.n }}</span> {{ l.text }}
          </li>
        </template>
        <li v-if="searched && !total" class="none">无匹配</li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { ref } from "vue";
import { api, track } from "../api.js";
import { getModelByPathSafe } from "../editor.js";

const emit = defineEmits(["jump"]);
const q = ref("");
const replacement = ref("");
const useRegex = ref(false);
const caseSensitive = ref(false);
const replaceMode = ref(false);
const matches = ref([]);
const total = ref(0);
const searched = ref(false);
const lastReplace = ref(null);

async function doSearch() {
  if (!q.value) return;
  track("search", q.value, { regex: useRegex.value });
  const r = await api.search({ q: q.value, regex: useRegex.value,
                               caseSensitive: caseSensitive.value });
  matches.value = r.matches;
  total.value = r.total;
  searched.value = true;
}

async function doReplace() {
  if (!confirm(`把工作区内所有 "${q.value}" 替换为 "${replacement.value}"？`)) return;
  track("search.replace", q.value);
  lastReplace.value = await api.searchReplace({
    q: q.value, replacement: replacement.value,
    caseSensitive: caseSensitive.value });
  // 磁盘已更新：刷新打开且无未保存修改的模型
  for (const f of matches.value) {
    const model = getModelByPathSafe(f.path);
    if (!model || model.isDirty?.() === false || model.getAlternativeVersionId === undefined) {
      try {
        const fresh = await api.reloadModel(f.path);
        model?.setValue(fresh);
      } catch {}
    }
  }
}
</script>

<style scoped>
.s-body { padding: 6px 8px; display: flex; flex-direction: column; gap: 6px; overflow: hidden; flex:1; }
.row { display: flex; gap: 6px; }
.row input { flex: 1; }
input { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; font-size: 12px; }
.summary { font-size: 11px; color: var(--dim); }
.results { list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1; font-family: Consolas, monospace; font-size: 12px; }
.results .file { color: var(--accent); padding: 4px 4px 2px; cursor: default; }
.results .line { padding: 1px 4px 1px 14px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.results .line:hover { background: #1d2430; }
.ln { color: var(--dim); display: inline-block; width: 34px; text-align: right; margin-right: 6px; }
.none { color: var(--dim); padding: 6px; }
button.on { border-color: var(--accent); color: var(--accent); }
</style>
