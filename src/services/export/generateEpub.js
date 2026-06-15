// EPUB3 export — styled to match openovel's Zen UI aesthetic:
//   - neutral light-grey paper (#f4f4f4), not the warm beige common to
//     other e-reader exports
//   - warm near-black ink (#1c1917) with cool grey chrome (#5e5d59, #8e8c87)
//   - hairline rules (#bdbcb6), no decorative dingbats or gold/red accents
//   - body serif: Bookerly / Charter / Source Serif + Songti SC fallback
//   - chrome sans: Inter / Noto Sans / PingFang
//   - paragraphs with 2em indent, justified, line-height 1.7
//
// Reader actions are rendered inline as italic "stage direction" blocks —
// mirroring the transcript's `.entry-user` styling — so the ebook reads the
// same way the live UI does.
//
// Returns a Node Buffer with the .epub zip ready to write to disk.

import JSZip from "jszip"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

const CSS = `
@page { margin: 5% 6%; }

body {
  background: #f4f4f4;
  color: #1c1917;
  font-family: "Bookerly", "Charter", "Source Serif 4", "Source Serif Pro",
    "Literata", "Iowan Old Style", "Songti SC", "Source Han Serif SC",
    "Noto Serif CJK SC", Georgia, serif;
  font-size: 1em;
  line-height: 1.7;
  margin: 0;
  padding: 0;
  -webkit-font-feature-settings: "kern", "liga", "calt", "onum";
  font-feature-settings: "kern", "liga", "calt", "onum";
}

.page {
  padding: 1em;
}
.page-centered {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 90vh;
  text-align: center;
  padding: 2em 1.5em;
  box-sizing: border-box;
}

/* ── Title page ── */
.title-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 92vh;
  text-align: center;
  padding: 2em 1.5em;
  box-sizing: border-box;
}
.title-name {
  font-size: 1.8em;
  font-weight: 400;
  letter-spacing: 0.04em;
  color: #1c1917;
  margin: 0;
  line-height: 1.4;
}
.title-rule {
  width: 2em;
  height: 1px;
  background: #bdbcb6;
  border: none;
  margin: 1.4em 0;
}
.title-brand {
  font-family: "Inter", "Noto Sans", "PingFang SC",
    -apple-system, "Helvetica Neue", "Microsoft YaHei", sans-serif;
  font-size: 0.7em;
  color: #8e8c87;
  letter-spacing: 0.22em;
  margin-top: 1.2em;
}

/* ── Brief preface ── */
.brief-page {
  padding: 4em 0 2em;
}
.brief-header {
  margin-bottom: 1.6em;
}
.brief-label {
  font-family: "Inter", "Noto Sans", "PingFang SC",
    -apple-system, "Helvetica Neue", "Microsoft YaHei", sans-serif;
  font-size: 0.72em;
  color: #5e5d59;
  letter-spacing: 0.22em;
  margin: 0 0 0.4em;
}
.brief-rule {
  width: 1.5em;
  height: 1px;
  background: #bdbcb6;
  border: none;
  margin: 0;
}
.brief-body p {
  text-indent: 0;
  color: #2a2a28;
  margin: 0.7em 0;
  line-height: 1.7;
}

/* ── Chapter ── */
.chapter-page {
  padding-top: 3em;
}
.chapter-header {
  margin-bottom: 1.6em;
}
.chapter-num {
  font-family: "Inter", "Noto Sans", "PingFang SC",
    -apple-system, "Helvetica Neue", "Microsoft YaHei", sans-serif;
  font-size: 0.72em;
  color: #8e8c87;
  letter-spacing: 0.22em;
  margin: 0 0 0.5em;
}
.chapter-title {
  font-size: 1.05em;
  font-weight: 400;
  color: #1c1917;
  margin: 0;
  line-height: 1.5;
}
.chapter-rule {
  width: 1.5em;
  height: 1px;
  background: #bdbcb6;
  border: none;
  margin: 0.9em 0 0;
}

p {
  text-indent: 2em;
  text-align: justify;
  line-height: 1.7;
  margin: 0;
  color: #1c1917;
  -webkit-hyphens: auto;
  hyphens: auto;
}
p + p { margin-top: 0.1em; }

em { font-style: italic; }
strong { font-weight: 600; }
code {
  font-family: "iA Writer Mono S", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.9em;
  background: rgba(0, 0, 0, 0.05);
  padding: 0.05em 0.3em;
  border-radius: 3px;
}
pre {
  margin: 0.9em 0;
  padding: 0.7em 0.9em;
  background: #ebebeb;
  border: 1px solid #d4d3cc;
  border-radius: 6px;
  text-indent: 0;
  text-align: left;
  overflow-x: auto;
}
pre code {
  display: block;
  font-size: 0.85em;
  line-height: 1.55;
  color: #2a2a28;
  background: none;
  padding: 0;
  border-radius: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
}
blockquote {
  margin: 0.8em 0;
  padding-left: 1em;
  border-left: 2px solid #bdbcb6;
  color: #5e5d59;
  /* Kai / 楷体 for quoted material — the CJK equivalent of italic. No
     font-style: italic (it faux-slants CJK glyphs); Latin falls back to the
     serif tail. */
  font-family: "Kaiti SC", "STKaiti", "KaiTi", "Kai", "BiauKai", "TW-Kai",
    "Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", Georgia, serif;
}
blockquote p { text-indent: 0; }
ul, ol {
  margin: 0.8em 0;
  padding-left: 1.6em;
}
li { margin: 0.2em 0; line-height: 1.6; }
li p { text-indent: 0; }
h1, h2, h3, h4 {
  font-weight: 600;
  line-height: 1.4;
  margin: 1.2em 0 0.5em;
  text-indent: 0;
}
h1 { font-size: 1.3em; }
h2 { font-size: 1.15em; }
h3 { font-size: 1.05em; }
hr {
  border: none;
  height: 1px;
  background: #bdbcb6;
  margin: 1.4em auto;
  width: 3em;
}
a { color: #1c1917; text-decoration: underline; }

/* Reader action — italic stage direction, mirrors the transcript UI. Reads
   in flow but the eye registers "this is the reader's input, not the
   narrator's". No leading indent because the chevron is the attribution cue. */
.reader-action {
  display: block;
  font-style: italic;
  font-size: 0.96em;
  color: #2a2a28;
  text-indent: 0;
  margin: 1em 0 1.2em;
  padding: 0.45em 0.85em 0.5em;
  background: rgba(0, 0, 0, 0.04);
  border-radius: 4px;
  line-height: 1.55;
}
.reader-action::before {
  content: "› ";
  color: #8e8c87;
  font-style: normal;
}

/* ── Colophon ── */
.colophon {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 80vh;
  text-align: center;
  padding: 2em 1.5em;
}
.colophon-brand {
  font-family: "Inter", "Noto Sans", "PingFang SC",
    -apple-system, "Helvetica Neue", "Microsoft YaHei", sans-serif;
  font-size: 0.85em;
  color: #5e5d59;
  letter-spacing: 0.22em;
}
.colophon-rule {
  width: 1.5em;
  height: 1px;
  background: #bdbcb6;
  border: none;
  margin: 1.4em 0;
}
.colophon-meta {
  font-family: "Inter", "Noto Sans", "PingFang SC",
    -apple-system, "Helvetica Neue", "Microsoft YaHei", sans-serif;
  font-size: 0.7em;
  color: #8e8c87;
  letter-spacing: 0.06em;
  line-height: 1.85;
}
.colophon-meta div { margin: 0.1em 0; }
`

const STRINGS = {
  zh: {
    chapter: (n) => `第 ${n} 章`,
    prologue: "序章",
    brand: "openovel",
    disclaimer: "由 openovel 生成。内容由 AI 创作。",
    exportDate: "导出日期",
    briefLabel: "原始构想",
    tocLabel: "目录",
  },
  en: {
    chapter: (n) => `Chapter ${n}`,
    prologue: "Prologue",
    brand: "openovel",
    disclaimer: "Generated by openovel. Content authored by AI.",
    exportDate: "Export date",
    briefLabel: "Original brief",
    tocLabel: "Contents",
  },
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// Run the same Markdown pipeline the streaming transcript uses (Streamdown
// is remark-gfm under the hood), but on the Node side via react-markdown +
// react-dom/server. Output is an HTML string ready to drop straight into
// the chapter's XHTML body. We DON'T enable rehype-raw — narration is
// trusted prose, but escaping any literal `<` keeps the EPUB well-formed.
const MD_PLUGINS = [remarkGfm]
function mdToHtml(markdown) {
  const text = String(markdown || "")
  if (!text.trim()) return ""
  return renderToStaticMarkup(
    React.createElement(ReactMarkdown, { remarkPlugins: MD_PLUGINS }, text),
  )
}

function xhtmlWrap(title, body, { centered = false } = {}) {
  const cls = centered ? "page-centered" : "page"
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh">
<head><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<div class="${cls}">
${body}
</div>
</body>
</html>`
}

function buildTitlePage(data, strings) {
  const body = `<div class="title-page">
  <div class="title-name">${esc(data.title)}</div>
  <hr class="title-rule"/>
  <div class="title-brand">${esc(strings.brand)}</div>
</div>`
  return xhtmlWrap(data.title, body)
}

function buildBriefPage(data, strings) {
  const body = `<div class="brief-page">
  <div class="brief-header">
    <div class="brief-label">${esc(strings.briefLabel)}</div>
    <hr class="brief-rule"/>
  </div>
  <div class="brief-body">
${mdToHtml(data.brief)}
  </div>
</div>`
  return xhtmlWrap(strings.briefLabel, body)
}

function buildChapter(ch, strings) {
  const heading = ch.turn === 0 ? strings.prologue : strings.chapter(ch.turn)
  // The reader action is rendered inline as a stage direction at the TOP of
  // the chapter body — except for the auto-seed prologue (action is empty
  // by the time it reaches us, courtesy of demoteAutoSeed).
  const actionBlock = ch.action
    ? `<div class="reader-action">${esc(ch.action)}</div>\n`
    : ""
  const paras = mdToHtml(ch.paragraphs.join("\n\n"))
  const body = `<div class="chapter-page">
  <div class="chapter-header">
    <div class="chapter-num">${esc(heading)}</div>
    <hr class="chapter-rule"/>
  </div>
${actionBlock}${paras}
</div>`
  return xhtmlWrap(heading, body)
}

function buildColophon(data, strings) {
  const date = data.exportedAt.slice(0, 10)
  const body = `<div class="colophon">
  <div class="colophon-brand">${esc(strings.brand)}</div>
  <hr class="colophon-rule"/>
  <div class="colophon-meta">
    <div>${esc(strings.exportDate)} · ${esc(date)}</div>
    <div>${esc(strings.disclaimer)}</div>
  </div>
</div>`
  return xhtmlWrap("Colophon", body)
}

export async function generateEpub(data) {
  const strings = STRINGS[data.locale] || STRINGS.en
  const zip = new JSZip()

  // mimetype must be first and uncompressed (epubcheck requirement)
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" })

  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  )

  const oebps = zip.folder("OEBPS")
  oebps.file("style.css", CSS)

  const items = []
  const spine = []

  items.push({ id: "title", href: "title.xhtml", content: buildTitlePage(data, strings) })
  spine.push("title")

  if (data.brief) {
    items.push({ id: "brief", href: "brief.xhtml", content: buildBriefPage(data, strings) })
    spine.push("brief")
  }

  data.chapters.forEach((ch, i) => {
    const id = `chapter-${i + 1}`
    items.push({ id, href: `${id}.xhtml`, content: buildChapter(ch, strings) })
    spine.push(id)
  })

  items.push({ id: "colophon", href: "colophon.xhtml", content: buildColophon(data, strings) })
  spine.push("colophon")

  for (const item of items) oebps.file(item.href, item.content)

  const manifestItems = [
    '<item id="css" href="style.css" media-type="text/css"/>',
    '<item id="toc" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    ...items.map(
      (it) => `<item id="${it.id}" href="${it.href}" media-type="application/xhtml+xml"/>`,
    ),
  ].join("\n    ")
  const spineItems = spine.map((id) => `<itemref idref="${id}"/>`).join("\n    ")

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">openovel-${esc(data.storyId)}-${Date.now()}</dc:identifier>
    <dc:title>${esc(data.title)}</dc:title>
    <dc:language>${data.locale === "zh" ? "zh-CN" : "en"}</dc:language>
    <dc:creator>${esc(strings.brand)}</dc:creator>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>
  </metadata>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`
  oebps.file("content.opf", opf)

  const navItems = items
    .map((it) => {
      const label =
        it.id === "title"
          ? data.title
          : it.id === "brief"
            ? strings.briefLabel
            : it.id === "colophon"
              ? strings.brand
              : (() => {
                  const idx = parseInt(it.id.split("-")[1], 10) - 1
                  const ch = data.chapters[idx]
                  if (!ch) return it.id
                  return ch.turn === 0 ? strings.prologue : strings.chapter(ch.turn)
                })()
      return `<li><a href="${it.href}">${esc(label)}</a></li>`
    })
    .join("\n      ")

  const toc = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${esc(strings.tocLabel)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<nav epub:type="toc"><h1 class="brief-label">${esc(strings.tocLabel)}</h1><ol>
      ${navItems}
</ol></nav>
</body>
</html>`
  oebps.file("toc.xhtml", toc)

  const arrayBuffer = await zip.generateAsync({ type: "uint8array", mimeType: "application/epub+zip" })
  return Buffer.from(arrayBuffer)
}
