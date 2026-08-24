import { createI18n } from "vue-i18n";
import zhCN from "./zh-CN.js";
import en from "./en.js";

const saved = localStorage.getItem("cf.locale") ||
  (navigator.language?.startsWith("zh") ? "zh-CN" : "en");

export const i18n = createI18n({
  legacy: false,
  locale: saved,
  fallbackLocale: "zh-CN",
  messages: { "zh-CN": zhCN, en },
});

export function setLocale(l) {
  i18n.global.locale.value = l;
  localStorage.setItem("cf.locale", l);
}
