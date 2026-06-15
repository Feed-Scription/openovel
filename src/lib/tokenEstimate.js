// Language-aware token estimate — no tokenizer, no dependency.
//
// Tokenizers split CJK far more finely than Latin text: a CJK character is
// roughly one token, so Chinese averages ~1.5 chars/token, while Latin/other
// text averages ~4 chars/token (GPT-4-ish ratios; close enough for the Chinese
// models we route to, whose exact BPE we don't ship). A flat character budget
// therefore lets ~2.6x more English characters than Chinese through for the
// same token count — or, the other way, cuts English content far shorter than
// Chinese under one char cap. Bucketing by script removes that skew.
//
// Accuracy is in the ballpark of dedicated 2kB estimators (~within 10-15% of a
// real tokenizer) and is plenty for soft budget warnings. It is NOT exact and
// must not be used where the model's own token accounting is required.
//
// CJK punctuation, kana, CJK ideographs (+ Ext A, compatibility), Hangul, and
// full/half-width forms. Each such char counts as roughly one token.
const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿가-힯＀-￯]/g
const CJK_CHARS_PER_TOKEN = 1.5
const OTHER_CHARS_PER_TOKEN = 4

export function estimateTokenCount(text) {
  const s = String(text || "")
  if (!s) return 0
  const total = [...s].length
  const cjk = (s.match(CJK_RE) || []).length
  const other = total - cjk
  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN + other / OTHER_CHARS_PER_TOKEN)
}
