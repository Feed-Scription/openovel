import React from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.jsx"
import { initI18n } from "./lib/i18n.js"
import { installWebOpenovelBridge } from "./webOpenovelBridge.js"

;(async () => {
  installWebOpenovelBridge()
  const prefs = await window.openovel.getPrefs()
  initI18n({ initialLocale: prefs?.locale })
  const root = createRoot(document.getElementById("root"))
  root.render(<App />)
})()
