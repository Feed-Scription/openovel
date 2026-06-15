// Side-effect-on-import: install an undici EnvHttpProxyAgent as the global
// dispatcher when the environment indicates a proxy. Without this, Node's
// global fetch() ignores HTTPS_PROXY / HTTP_PROXY / ALL_PROXY (curl honors
// them, undici does not by default), so websearch / webfetch / provider
// HTTP calls quietly fail with ECONNRESET or UND_ERR_CONNECT_TIMEOUT on
// networks where outbound HTTPS is only reachable through a local proxy
// (Clash, V2Ray, corporate egress, etc.).
//
// Importing this module from each entry-point preamble is the cheapest way
// to fix the whole runtime in one place — websearch, webfetch, provider
// chat, telemetry POSTs, all go through fetch and inherit the dispatcher.
//
// NOTE: Node bundles undici INTERNALLY to power global fetch(), but does NOT
// expose it as an importable specifier — `import ... from "undici"` requires
// the npm `undici` package. It is a declared dependency for exactly this
// reason; a packaged build that drops it crashes at startup with
// ERR_MODULE_NOT_FOUND. Keep undici in package.json dependencies.

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici"

const proxyEnv =
  process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY  || process.env.http_proxy  ||
  process.env.ALL_PROXY   || process.env.all_proxy

if (proxyEnv) {
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent())
    if (process.env.OPENOVEL_LOG_NETWORK) {
      process.stderr.write(`[network] proxy enabled via env: ${proxyEnv}\n`)
    }
  } catch (error) {
    process.stderr.write(
      `[network] failed to install EnvHttpProxyAgent: ${error?.message || error}\n`,
    )
  }
}
