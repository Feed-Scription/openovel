import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  CUSTOM_PROVIDERS_ENV,
  customProviderKeyEnv,
  customProviderBaseUrlEnv,
  customProviderSpec,
  customThinkingTransform,
  normalizeCustomProviderEntry,
  normalizeCustomProvidersList,
  slugifyCustomProviderName,
} from "../src/provider/customProviders.js"
import { ProviderRegistry } from "../src/provider/registry.js"
import { builtinProviders } from "../src/provider/plugins/index.js"
import { loadSettings } from "../src/config/settings.js"

// Base env for registry tests: enough to make resolution deterministic
// without touching the developer's real settings files.
function isolatedEnv(extra = {}) {
  return {
    OPENOVEL_IGNORE_PROJECT_CONFIG: "1",
    ...extra,
  }
}

test("normalizeCustomProviderEntry canonicalizes ids, names, and kinds", () => {
  const entry = normalizeCustomProviderEntry({
    id: "My Proxy!",
    kind: "anthropic",
    baseUrl: " https://gw.example.com ",
    defaultModel: " m-small ",
  })
  assert.equal(entry.id, "custom:my-proxy")
  assert.equal(entry.name, "my-proxy")
  assert.equal(entry.kind, "anthropic")
  assert.equal(entry.baseUrl, "https://gw.example.com")
  assert.equal(entry.defaultModel, "m-small")

  // Unknown kind coerces to openai-compatible; explicit name survives.
  const fallback = normalizeCustomProviderEntry({ id: "custom:x", name: "My X", kind: "weird" })
  assert.equal(fallback.kind, "openai-compatible")
  assert.equal(fallback.name, "My X")

  // No usable id → rejected.
  assert.equal(normalizeCustomProviderEntry({ name: "只有中文" }), null)
  assert.equal(normalizeCustomProviderEntry(null), null)
})

test("slugify strips to ascii kebab", () => {
  assert.equal(slugifyCustomProviderName("My Fast Proxy v2"), "my-fast-proxy-v2")
  assert.equal(slugifyCustomProviderName("中文名字"), "")
})

test("normalizeCustomProvidersList parses JSON, dedupes by id (later wins)", () => {
  const list = normalizeCustomProvidersList(JSON.stringify([
    { id: "custom:a", baseUrl: "https://one" },
    { id: "custom:a", baseUrl: "https://two" },
    { bogus: true },
  ]))
  assert.equal(list.length, 1)
  assert.equal(list[0].baseUrl, "https://two")
  assert.deepEqual(normalizeCustomProvidersList("not json"), [])
  assert.deepEqual(normalizeCustomProvidersList(undefined), [])
})

test("customProviderSpec derives per-provider env names and kind shape", () => {
  const openai = customProviderSpec(normalizeCustomProviderEntry({ id: "custom:my-proxy", baseUrl: "https://p" }))
  assert.equal(openai.kind, "openai-compatible")
  assert.deepEqual(openai.apiKeyEnv, ["OPENOVEL_CUSTOM_MY_PROXY_API_KEY"])
  assert.deepEqual(openai.baseUrlEnv, ["OPENOVEL_CUSTOM_MY_PROXY_BASE_URL"])
  assert.equal(openai.auth.type, "bearer")

  const anthropic = customProviderSpec(normalizeCustomProviderEntry({ id: "custom:claude-gw", kind: "anthropic" }))
  assert.equal(anthropic.kind, "anthropic")
  assert.equal(anthropic.path, "/v1/messages")
  assert.equal(anthropic.auth.header, "x-api-key")
  assert.equal(anthropic.headers["anthropic-version"], "2023-06-01")

  assert.equal(customProviderKeyEnv("custom:my-proxy"), "OPENOVEL_CUSTOM_MY_PROXY_API_KEY")
  assert.equal(customProviderBaseUrlEnv("custom:my-proxy"), "OPENOVEL_CUSTOM_MY_PROXY_BASE_URL")
})

test("registry syncs custom providers from env: register, resolve, update, remove", () => {
  const registry = new ProviderRegistry(builtinProviders)
  const defs = [
    { id: "custom:alpha", name: "Alpha", kind: "openai-compatible", baseUrl: "https://alpha.example.com/v1", defaultModel: "alpha-small", defaultBackgroundModel: "alpha-large" },
    { id: "custom:beta", name: "Beta", kind: "anthropic", baseUrl: "https://beta.example.com", defaultModel: "beta-model" },
  ]
  const env = isolatedEnv({
    [CUSTOM_PROVIDERS_ENV]: JSON.stringify(defs),
    OPENOVEL_CUSTOM_ALPHA_API_KEY: "sk-alpha",
  })

  // Pinned route to a custom provider resolves with its own key + baseUrl.
  const route = registry.route({ role: "foreground", env, providerId: "custom:alpha" })
  assert.equal(route.length, 1)
  assert.equal(route[0].id, "custom:alpha")
  assert.equal(route[0].baseUrl, "https://alpha.example.com/v1")
  assert.equal(route[0].apiKey, "sk-alpha")
  assert.equal(route[0].keyConfigured, true)
  assert.equal(route[0].model, "alpha-small")

  // Background role picks the background default model.
  const bg = registry.route({ role: "background", env, providerId: "custom:alpha" })
  assert.equal(bg[0].model, "alpha-large")

  // The anthropic-format one carries the Messages adapter shape.
  const beta = registry.route({ role: "foreground", env, providerId: "custom:beta" })
  assert.equal(beta[0].kind, "anthropic")
  assert.equal(beta[0].headers["anthropic-version"], "2023-06-01")

  // Both are visible to provider listings (Routing/Agents dropdowns).
  const ids = registry.all(env).map((p) => p.id)
  assert.ok(ids.includes("custom:alpha") && ids.includes("custom:beta"))

  // Editing the blob updates in place; removing an entry unregisters it
  // without touching builtins.
  const env2 = isolatedEnv({
    [CUSTOM_PROVIDERS_ENV]: JSON.stringify([{ ...defs[0], baseUrl: "https://alpha2.example.com/v1" }]),
  })
  const updated = registry.route({ role: "foreground", env: env2, providerId: "custom:alpha" })
  assert.equal(updated[0].baseUrl, "https://alpha2.example.com/v1")
  assert.equal(registry.get("custom:beta"), undefined)
  assert.ok(registry.get("kimi-code"))

  // Clearing the env removes all dynamic entries.
  const env3 = isolatedEnv({})
  registry.syncCustomProviders(env3)
  assert.equal(registry.get("custom:alpha"), undefined)
  assert.ok(registry.get("custom-openai"), "builtin custom-openai slot must survive")
})

test("custom provider thinking config: normalize, transform shapes, spec attach", () => {
  // Normalize keeps a valid mode + effort, drops defaults/invalid.
  const off = normalizeCustomProviderEntry({ id: "custom:a", thinking: "disabled" })
  assert.equal(off.thinking, "disabled")
  assert.equal(off.reasoningEffort, undefined)
  const on = normalizeCustomProviderEntry({ id: "custom:b", thinking: "enabled", reasoningEffort: "high" })
  assert.equal(on.thinking, "enabled")
  assert.equal(on.reasoningEffort, "high")
  const dflt = normalizeCustomProviderEntry({ id: "custom:c", thinking: "nonsense", reasoningEffort: "ultra" })
  assert.equal(dflt.thinking, undefined, "default 'hint' is not persisted")
  assert.equal(dflt.reasoningEffort, undefined, "invalid effort dropped")
  // Explicit passthrough IS persisted (it's no longer the default).
  const passthrough = normalizeCustomProviderEntry({ id: "custom:d", thinking: "auto" })
  assert.equal(passthrough.thinking, "auto")

  // Transform shapes match the Kimi/MiMo wire form.
  assert.equal(customThinkingTransform("auto"), null, "auto = passthrough (no transform)")
  assert.deepEqual(customThinkingTransform("disabled")({ model: "m" }), { model: "m", thinking: { type: "disabled" } })
  assert.deepEqual(customThinkingTransform("enabled", "high")({ model: "m" }), { model: "m", thinking: { type: "enabled" }, reasoning_effort: "high" })
  // "hint" follows the per-call runtime hint.
  const hint = customThinkingTransform("hint")
  assert.deepEqual(hint({ model: "m" }, { thinking: "disabled" }), { model: "m", thinking: { type: "disabled" } })
  assert.deepEqual(hint({ model: "m" }, { thinking: "enabled" }), { model: "m", thinking: { type: "enabled" } })
  assert.deepEqual(hint({ model: "m" }, {}), { model: "m" }, "no hint → passthrough")

  // The spec attaches a bodyTransform whenever thinking is active.
  const specOff = customProviderSpec(normalizeCustomProviderEntry({ id: "custom:a", thinking: "disabled" }))
  assert.equal(typeof specOff.bodyTransform, "function")
  assert.deepEqual(specOff.bodyTransform({ model: "m" }), { model: "m", thinking: { type: "disabled" } })
  // Default (no thinking field) resolves to "hint" → a transform that follows
  // the per-call hint, so the narrator (disabled hint) won't over-think.
  const specDefault = customProviderSpec(normalizeCustomProviderEntry({ id: "custom:c" }))
  assert.equal(typeof specDefault.bodyTransform, "function", "default 'hint' attaches a transform")
  assert.deepEqual(specDefault.bodyTransform({ model: "m" }, { thinking: "disabled" }), { model: "m", thinking: { type: "disabled" } })
  // Explicit passthrough opts out of the field entirely.
  const specAuto = customProviderSpec(normalizeCustomProviderEntry({ id: "custom:e", thinking: "auto" }))
  assert.equal(specAuto.bodyTransform, undefined, "auto = no bodyTransform")

  // Anthropic-kind ignores the thinking switch (its adapter owns thinking).
  const anth = customProviderSpec(normalizeCustomProviderEntry({ id: "custom:x", kind: "anthropic", thinking: "disabled" }))
  assert.equal(anth.bodyTransform, undefined)

  // Round-trips through the env blob.
  const list = normalizeCustomProvidersList(JSON.stringify([{ id: "custom:a", thinking: "enabled", reasoningEffort: "low" }]))
  assert.equal(list[0].thinking, "enabled")
  assert.equal(list[0].reasoningEffort, "low")
})

test("custom provider ignores stale global AI_SMALL_MODEL/AI_LARGE_MODEL pins", async () => {
  // A leftover global cost-tier pin from a built-in provider (deepseek) must
  // not be sent to a custom endpoint — it would 400 with "Not supported model".
  const env = isolatedEnv({
    [CUSTOM_PROVIDERS_ENV]: JSON.stringify([
      { id: "custom:mimo", name: "mimo", baseUrl: "https://api.example.com/v1", defaultModel: "mimo-pro", defaultBackgroundModel: "mimo-pro-bg" },
    ]),
    OPENOVEL_CUSTOM_MIMO_API_KEY: "sk-mimo",
    AI_PROVIDER: "custom:mimo",
    AI_SMALL_MODEL: "deepseek-v4-flash",
    AI_LARGE_MODEL: "deepseek-v4-pro",
  })

  // resolveProvider (via the registry) uses the entry's own model, not the pin.
  const registry = new ProviderRegistry(builtinProviders)
  const fg = registry.route({ role: "foreground", env, providerId: "custom:mimo" })
  assert.equal(fg[0].model, "mimo-pro")
  const bg = registry.route({ role: "background", env, providerId: "custom:mimo" })
  assert.equal(bg[0].model, "mimo-pro-bg")

  // resolveModelProfile (the actual call-time resolver) must agree, since it
  // independently consults AI_SMALL_MODEL.
  const { resolveModelProfile } = await import("../src/provider/modelProfiles.js")
  assert.equal(resolveModelProfile("foreground", { env }).model, "mimo-pro")
  assert.equal(resolveModelProfile("narrator", { env }).model, "mimo-pro")
  assert.equal(resolveModelProfile("storykeeper", { env }).model, "mimo-pro-bg")

  // A built-in provider STILL honors the global pin (regression guard).
  const ds = resolveModelProfile("foreground", { env: { ...env, AI_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "sk-ds" } })
  assert.equal(ds.model, "deepseek-v4-flash")
})

test("settings layering: file definitions emit env blob + per-provider key vars", () => {
  const config = {
    provider: {
      customProviders: [
        { id: "custom:alpha", name: "Alpha", kind: "openai-compatible", baseUrl: "https://alpha.example.com/v1" },
      ],
      providers: {
        "custom:alpha": { apiKey: "sk-alpha-file" },
      },
    },
  }
  const env = isolatedEnv({
    OPENOVEL_CONFIG_DIR: "/nonexistent-openovel-config-dir",
    OPENOVEL_CONFIG_CONTENT: JSON.stringify(config),
  })
  const loaded = loadSettings({ env })
  assert.equal(loaded.settings.provider.customProviders.length, 1)
  const blob = JSON.parse(loaded.env[CUSTOM_PROVIDERS_ENV])
  assert.equal(blob[0].id, "custom:alpha")
  assert.equal(blob[0].apiKey, undefined, "definitions blob must not carry key material")
  assert.equal(loaded.env.OPENOVEL_CUSTOM_ALPHA_API_KEY, "sk-alpha-file")

  // Real env var wins over the file-derived key (env is the final layer).
  const loaded2 = loadSettings({ env: { ...env, OPENOVEL_CUSTOM_ALPHA_API_KEY: "sk-from-env" } })
  assert.equal(loaded2.env.OPENOVEL_CUSTOM_ALPHA_API_KEY, "sk-from-env")
})

// ── Alias (provider id) support in the settings store ───────────────────
const STORE_ENV_KEYS = [
  "OPENOVEL_HOME",
  "AI_PROVIDER",
  "AI_BACKGROUND_PROVIDER",
  "AI_PROVIDER_ORDER",
  "OPENOVEL_CUSTOM_PROVIDERS",
  "OPENOVEL_CUSTOM_FAST_API_KEY",
  "OPENOVEL_CUSTOM_TURBO_API_KEY",
  "OPENOVEL_MODEL_PROFILE_ROUTES",
  "OPENOVEL_AGENT_OVERRIDES",
  "OPENOVEL_NARRATOR_TIC_PATTERNS",
]

async function withStoreSandbox(run) {
  const saved = Object.fromEntries(STORE_ENV_KEYS.map((k) => [k, process.env[k]]))
  const home = await mkdtemp(path.join(os.tmpdir(), "openovel-custom-alias-"))
  process.env.OPENOVEL_HOME = home
  for (const k of STORE_ENV_KEYS) { if (k !== "OPENOVEL_HOME") delete process.env[k] }
  try {
    await run(home)
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test("saveCustomProvider: explicit alias controls the id; collisions rejected", async () => {
  await withStoreSandbox(async () => {
    const { saveCustomProvider } = await import("../src/electron/apiKeysStore.js")
    const created = await saveCustomProvider({ name: "我的快代理", alias: "Fast Proxy", baseUrl: "https://fast.example.com/v1", apiKey: "sk-fast" })
    assert.equal(created.ok, true)
    assert.equal(created.id, "custom:fast-proxy")

    const dup = await saveCustomProvider({ name: "Another", alias: "fast proxy" })
    assert.equal(dup.ok, false)
    assert.match(dup.message, /alias already in use/)

    const bad = await saveCustomProvider({ name: "X", alias: "中文别名" })
    assert.equal(bad.ok, false)
    assert.match(bad.message, /ascii/)
  })
})

test("saveCustomProvider: default + background model names round-trip to the registry", async () => {
  await withStoreSandbox(async () => {
    const { saveCustomProvider, getApiKeysSnapshot } = await import("../src/electron/apiKeysStore.js")
    const created = await saveCustomProvider({
      name: "mimo ultraspeed",
      baseUrl: "https://api.xiaomimimo.com/v1",
      defaultModel: "mimo-v2.5-pro-ultraspeed",
      defaultBackgroundModel: "mimo-v2.5-pro-ultraspeed",
      apiKey: "sk-mimo",
    })
    assert.equal(created.ok, true)

    // The snapshot the UI reads back carries the model names (so the editor
    // re-renders them, not blanks).
    const snap = await getApiKeysSnapshot()
    const entry = snap.customProviders.find((p) => p.id === created.id)
    assert.equal(entry.defaultModel, "mimo-v2.5-pro-ultraspeed")
    assert.equal(entry.defaultBackgroundModel, "mimo-v2.5-pro-ultraspeed")

    // And they reach the registry as the resolved model for each role —
    // saveCustomProvider mirrored OPENOVEL_CUSTOM_PROVIDERS into process.env.
    const { ProviderRegistry } = await import("../src/provider/registry.js")
    const { builtinProviders } = await import("../src/provider/plugins/index.js")
    const registry = new ProviderRegistry(builtinProviders)
    const fg = registry.route({ role: "foreground", env: process.env, providerId: created.id })
    assert.equal(fg[0].model, "mimo-v2.5-pro-ultraspeed")
    const bg = registry.route({ role: "background", env: process.env, providerId: created.id })
    assert.equal(bg[0].model, "mimo-v2.5-pro-ultraspeed")

    // Editing only the model (no key touched) preserves the saved key.
    const edited = await saveCustomProvider({ id: created.id, name: "mimo ultraspeed", baseUrl: "https://api.xiaomimimo.com/v1", defaultModel: "mimo-v3" })
    assert.equal(edited.ok, true)
    const snap2 = await getApiKeysSnapshot()
    const entry2 = snap2.customProviders.find((p) => p.id === created.id)
    assert.equal(entry2.defaultModel, "mimo-v3")
    assert.equal(entry2.set, true, "key survives a model-only edit")
  })
})

test("saveCustomProvider: alias rename migrates every reference", async () => {
  await withStoreSandbox(async (home) => {
    // Seed a settings file where custom:fast is referenced from everywhere a
    // provider id can appear.
    const seeded = {
      provider: {
        foreground: "custom:fast",
        background: "custom:fast",
        order: ["custom:fast", "kimi-code"],
        customProviders: [
          { id: "custom:fast", name: "Fast", kind: "openai-compatible", baseUrl: "https://fast.example.com/v1" },
        ],
        providers: {
          "custom:fast": { apiKey: "sk-fast", ticPatterns: "不由得" },
        },
      },
      modelProfiles: {
        routes: {
          narrator: { provider: "custom:fast", model: "m1" },
          summary: "custom:fast/m2",
        },
      },
      agents: {
        overrides: {
          director: { model: { provider: "custom:fast", model: "m3", role: "background" } },
        },
      },
    }
    await writeFile(path.join(home, "settings.local.json"), JSON.stringify(seeded, null, 2), "utf8")

    const { saveCustomProvider } = await import("../src/electron/apiKeysStore.js")
    const res = await saveCustomProvider({ id: "custom:fast", alias: "turbo" })
    assert.equal(res.ok, true)
    assert.equal(res.id, "custom:turbo")
    assert.equal(res.renamedFrom, "custom:fast")

    const after = JSON.parse(await readFile(path.join(home, "settings.local.json"), "utf8"))
    assert.equal(after.provider.customProviders.length, 1)
    assert.equal(after.provider.customProviders[0].id, "custom:turbo")
    assert.equal(after.provider.customProviders[0].baseUrl, "https://fast.example.com/v1", "definition fields survive the rename")
    assert.equal(after.provider.foreground, "custom:turbo")
    assert.equal(after.provider.background, "custom:turbo")
    assert.deepEqual(after.provider.order, ["custom:turbo", "kimi-code"])
    assert.equal(after.provider.providers["custom:fast"], undefined)
    assert.equal(after.provider.providers["custom:turbo"].apiKey, "sk-fast")
    assert.equal(after.provider.providers["custom:turbo"].ticPatterns, "不由得")
    assert.equal(after.modelProfiles.routes.narrator.provider, "custom:turbo")
    assert.equal(after.modelProfiles.routes.summary, "custom:turbo/m2")
    assert.equal(after.agents.overrides.director.model.provider, "custom:turbo")

    // Env mirrors re-derived for the running session.
    assert.equal(process.env.AI_PROVIDER, "custom:turbo")
    assert.equal(process.env.AI_BACKGROUND_PROVIDER, "custom:turbo")
    assert.equal(process.env.AI_PROVIDER_ORDER, "custom:turbo,kimi-code")
    assert.equal(process.env.OPENOVEL_CUSTOM_TURBO_API_KEY, "sk-fast")
    assert.equal(process.env.OPENOVEL_CUSTOM_FAST_API_KEY, undefined)
    const blob = JSON.parse(process.env.OPENOVEL_CUSTOM_PROVIDERS)
    assert.equal(blob[0].id, "custom:turbo")
    const routes = JSON.parse(process.env.OPENOVEL_MODEL_PROFILE_ROUTES)
    assert.equal(routes.narrator.provider, "custom:turbo")
  })
})

test("provider aliases: applied at resolve time, emitted from settings", () => {
  const registry = new ProviderRegistry(builtinProviders)
  const env = isolatedEnv({
    OPENOVEL_PROVIDER_ALIASES: JSON.stringify({ "deepseek": "深度求索（备用）", "custom:alpha": "Alpha 主力" }),
    [CUSTOM_PROVIDERS_ENV]: JSON.stringify([{ id: "custom:alpha", name: "Alpha", baseUrl: "https://a" }]),
  })

  // Builtin provider name is overridden; the underlying id is untouched.
  const route = registry.route({ role: "foreground", env, providerId: "deepseek" })
  assert.equal(route[0].id, "deepseek")
  assert.equal(route[0].name, "深度求索（备用）")

  // Aliases also apply to custom providers (over their configured name).
  const alpha = registry.route({ role: "foreground", env, providerId: "custom:alpha" })
  assert.equal(alpha[0].name, "Alpha 主力")

  // No alias → builtin name unchanged.
  const kimi = registry.route({ role: "foreground", env, providerId: "kimi-code" })
  assert.equal(kimi[0].name, "Kimi Code")

  // settingsToEnv emits the aliases map from providers[<id>].alias; blank
  // aliases are dropped; a real env var wins over the file-derived one.
  const config = {
    provider: {
      providers: {
        deepseek: { alias: "DS 备用" },
        "kimi-code": { alias: "   " },
      },
    },
  }
  const loaded = loadSettings({ env: isolatedEnv({
    OPENOVEL_CONFIG_DIR: "/nonexistent-openovel-config-dir",
    OPENOVEL_CONFIG_CONTENT: JSON.stringify(config),
  }) })
  assert.deepEqual(JSON.parse(loaded.env.OPENOVEL_PROVIDER_ALIASES), { deepseek: "DS 备用" })

  const loaded2 = loadSettings({ env: isolatedEnv({
    OPENOVEL_CONFIG_DIR: "/nonexistent-openovel-config-dir",
    OPENOVEL_CONFIG_CONTENT: JSON.stringify(config),
    OPENOVEL_PROVIDER_ALIASES: JSON.stringify({ deepseek: "env wins" }),
  }) })
  assert.deepEqual(JSON.parse(loaded2.env.OPENOVEL_PROVIDER_ALIASES), { deepseek: "env wins" })
})

test("settings layering: OPENOVEL_CUSTOM_PROVIDERS env round-trips into settings", () => {
  const env = isolatedEnv({
    OPENOVEL_CONFIG_DIR: "/nonexistent-openovel-config-dir",
    [CUSTOM_PROVIDERS_ENV]: JSON.stringify([{ id: "custom:envy", baseUrl: "https://envy.example.com" }]),
  })
  const loaded = loadSettings({ env })
  assert.equal(loaded.settings.provider.customProviders.length, 1)
  assert.equal(loaded.settings.provider.customProviders[0].id, "custom:envy")
})
