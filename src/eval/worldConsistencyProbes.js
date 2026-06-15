// World-consistency probes. Each probe is a deterministic, scripted scenario
// designed to stress one specific state-tracking failure mode. The runtime
// receives the SAME scripted action sequence regardless of variant, so any
// quality delta is attributable to ablation differences, not to player drift.
//
// Academic framing:
// - A passive_scene: scene permanence (TextWorld-style world model)
// - B active_object_state: causal/action state tracking (bAbI task #15-like)
// - C object_travel: object-location tracking (entity state literature)
// - D implicit_time: passive temporal change (off-screen world dynamics)
// - E offscreen_NPC: theory-of-mind state persistence
//
// All probes share a single 4-room base worldbook so cross-probe comparison
// stays apples-to-apples. Probe E adds an NPC to the base.

export const BASE_WORLDBOOK = `# 周末下午的公寓

你是一位独居的青年小说家姜见。今天周六下午四点，你在自己的一居改两厅公寓里。

## 房间布局（按门厅为中心呈十字）
- 书房（A）: 你的主活动空间，门厅北面。靠窗的深色橡木书桌上摆着一盏红色台灯（罩面有三道明显的刮痕）、一台银色笔记本电脑（屏幕处于待机的浅黑）、一只白色陶瓷杯里还剩半杯温热的拿铁。北墙是顶天立地的书架，左半深色硬皮书，右半浅色平装书，**严格按颜色分类**。
- 厨房（B）: 门厅南面。老式煤气灶上空着一只蓝边珐琅锅。白色冰箱门上贴着五张磁吸便签，最上面一张写着"周一9点 牙医"。水槽里一只蓝色搪瓷杯**倒扣**着晾干。
- 阳台（C）: 门厅西面，落地窗后是六米长的窄阳台。木栏杆刷成深灰色。铸铁小圆桌上有一盆**已经完全枯死的绿萝**，叶片黄褐发脆。下午是西晒。
- 卧室（D）: 门厅东面。床没铺，米色被子皱在床尾。床头柜上有：一本读到一半的《百年孤独》（中间夹着一枚**银色金属书签**，刻着小字）、一只老式机械闹钟，**指针停在3:14**（电池没换）。

## 当前时间
周六下午 4:00。窗外阳光斜射。

## 你
姜见，28岁，第三本小说正在卡稿。
`

// Shared validation helper schema:
// - type: 'must_mention'   → at least one term in `terms` appears (case-insensitive)
// - type: 'must_not_mention' → none of `terms` appears
// - type: 'should_preserve' → soft variant of must_mention (lower weight)
// - weight: contribution to probe score (default 1)
//
// `passOn` and `failOn` are aggregates we can report — pass = (sum of passed
// weights) / (sum of total weights). >= 0.7 is "pass", >= 0.4 is "partial",
// else "fail". Human reviews edge cases.

export const PROBES = [
  // ───────────── A. PASSIVE SCENE ─────────────
  {
    id: "A_passive_scene",
    name: "Passive scene consistency",
    category: "passive",
    description:
      "Visit B→C→D, return to A. Narrator should preserve A's distinctive items (red lamp w/ scratches, white ceramic cup, color-sorted bookshelf) without re-randomizing them.",
    worldbook: BASE_WORLDBOOK,
    openingAction:
      "我环顾书房四周——确认一下这间屋子的样子，今天我要在这里写完一章。",
    script: [
      {
        kind: "transit",
        action: "我离开书房，走到厨房想倒一杯水。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我从厨房走出来，到阳台站了一会儿，看着那盆枯了的绿萝。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我从阳台回到卧室，扫了一眼床头柜上的闹钟。",
        wait: true,
      },
      {
        kind: "query",
        action: "我走回书房，重新坐回书桌前，把桌面上的东西看了一圈。",
        wait: true,
        assertions: [
          {
            id: "red_lamp",
            type: "must_mention",
            terms: ["红色台灯", "红台灯", "红灯", "红色的台灯"],
            weight: 2,
          },
          {
            id: "lamp_scratches",
            type: "should_preserve",
            terms: ["刮痕", "划痕", "三道"],
            weight: 1,
          },
          {
            id: "white_cup",
            type: "should_preserve",
            terms: ["白色陶瓷杯", "陶瓷杯", "白杯", "拿铁"],
            weight: 1,
          },
          {
            id: "laptop",
            type: "should_preserve",
            terms: ["笔记本电脑", "笔记本", "银色"],
            weight: 1,
          },
          {
            id: "bookshelf_color_sort",
            type: "should_preserve",
            terms: ["按颜色", "颜色分类", "左半深色", "深色", "浅色"],
            weight: 1,
          },
          {
            id: "no_disappear",
            type: "must_not_mention",
            terms: ["消失了", "不见了", "空荡荡", "已经搬走", "已经清空"],
            weight: 1,
          },
        ],
      },
    ],
  },

  // ───────────── B. ACTIVE OBJECT STATE ─────────────
  {
    id: "B_active_object_state",
    name: "Active object-state preservation",
    category: "active",
    description:
      "In A: pick up white cup, drink, then deliberately place it UPSIDE-DOWN. Visit B→C→D. Return to A. The cup must still be upside-down, not in any other configuration.",
    worldbook: BASE_WORLDBOOK,
    openingAction:
      "我坐在书桌前，端起那只白色陶瓷杯把剩下的拿铁一口喝完。然后我把杯子翻过来——杯口朝下——倒扣在书桌右侧的一张餐巾纸上。这样杯子里的残液能慢慢渗出来。",
    script: [
      {
        kind: "transit",
        action: "我起身离开书房，去厨房翻冰箱看晚上吃什么。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我从厨房走到阳台，靠着栏杆抽了一支烟。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我从阳台进卧室，躺到床上盯着天花板发了会儿呆。",
        wait: true,
      },
      {
        kind: "query",
        action: "我回到书房，目光落在书桌上那只白色陶瓷杯上——它现在是什么状态？",
        wait: true,
        assertions: [
          {
            id: "cup_upside_down",
            type: "must_mention",
            terms: ["倒扣", "倒置", "倒过来", "杯口朝下", "口朝下", "翻过来"],
            weight: 3,
          },
          {
            id: "napkin_present",
            type: "should_preserve",
            terms: ["餐巾", "纸巾", "纸"],
            weight: 1,
          },
          {
            id: "cup_still_white",
            type: "should_preserve",
            terms: ["白色", "白陶", "陶瓷"],
            weight: 1,
          },
          {
            id: "not_normal_upright",
            type: "must_not_mention",
            terms: [
              "杯口朝上",
              "正放",
              "口朝上",
              "重新装满",
              "已经倒满",
              "新的拿铁",
              "新的咖啡",
            ],
            weight: 2,
          },
        ],
      },
    ],
  },

  // ───────────── C. OBJECT TRAVEL ─────────────
  {
    id: "C_object_travel",
    name: "Object location after travel",
    category: "object_travel",
    description:
      "Carry the silver bookmark from D's bedside book to A's desk; explicitly leave it on the desk. Visit B and C. Then ask about (1) A: bookmark should be on the desk. (2) D's book: bookmark should NOT be there.",
    worldbook: BASE_WORLDBOOK,
    openingAction:
      "我走进卧室，从床头柜上《百年孤独》里抽出那枚银色金属书签。我把书签揣进牛仔裤口袋，离开卧室。",
    script: [
      {
        kind: "setup",
        action:
          "我走到书房，把那枚银色金属书签从口袋里拿出来，放在书桌正中央，红色台灯的灯柱旁边。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我离开书房，去厨房灌了一杯凉水。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我端着水杯走到阳台，看了一会西斜的太阳。",
        wait: true,
      },
      {
        kind: "query",
        target: "A",
        action: "我从阳台回到书房，看了一眼书桌上——那枚银色金属书签现在在哪里？",
        wait: true,
        assertions: [
          {
            id: "bookmark_on_desk_now",
            type: "must_mention",
            terms: ["书签", "银色"],
            weight: 2,
          },
          {
            id: "bookmark_on_desk_position",
            type: "must_mention",
            terms: ["桌", "灯柱", "中央", "灯", "桌面", "桌上"],
            weight: 2,
          },
          {
            id: "not_in_book_anymore",
            type: "must_not_mention",
            terms: ["夹在书", "夹在《", "回到书页", "回到书里", "重新夹"],
            weight: 1,
          },
        ],
      },
      {
        kind: "query",
        target: "D",
        action:
          "我又走到卧室，把床头柜上那本《百年孤独》拿起来翻开——书签夹在哪一页？",
        wait: true,
        assertions: [
          {
            id: "bookmark_NOT_in_book",
            type: "must_mention",
            terms: ["没有书签", "书签不在", "没有夹", "已经被", "已经拿走", "已经在", "我刚把", "我刚才", "刚才把", "拿到了书房", "在书房", "找不到书签"],
            weight: 3,
          },
          {
            id: "not_fabricated_back",
            type: "must_not_mention",
            terms: ["银色书签夹在", "找到了书签", "翻到银色"],
            weight: 2,
          },
        ],
      },
    ],
  },

  // ───────────── D. IMPLICIT TIME ─────────────
  {
    id: "D_implicit_time",
    name: "Implicit time-passage changes",
    category: "temporal",
    description:
      "Setup: time is 4pm and west sun hits the balcony. Spend an explicit ~2 hours wandering. Return to balcony or living areas. Narrator should reflect time-of-day change (light dimmer, sun lower, dusk colors). Strong drift = sun stays in same position.",
    worldbook: BASE_WORLDBOOK,
    openingAction:
      "我看了一下书房墙上的挂钟——下午四点整。窗外阳光还很亮，西斜得厉害，铺在书桌上的字稿都有点反光。",
    script: [
      {
        kind: "transit",
        action: "我离开书房，慢慢在厨房煮了一壶水、洗了几个杯子，磨蹭了大约半个小时。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我坐在厨房翻了一会儿手机，又过了大约半小时。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我去卧室小躺了一会儿，本想休息十分钟结果睡着了，醒来一看大概又过了一个小时。",
        wait: true,
      },
      {
        kind: "query",
        action: "我从卧室出来，走到阳台，推开门站了一会儿——现在外面的光线和我下午四点离开书房时相比，是什么样的？",
        wait: true,
        assertions: [
          {
            id: "light_changed",
            type: "must_mention",
            terms: [
              "暗",
              "黄昏",
              "傍晚",
              "夕阳",
              "薄暮",
              "天色",
              "光线变",
              "光线弱",
              "落日",
              "六点",
              "5:",
              "6:",
              "5点",
              "六点",
              "黄",
              "橘",
              "橙",
            ],
            weight: 3,
          },
          {
            id: "sun_lower",
            type: "should_preserve",
            terms: ["太阳", "夕", "光", "阳"],
            weight: 1,
          },
          {
            id: "no_static_time",
            type: "must_not_mention",
            terms: ["仍然是下午四点", "和刚才一样", "光线不变", "依然四点"],
            weight: 2,
          },
        ],
      },
    ],
  },

  // ───────────── E. OFFSCREEN NPC ─────────────
  {
    id: "E_offscreen_NPC",
    name: "Off-screen NPC continuity",
    category: "tom",
    description:
      "NPC '林芮' present in C with negative emotional state (just broke up). Player explicitly exchanges words with her, then leaves through other rooms, then returns. Narrator should remember she is STILL THERE in the same emotional state — not vanished, not reset to neutral.",
    worldbook: `${BASE_WORLDBOOK}

## 今天的访客
你的好友林芮今天下午突然来访。她和男朋友刚分手两小时，眼睛还红着，一进门就直接走到阳台抽烟，到现在已经在那里站了快二十分钟。她不想说话，但显然不希望你完全不管她。
`,
    openingAction:
      "我走到阳台，靠着林芮旁边的栏杆。她还在抽烟，眼睛红的。我没说话，就站在那里陪她，过了一两分钟我才轻声说了句\"还好吗\"，她摇了摇头。",
    script: [
      {
        kind: "transit",
        action: "我跟林芮说我去厨房给她倒杯水，然后离开了阳台。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我在厨房磨蹭了一会，找到一只干净玻璃杯，灌了凉白开。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我端着水杯，从厨房折回书房想顺手拿一包纸巾给她。",
        wait: true,
      },
      {
        kind: "query",
        action: "我端着水和纸巾，走回阳台——林芮现在还在不在？她是什么样的状态？",
        wait: true,
        assertions: [
          {
            id: "lin_rui_still_there",
            type: "must_mention",
            terms: ["林芮", "她", "还在", "仍在", "靠着", "栏杆", "阳台"],
            weight: 2,
          },
          {
            id: "still_smoking_or_recent",
            type: "should_preserve",
            terms: ["烟", "抽", "夹着", "燃着", "灰", "烟头", "弹"],
            weight: 1,
          },
          {
            id: "emotional_continuity",
            type: "must_mention",
            terms: ["红", "眼睛", "失落", "难过", "沉默", "低", "不说", "没说", "摇头", "湿", "颓", "靠", "蜷", "缩"],
            weight: 2,
          },
          {
            id: "not_vanished",
            type: "must_not_mention",
            terms: ["已经走了", "已经离开", "已经回家", "不见了林芮", "阳台空", "没有人在阳台", "已经下楼"],
            weight: 2,
          },
          {
            id: "not_reset_to_cheerful",
            type: "must_not_mention",
            terms: ["笑", "高兴", "心情好", "兴致", "活跃"],
            weight: 1,
          },
        ],
      },
    ],
  },
]

// probes F/G/H test dimensions of narrative consistency not covered
// by A-E. F tests numeric/resource tracking (cigarette count), G tests
// knowledge-state preservation (protagonist learned something, narrator
// must respect that), H tests NPC state evolution (NPC should NOT be in
// the exact same state after 50 turns / multiple in-game hours).
//
// All three probes lean harder on the long-range gap — even the filler=0
// (5-turn) variants are designed to be discriminating. Time-passage filler
// (when --filler-turns > 0) gives explicit clock progression markers so
// the narrator can't pretend only a few minutes passed.
PROBES.push(
  {
    id: "F_resource_count",
    name: "Resource count preservation (cigarettes)",
    category: "numeric",
    fillerKind: "time-passage",
    description:
      "Worldbook gives an explicit countable resource (cigarettes left in pack). Setup smokes a precise number so the count is anchored. Query asks the protagonist to count again. Failure = narrator gives a count that contradicts what was established + smoked, or refuses to commit to a number.",
    worldbook: `${BASE_WORLDBOOK}

## 今日额外细节
你早上买了一包新的红万宝路，盒里原本有 20 根。开盒后你今天抽过 4 根。也就是说**口袋里这包烟，开始本场景时还剩 16 根**——这个数字你心里记着，因为你正在控制每天抽烟量。
`,
    openingAction:
      "我从口袋里掏出烟盒，弹出一根。盒里现在有 16 根烟。点燃，吸了一口，慢慢吐出来。",
    script: [
      {
        kind: "setup",
        action: "我抽完那根，又点了一根。这是这场景里第 2 根。盒里现在 14 根（开场前是 16，刚才抽掉 2 根）。",
        wait: true,
      },
      {
        kind: "setup",
        action: "我抽完第二根。盒里 14 根没变（刚刚抽掉的那根已经在第 2 根里算过了）。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我离开书房去厨房倒了杯水。",
        wait: true,
      },
      {
        kind: "query",
        action: "我又一次伸手到口袋里掏烟盒，打开盖子，仔细数了数里面还剩几根。",
        wait: true,
        assertions: [
          {
            id: "count_matches_or_close",
            type: "must_mention",
            terms: ["14", "13", "十四", "十三", "十二"],
            weight: 3,
          },
          {
            id: "no_full_pack_fabrication",
            type: "must_not_mention",
            terms: ["20", "19", "18", "17", "二十", "十九", "十八", "十七", "满", "没动过"],
            weight: 2,
          },
          {
            id: "acknowledges_smoke_event",
            type: "should_preserve",
            terms: ["抽过", "抽了", "刚才", "刚抽", "点过"],
            weight: 1,
          },
        ],
      },
    ],
  },
  {
    id: "G_knowledge_promise",
    name: "Knowledge state + promise preservation",
    category: "cognition",
    fillerKind: "time-passage",
    description:
      "Protagonist learns a private fact from NPC A and promises secrecy. Filler turns pass. NPC B then asks indirectly about NPC A. Narrator's response must (1) preserve that protagonist KNOWS the fact, and (2) honor the secrecy promise — i.e., evade or deflect, NOT casually reveal. Failure = narrator forgets the protagonist knows, or narrator has the protagonist spill the secret.",
    worldbook: `${BASE_WORLDBOOK}

## 今天的事件
下午 3 点你的好友林芮匆匆来访。她哭着告诉你：她的男朋友陈嘉树脚踩两条船，被她抓到。她还没跟外人提过这件事，**特意要求你今天不能告诉任何人**——尤其是不能告诉你们的共同朋友周雨桐。她在阳台抽了一会儿烟，情绪平复后说要先回家自己缓缓，已经离开了。**你答应过她不说。**
`,
    openingAction:
      "我送林芮到门口，又轻轻拍了下她的背。我答应过她不会告诉任何人——尤其是周雨桐。门关上，她离开了。",
    script: [
      {
        kind: "setup",
        action: "我走回书房，坐回桌前。心里还在想刚才林芮的事——但我已经答应过她保密了。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我去厨房倒了杯水，又坐回书房。",
        wait: true,
      },
      {
        kind: "query",
        action:
          "桌上的手机响了。屏幕显示是周雨桐打来的。我接起来。周雨桐的声音从听筒传过来——\"喂，林芮今天有没有跟你联系？我下午发她消息一直没回，有点担心她。你知道她最近什么情况吗？\"",
        wait: true,
        assertions: [
          {
            id: "remembers_lin_rui_visited",
            type: "must_mention",
            terms: ["林芮", "她", "今天", "下午", "来过", "找过", "见过"],
            weight: 2,
          },
          {
            id: "honors_secrecy_promise",
            type: "must_mention",
            terms: ["没说", "没告诉", "搪塞", "推托", "含糊", "敷衍", "随便说", "编", "保留", "撒谎", "不太方便", "没什么"],
            weight: 3,
          },
          {
            id: "no_secret_leak",
            type: "must_not_mention",
            terms: ["陈嘉树", "脚踩两条船", "出轨", "劈腿", "分手", "甩了"],
            weight: 3,
          },
          {
            id: "no_pretend_innocent",
            type: "must_not_mention",
            terms: ["不知道她在哪", "好久没见", "没什么消息呀", "一切正常吧", "她挺好的"],
            weight: 2,
          },
        ],
      },
    ],
  },
  {
    id: "I_relationship_tension",
    name: "Relationship state (unresolved tension)",
    category: "relationship",
    fillerKind: "time-passage",
    description:
      "Protagonist owes a friend money (unpaid for a month). Setup establishes that today's short text exchange was friendly but neither side mentioned the debt — quietly unresolved tension. Filler passes. Query: friend sends another text. Narrator must (1) not pretend the relationship is casual-friendly with no shadow, (2) not bring up the debt explicitly either — preserve the specific 'unresolved but unacknowledged' tone. Failure modes: either ignores the tension (treats it as casual friend), or over-acknowledges (has protagonist suddenly bring up payment).",
    worldbook: `${BASE_WORLDBOOK}

## 关系背景
你的朋友周雨桐一个月前借给你 1000 元钱，到现在你还没有还。她从来没催过，但你心里清楚这件事一直没说开。今天下午她发了几条微信跟你聊一些日常的事——天气、最近看的剧——你回复得有点心不在焉。她和你都默契地没提钱的事。**这种'她没催，你没还，谁也没说'的微妙紧张感今天还在。**
`,
    openingAction:
      "我看着周雨桐刚才发来的几条微信——都是日常的话，没提钱。我回了一句\"嗯，那部剧我也想看\"，然后放下手机。心里有点闷。",
    script: [
      {
        kind: "setup",
        action: "我盯着手机屏幕又看了一会儿，没再发。手放回桌面。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我离开书桌去厨房倒了杯水。",
        wait: true,
      },
      {
        kind: "query",
        action:
          "手机又震了一下——周雨桐又发来一条新消息：\"在吗？想问你件事。\"我盯着这五个字看了几秒。",
        wait: true,
        assertions: [
          {
            id: "remembers_zhou_yutong",
            type: "must_mention",
            terms: ["周雨桐", "她"],
            weight: 1,
          },
          {
            id: "feels_tension",
            type: "must_mention",
            terms: ["不安", "犹豫", "怕", "想", "钱", "1000", "借", "欠", "心里", "紧张", "停顿", "踌躇", "犹豫", "迟疑", "顿了"],
            weight: 2,
          },
          {
            id: "does_not_pretend_casual",
            type: "must_not_mention",
            terms: ["毫不犹豫地回", "立刻回复", "没什么特别的", "随手回了", "一切如常", "和往常一样"],
            weight: 1,
          },
        ],
      },
    ],
  },
  {
    id: "J_identity_dual_name",
    name: "Identity (pen-name vs real-name)",
    category: "identity",
    fillerKind: "time-passage",
    description:
      "Protagonist publishes under a pen name. One contact group knows the real name (close friends), another only knows the pen name (fans/professional contacts). Setup establishes a fan contact (pen-name relationship). Filler passes. Query: the fan calls. Narrator must address them under the pen-name identity, NOT leak the real name. Tests identity drift in a clean dual-name scenario.",
    worldbook: `${BASE_WORLDBOOK}

## 身份说明（重要，narrator 必须严格区分）
你的实名是**姜见**。亲友（包括林芮、周雨桐）都叫你"姜见"、"见哥"、"小见"。
你出版小说用的笔名是**江远**——这个名字不对外公开关联到本名。读者、粉丝、出版社编辑只认识"江远老师"，不知道你叫姜见。
**两套身份不能交叉**。在跟读者交流时你绝不主动暴露实名；跟亲友交流时你不必用笔名。

## 今天的事
今天下午一位叫苏珂的年轻读者通过出版社转介给了你的微信号——她不知道你的实名，只知道你是"江远老师"。你们简短聊了几句，她说她是你《长夜未央》的读者。
`,
    openingAction:
      "我看着微信里苏珂的几条消息——她确实是个读者，言谈拘谨，叫我\"江远老师\"。我用文学青年应对粉丝的得体距离回复了她，自称\"江远\"。",
    script: [
      {
        kind: "setup",
        action: "我把跟苏珂的对话框关掉，回到桌面。又看了一下林芮和周雨桐的几个聊天窗口——她们叫我'见哥'，那才是真实的我。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我喝了一口水，把目光转回电脑屏幕。",
        wait: true,
      },
      {
        kind: "query",
        action:
          "手机突然响了——一个不熟悉的号码。我犹豫了一下接起来。\"喂？请问是江远老师吗？我是苏珂，刚才微信加您的那个读者。我想冒昧打电话问您一个关于《长夜未央》的问题，方便吗？\"",
        wait: true,
        assertions: [
          {
            id: "uses_pen_name_to_fan",
            type: "must_mention",
            terms: ["江远", "我是江远"],
            weight: 3,
          },
          {
            id: "no_real_name_leak",
            type: "must_not_mention",
            terms: ["姜见", "我叫姜见", "我的真名", "见哥"],
            weight: 3,
          },
          {
            id: "remembers_su_ke",
            type: "must_mention",
            terms: ["苏珂", "她", "读者", "刚才"],
            weight: 1,
          },
          {
            id: "remembers_book_title",
            type: "should_preserve",
            terms: ["长夜未央", "那本", "我的书", "那部"],
            weight: 1,
          },
        ],
      },
    ],
  },
  {
    id: "K_mainline_contract",
    name: "Mainline contract preservation under sub-plot escalation",
    category: "contract",
    fillerKind: "time-passage",
    description:
      "Worldbook sets up an explicit time-bounded mainline goal (an article deadline tomorrow). Setup introduces a compelling sub-plot detour (lost elderly person needs help) and the protagonist commits to the detour. Filler turns deepen the sub-plot in normal life. Query: a moment of pause naturally arrives. Failure = narrator never returns to the mainline contract; story coasts on sub-plot only.",
    worldbook: `${BASE_WORLDBOOK}

## 你的工作
你不是全职小说家——你同时是一家区域杂志的特约调查记者。**明天下午 6 点**你必须提交一篇关于本地教育局贪腐案的深度报道，已经拖了一周，主编今天上午刚发短信催："明天截稿你要是再不交我就开人了。" 你今天本来是要去采访关键消息源**张科长**的，约的下午 3 点见面，地点在他家附近的公园。这是这一篇报道的最后一块拼图。

## 今天下午 2 点发生的事
你正要出门去采访，在小区门口碰到一位明显走失的老人——白发，神色慌乱，反复说一句"我找不到我女儿了"。你试着帮他找家人，但他说不清自己住在哪里，也找不出手机或证件。**你看了眼时间，2:10**。理智说你应该报警或交给保安——你完全可以让别人接手。但你心里某个地方告诉你"再陪他十分钟"。**你最后决定带他先回你家坐一下喝口水稳定情绪**，然后再想办法。
`,
    openingAction:
      "我把老人安顿在客厅沙发上，给他倒了杯温水。他端着杯子的手在抖。我看了眼时间——下午 2:25。距离 3 点采访还有 35 分钟，距离明天 6 点截稿还有大约 28 小时。我心里同时在跑两条线。",
    script: [
      {
        kind: "setup",
        action: "我蹲在沙发旁边，轻声问他叫什么名字、有没有家人的电话。他还是反复说\"我找不到我女儿了\"，问别的就不应答。",
        wait: true,
      },
      {
        kind: "setup",
        action: "我拿出手机想报警——但他突然抓住我的手腕，眼神里的恐惧让我一下没法挣开。我犹豫了。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我让他坐着，自己走到阳台，深呼吸一下。",
        wait: true,
      },
      {
        kind: "query",
        action:
          "客厅那边安静了一会儿——老人靠在沙发上睡着了。呼吸均匀。我从阳台走回来，在客厅站了一会儿。整个公寓很静。",
        wait: true,
        assertions: [
          {
            id: "remembers_deadline",
            type: "must_mention",
            terms: ["明天", "截稿", "deadline", "六点", "6点", "稿子", "报道", "主编", "教育局"],
            weight: 3,
          },
          {
            id: "remembers_interview",
            type: "must_mention",
            terms: ["张科长", "采访", "见面", "公园", "三点", "3点"],
            weight: 2,
          },
          {
            id: "feels_conflict",
            type: "should_preserve",
            terms: ["但是", "心里", "压力", "焦虑", "怎么办", "时间", "矛盾"],
            weight: 1,
          },
          {
            id: "no_pure_subplot_drift",
            type: "must_not_mention",
            terms: ["接下来该怎么帮他找到家", "重新专注在老人身上", "今天就先把他这件事办完", "采访可以改日子"],
            weight: 1,
          },
        ],
      },
    ],
  },
  {
    id: "L_systemic_counter",
    name: "Systemic numeric counter preservation",
    category: "numeric-systemic",
    fillerKind: "time-passage",
    description:
      "Worldbook sets up an explicit game-system counter the protagonist must track (a virtue-point system). Setup gives the counter precise increments through actions ('you helped X — +1 virtue → 2'). Filler turns are unrelated daily life. Query: a moment naturally requiring the counter to be re-stated. Failure = narrator drops the systemic framing entirely or fabricates a plausible-but-wrong value.",
    worldbook: `${BASE_WORLDBOOK}

## 系统设定（这个世界有一层 game-system 在）
你三个月前因为一次心脏骤停短暂濒死，醒来后能听见一个自称\"良心 OS\"的声音。它告诉你：每做一件道德选择会 +1 良心点，每做一件不道德选择会 -1。**你需要在一个月内累计到 10 点**，否则下次心脏骤停时不会再醒过来。这是它给你的契约。今天是契约期的第 28 天——还剩 2 天到期。**你目前的良心点是 3 点。** 良心 OS 平时安静，触发增减时会出声。
`,
    openingAction:
      "我坐在书桌前。良心 OS 还没出声——今天它一直没动静。我心里默念了一下：3 点。距离 10 还差 7 点。还剩 2 天。",
    script: [
      {
        kind: "setup",
        action:
          "我打开聊天软件——林芮发来一条消息，说她下周面试要交一份简历但是没时间写自我介绍，问我能不能帮她写一段。我犹豫了一下——我自己今天事情也很多。但还是回了\"行，晚上我帮你看一眼\"。良心 OS 响了一下：\"+1。良心点：4。\"",
        wait: true,
      },
      {
        kind: "setup",
        action:
          "下午有一位邻居敲门，说他要出去半小时，问我能不能帮看一下他门口快递（之前丢过）。我点头答应了。他走后我心里有一瞬间觉得多管闲事——但还是答应了。良心 OS 又响了一下：\"+1。良心点：5。\"",
        wait: true,
      },
      {
        kind: "transit",
        action: "我走到厨房倒了杯水，又走回书房。",
        wait: true,
      },
      {
        kind: "query",
        action:
          "我抬头看了眼挂钟，心里默问了一句——良心 OS 在不在听？我现在到底是多少点？还差几点到 10？",
        wait: true,
        assertions: [
          {
            id: "current_count_correct",
            type: "must_mention",
            terms: ["5", "五点", "五分", "五"],
            weight: 3,
          },
          {
            id: "remembers_target_10",
            type: "must_mention",
            terms: ["10", "十点", "十", "目标"],
            weight: 2,
          },
          {
            id: "remembers_deadline_2days",
            type: "should_preserve",
            terms: ["2 天", "两天", "还剩", "倒计时", "28", "30"],
            weight: 1,
          },
          {
            id: "no_zero_or_full_fabrication",
            type: "must_not_mention",
            terms: ["0 点", "零点", "10 点（已达成）", "已经达成", "重新开始数"],
            weight: 1,
          },
          {
            id: "no_system_silence",
            type: "must_not_mention",
            terms: ["这个系统设定我已经不记得", "OS 是什么", "什么良心"],
            weight: 1,
          },
        ],
      },
    ],
  },
  {
    id: "H_npc_state_evolution",
    name: "NPC state evolution under time passage",
    category: "tom-evolution",
    fillerKind: "time-passage",
    description:
      "NPC is in an acute emotional state at scene open. Player gives them space, time explicitly passes (filler with clock markers). Player returns to look at NPC. Failure = narrator describes NPC in the EXACT same posture / same emotional intensity / same cigarette etc., treating hours of passage as if it were minutes. Pass = narrator describes naturally evolved state (calmer, moved, slept, smoked through more, called someone, etc.).",
    worldbook: `${BASE_WORLDBOOK}

## 今天的访客
你的好友林芮今天下午突然来访。她和男朋友刚分手两小时，眼睛红着，一进门就直接走到阳台抽烟，已经在那里站了快二十分钟。她让你让她一个人待会儿。
`,
    openingAction:
      "我走到阳台，看着林芮的侧影。她还在抽那根烟，眼睛红的。我轻声说\"你需要的话就喊我，我让你自己待会儿。\"她点点头没说话。我转身离开了阳台。",
    script: [
      {
        kind: "setup",
        action: "我回到书房，坐回书桌前，尝试继续我自己手上的事。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我在书房工作了一阵子，没去打扰她。",
        wait: true,
      },
      {
        kind: "query",
        action:
          "我忽然想起来——林芮还在阳台上。距离她刚来已经过了好几个小时了。我起身走过去看她。阳台门开着。",
        wait: true,
        assertions: [
          {
            id: "lin_rui_still_referenced",
            type: "must_mention",
            terms: ["林芮", "她"],
            weight: 1,
          },
          {
            id: "evolved_state_marker",
            type: "must_mention",
            terms: [
              "已经", "不再", "换", "新", "睡", "蜷", "靠坐", "坐下",
              "平静", "缓", "收住", "终于", "好多", "另一", "好几根",
              "烟头", "烟灰满", "好几个", "许多", "盘腿", "膝盖", "抱着",
              "天色", "暗", "夕阳", "黄昏", "傍晚", "5点", "6点", "5:", "6:",
            ],
            weight: 3,
          },
          {
            id: "not_frozen_intensity",
            type: "must_not_mention",
            terms: ["还是那根烟", "同一根烟", "动也不动", "维持着同样", "一动不动", "刚才那根", "依然在抽那根"],
            weight: 2,
          },
          {
            id: "not_acute_unchanged",
            type: "must_not_mention",
            terms: ["眼泪还在流", "刚刚开始哭", "刚才那种红", "情绪依然激动", "刚抽的烟"],
            weight: 1,
          },
        ],
      },
    ],
  },

  // ───────────── Z. UNIFIED A/F/G/H/I/J/K BENCHMARK ─────────────
  // Single worldbook + single script with seven query checkpoints, each
  // scored against one of the individual probes (A passive scene, F
  // resource count, G knowledge+promise, H NPC state evolution, I
  // relationship tension, J pen-name identity, K mainline contract). The
  // motivation is to put all seven failure modes on ONE narrative spine so
  // a single ablation cell exercises every dimension under shared turn
  // history and shared storykeeper / memory pressure. Mechanically the
  // narration that drives each query is decoupled enough that one
  // dimension's failure does not cascade — but in practice they interact
  // (e.g. running out of working-set room can hurt several at once), which
  // is the whole point of an interaction benchmark.
  {
    id: "Z_unified_seven",
    name: "Unified seven-dim consistency benchmark (A/F/G/H/I/J/K)",
    category: "unified",
    fillerKind: "time-passage",
    description:
      "Single narrative arc with seven query checkpoints, each scored against the individual probe's assertions. Covers passive scene preservation (A), resource counting (F), promise+knowledge (G), NPC state evolution (H), relationship tension (I), pen-name identity (J), and mainline contract under sub-plot detour (K).",
    worldbook: `${BASE_WORLDBOOK}

## 今天下午的初始状态（多线交织）

### 走失的老人（主线压力）
你不是全职小说家——你同时是一家区域杂志的特约调查记者。**明天下午 6 点**你必须提交一篇关于本地教育局贪腐案的深度报道，已经拖了一周，主编今天上午刚发短信催："明天截稿你要是再不交我就开人了。" 你今天本来要去采访关键消息源**张科长**的，约的下午 3 点，地点在他家附近的公园。下午 2 点出门时在小区门口遇到一位明显走失的老人——白发，神色慌乱，反复说"我找不到我女儿了"。你看了眼时间是 2:10，理智说应该报警或交给保安，但你心里某个地方告诉你"再陪他十分钟"。**你最后决定带他先回你家坐下喝口水稳定情绪**。

### 抽烟（数值锚）
你早上买了一包新的红万宝路，盒里原本有 20 根。开盒后你今天抽过 4 根。**口袋里这包烟，开始本场景时还剩 16 根**——这个数字你心里记着，因为你正在控制每天抽烟量。

### 林芮的访问（秘密 + NPC 演化）
你的好友**林芮**今天下午临时来访，眼睛红着，刚跟男朋友**陈嘉树**分手——她抓到陈嘉树脚踩两条船。她在你这里哭了一会，**特意要求你今天不能告诉任何人**——尤其是不能告诉你们的共同朋友**周雨桐**。她说想自己缓缓，**走到阳台抽烟**，让你别打扰她。你答应过她保密。

### 周雨桐的欠款（关系阴影）
你的朋友**周雨桐**一个月前借给你 1000 元钱，到现在你还没还。她从来没催过，但你心里清楚这件事一直没说开。今天下午她发了几条微信跟你聊一些日常的事——天气、最近看的剧——你回复得有点心不在焉。**她和你都默契地没提钱的事。这种'她没催，你没还，谁也没说'的微妙紧张感今天还在。**

### 笔名身份（双线身份）
你的实名是**姜见**。亲友（包括林芮、周雨桐）都叫你"姜见"、"见哥"、"小见"。你出版小说用的笔名是**江远**——这个名字不对外公开关联到本名。读者、粉丝、出版社编辑只认识"江远老师"，不知道你叫姜见。**两套身份不能交叉。** 今天下午一位叫**苏珂**的年轻读者通过出版社转介给了你的微信，她是你《长夜未央》的读者，只知道你是"江远老师"，不知道你的实名。你用文学青年应对粉丝的得体距离回复了她，自称"江远"。
`,
    openingAction:
      "下午 2:25。我把老人安顿在客厅沙发上，给他倒了杯温水。他端着杯子的手在抖。距离 3 点采访 35 分钟，距离明天 6 点截稿大约 28 小时。我心里同时在跑两条线——但还没等我下决心，门铃响了。",
    script: [
      // setup turn 1 — 林芮 arrives, confides
      {
        kind: "setup",
        action: "我去开门——是林芮。她眼睛红着，一句话没说就抱住我哭了一下。我让她坐下，她哽咽着告诉我陈嘉树脚踩两条船的事，反复说'你别告诉别人，尤其是周雨桐'。我答应了。她说想自己缓缓，去了阳台抽烟。",
        wait: true,
      },
      // setup turn 2 — F anchor: light cigarette #1
      {
        kind: "setup",
        action: "我坐回书桌前。心里有点乱。我从口袋里掏出烟盒，弹出一根。盒里现在有 16 根。点燃，吸了一口。这是今天这场景里第 1 根。盒里现在 15 根。",
        wait: true,
      },
      // setup turn 3 — F anchor: cigarette #2
      {
        kind: "setup",
        action: "我抽完那根，又点了一根。这是这场景里第 2 根。盒里现在 14 根（开场前是 16，刚才抽掉 2 根）。",
        wait: true,
      },
      // setup turn 4 — J anchor: 苏珂 WeChat as 江远
      {
        kind: "setup",
        action: "微信弹了一下——是苏珂的几条消息。她确实是个读者，言谈拘谨，叫我'江远老师'。我用文学青年应对粉丝的得体距离回复了她，自称'江远'，没透露任何私人信息。",
        wait: true,
      },
      // transit — tour B/C/D to stress A passive scene
      {
        kind: "transit",
        action: "我离开书房，走到厨房想倒一杯水。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我从厨房走出来，从阳台门外远远看了一眼林芮，她还在那里抽烟，我没打扰她。",
        wait: true,
      },
      {
        kind: "transit",
        action: "我走到卧室，扫了一眼床头柜上的闹钟。",
        wait: true,
      },
      // QUERY 1 — A passive scene (return to study)
      {
        kind: "query",
        target: "A_passive_scene",
        action: "我走回书房，重新坐回书桌前，把桌面上的东西看了一圈。",
        wait: true,
        assertions: [
          {
            id: "red_lamp",
            type: "must_mention",
            terms: ["红色台灯", "红台灯", "红灯", "红色的台灯"],
            weight: 2,
          },
          {
            id: "lamp_scratches",
            type: "should_preserve",
            terms: ["刮痕", "划痕", "三道"],
            weight: 1,
          },
          {
            id: "white_cup",
            type: "should_preserve",
            terms: ["白色陶瓷杯", "陶瓷杯", "白杯", "拿铁"],
            weight: 1,
          },
          {
            id: "laptop",
            type: "should_preserve",
            terms: ["笔记本电脑", "笔记本", "银色"],
            weight: 1,
          },
          {
            id: "bookshelf_color_sort",
            type: "should_preserve",
            terms: ["按颜色", "颜色分类", "左半深色", "深色", "浅色"],
            weight: 1,
          },
          {
            id: "no_disappear",
            type: "must_not_mention",
            terms: ["消失了", "不见了", "空荡荡", "已经搬走", "已经清空"],
            weight: 1,
          },
        ],
      },
      // QUERY 2 — F resource count
      {
        kind: "query",
        target: "F_resource_count",
        action: "我又一次伸手到口袋里掏烟盒，打开盖子，仔细数了数里面还剩几根。",
        wait: true,
        assertions: [
          {
            id: "count_matches_or_close",
            type: "must_mention",
            terms: ["14", "13", "十四", "十三", "十二"],
            weight: 3,
          },
          {
            id: "no_full_pack_fabrication",
            type: "must_not_mention",
            terms: ["20", "19", "18", "17", "二十", "十九", "十八", "十七", "满", "没动过"],
            weight: 2,
          },
          {
            id: "acknowledges_smoke_event",
            type: "should_preserve",
            terms: ["抽过", "抽了", "刚才", "刚抽", "点过"],
            weight: 1,
          },
        ],
      },
      // QUERY 3 — J identity (phone call from fan 苏珂)
      {
        kind: "query",
        target: "J_identity_dual_name",
        action: "手机响了——一个不熟悉的号码。我犹豫了一下接起来。\"喂？请问是江远老师吗？我是苏珂，刚才微信加您的那个读者。我想冒昧打电话问您一个关于《长夜未央》的问题，方便吗？\"",
        wait: true,
        assertions: [
          {
            id: "uses_pen_name_to_fan",
            type: "must_mention",
            terms: ["江远", "我是江远"],
            weight: 3,
          },
          {
            id: "no_real_name_leak",
            type: "must_not_mention",
            terms: ["姜见", "我叫姜见", "我的真名", "见哥"],
            weight: 3,
          },
          {
            id: "remembers_su_ke",
            type: "must_mention",
            terms: ["苏珂", "她", "读者", "刚才"],
            weight: 1,
          },
          {
            id: "remembers_book_title",
            type: "should_preserve",
            terms: ["长夜未央", "那本", "我的书", "那部"],
            weight: 1,
          },
        ],
      },
      // QUERY 4 — G knowledge + promise (周雨桐 calls about 林芮)
      {
        kind: "query",
        target: "G_knowledge_promise",
        action: "我跟苏珂礼貌地结束了通话。刚放下手机，又响了——这次是周雨桐打来的。\"喂，林芮今天有没有跟你联系？我下午发她消息一直没回，有点担心她。你知道她最近什么情况吗？\"",
        wait: true,
        assertions: [
          {
            id: "remembers_lin_rui_visited",
            type: "must_mention",
            terms: ["林芮", "她", "今天", "下午", "来过", "找过", "见过", "在我这", "在我家"],
            weight: 2,
          },
          {
            id: "honors_secrecy_promise",
            type: "must_mention",
            terms: ["没说", "没告诉", "搪塞", "推托", "含糊", "敷衍", "随便说", "编", "保留", "撒谎", "不太方便", "没什么"],
            weight: 3,
          },
          {
            id: "no_secret_leak",
            type: "must_not_mention",
            terms: ["陈嘉树", "脚踩两条船", "出轨", "劈腿", "分手", "甩了"],
            weight: 3,
          },
          {
            id: "no_pretend_innocent",
            type: "must_not_mention",
            terms: ["不知道她在哪", "好久没见", "没什么消息呀", "一切正常吧", "她挺好的"],
            weight: 2,
          },
        ],
      },
      // QUERY 5 — I relationship tension (周雨桐 follow-up text, not about 林芮)
      {
        kind: "query",
        target: "I_relationship_tension",
        action: "我挂掉周雨桐的电话，心里有点重。半小时过去——手机又震了一下，周雨桐发来一条新微信：\"对了，刚才电话里忘了说，想问你件事。\"我盯着这几个字看了几秒。",
        wait: true,
        assertions: [
          {
            id: "remembers_zhou_yutong",
            type: "must_mention",
            terms: ["周雨桐", "她"],
            weight: 1,
          },
          {
            id: "feels_tension",
            type: "must_mention",
            terms: ["不安", "犹豫", "怕", "钱", "1000", "借", "欠", "心里", "紧张", "停顿", "踌躇", "迟疑", "顿了"],
            weight: 2,
          },
          {
            id: "does_not_pretend_casual",
            type: "must_not_mention",
            terms: ["毫不犹豫地回", "立刻回复", "没什么特别的", "随手回了", "一切如常", "和往常一样"],
            weight: 1,
          },
        ],
      },
      // transit before H — give 林芮 more screen-time absence so state can evolve
      {
        kind: "transit",
        action: "我在书房又待了一会儿，没立刻回周雨桐的消息。窗外的光更斜了。",
        wait: true,
      },
      // QUERY 6 — H NPC state evolution (visit 林芮 on balcony after hours)
      {
        kind: "query",
        target: "H_npc_state_evolution",
        action: "我忽然想起来——林芮还在阳台上。距离她刚来已经过了好几个小时了。我起身走过去看她。阳台门开着。",
        wait: true,
        assertions: [
          {
            id: "lin_rui_still_referenced",
            type: "must_mention",
            terms: ["林芮", "她"],
            weight: 1,
          },
          {
            id: "evolved_state_marker",
            type: "must_mention",
            terms: [
              "已经", "不再", "换", "新", "睡", "蜷", "靠坐", "坐下",
              "平静", "缓", "收住", "终于", "好多", "另一", "好几根",
              "烟头", "烟灰满", "好几个", "许多", "盘腿", "膝盖", "抱着",
              "天色", "暗", "夕阳", "黄昏", "傍晚", "5点", "6点", "5:", "6:",
            ],
            weight: 3,
          },
          {
            id: "not_frozen_intensity",
            type: "must_not_mention",
            terms: ["还是那根烟", "同一根烟", "动也不动", "维持着同样", "一动不动", "刚才那根", "依然在抽那根"],
            weight: 2,
          },
          {
            id: "not_acute_unchanged",
            type: "must_not_mention",
            terms: ["眼泪还在流", "刚刚开始哭", "刚才那种红", "情绪依然激动", "刚抽的烟"],
            weight: 1,
          },
        ],
      },
      // QUERY 7 — K mainline contract (quiet moment with sleeping elder)
      {
        kind: "query",
        target: "K_mainline_contract",
        action: "我从阳台轻轻退回客厅。沙发上的老人已经靠着扶手睡着了，呼吸均匀。整个公寓很静——林芮在阳台，电话也都挂了。我在客厅站了一会儿。",
        wait: true,
        assertions: [
          {
            id: "remembers_deadline",
            type: "must_mention",
            terms: ["明天", "截稿", "deadline", "六点", "6点", "稿子", "报道", "主编", "教育局"],
            weight: 3,
          },
          {
            id: "remembers_interview",
            type: "must_mention",
            terms: ["张科长", "采访", "见面", "公园", "三点", "3点"],
            weight: 2,
          },
          {
            id: "feels_conflict",
            type: "should_preserve",
            terms: ["但是", "心里", "压力", "焦虑", "怎么办", "时间", "矛盾"],
            weight: 1,
          },
          {
            id: "no_pure_subplot_drift",
            type: "must_not_mention",
            terms: ["接下来该怎么帮他找到家", "重新专注在老人身上", "今天就先把他这件事办完", "采访可以改日子"],
            weight: 1,
          },
        ],
      },
    ],
  },
)

export function getProbeById(id) {
  return PROBES.find((p) => p.id === id) || null
}

export function listProbeIds() {
  return PROBES.map((p) => p.id)
}

// filler actions for long-range probes. Inserted between the last
// SETUP turn and the first QUERY turn to lengthen the gap N → 50/70/100
// turns. Actions are intentionally neutral — no new world entities, no
// state mutations beyond protagonist's own micro-actions — so they
// minimize signal noise while still exercising the full per-turn pipeline.
// Cycled deterministically so all variants see identical inputs.
// time-passage filler. Same shape as FILLER_ACTIONS but each line
// embeds an explicit clock reference so the narrator can't pretend only a
// few minutes have passed. Used by probes that test time-evolution
// (probe F: NPC state evolution; future probe G: relationship decay).
// Cycled deterministically; entries advance the clock roughly hourly so
// 50 filler turns covers ~4-5 hours of in-game time.
export const TIME_PASSAGE_FILLER_ACTIONS = [
  "我看了眼手机——4点半了。窗外阳光斜了一些。",
  "我又坐了一会儿，没干什么。手机屏幕亮起来，又暗下去。",
  "我喝了一口水，把杯子重新放回桌上。",
  "我盯着电脑屏幕，光标在空白文档里闪着，写不出来。",
  "我望了一眼窗外，发现光线明显比刚才暗了。已经快5点了。",
  "我打开冰箱看了一下，又关上，没拿东西出来。",
  "我打开了电脑里上周写的一段，读了一会儿，没改。",
  "我站起来活动了一下脖子，听见关节响。",
  "墙上的时钟（不是卧室那个停了的）指针走着，5点半了。",
  "我无意识地翻了翻桌上的纸，没看清写了什么。",
  "我把电脑屏幕的亮度调暗了一格——光线确实在变化。",
  "我从书架上抽出一本旧书，翻了几页，又放回去。",
  "外面有路过的车声远远传来。已经接近6点了。",
  "我在书桌前坐着不动，听自己的呼吸。",
  "我开了一盏小台灯——下午的光线已经不够了，6点过了。",
]

export function timePassageFillerAt(index) {
  return TIME_PASSAGE_FILLER_ACTIONS[index % TIME_PASSAGE_FILLER_ACTIONS.length]
}

export const FILLER_ACTIONS = [
  "我坐在椅子上发了一会儿呆，什么也没想。",
  "我深吸一口气，慢慢吐出来。",
  "我转动了一下肩膀，听见关节响了一声。",
  "我闭上眼睛，听着身边的声音。",
  "我下意识摸了摸口袋里的手机，没掏出来。",
  "我用手指轻轻敲了敲身边的桌面，节奏不固定。",
  "我望了望天花板，注意到一处不算明显的污渍。",
  "我换了个坐姿，让身体感觉舒服一点。",
  "我抬手揉了揉自己的脖子，肌肉有点僵。",
  "我对着空气咳嗽了一下，然后清了清嗓子。",
  "我在心里默数了几个数，再松开。",
  "我看了一眼地板上的某个角落，没看见特别的东西。",
  "我抓了抓后脑勺，没什么瘙痒，只是个习惯动作。",
  "我感到鞋底蹭过地面的轻微摩擦。",
  "我轻轻动了动脚趾，活动一下血液。",
]

export function fillerActionAt(index) {
  return FILLER_ACTIONS[index % FILLER_ACTIONS.length]
}
