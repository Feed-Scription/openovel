# openovel

<p align="center">
  <img src="./assets/hero.webp" alt="openovel - 交互小说的双速运行时" width="100%" />
</p>

<p align="center">
  <img src="./assets/screenshot.png" alt="openovel Electron 应用运行互动小说场景的截图" width="100%" />
</p>

openovel 是一个开源、本地优先的 AI 交互式小说应用：读者实时游玩，后台 Agent 同时把连续性、记忆和世界状态写进普通文件里——一个文件原生、可自托管的云端 AI 小说工具替代方案。

它的核心是**双循环**设计。快速的前台叙述器立即回应读者；异步的**后台大脑**维护持久故事知识。默认情况下这个大脑是一支由专职 Agent 组成的**常驻团队**——一个 Showrunner 协调者，加上 World Keeper、Director、Card Manager、Memory 等子 Agent（以及按功能开关启用的渲染 / 图像 / 音乐 Agent）——并以单个 **Storykeeper** Agent 作为回退（`OPENOVEL_RESIDENT_TEAM=0`）。两个循环通过 Markdown / JSON / JSONL 文件通信，没有向量库，没有 RAG 层，也没有图数据库。

状态：**Demo 阶段**。应用已经可以端到端使用，但 API 和磁盘布局仍可能随迭代调整。它还不是一个稳定的下游依赖版本。

**平台支持：** 目前主要在 **macOS** 上开发和测试。Windows / Linux 构建虽然能产出，但测试覆盖很少，现阶段可能存在各种问题——欢迎反馈平台相关的 bug。

> English version: [`README.md`](./README.md)

## 为什么是 openovel

多数编码 Agent 运行时都是单循环系统：用户提问、Agent 推理、调工具、最终返回。这个形态适合代码任务。它撑不起长篇交互式小说——读者期待几秒内有回应，而世界模型需要在几小时游玩中持续演化。

openovel 把这两件事拆开：

- **前台叙述器**：快、不带工具、上下文有边界。它读取 `story/guidance/FOREGROUND.md`、选中的 context cards、最近 canon、用户偏好等小工作集，然后生成一段正文。
- **后台大脑**：更慢、带工具、异步执行。它收到读者动作和前台输出后，按自己的节奏更新 guidance、context cards、记忆、状态文件和 inbox 待办。默认是一支协同的**常驻团队**（一个负责组装叙述器工作集的 Showrunner，加上专职的 World Keeper / Director / Card Manager / Memory 子 Agent）；单个 **Storykeeper** 作为回退。
- **文件原生记忆**：持久知识住在普通文件里。角色卡、世界状态、时间线、研究笔记、记忆和场景日志都可以被查看、手改、diff 和测试，不依赖不透明的检索层。

## 前置条件

- Node.js >= 20
- npm
- 一个受支持的模型 provider key。Electron onboarding 可以帮你填写；CLI 和 eval 工具则从 settings 或环境变量读取。

## 快速开始

```bash
git clone https://github.com/Feed-Scription/openovel.git
cd openovel
npm install
npm run electron
```

`npm run electron` 是推荐的日常入口，首次启动会自动打包 renderer。桌面应用随后会打开 onboarding：选界面 / 故事语言、粘 provider API key、可选地用偏好标签收窄行文风格。之后所有配置都可以通过齿轮图标进入 Settings 修改（API keys、行为开关、偏好、环境路径）。

在输入栏试一条动作：

```text
我在废弃的渡轮码头醒来，环顾四周。
```

叙述器秒级回应。后台大脑继续在后台工作，下一回合能继承更新后的连续性，但当前回合不会被它阻塞。

## 工作原理

<p align="center">
  <img src="./assets/architecture.zh-CN.svg" alt="openovel 快慢双循环架构：前台叙述器、文件原生基座、异步的后台常驻团队" width="100%" />
</p>

运行时把每个回合追加到 `story/canon/scene_log.jsonl`，把后台待办入队到 `story/inbox/INBOX.md`。后台大脑之后把这些事项合并到 `story/frontend/*`、`story/guidance/FOREGROUND.md`、`story/memory/MEMORY.md`、`story/state/*`。

## 功能特性

大多数表层功能都可以在 Settings → Behavior 里切换。可选实验功能也有对应的 `OPENOVEL_ENABLE_*` 环境变量。下面标注的默认值针对全新安装。

**默认开启**

- **建议选项**：叙述结束后的一次独立调用，给出几个读者可直接选择、不必手打的下一步动作（`OPENOVEL_OPTIONS_ENABLED`）。
- **阅读节奏显示**：正文按本地阅读速度逐步显示，与模型流式速度无关（`OPENOVEL_DISPLAY_CPM`，默认 720）。
- **常驻 Agent 团队**：后台大脑以 Showrunner 协调者加专职子 Agent 的形式运行；设 `OPENOVEL_RESIDENT_TEAM=0` 切回单 Storykeeper 路径。
- **重复 / 口癖控制**：运行时统计叙述器最常重复的短语并回灌，让后台团队收紧 guidance、消除口头禅。
- **小说导出**：从故事菜单把完成的故事导出为 EPUB 或 TXT。

**可选 / 实验性**（默认关闭）

- **富渲染**：叙述器输出 `ovl:<kind>` 块，依据每个故事的 HTML/CSS 契约渲染成带样式的卡片、属性面板和常驻 HUD（`OPENOVEL_ENABLE_FORMAT_CONTRACT`）。
- **媒体内嵌**：通过 `ovl:include` 指令嵌入故事 `includes/` 文件夹里的图片、视频、音频或文本（`OPENOVEL_ENABLE_STORY_INCLUDES`）。
- **场景背景**：叙述背后铺一张压暗的整页背景图（`OPENOVEL_ENABLE_IMAGE_BACKGROUND`）。
- **图像生成**：后台图像 Agent 提前为剧情准备场景图和角色参考图（`OPENOVEL_ENABLE_IMAGE_GEN`；需要图像 provider key）。
- **背景音乐**：音乐 Agent 整理氛围曲目，叙述器按 id 触发（`OPENOVEL_ENABLE_MUSIC_GEN`）。
- **叙述配音**：通过配置的 TTS provider 朗读叙述（`OPENOVEL_ENABLE_TTS`）。
- **漫画模式 / 快进模式**：按故事切换的模式，把正文换成连环画式画格，或换成压缩时间的短促爆发。
- **初始化声音预览**：在故事初始化阶段，用草稿试听叙述器的声音（`OPENOVEL_ENABLE_INIT_NARRATOR_PREVIEW`）。

模型撰写的富内容是沙箱化的：块模板是经过封闭标签 / 属性白名单过滤的 HTML，CSS 经过属性白名单过滤后才进入渲染（绝不用 `innerHTML`），叙述器永远看不到原始 CSS。块的**种类**是开放的——模型用普通 HTML 组合即可——而能力边界是封闭的。

## Provider 与配置

前后台模型调用都走 `src/provider/provider.js`。Provider 是 `src/provider/plugins/` 下的元数据插件：一个 OpenAI 兼容 chat endpoint、价格元数据、流式偏好和能力标记。不捆绑 vendor SDK。

内置 provider：

| Provider | 厂商 | 默认角色 | 计费模式 |
| --- | --- | --- | --- |
| `kimi-code` | Moonshot Kimi | 前台默认 | 订阅 / 免费额度 |
| `mimo-token-plan-{cn,sgp,ams}` | 小米 MiMo | 默认回退链 | Token plan |
| `mimo-api` | 小米 MiMo | 按量付费回退 | 按 token |
| `deepseek` | DeepSeek | 按量付费回退 | 按 token |
| `openrouter` | OpenRouter | 按量付费回退 | 按 token |
| `anthropic` | Anthropic (Claude) | 按量付费回退 | 按 token |

默认路由是 `kimi-code → mimo-token-plan-{sgp,cn,ams}`——全是免费或 token-plan 档。按量付费 provider 只有在 `AI_ALLOW_PAID_FALLBACK=true` 时才会加入回退链。你也可以在 Settings → API Keys → 高级里定义自己的 OpenAI 兼容或 Anthropic 格式 endpoint，作为 `custom:<name>` provider，并按 model profile 指派。

大多数用户直接在 Electron Settings UI 里配置 key 即可。UI 会把 secrets 和开关保存到 `$OPENOVEL_HOME/settings.local.json`（默认 `~/.openovel/settings.local.json`），并在启动时镜像进应用环境。通用 JSONC 配置文件按以下顺序层叠，后者覆盖前者：

```text
defaults
  -> ~/.openovel/settings.jsonc
    -> .openovel/settings.jsonc
      -> .openovel/settings.local.json
        -> 环境变量
```

支持 JSONC、尾随逗号、`{env:VAR}` 和 `{file:path}` 插值。

常用诊断命令：

```bash
npm run config:doctor       # 显示 settings 层叠 + 当前生效配置
npm run provider:doctor     # 显示每个 profile 的 provider + model 解析过程
```

## 项目结构

```text
src/
  runtime/       共享引擎：session、job、event、tool、permission
  workflows/     agent pack：Storykeeper/Showrunner、常驻 Agent、initializer、memory review、onboarding
  lib/           故事文件、叙事、snapshot、路径、重试工具
  context/       前台 prompt 编译和 context-card 插入
  provider/      provider 注册、模型 profile、OpenAI 兼容适配
  electron/      桌面应用：main 进程、preload、renderer、IPC 桥
  tools/         工具注册
  agents/        常驻 Agent 卡（*.agent.yaml）+ 子 Agent 定义
  memory/        记忆存储和注册
  search/        web search provider 注册
  eval/          smoke、probe、judge、model-player 评测脚手架
  config/        settings 解析和 doctor
test/            node --test 测试
scripts/         构建和启动辅助脚本
story/           本地故事工作区，通常是 gitignored 运行时数据
```

主运行链路：

```text
UI -> SessionViewModel -> SessionProcessor
   -> Foreground Narrator -> Provider
   -> BackgroundJob -> BackgroundAgentRuntime -> ToolLoop -> ToolRegistry
   -> StoryStore / files
```

## 存储模型

openovel 使用两个根目录：

```text
~/.openovel/                 用户全局数据
  memory/USER.md             用户自己设的偏好（模型只读）
  memory/OBSERVED.md         模型观察到的读者笔记（memory-review 写入）
  context-cards/             可复用 cards
  references/                共享参考资料
  stories/<story-id>/        可选的单故事工作区

story/                       项目本地工作故事
  BRIEF.md                   原始 brief——init 时写一次，之后只读
  canon/                     chapters 和 append-only scene log
  frontend/                  组装进前台的叙述器可见分节
  guidance/                  FOREGROUND.md（自动组装的只读视图）、FG_template.md（manifest）、cards.md、cards.auto.md
  director/ worldkeeper/     内部 Agent 草稿区（分析、规划、模拟）
  state/                     stats、characters 等结构化世界状态
  context-cards/             故事级 cards
  inbox/                     后台待办和已解决归档
  memory/                    故事级记忆
  format/ includes/          可选的富渲染契约 + 可内嵌媒体
  research/ packets/         搜索日志 + 每回合诊断包
```

`frontend/`、`guidance/` 和 context cards 是叙述器可见的——里面的每个字都可能抵达读者。`director/`、`worldkeeper/`、`state/` 和每回合的 `packets/` 是叙述器永远看不到的内部草稿区；后台 Agent 用它们做分析、规划和世界模拟。

USER.md 和 OBSERVED.md 按"谁能写"切分全局记忆：USER.md 归用户（onboarding + Settings UI 写入），OBSERVED.md 归模型（后台 memory-review 写入）。文件级工具会强制 USER.md 对模型只读，无论是哪个 workflow 在跑。

`OPENOVEL_HOME` 默认是 `~/.openovel`。`OPENOVEL_STORY_ID` 和 `OPENOVEL_STORY_ROOT` 控制故事工作区解析。旧的 `AI_STORY_*` 变量仍然为了兼容而识别。

## 命令速查

```bash
# 交互
npm run electron              # 默认入口——桌面客户端（启动时自动打包 renderer）
npm run electron:dev          # 带 devtools 的桌面客户端

# 构建
npm run build:electron        # 把 renderer 打包到 dist-electron/（`npm run electron` 会自动跑）
npm run dist                  # electron-builder 打包；可加 :mac / :win / :linux 限定平台

# 测试
npm test                                                           # 全套
node --test test/sessionViewModel.test.js                          # 单文件
node --test --test-name-pattern "<regex>" test/foo.test.js         # 按 case 名筛

# 诊断
npm run config:doctor                                              # settings + env 层叠
npm run provider:doctor                                            # provider + key + model 解析

# 评测
npm run eval:smoke -- --action "..." --expect "..." --wait-background
npm run eval:model-player                                          # DeepSeek 驱动的模拟读者
npm run eval:judge                                                 # LLM judge 跑生成的故事
npm run eval:ablation                                              # 每个子进程切换 OPENOVEL_ABLATION_DISABLE_*
npm run eval:tms:prepare && npm run eval:tms                       # Tell-Me-A-Story benchmark adapter
```

## 测试

`node --test` 会运行 `test/*.test.js`。测试套件是 hermetic 的：不访问网络、不真调模型、不写临时目录以外的磁盘。新功能应该通过 `src/provider/provider.js` mock provider，并断言持久化文件 patch 或 `SessionViewModel` 状态，而不是断言生成的 prose。

## 故障排查

- Provider 路由看起来不对：`npm run provider:doctor`。
- Settings 没生效：`npm run config:doctor`，检查层叠顺序。
- 拉了新代码后 renderer 还是旧的：`rm -rf dist-electron && npm run electron`。
- 想要全新的本地故事工作区：`story/` 是项目本地运行时数据，通常已经 gitignore。

## 常见问题（FAQ）

**openovel 是什么？**
openovel 是一个开源、本地优先的 AI 交互式小说运行时。快速的前台叙述器在数秒内回应读者，异步的后台 Agent 团队则把连续性、记忆和世界状态维护在纯 Markdown / JSON 文件里。

**它和 AI Dungeon、SillyTavern 有什么不同？**
openovel 完全在本地运行，所有内容都存为普通文件——没有向量库、没有 RAG、不绑定云端。它的双循环设计把「快速、无工具的叙述器」和「较慢、带工具的后台团队」分开，让世界在长时间游玩中保持一致。

**我的数据私密吗？存在哪里？**
你的故事、记忆和设置都留在本机的 `story/` 和 `~/.openovel/` 下。openovel 只会访问你配置的模型 provider，其它任何数据都不会离开你的电脑。

**它支持哪些 AI 模型？**
任何 OpenAI 兼容或 Anthropic 格式的端点。内置 provider 包括 Moonshot Kimi、小米 MiMo、DeepSeek、OpenRouter 和 Anthropic，还可自定义 provider。

**它能在哪些平台运行？**
一个跨平台 Electron 桌面应用，支持 macOS、Windows、Linux。目前主要在 macOS 上测试。

**openovel 免费、开源吗？**
是的——以 Apache-2.0 许可证发布。

## 致谢

双循环交互模型受 Thinking Machines 关于 interaction models 的写作启发，runtime 形态借鉴 Claude Code、opencode 和 Hermes Agent。文件原生 context 是对 AI 小说社区常见向量-RAG 路线的有意背离，来自 SillyTavern 和本项目前作 `fate-river` 的长程实验经验。

## 许可证

Apache License, Version 2.0。完整文本见 [`LICENSE`](./LICENSE)。
