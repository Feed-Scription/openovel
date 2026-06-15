import { existsSync } from "node:fs"
import { readdir, unlink } from "node:fs/promises"
import path from "node:path"
import { readText, writeJson, writeText } from "../lib/files.js"
import { workspaceLayout } from "../lib/workspacePaths.js"
import { addMemoryEntry, clearMemoryTarget, getMemorySnapshot } from "../memory/memoryStore.js"
import { chatCompletion, hasModelKey } from "../provider/provider.js"
import { resolveModelProfile } from "../provider/modelProfiles.js"
import { parseJsonObject } from "../lib/json.js"

const STYLE_COMPARISON_TIMEOUT_MS = 2500
const DEFAULT_ONBOARDING_LOCALE = "en"

// ── Style preference tag groups (en + zh) ──
// Stable per-user preferences across writing-craft + IF dimensions. The
// onboarding GUI shows these as multi-select pills; the joined selection
// is written to USER.md as one prose line. Users are free to ADD their
// own tags into USER.md later — prompts treat unknown tags as semantic
// hints, not lookup keys, so custom additions Just Work.
//
// Dimensions covered (informed by writing-craft + IF research):
//   pacing      — story tempo (slow-burn ↔ cinematic, plus rhythm shape)
//   progression — time grain per turn (hour-by-hour ↔ leap across years)
//   tone        — narrator attitude/mood (lyrical ↔ detached, etc.)
//   pov         — narrative perspective (1st / 2nd / 3rd limited|omni / unreliable)
//   rhythm      — sentence-level cadence (terse ↔ flowing)
//   focus       — what the narration weights (action / dialogue / interior / sensory)
//   imagery     — sensory modality preference (visual / auditory / tactile / synesthetic)
//   agency      — IF-specific: how much the reader's choices should bite
//   avoid       — anti-patterns the user wants to never see
// Group order goes from MOST structural (the lens through which the
// reader experiences the story) to LEAST structural / most ancillary —
// POV first sets the camera; pacing/tone shape the broad feel; rhythm
// and focus are sentence-level; imagery and agency are channel/IF
// specific; avoid lists exclusions and naturally goes last.
//
// Within each group, options order by intuitive progression:
//   POV     — common → rare → modifiers
//   Pacing  — slow → fast, then quality modifiers
//   Tone    — light/warm → heavy/cool
//   Rhythm  — short → long → mixed → meta
//   Focus   — what surface → what depth → structural emphasis
//   Imagery — by sensory channel, then meta
//   Agency  — high agency → low agency
//   Avoid   — voice issues → style issues → agency issues
const STYLE_TAG_GROUPS_EN = [
  {
    id: "pov",
    label: "POV",
    options: [
      { value: "first-person",     label: "First person",            description: "Narrate in 'I'." },
      { value: "third-limited",    label: "Third-person limited",    description: "He/she/they with one focal consciousness." },
      { value: "third-omniscient", label: "Third-person omniscient", description: "He/she/they; narrator can know any mind." },
      { value: "second-person",    label: "Second person",           description: "Narrate in 'you'." },
      { value: "unreliable",       label: "Unreliable narrator",     description: "Narrator may be biased, mistaken, or lying." },
      { value: "epistolary",       label: "Epistolary",              description: "Told via letters, journals, or messages." },
    ],
  },
  {
    id: "pacing",
    label: "Pacing",
    options: [
      { value: "slow-burn",  label: "Slow burn",  description: "Gradual buildup; long quiet beats before payoff." },
      { value: "meandering", label: "Meandering", description: "Allow tangents and side musings to breathe." },
      { value: "steady",     label: "Steady",     description: "Even tempo; few abrupt rhythm shifts." },
      { value: "brisk",      label: "Brisk",      description: "Quick beats; minimal lingering between events." },
      { value: "staccato",   label: "Staccato",   description: "Punchy short scenes and clipped fragments." },
      { value: "cinematic",  label: "Cinematic",  description: "Scene-cut feel; sharp transitions like film." },
    ],
  },
  {
    id: "progression",
    label: "Time per turn",
    // How much in-story time + plot a single turn advances. Distinct from
    // pacing (which is prose tempo): this is the time GRAIN. singleSelect —
    // a turn moves at one speed, so the pills behave like radio buttons.
    singleSelect: true,
    options: [
      { value: "hour-by-hour",  label: "Hour by hour",   description: "Very fine grain; a turn spans minutes to an hour." },
      { value: "scene-by-scene", label: "Scene by scene", description: "A turn completes one scene — hours within a day." },
      { value: "day-by-day",    label: "Day by day",     description: "A turn advances roughly a day." },
      { value: "skip-lulls",    label: "Skip the lulls", description: "Leap over uneventful stretches to the next meaningful beat — days or weeks." },
      { value: "across-years",  label: "Across years",   description: "When the story allows, sweep through months, years, or longer in one stroke." },
    ],
  },
  {
    id: "tone",
    label: "Tone",
    options: [
      { value: "earnest",      label: "Earnest",      description: "Sincere; no irony or wink to the reader." },
      { value: "intimate",     label: "Intimate",     description: "Stay close to the protagonist's interiority." },
      { value: "playful",      label: "Playful",      description: "Light wit; willing to be funny when it fits." },
      { value: "lyrical",      label: "Lyrical",      description: "Permit figurative language and rhythmic phrasing." },
      { value: "wry",          label: "Wry",          description: "Dry humor that doesn't undercut seriousness." },
      { value: "ironic",       label: "Ironic",       description: "Surface meaning diverges from intent." },
      { value: "spare",        label: "Spare",        description: "Terse; no metaphor flourishes." },
      { value: "detached",     label: "Detached",     description: "Distant narrator; observation over feeling." },
      { value: "reverent",     label: "Reverent",     description: "Solemn weight; gravitas around stakes." },
      { value: "melancholic",  label: "Melancholic",  description: "Quiet sadness running beneath the action." },
      { value: "brutal",       label: "Brutal",       description: "Unsoftened; consequences hit hard." },
    ],
  },
  {
    id: "rhythm",
    label: "Sentence rhythm",
    options: [
      { value: "terse",    label: "Terse",         description: "Short sentences and short clauses." },
      { value: "flowing",  label: "Flowing",       description: "Longer sentences with subordinate clauses." },
      { value: "varied",   label: "Varied / mixed", description: "Mix sentence lengths for dynamic feel." },
      { value: "rhythmic", label: "Rhythmic",      description: "Audible cadence; attention to syllable weight." },
    ],
  },
  {
    id: "focus",
    label: "Focus",
    options: [
      { value: "action-forward",     label: "Action-forward",      description: "Lead with what someone does, then react." },
      { value: "dialogue-heavy",     label: "Dialogue-heavy",      description: "Lean on conversation to advance scenes." },
      { value: "internal-monologue", label: "Internal monologue",  description: "Foreground the protagonist's thoughts." },
      { value: "reflection-forward", label: "Reflection-forward",  description: "Pause for meaning between events." },
      { value: "sensory-dense",      label: "Sensory-dense",       description: "Rich physical detail per beat." },
      { value: "sensory-spare",      label: "Sensory-spare",       description: "Minimal description; let the eye fill in." },
      { value: "world-rich",         label: "World-building rich", description: "Surface setting and lore textures." },
      { value: "character-driven",   label: "Character-driven",    description: "Personalities steer the plot." },
      { value: "plot-driven",        label: "Plot-driven",         description: "Events steer the characters." },
    ],
  },
  {
    id: "imagery",
    label: "Imagery",
    options: [
      { value: "visual",      label: "Visual",                  description: "Lead with what the eye sees." },
      { value: "auditory",    label: "Auditory",                description: "Lead with sound, voices, silence." },
      { value: "tactile",     label: "Tactile",                 description: "Lead with touch, texture, temperature." },
      { value: "olfactory",   label: "Smells & tastes",         description: "Lean on smell and taste channels." },
      { value: "spatial",     label: "Spatial / architectural", description: "Make geometry and architecture readable." },
      { value: "synesthetic", label: "Synesthetic",             description: "Cross sensory channels (e.g. sound has color)." },
    ],
  },
  {
    id: "agency",
    label: "Interaction style",
    options: [
      { value: "high-consequence", label: "Choices have weight",  description: "Player choices alter major outcomes." },
      { value: "sandbox",          label: "Sandbox / open world", description: "Wide options at every beat; minimal rails." },
      { value: "exploration",      label: "Exploration-focused",  description: "Reward poking around the world." },
      { value: "puzzle",           label: "Puzzle-leaning",       description: "Knots that require thinking to untangle." },
      { value: "guided",           label: "Guided main path",     description: "Strong main path with side flourishes." },
      { value: "light-touch",      label: "Light interaction",    description: "Most choices are cosmetic; mainline stable." },
    ],
  },
  {
    id: "avoid",
    label: "Avoid",
    options: [
      { value: "ai-isms",             label: "AI-isms",                       description: "No 'as an AI' / hedged disclaimers / chatbot tics." },
      { value: "over-explain",        label: "Over-explanation",              description: "Don't restate what's already clear from action." },
      { value: "info-dump",           label: "Info-dumping",                  description: "Don't lecture readers on lore." },
      { value: "telling-not-showing", label: "Tell, don't show",              description: "Demonstrate via scene, not summary." },
      { value: "purple-prose",        label: "Purple prose",                  description: "No ornate, over-decorated prose." },
      { value: "cliches",             label: "Genre clichés",                 description: "No stock tropes or shortcut stereotypes." },
      { value: "fourth-wall-break",   label: "Fourth-wall breaks",            description: "Don't address the reader directly." },
      { value: "take-agency",         label: "Taking the player's decisions", description: "Don't decide for the player." },
      { value: "anachronisms",        label: "Anachronisms",                  description: "No modern objects / idioms in period work." },
      { value: "modern-slang",        label: "Modern slang (in period work)", description: "Use period-appropriate vocabulary." },
    ],
  },
]
const STYLE_TAG_GROUPS_ZH = [
  {
    id: "pov",
    label: "视角",
    options: [
      { value: "first-person",     label: "第一人称",     description: "用「我」叙述。" },
      { value: "third-limited",    label: "第三人称限知", description: "他/她/他们，单一焦点意识。" },
      { value: "third-omniscient", label: "第三人称全知", description: "他/她/他们，叙述者无所不知。" },
      { value: "second-person",    label: "第二人称",     description: "用「你」叙述。" },
      { value: "unreliable",       label: "不可靠叙述者", description: "叙述者可能偏颇、误记或撒谎。" },
      { value: "epistolary",       label: "书信体",       description: "以书信、日记或消息推动。" },
    ],
  },
  {
    id: "pacing",
    label: "节奏",
    options: [
      { value: "slow-burn",  label: "慢热",   description: "缓慢铺垫，高潮前留足安静的呼吸。" },
      { value: "meandering", label: "闲笔",   description: "允许岔路与漫谈呼吸。" },
      { value: "steady",     label: "平稳",   description: "节奏均匀，少有急转。" },
      { value: "brisk",      label: "紧凑",   description: "节奏快，事件之间少有停顿。" },
      { value: "staccato",   label: "短促",   description: "短场景与短句切换。" },
      { value: "cinematic",  label: "电影感", description: "镜头剪辑感，场景转换利落。" },
    ],
  },
  {
    id: "progression",
    label: "推进速度",
    singleSelect: true,
    options: [
      { value: "hour-by-hour",   label: "逐时",     description: "极细颗粒；一个回合跨越几分钟到一小时。" },
      { value: "scene-by-scene", label: "逐场",     description: "一个回合完成一个场景，数小时之内。" },
      { value: "day-by-day",     label: "逐日",     description: "一个回合大致推进一天。" },
      { value: "skip-lulls",     label: "跳过平淡", description: "略过无事的时段，直接跳到下一个有意义的节点——数日乃至数周。" },
      { value: "across-years",   label: "纵跨岁月", description: "故事允许时，一笔扫过数月、数年乃至更久。" },
    ],
  },
  {
    id: "tone",
    label: "调性",
    options: [
      { value: "earnest",      label: "诚恳",   description: "真诚，不带戏谑或对读者眨眼。" },
      { value: "intimate",     label: "亲密",   description: "紧贴主角的内心。" },
      { value: "playful",      label: "俏皮",   description: "带笑意，必要时愿意俏皮。" },
      { value: "lyrical",      label: "诗意",   description: "允许比喻和韵律感语言。" },
      { value: "wry",          label: "戏谑",   description: "干涩幽默，不削弱严肃。" },
      { value: "ironic",       label: "反讽",   description: "字面与意图相悖，反讽笔触。" },
      { value: "spare",        label: "克制",   description: "克制；不堆砌修辞。" },
      { value: "detached",     label: "疏离",   description: "疏远的叙述视角，重观察轻情绪。" },
      { value: "reverent",     label: "庄重",   description: "肃穆有分量，重视分寸。" },
      { value: "melancholic",  label: "忧郁",   description: "动作之下流淌静默的伤感。" },
      { value: "brutal",       label: "凛冽",   description: "不加修饰，后果直白沉重。" },
    ],
  },
  {
    id: "rhythm",
    label: "句式",
    options: [
      { value: "terse",    label: "短句",     description: "短句和短小分句。" },
      { value: "flowing",  label: "长句",     description: "长句和复合从句。" },
      { value: "varied",   label: "长短交错", description: "长短句交错，节奏起伏。" },
      { value: "rhythmic", label: "韵律感",   description: "可闻的节奏，关注音节重量。" },
    ],
  },
  {
    id: "focus",
    label: "侧重",
    options: [
      { value: "action-forward",     label: "重动作",   description: "先动作后反应。" },
      { value: "dialogue-heavy",     label: "重对话",   description: "靠对话推进场景。" },
      { value: "internal-monologue", label: "重独白",   description: "前景化主角的思考。" },
      { value: "reflection-forward", label: "重反思",   description: "事件之间停顿沉思。" },
      { value: "sensory-dense",      label: "感官浓密", description: "每个节拍充满感官细节。" },
      { value: "sensory-spare",      label: "感官克制", description: "感官描写克制；留白由读者补足。" },
      { value: "world-rich",         label: "重世界观", description: "重视设定与世界纹理。" },
      { value: "character-driven",   label: "人物驱动", description: "由人物性格推动情节。" },
      { value: "plot-driven",        label: "情节驱动", description: "由情节推动人物。" },
    ],
  },
  {
    id: "imagery",
    label: "意象",
    options: [
      { value: "visual",      label: "画面感",        description: "以视觉为主。" },
      { value: "auditory",    label: "声响感",        description: "以声音、对白、寂静为主。" },
      { value: "tactile",     label: "触感",          description: "以触感、质地、温度为主。" },
      { value: "olfactory",   label: "气味与味道",    description: "调动嗅觉与味觉。" },
      { value: "spatial",     label: "空间 / 建筑感", description: "强调空间结构与建筑质感。" },
      { value: "synesthetic", label: "通感",          description: "感官通联（声音有颜色等）。" },
    ],
  },
  {
    id: "agency",
    label: "互动取向",
    options: [
      { value: "high-consequence", label: "选择有分量", description: "玩家选择影响重要走向。" },
      { value: "sandbox",          label: "沙盒",       description: "每个节点开放选项，限制少。" },
      { value: "exploration",      label: "探索向",     description: "鼓励四处探索。" },
      { value: "puzzle",           label: "解谜倾向",   description: "需要思考解开的谜结。" },
      { value: "guided",           label: "引导式主线", description: "主线明确，旁枝点缀。" },
      { value: "light-touch",      label: "轻互动",     description: "选择多为装饰，主线稳定。" },
    ],
  },
  {
    id: "avoid",
    label: "避免",
    options: [
      { value: "ai-isms",             label: "AI 腔",         description: "不要「作为 AI」「我可以协助」等聊天机器人腔。" },
      { value: "over-explain",        label: "过度解释",       description: "动作已表明的不再解释。" },
      { value: "info-dump",           label: "信息轰炸",       description: "不长篇灌输设定。" },
      { value: "telling-not-showing", label: "说教不展现",     description: "用场景展现，不靠旁白概述。" },
      { value: "purple-prose",        label: "紫色散文",       description: "不堆砌华丽辞藻。" },
      { value: "cliches",             label: "套路",           description: "避开类型套路与刻板桥段。" },
      { value: "fourth-wall-break",   label: "打破第四面墙",   description: "不直接对读者搭话。" },
      { value: "take-agency",         label: "替玩家做决定",   description: "不替玩家做决定。" },
      { value: "anachronisms",        label: "时代不符",       description: "古代场景里不出现现代物件 / 俚语。" },
      { value: "modern-slang",        label: "古今错乱",       description: "古风作品里避免现代俚语。" },
    ],
  },
]

const QUESTION_DEFS = [
  {
    id: "language",
    label: "Language",
    memoryPrefix: "Default story language",
    prompts: {
      en:
        [
          "1/3 Choose the default story language:",
          "1. English (default)",
          "2. Simplified Chinese",
          "3. Traditional Chinese",
          "4. Other or mixed: type the language/rule directly",
          "Press Enter for 1, or type /skip.",
        ].join("\n"),
      zh:
        [
          "1/3 选择默认故事语言：",
          "1. English",
          "2. 简体中文（默认）",
          "3. 繁體中文",
          "4. 其他/混合：直接输入语言或规则",
          "直接回车选择 2，输入 /skip 跳过初始化。",
        ].join("\n"),
    },
    fallbacks: {
      en: "English",
      zh: "简体中文",
    },
  },
  {
    id: "style_sample",
    label: "Prose Reference",
    memoryPrefix: "Prose reference (writing the user wants to read like)",
    prompts: {
      en:
        "2/3 Optional: paste a short passage you like, or name a book/author/web-novel type whose voice the narrator should echo. Press Enter to skip.",
      zh: "2/3 可选：贴一小段喜欢的文字，或写一个希望叙述者参考的作品名 / 作者 / 网文类型。没有就直接回车。",
    },
    fallbacks: {
      en: "No prose reference provided; rely on the style tags + the user's later feedback to calibrate voice.",
      zh: "未提供参考文本；以风格标签和后续反馈逐步校准叙述者的笔触。",
    },
  },
  {
    id: "style_comparison",
    label: "Style Tags",
    memoryPrefix: "Style preferences",
    kind: "tags",   // GUI renders a TagPicker; `prompt` is the plain-text fallback.
    tagGroups: {
      en: STYLE_TAG_GROUPS_EN,
      zh: STYLE_TAG_GROUPS_ZH,
    },
    prompts: {
      en: "3/3 Style tags (optional). Type a comma-separated list, or press Enter to skip.",
      zh: "3/3 风格 tag（可选）。输入逗号分隔的标签，或直接回车跳过。",
    },
    fallbacks: {
      en:
        "No tags selected; default to concrete action, clear causality, readable pacing, and avoid generic AI prose, over-explanation, and taking decisions away from the player.",
      zh: "未选择标签；默认优先具体动作、清楚因果和可读节奏，避免AI腔、过度解释和替玩家做决定。",
    },
  },
]


export const PREFERENCE_QUESTIONS = preferenceQuestions(DEFAULT_ONBOARDING_LOCALE)

// Every style group leads with a "Default" sentinel meaning "let the model
// decide". It is a no-op tag: it is NEVER stored or serialized (an unselected
// group already writes nothing), and the GUI highlights it whenever no other
// option in the group is chosen. Defined here so the picker stays data-driven
// (label + description arrive already localized) instead of hard-coding a pill
// in each renderer.
function defaultStyleSentinel(locale) {
  return locale === "zh"
    ? { value: "__default__", label: "默认", description: "让模型自己决策", isDefault: true }
    : { value: "__default__", label: "Default", description: "Let the model decide.", isDefault: true }
}
function withDefaultSentinels(groups, locale) {
  return (groups || []).map((g) => ({
    ...g,
    options: [defaultStyleSentinel(locale), ...g.options],
  }))
}

export function preferenceQuestions(locale = DEFAULT_ONBOARDING_LOCALE) {
  const normalized = normalizeLocale(locale)
  return QUESTION_DEFS.map((question) => ({
    id: question.id,
    label: question.label,
    memoryPrefix: question.memoryPrefix,
    kind: question.kind || "text",
    prompt: localizedValue(question.prompts, normalized),
    fallback: localizedValue(question.fallbacks, normalized),
    // Tag groups travel with the question so the GUI can render a
    // multi-select picker without re-importing from this module. Each group is
    // given its leading "Default" sentinel here.
    tagGroups: question.tagGroups
      ? withDefaultSentinels(question.tagGroups[normalized] || question.tagGroups.en, normalized)
      : undefined,
  }))
}

// First-run onboarding collects ONLY the language (plus the inserted API-key
// step). The richer preference questions still exist in QUESTION_DEFS for the
// Settings → Preferences editor, but are intentionally NOT asked during
// onboarding — first run stays a two-step language + API key flow.
export function onboardingQuestions(locale = DEFAULT_ONBOARDING_LOCALE) {
  return preferenceQuestions(locale).filter((question) => question.id === "language")
}

export function resolveOnboardingLocale(env = process.env) {
  const explicit = env.OPENOVEL_ONBOARDING_LOCALE || env.OPENOVEL_LOCALE
  if (explicit && explicit !== "auto") return normalizeLocale(explicit)
  if (explicit === "auto") return normalizeLocale(env.LC_ALL || env.LC_MESSAGES || env.LANG || DEFAULT_ONBOARDING_LOCALE)
  return DEFAULT_ONBOARDING_LOCALE
}

export function onboardingCopy(locale = DEFAULT_ONBOARDING_LOCALE) {
  if (normalizeLocale(locale) === "zh") {
    return {
      intro:
        "两步即可开始：先选择界面语言，再连接你的 LLM（粘贴 API key）。输入 /skip 可立刻进入故事。以后可在 设置 → 偏好 里查看或编辑你的偏好。",
      defaultLabel: "默认",
      skipped: "已跳过初始化",
      saved: "已写入用户偏好",
    }
  }
  return {
    intro:
      "Two quick steps to begin: pick your interface language, then connect your LLM (paste an API key). Type /skip to start the story now. You can inspect or edit your preferences later from Settings → Preferences.",
    defaultLabel: "Default",
    skipped: "Onboarding skipped",
    saved: "Saved user preferences",
  }
}

export function normalizeLanguagePreference(answer, { fallback = "English" } = {}) {
  const raw = compactAnswer(answer)
  if (!raw) return fallback
  const key = raw.toLowerCase()
  if (["1", "en", "eng", "english"].includes(key)) return "English"
  if (["2", "zh", "zh-cn", "cn", "chinese", "simplified chinese", "简体", "简体中文", "中文"].includes(key)) {
    return "Simplified Chinese"
  }
  if (
    ["3", "zh-tw", "zh-hant", "traditional chinese", "繁體", "繁體中文", "繁体", "繁体中文"].includes(key)
  ) {
    return "Traditional Chinese"
  }
  if (["4", "other", "mixed", "custom"].includes(key)) {
    return "Other or mixed language; follow the user's explicit story-level language rule."
  }
  return raw
}

export function localeFromLanguagePreference(answer, fallbackLocale = DEFAULT_ONBOARDING_LOCALE) {
  const value = String(answer || "").toLowerCase()
  if (/中文|简体|繁體|繁体|chinese|zh|mandarin|cantonese/.test(value)) return "zh"
  if (/english|英文|\ben\b/.test(value)) return "en"
  return normalizeLocale(fallbackLocale)
}

// Passthrough kept for API compatibility. All
// onboarding questions are now static (the GUI's TagPicker turns the
// style_comparison question into per-group multi-select pills); the old
// LLM-driven A/B sample materialization has been removed.
export async function materializePreferenceQuestion(question /* , answers, opts */) {
  return question
}

export async function generateStyleComparisonQuestion(
  answers = [],
  { locale = DEFAULT_ONBOARDING_LOCALE } = {},
) {
  const normalized = normalizeLocale(locale)
  const generated = await generateStyleComparison(answers, { locale: normalized }).catch(() => null)
  if (!generated) {
    return fallbackStyleComparisonQuestion({ locale: normalized })
  }

  const question = questionById("style_comparison", normalized)
  return {
    ...question,
    prompt: [
      styleComparisonIntro(normalized),
      `A. ${generated.a}`,
      `B. ${generated.b}`,
    ].join("\n"),
    context: `A: ${generated.a} | B: ${generated.b}`,
    generated: true,
  }
}

export function fallbackStyleComparisonQuestion({ locale = DEFAULT_ONBOARDING_LOCALE } = {}) {
  const normalized = normalizeLocale(locale)
  return {
    ...questionById("style_comparison", normalized),
    prompt: fallbackStyleComparisonPrompt(normalized),
    context: fallbackStyleComparisonContext(normalized),
    generated: false,
  }
}

export async function openovelHomeWasEmpty({ cwd = process.cwd(), env = process.env } = {}) {
  const { home } = workspaceLayout({ cwd, env })
  if (!existsSync(home)) return true
  const entries = await readdir(home).catch((error) => {
    if (error?.code === "ENOENT") return []
    throw error
  })
  return entries.length === 0
}

export async function shouldRunPreferenceOnboarding({
  cwd = process.cwd(),
  env = process.env,
  homeWasEmpty = false,
} = {}) {
  if (isDisabled(env.OPENOVEL_SKIP_ONBOARDING)) return false
  const layout = workspaceLayout({ cwd, env })
  if (existsSync(onboardingMarkerPath(layout.home))) return false
  if (homeWasEmpty) return true

  const snapshot = await getMemorySnapshot()
  return !hasMemoryEntries(snapshot.user)
}

export async function savePreferenceOnboarding(
  answers,
  { cwd = process.cwd(), env = process.env, skipped = false } = {},
) {
  const layout = workspaceLayout({ cwd, env })
  const entries = skipped ? preferenceAnswersToMemoryEntries(answers, { includeFallbacks: false }) : preferenceAnswersToMemoryEntries(answers)
  for (const entry of entries) {
    await addMemoryEntry("user", entry)
  }
  // Convert the freshly written flat `Style preferences (Group): items`
  // bullets into a nested form so USER.md reads as a proper sub-list.
  // memoryStore's normalizeEntry collapses whitespace inside an entry, so
  // we can't produce nesting via addMemoryEntry — do it as a post-process
  // raw rewrite. The narrator's bullet parser is unaffected (it trims
  // indent and surfaces each child as its own entry alongside the
  // `Style preferences:` parent for context).
  await collapseStyleBulletsIntoNested(layout.userMemory).catch(() => {})
  const languagePreference = onboardingLanguagePreference(answers, { skipped })
  await writeJson(onboardingMarkerPath(layout.home), {
    version: 1,
    completedAt: new Date().toISOString(),
    skipped,
    questionCount: PREFERENCE_QUESTIONS.length,
    languagePreference,
    onboardingLocale: languagePreference ? localeFromLanguagePreference(languagePreference) : "",
    userMemory: layout.userMemory,
  })
  return {
    entries,
    markerPath: onboardingMarkerPath(layout.home),
    userMemory: layout.userMemory,
  }
}

export function preferenceAnswersToMemoryEntries(answers = [], { includeFallbacks = true } = {}) {
  const byId = new Map(answers.map((item) => [item.id, item]))
  return PREFERENCE_QUESTIONS.flatMap((question) => {
    const item = byId.get(question.id)
    const rawAnswer = String(item?.answer || "").trim()
    if (!rawAnswer && !includeFallbacks) return []
    const fallback = item?.fallback || question.fallback
    const answer = answerForMemory(question.id, rawAnswer, fallback)
    const prefix = item?.memoryPrefix || question.memoryPrefix
    if (question.id === "style_comparison") {
      // OnboardingModal joins per-group lines with `\n`. Split here so
      // each group becomes its own USER.md bullet:
      //   - Style preferences (Pacing): Brisk — desc; Cinematic — desc
      //   - Style preferences (Tone):   Ironic — desc
      const groupLines = String(answer || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      if (!groupLines.length) return []
      return groupLines.map((line) => {
        // Each line shape: `GroupLabel: items`. Move the GroupLabel into
        // parentheses on the prefix so the bullet starts with the canonical
        // `Style preferences` marker the renderer rewrites against.
        const colon = line.indexOf(":")
        if (colon < 0) return `${prefix}: ${compactAnswer(line, 360)}`
        const groupLabel = line.slice(0, colon).trim()
        const items = line.slice(colon + 1).trim()
        return `${prefix} (${groupLabel}): ${compactAnswer(items, 360)}`
      })
    }
    return [`${prefix}: ${compactAnswer(answer)}`]
  })
}

export function onboardingMarkerPath(home) {
  return path.join(home, "onboarding.json")
}

// Wipe stored preference state so the next interactive start re-runs the
// 3-question onboarding flow. Returns what was removed for caller reporting.
//
// keepResearch: leaves ~/.openovel/references intact (the background
// preference-research workflow's output). The questions still re-run; only
// the saved answers and the marker are cleared.
export async function resetPreferenceOnboarding({
  cwd = process.cwd(),
  env = process.env,
  keepResearch = false,
} = {}) {
  const layout = workspaceLayout({ cwd, env })
  const removed = { userMemory: false, marker: false, references: false }

  const userClear = await clearMemoryTarget("user").catch(() => null)
  removed.userMemory = Boolean(userClear?.ok)

  const marker = onboardingMarkerPath(layout.home)
  if (existsSync(marker)) {
    await unlink(marker).catch(() => {})
    removed.marker = true
  }

  if (!keepResearch) {
    const refClear = await clearMemoryTarget("references").catch(() => null)
    removed.references = Boolean(refClear?.ok)
  }

  return { removed, layout }
}

// Compact snapshot used by the `/preferences` command to show the user
// what is currently saved, without dumping raw Markdown.
export async function getPreferenceSnapshot({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const layout = workspaceLayout({ cwd, env })
  const marker = onboardingMarkerPath(layout.home)
  const markerExists = existsSync(marker)
  const snapshot = await getMemorySnapshot()
  const userText = String(snapshot.user || "")
  const entries = userText
    .split(/\r?\n/)
    .filter((line) => /^-\s+\S/.test(line))
    .map((line) => line.replace(/^-\s+/, "").trim())
  return {
    markerExists,
    markerPath: marker,
    userMemoryPath: layout.userMemory,
    entries,
  }
}

function hasMemoryEntries(text) {
  return /^-\s+\S/m.test(String(text || ""))
}

// Find any bullets of shape `- Style preferences (Group): items` (flat
// form produced by addMemoryEntry → writeEntries → normalizeEntry, which
// collapses whitespace and so cannot create nesting) and rewrite them
// as a single nested block:
//
//   - Style preferences:
//     - Group: items
//     - Group2: items
//
// Splices in-place at the first matched bullet; preserves all other
// content (including unrelated bullets and free-form notes the user may
// have added). No-op if no matching bullets exist.
async function collapseStyleBulletsIntoNested(filePath) {
  const text = await readText(filePath, "")
  if (!text) return
  const lines = text.split(/\r?\n/)
  const pattern = /^[\t ]*-\s+Style preferences\s*\(([^)]+)\)\s*:\s*(.*)$/
  const children = []
  const kept = []
  let anchor = -1
  for (const line of lines) {
    const match = line.match(pattern)
    if (match) {
      if (anchor === -1) anchor = kept.length
      const groupLabel = match[1].trim()
      const items = match[2].trim()
      children.push(`  - ${groupLabel}: ${items}`)
      continue
    }
    kept.push(line)
  }
  if (!children.length) return
  const nestedBlock = ["- Style preferences:", ...children]
  if (anchor === -1) anchor = kept.length
  kept.splice(anchor, 0, ...nestedBlock)
  await writeText(filePath, kept.join("\n"))
}

async function generateStyleComparison(answers, { locale = DEFAULT_ONBOARDING_LOCALE } = {}) {
  const profile = resolveModelProfile("summary")
  if (!hasModelKey({
    role: profile.role,
    modelProfile: profile.id,
    providerId: profile.providerPinned ? profile.provider?.id : "",
  })) return null

  const byId = new Map(answers.map((item) => [item.id, String(item.answer || "").trim()]))
  const normalized = normalizeLocale(locale)
  const content = await chatCompletion({
    role: profile.role,
    model: profile.model,
    modelProfile: profile.id,
    temperature: 0.9,
    maxTokens: 300,
    timeoutMs: STYLE_COMPARISON_TIMEOUT_MS,
    json: true,
    messages: [
      {
        role: "system",
        content: [
          "You generate a first-run style calibration question for an interactive fiction system.",
          `Create two short prose variants in ${generatedSampleLanguage(normalized, byId.get("language"))} for the same concrete scene.`,
          "The two variants must be meaningfully different in sentence rhythm, imagery density, exposition level, and narrative distance.",
          "Do not imitate any living author's exact style. Do not use copyrighted text.",
          "Keep each variant concise: roughly one short paragraph or 35-90 CJK characters when writing Chinese.",
          'Return strict JSON only: { "a": string, "b": string }.',
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            languagePreference: byId.get("language") || "",
            proseReference: byId.get("style_sample") || "",
            onboardingLocale: normalized,
            scene:
              "A commander studies a rainy battlefield map at night, receives an enemy movement report, and notices a practical tactical opportunity.",
            goal:
              "The user should be able to choose which version feels closer to their desired reading experience and explain why.",
          },
          null,
          2,
        ),
      },
    ],
  })
  const parsed = parseJsonObject(content, {})
  const a = cleanSample(parsed.a)
  const b = cleanSample(parsed.b)
  if (!a || !b || a === b) return null
  return { a, b }
}

function fallbackStyleComparisonPrompt(locale = DEFAULT_ONBOARDING_LOCALE) {
  if (normalizeLocale(locale) === "zh") {
    return [
      "3/3 如果动态 A/B 样本还没准备好：请用一句话描述你更想看的阅读体验，也可以写最出戏的点。",
      "例如：更具体 / 更抒情 / 少解释 / 少替玩家做决定 / 更重史实或技术细节。直接回车用默认。",
    ].join("\n")
  }
  return [
    "3/3 If the dynamic A/B samples are not ready yet, describe the reading experience you want in one sentence, or name what usually feels off.",
    "For example: more concrete, more lyrical, less explanation, fewer player decisions taken over, stronger historical or technical grounding. Press Enter for default.",
  ].join("\n")
}

function fallbackStyleComparisonContext(locale = DEFAULT_ONBOARDING_LOCALE) {
  return normalizeLocale(locale) === "zh"
    ? "No generated A/B samples were available; the user answered a free-form style calibration prompt."
    : "No generated A/B samples were available; the user answered a free-form style calibration prompt."
}

function styleComparisonIntro(locale = DEFAULT_ONBOARDING_LOCALE) {
  if (normalizeLocale(locale) === "zh") {
    return "3/3 看同一场景的两种写法，选更接近你想看的 A 或 B；也可补一句最出戏点或互动偏好。直接回车用默认。"
  }
  return "3/3 Pick the version closer to what you want to read: A or B. You can also add one note about what feels off or how choices should work. Press Enter for default."
}

function questionById(id, locale = DEFAULT_ONBOARDING_LOCALE) {
  return preferenceQuestions(locale).find((question) => question.id === id)
}

function generatedSampleLanguage(locale, languageAnswer) {
  const answer = String(languageAnswer || "").toLowerCase()
  if (/中文|简体|繁體|繁体|chinese|zh/.test(answer)) return "Chinese"
  if (/english|英文|en\b/.test(answer)) return "English"
  return normalizeLocale(locale) === "zh" ? "Chinese" : "English"
}

function localizedValue(values, locale) {
  return values[normalizeLocale(locale)] || values.en
}

function answerForMemory(questionId, rawAnswer, fallback) {
  if (questionId === "language") return normalizeLanguagePreference(rawAnswer, { fallback })
  return rawAnswer || fallback
}

function onboardingLanguagePreference(answers, { skipped = false } = {}) {
  if (skipped) return ""
  const item = answers.find((answer) => answer.id === "language")
  return normalizeLanguagePreference(item?.answer, { fallback: item?.fallback || questionById("language")?.fallback || "English" })
}

function normalizeLocale(locale) {
  return String(locale || DEFAULT_ONBOARDING_LOCALE).toLowerCase().startsWith("zh") ? "zh" : "en"
}

function cleanSample(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[AB][.、:\s]+/i, "")
    .trim()
    .slice(0, 180)
}

function compactAnswer(value, maxChars = 420) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
}

function isDisabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase())
}
