// i18n configuration for the Electron renderer. Two locales: en (default)
// and zh (Simplified Chinese). Locale priority on init:
//   1. Persisted electron-prefs `locale` (user picked in Settings / onboarding)
//   2. Browser detection (navigator.language)
//   3. Fallback: en
//
// Locale changes are driven via i18n.changeLanguage(); the onboarding flow
// pushes ob.locale into here whenever the user picks their default story
// language so the whole UI re-renders without a restart.

import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import LanguageDetector from "i18next-browser-languagedetector"
import en from "./locales/en.json"
import zh from "./locales/zh.json"

export const SUPPORTED_LOCALES = ["en", "zh"]

export function initI18n({ initialLocale } = {}) {
  if (i18n.isInitialized) return i18n
  i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources: { en: { translation: en }, zh: { translation: zh } },
      lng: initialLocale,                  // explicit pin from electron-prefs
      fallbackLng: "en",
      supportedLngs: SUPPORTED_LOCALES,
      interpolation: { escapeValue: false },
      detection: {
        order: ["navigator", "htmlTag"],
        caches: [],                        // we persist via electron-prefs, not localStorage
      },
      react: { useSuspense: false },
    })
  return i18n
}

// Normalize whatever locale-ish string we get (e.g. "zh-CN", "Simplified
// Chinese", "中文") to one of our supported codes. Keep simple — runtime
// preferenceOnboarding has its own deeper normalization for memory.
export function normalizeUiLocale(value) {
  const s = String(value || "").toLowerCase()
  if (!s) return null
  if (s.startsWith("zh") || s.includes("chinese") || s.includes("中文") || s.includes("简体")) return "zh"
  if (s.startsWith("en") || s.includes("english")) return "en"
  return null
}

export default i18n
