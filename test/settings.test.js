import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { loadSettings } from "../src/config/settings.js"

test("settings load defaults without requiring env vars", () => {
  const loaded = loadSettings({ cwd: "/", env: isolatedEnv() })
  assert.equal(loaded.settings.provider.foreground, "kimi-code")
  assert.equal(loaded.settings.tui.displayCpm, 720)
  assert.equal(loaded.settings.tui.optionsEnabled, true)
  assert.equal(loaded.settings.webSearch.provider, "duckduckgo-html")
  assert.equal(loaded.settings.tools.permissions.askFallback, "deny")
  assert.equal(loaded.env.AI_PROVIDER, "kimi-code")
  assert.equal(loaded.env.OPENOVEL_DISPLAY_CPM, "720")
  assert.equal(loaded.env.OPENOVEL_OPTIONS_ENABLED, "true")
  assert.equal(loaded.env.OPENOVEL_WEBSEARCH_PROVIDER, "duckduckgo-html")
  assert.equal(loaded.env.OPENOVEL_PERMISSION_ASK_FALLBACK, "deny")
})

test("project settings support JSONC, env substitution, and local overrides", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "openovel-settings-"))
  const configDir = path.join(cwd, ".openovel")
  await mkdir(configDir)
  await writeFile(
    path.join(configDir, "settings.jsonc"),
    `{
      // shared project settings
      "provider": {
        "foreground": "deepseek",
        "order": ["deepseek"],
        "allowPaidFallback": true,
        "modelCapabilities": {
          "deepseek/custom": {
            "limits": { "outputTokens": 4096 }
          }
        },
        "providers": {
          "deepseek": {
            "apiKey": "{env:TEST_DEEPSEEK_KEY}",
            "model": "deepseek-v4-flash",
            "capabilities": {
              "request": { "jsonMode": true }
            }
          }
        }
      },
      "tui": {
        "displayCpm": 900
      },
      "modelProfiles": {
        "small": "deepseek-v4-flash",
        "large": "deepseek-v4-pro"
      },
      "workspace": {
        "home": "{env:TEST_STORY_HOME}",
        "storyId": "settings-story"
      },
      "webSearch": {
        "provider": "custom-http-search",
        "providers": {
          "custom-http-search": {
            "baseUrl": "https://search.example.test?q={query}&limit={limit}"
          }
        }
      },
      "image": {
        "generation": {
          "provider": "volcengine",
          "baseUrl": "https://img.example.test/v1",
          "apiKey": "{env:TEST_IMAGE_KEY}",
          "model": "img-test",
          "path": "/images/generations",
          "size": "512x512"
        }
      },
    }`,
  )
  await writeFile(
    path.join(configDir, "settings.local.json"),
    JSON.stringify({
      tui: { displayCpm: 960, optionsEnabled: false },
      tools: {
        bash: true,
        permissions: {
          rules: [{ permission: "webfetch", pattern: "https://blocked.example/*", action: "deny" }],
        },
      },
    }),
  )

  const loaded = loadSettings({
    cwd,
    env: isolatedEnv({ TEST_DEEPSEEK_KEY: "sk-test", TEST_IMAGE_KEY: "sk-img", TEST_STORY_HOME: "/tmp/openovel-settings-home" }),
  })

  assert.equal(loaded.settings.provider.foreground, "deepseek")
  assert.equal(loaded.settings.tui.displayCpm, 960)
  assert.equal(loaded.settings.tui.optionsEnabled, false)
  assert.equal(loaded.env.DEEPSEEK_API_KEY, "sk-test")
  assert.match(loaded.env.OPENOVEL_PROVIDER_CAPABILITIES, /jsonMode/)
  assert.match(loaded.env.OPENOVEL_MODEL_CAPABILITIES, /outputTokens/)
  assert.equal(loaded.env.AI_SMALL_MODEL, "deepseek-v4-flash")
  assert.equal(loaded.env.AI_LARGE_MODEL, "deepseek-v4-pro")
  assert.equal(loaded.env.OPENOVEL_HOME, "/tmp/openovel-settings-home")
  assert.equal(loaded.env.OPENOVEL_STORY_ID, "settings-story")
  assert.equal(loaded.env.OPENOVEL_ENABLE_BASH_TOOL, "true")
  assert.match(loaded.env.OPENOVEL_TOOL_PERMISSION_RULES, /blocked\.example/)
  assert.equal(loaded.env.OPENOVEL_OPTIONS_ENABLED, "false")
  assert.equal(loaded.env.OPENOVEL_WEBSEARCH_PROVIDER, "custom-http-search")
  assert.equal(loaded.env.CUSTOM_HTTP_SEARCH_URL, "https://search.example.test?q={query}&limit={limit}")
  assert.equal(loaded.env.OPENOVEL_IMAGE_PROVIDER, "volcengine")
  assert.equal(loaded.env.OPENOVEL_IMAGE_BASE_URL, "https://img.example.test/v1")
  assert.equal(loaded.env.OPENOVEL_IMAGE_API_KEY, "sk-img")
  assert.equal(loaded.env.OPENOVEL_IMAGE_MODEL, "img-test")
  assert.equal(loaded.env.OPENOVEL_IMAGE_PATH, "/images/generations")
  assert.equal(loaded.env.OPENOVEL_IMAGE_SIZE, "512x512")
  assert.deepEqual(
    loaded.sources.map((source) => source.kind),
    ["project", "local"],
  )
})

test("environment variables override file settings", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "openovel-settings-"))
  const configDir = path.join(cwd, ".openovel")
  await mkdir(configDir)
  await writeFile(
    path.join(configDir, "settings.json"),
    JSON.stringify({
      provider: {
        foreground: "deepseek",
        providers: { deepseek: { apiKey: "sk-from-file" } },
      },
      tui: { displayCpm: 900 },
    }),
  )

  const loaded = loadSettings({
    cwd,
    env: isolatedEnv({
      AI_PROVIDER: "kimi-code",
      KIMI_API_KEY: "sk-from-env",
      OPENOVEL_DISPLAY_CPM: "780",
      OPENOVEL_OPTIONS_ENABLED: "0",
      AI_SMALL_MODEL: "kimi-for-coding",
    }),
  })

  assert.equal(loaded.settings.provider.foreground, "kimi-code")
  assert.equal(loaded.env.KIMI_API_KEY, "sk-from-env")
  assert.equal(loaded.settings.modelProfiles.small, "kimi-for-coding")
  assert.equal(loaded.env.OPENOVEL_DISPLAY_CPM, "780")
  assert.equal(loaded.settings.tui.optionsEnabled, false)
})

test("legacy ai-story config and env names remain readable", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "openovel-legacy-settings-"))
  const configDir = path.join(cwd, ".ai-story")
  await mkdir(configDir)
  await writeFile(
    path.join(configDir, "settings.json"),
    JSON.stringify({
      workspace: { storyId: "legacy-story" },
      tui: { displayCpm: 810 },
    }),
  )

  const loaded = loadSettings({
    cwd,
    env: {
      AI_STORY_CONFIG_DIR: path.join(os.tmpdir(), "openovel-empty-legacy-config"),
      AI_STORY_DISPLAY_PACING: "0",
      AI_STORY_OPTIONS_ENABLED: "false",
    },
  })

  assert.equal(loaded.settings.workspace.storyId, "legacy-story")
  assert.equal(loaded.env.OPENOVEL_STORY_ID, "legacy-story")
  assert.equal(loaded.env.OPENOVEL_DISPLAY_CPM, "810")
  assert.equal(loaded.env.OPENOVEL_DISPLAY_PACING, "false")
  assert.equal(loaded.env.OPENOVEL_OPTIONS_ENABLED, "false")
})

function isolatedEnv(extra = {}) {
  return {
    OPENOVEL_CONFIG_DIR: path.join(os.tmpdir(), "openovel-empty-config"),
    ...extra,
  }
}
