import React from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.jsx"
import { initI18n } from "./lib/i18n.js"

// Bootstrap order: pull the user's persisted locale from electron-prefs
// (if any), feed it to i18n.init, THEN mount React. This avoids a flash
// of English in the first paint when zh is the persisted choice.
;(async () => {
  let initialLocale
  try {
    const prefs = await window.openovel.getPrefs()
    if (prefs?.locale) initialLocale = prefs.locale
  } catch { /* fall back to detector */ }
  initI18n({ initialLocale })
  const root = createRoot(document.getElementById("root"))
  root.render(<App />)
})()
