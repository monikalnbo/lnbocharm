<template>
  <div v-if="locked" class="lock-mask">
    <div class="lock-card">
      <h3 class="lock-title">CodeForge 已锁定</h3>
      <p v-if="hint" class="hint">{{ hint }}</p>

      <template v-if="method === 'touchid'">
        <button class="primary" @click="unlockTouchId">使用指纹解锁</button>
      </template>
      <template v-else>
        <input type="password" v-model="password"
               placeholder="输入主密码" @keydown.enter="unlockPassword" />
        <button class="primary" @click="unlockPassword">解锁</button>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";

const locked = ref(false);
const method = ref("none");
const password = ref("");
const hint = ref("");

onMounted(async () => {
  if (!window.codeforge?.applock) return;   // 纯网页模式无应用锁
  try {
    const st = await window.codeforge.applock.state();
    if (!st.enabled) return;
    method.value = st.method === "touchid" && st.caps?.touchId ? "touchid" : "password";
    locked.value = true;
  } catch {}
});

async function unlockTouchId() {
  const r = await window.codeforge.applock.unlock();
  if (r.ok) locked.value = false;
  else hint.value = r.hint || "验证失败";
}

async function unlockPassword() {
  const r = await window.codeforge.applock.unlock({ password: password.value });
  if (r.ok) { locked.value = false; password.value = ""; }
  else hint.value = r.hint || "密码不正确";
}
</script>

<style scoped>
.lock-mask { position: fixed; inset: 0; background: rgba(5,8,14,.92); backdrop-filter: blur(6px);
  display:flex; align-items:center; justify-content:center; z-index:100; }
.lock-card { text-align:center; color:var(--text); }
.lock-title { margin-bottom:12px; }
h3 { margin-bottom:12px; font-weight:600; }
input { display:block; width:240px; margin:10px auto; padding:8px 12px;
  background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:6px; }
.primary { display:block; width:240px; margin:10px auto; padding:8px;
  background:var(--accent); color:#fff; border:none; border-radius:6px; cursor:pointer; }
.primary:hover { filter:brightness(1.15); }
.hint { color:#f85149; font-size:12px; min-height:16px; margin-bottom:4px; }
</style>
