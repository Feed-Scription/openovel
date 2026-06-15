import { storyPaths } from "../lib/workspacePaths.js"

// In-memory registry of resident-agent configs, keyed by id and kept PER STORY
// ROOT. Populated by loadAgentConfigs(); consulted by the write-scope guard
// (src/agents/writeGuard.js) and, indirectly, by the channel inbox resolver.
// Process-scoped like the other singletons, but slotted by root because
// background agents outlive story switches: a story-A agent still finishing
// after the reader switched to story B runs pinned to A (storyContext.js) and
// must be checked against A's configs (write scopes, per-story YAML
// overrides), not B's. Lookups resolve the caller's current root via
// storyPaths(), which is pin-aware.
const registries = new Map() // story root → Map(agentId → config)

function currentRegistry() {
  return registries.get(storyPaths().root) || null
}

export function setAgentRegistry(configs = []) {
  registries.set(storyPaths().root, new Map(configs.map((c) => [c.id, c])))
}

export function getAgentConfig(id) {
  return currentRegistry()?.get(String(id)) || null
}

export function allAgentConfigs() {
  const registry = currentRegistry()
  return registry ? [...registry.values()] : []
}

export function getAgentWriteScope(id) {
  return currentRegistry()?.get(String(id))?.writeScope || null
}

export function clearAgentRegistry() {
  registries.clear()
}
