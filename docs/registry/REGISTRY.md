# 注册表（REGISTRY）

> 本文件是 green-world **所有「表」的索引**：配置表、规则表、事件表、数值分区、美术图位表。
> 改任何一张表之前先在这里找到它的宿主文件、条目数与看守断言。
> 分层与依赖方向见 `docs/architecture/ARCHITECTURE.md`。

## 1. 配置表总表

| 表 | 宿主文件 | 条目数 | 主要导出 |
|---|---|---:|---|
| 洲际联合会 | `src/game/config/confederations.ts` | **6**（UEFA / CONMEBOL / AFC / CAF / CONCACAF / OFC） | `CONFEDERATIONS` |
| 国家与俱乐部生成 | `src/game/config/countries.ts` | **12 国 / 776 俱乐部** | `COUNTRIES`、`CITY_POOL`、`CLUB_SUFFIXES`、`countClubs`、`confederationTierCount` |
| 洲际赛事与世俱杯 | `src/game/config/competitions.ts` | **12 洲际 + 1 世俱杯** | `CONTINENTAL_COMPETITIONS`、`CLUB_WORLD`、`DOMESTIC_CUP_ENTRANTS = 16`、`continentalOf`、`continentalById` |
| 资格 / 抽签 / 升降级 | `src/game/config/qualification.ts` | 12 条洲际名额配方 + 世俱杯配方 + 3 条升降级 | `RULE_PRIORITY`、`CONTINENTAL_RULES`、`CLUB_WORLD_RULES`、`CLUB_QUALIFICATION_RULES`、`PROMOTION_RULES`、`drawRulesOf`、`declaredSlotsOf`、`QUALIFICATION_CONFIG` |
| 国家队线 | `src/game/config/national.ts` | 世界杯 8 队 / 国家联赛 A–D | `WORLD_CUP_SLOTS`、`WORLD_CUP_SIZE`、`CONTINENTAL_CUP_SLOTS`、`NATIONS_LEAGUE_TIERS`、`majorTournamentOf` |
| 日历 | `src/game/config/calendar.ts` | 52 周 / 6 段 / 2 窗 | `CALENDAR`、`leagueWeeks`、`phaseLabelOf`、`isTransferWindow`、`isNationalWindow` |
| 事件链 | `src/game/config/chains.ts` | **3 条链**（`bench-crisis` / `board-pressure` / `wonderkid`），`agent` / `training` / `showdown` 等 `id` 是链内步骤 | `CHAINS`、`chainById`、`chainSteps` |
| 关键时刻 | `src/game/config/moments.ts` | **8 个模板** | `MOMENTS`、`momentById` |
| 挑战剧本 | `src/game/config/scenarios.ts` | **3 个** | `SCENARIOS`、`scenarioById`、`gradeScenario`、`scenarioProgress` |
| 球员位置 | `src/game/config/positions.ts` | **6 个细位**（FW/WF/AM/DM/CB/GK） | `POSITIONS`、`DEFAULT_POSITION`、`positionOf`、`basePositionOf` |
| 数值旋钮 | `src/game/balance.ts` | **131 个**（18 个分区） | `BALANCE`（含 `saveVersion`） |
| 美术图位 | `assets/art-manifest.json` | **105 个图位 / 11 组** | 单一事实源 → `npm run gen:art` → `src/ui/art-manifest.ts` |

> 「条目数」是语义计数，不随排版变化；本表**不记录行数**，避免代码变更时索引数字漂移。

## 2. 世界结构（12 国 / 776 俱乐部）

`countries.ts` 顶部的算式（单测 `tests/world.spec.ts:10-13` 锁死）：

```
UEFA      5 国 × (18+20+20+20 = 78) = 390
CONMEBOL  2 国 × (18+20+20    = 58) = 116
AFC       2 国 × 58                 = 116
CAF       1 国 × 58                 =  58
CONCACAF  1 国 × 58                 =  58
OFC       1 国 × (18+20       = 38) =  38
                             合计    = 776
```

| 国家 | 联合会 | 层级 | 每层队数 | strength |
|---|---|---:|---|---:|
| ENG / ESP / GER / ITA / FRA | UEFA | 4 | 18/20/20/20 | 92 / 90 / 88 / 87 / 86 |
| BRA / ARG | CONMEBOL | 3 | 18/20/20 | 88 / 85 |
| JPN / KSA | AFC | 3 | 18/20/20 | 68 / 62 |
| EGY | CAF | 3 | 18/20/20 | 63 |
| USA | CONCACAF | 3 | 18/20/20 | 66 |
| NZL | OFC | 2 | 18/20 | 44 |

俱乐部名 = `CITY_POOL[国家]` 的城市 + `CLUB_SUFFIXES`（16 个虚构后缀）之一，**全程序化**；
`tests/world.spec.ts:27-34` 断言名称里不出现 Real Madrid / Barcelona / Manchester / Bayern /
Juventus / PSG / Chelsea / Arsenal 等真实俱乐部。

## 3. 赛事注册表

### 3.1 俱乐部赛事

| 类别 | 数量 | 来源 |
|---|---:|---|
| 各国联赛（`type: 'league'`） | **40**（5×4 + 2×3 + 2×3 + 1×3 + 1×3 + 1×2） | 由 `COUNTRIES` 派生，id 形如 `eng-l1`（`leagueId(countryId, tier)`） |
| 洲际赛事（`CONTINENTAL_COMPETITIONS`） | **12** | UEFA 3（`uefa-cl` / `uefa-el` / `uefa-uecl`）、CONMEBOL 2（`conmebol-libertadores` / `conmebol-sudamericana`）、AFC 2（`afc-cl` / `afc-cup`）、CAF 2（`caf-cl` / `caf-confed`）、CONCACAF 2（`concacaf-cl` / `concacaf-central`）、OFC 1（`ofc-cl`） |
| 世俱杯 | **1** | `CLUB_WORLD.id = 'fifa-club-world'`，32 队，`pots: 4`，`avoidSameCountry` + `avoidSameConfederation` |
| 国内杯赛 | **12**（每国一个） | `DOMESTIC_CUP_ENTRANTS = 16`（顶级联赛取前 16） |

> 俱乐部赛事合计 **65**；国家队赛事（世界杯 1 + 6 洲际杯 + 国家联赛各级）另计，
> 世界生成后 `world.competitions` 总数 README 记为 **79**。

### 3.2 洲际名额守恒等式（`qualification.ts` 注释原文，单测锁死）

```
uefa-cl     8+7+6+6+5                      = 32
uefa-el     8+7+6+6+5                      = 32
uefa-uecl   5 国 × 3（l2）+ 5 杯赛冠军 + 12 递补 = 32
libertadores 8+8（l1）+ 4+4（l2）+ 8 递补      = 32
sudamericana 8+8（l1）+ 2 杯赛冠军 + 14 递补    = 32
afc-cl      10+10 + 2 杯赛冠军 + 10 递补       = 32
afc-cup     6+6（l2）+ 2 杯赛亚军 + 18 递补     = 32
caf-cl      16 + 1 杯赛冠军 + 15 递补          = 32
caf-confed  8（l2）+ 1 + 23 递补               = 32
concacaf-cl 10 + 1 + 5 递补                    = 16
concacaf-central 6（l2）+ 1 + 9 递补           = 16
ofc-cl      10 + 1 + 5 递补                    = 16
```

**规则**：所有名额之和必须严格等于该赛事参赛队数，改任何一个数字都要重算等式并跑 `tests/qualify.spec.ts`。

### 3.3 资格优先级（`RULE_PRIORITY`）

| 来源 | 值 | 含义 |
|---|---:|---|
| `leagueTop` | 10 | 联赛前 N 名，最高优先 |
| `leagueRest` | 20 | 联赛其余名次 |
| `cupWinner` | 30 | 杯赛冠军 |
| `cupRunnerUp` | 40 | 杯赛亚军 |
| `continentalChampion` | 50 | 上届洲际冠军 |
| `continentalRank` | 60 | 洲际排名顺位 |
| `host` | 70 | 主办方 |
| `fill` | 90 | 递补填满 |

### 3.4 升降级（`PROMOTION_RULES`）

| fromTier → toTier | up | down | note |
|---|---:|---:|---|
| 2 → 1 | 3 | 3 | 次级前 3 升顶级，顶级末 3 降 |
| 3 → 2 | 3 | 3 | 第三级前 3 升次级，次级末 3 降 |
| 4 → 3 | 4 | 4 | 第四级前 4 升第三级，第三级末 4 降 |

`leagueSystemOf(countryId)` 目前全部返回 `'open'`；`closedCountries` 数组留空，改成封闭体系只需把国家 id 填进去。

### 3.5 抽签约束（`DrawRules`）

`pots: 4`、`potBy: 'reputation'`、`avoidSameCountry: true`；
`avoidSameConfederation` 仅**世俱杯**为 `true`，洲际赛默认 `false`。
抽签算法见 `src/game/rules/draw.ts`：分档 → 上下档配对 → 逐条校验 → 违规交换最多 200 次 → 仍不满足记 `degraded`。

## 4. 日历（`CALENDAR`，52 周）

| 段 | id | 周 | label |
|---|---|---|---|
| 1 | `preseason` | 1–4 | 季前备战 |
| 2 | `first-half` | 5–24 | 联赛前半程 |
| 3 | `winter` | 25–28 | 冬歇期 |
| 4 | `second-half` | 29–44 | 联赛后半程 |
| 5 | `finals` | 45–48 | 决赛与赛季结算 |
| 6 | `offseason` | 49–52 | 休赛期 |

- 转会窗：夏季 **1–9**、冬季 **26–30**。
- 国家队窗口周：**6 / 10 / 14 / 18 / 33 / 37**（`nationalWindows`）。
- `maxMatchesPerWeek = 2`；`leagueWeeks()` 去掉季前、冬歇、决赛、休赛期。
- 国家联赛轮次 `NATIONAL_LEAGUE_WEEKS = [6,10,14,18]`，淘汰赛 `NATIONAL_KNOCKOUT_WEEKS = [33,37,43]`。

## 5. 叙事与玩法表

| 表 | 条目 | 结构要点 |
|---|---:|---|
| 关键时刻 `MOMENTS` | 8 | 每个模板**恰好 3 个选项**且取舍不同；`difficulty` 是成功率基准（还叠能力差，见 `match/flow.ts`）；效果只改剩余比赛的 `attackEdge`/`defenseEdge` 与体能/换人名额，**绝不回改已发生的比分** |
| 事件链 `CHAINS` | 3 | 同时活跃 ≤ `chainMaxActive`，满了排队不丢弃；每步有 `dueWeek`；结束（success/fail/abandon）记 `chainDone` 同档不再触发；效果只经 `advanceWeek` 入口 |
| 挑战剧本 `SCENARIOS` | 3 | 固定种子 + 固定起始国家/级别 + 「开场不利」；目标为名次（可叠现金目标）；进度写 `PlayState.scenario`；评级 `none/bronze/silver/gold` |
| 球员位置 `POSITIONS` | 6 | 细位只用于开局选择与展示，落库归并到 `GK/DF/MF/FW`；归并关系决定进球/助攻份额（`play/career.ts` 的 `SCORING_SHARE`） |

## 6. 数值旋钮（`balance.ts`，131 个 / 18 分区）

| 分区 | 起始行 | 覆盖内容 |
|---|---:|---|
| 世界 | L5 | 世界基准强度参照点 |
| 比赛：xG 与泊松 | L14 | 期望进球与泊松抽样 |
| 球队强度权重 | L22 | 攻防属性如何折成强度 |
| 战术对抗 | L27 | press / possess / counter 的相互克制 |
| 体能 / 疲劳 | L35 | 每周恢复、出场消耗 |
| 半场交互（P7） | L44 | 半场决策的影响幅度 |
| 点球 | L56 | 点球判定 |
| 球员评分 | L64 | 赛后评分公式 |
| 财政 | L75 | 上座率 `0.35 + 声望/200 + 战绩修正`、差旅、青训占比、债务年息、周薪→赛季工资（Σ周薪 × 52，单位百分之一） |
| 声望 | L91 | 声望下限、夺冠/升级/洲际资格/降级增减 |
| 成长与身价 | L103 | 年龄系数（16-21 / 22-26 / 27-29 / 30+）、出场系数（0.6~1.2）、训练系数、身价年龄曲线（26 岁见顶）、身价基准 `ability² × 系数` |
| 转会 | L122 | 每周 AI 笔数、每窗每队引进上限、每点属性折合转会费、玩家每周报价数、挖人声望差门槛 |
| 国家队征召 | L142 | 征召窗口、入选条件、征召期间的俱乐部赛事让位 |
| 生涯 | L148 | 生涯线专属：出场即成长、退役与转生阈值 |
| 评级线 | L165 | 赛后评分的档位阈值（与「球员评分」公式配套） |
| 双模式：生涯 / 经理 | L168 | 两模式各自的初始与成长参数 |
| 仿真分级 LOD | L190 | 非玩家赛事的简化模拟档位 |
| P7 可玩性 | L197 | 事件链上限、热评长度、谈判轮数等 |

> 起始行以 `// === 分区名 ===` 注释为准；编辑 `balance.ts` 后行号会漂移，改完请顺手校一次。

**铁律**：其他文件里不允许出现这些数值的字面量；`tests/play.spec.ts` 锁 41 项不变量，
`BALANCE.saveVersion` 是存档版本号（改存档结构才动它）。

## 7. 美术图位注册表（105 / 11 组）

单一事实源 `assets/art-manifest.json`（`budgetKB: 1536`）→ `npm run gen:art` 生成
`src/ui/art-manifest.ts`（紧凑字符串，组间 `|`，每项 `目录:前缀~尾名,宽,高[,*]`，`*` = preload）。

| 组 | 数量 | 尺寸 | 组目录 | 备注 |
|---|---:|---|---|---|
| brand | 10 | 512×512 … 64×64 | `brand/` | 仅 `brand-02-hero-keyart` 带 `preload` |
| confederation | 6 | 256×256 | `confederation/` | 六大洲徽 |
| scenery | 10 | 640×360 | `scenery/` | 场景底图 |
| event | 26 | 480×320 | `event/` | `c01`–`c14` + `m01`–`m12` |
| moment | 8 | 640×427 | `moment/` | 关键时刻插图 |
| honor | 12 | 256×256 | `honor/` | 荣誉徽章 |
| scenario | 4 | 640×427 | `scenario/` | 剧本封面 |
| pylon | 3 | 750×180 | `pylon/` | 金字塔横幅 |
| community | 12 | 128×128 ×8 / 480×160 ×3 / 480×320 ×1 | `community/` | 头像、情绪条、媒体话筒 |
| end | 8 | 384×384 ×5 / 750×420 / 640×427 / 750×1000 | `end/` | 评级、生涯墙、奖杯架、分享框 |
| texture | 6 | 256×256 | `texture/` | 走 CSS 背景，不生成 `<img>` |

**命名规则**（`scripts/check-art.mjs` 断言）：`^[a-z]+-[a-z]?\d{2}-[a-z0-9-]+\.webp$`，
实际落盘 `assets/img/<组目录>/`。缺图只 warning，`--strict` 才算失败；总体积不得超 `budgetKB`；
`dist/` 里不得出现 `art-manifest.json`。

**画风约定**（见美术规范）：风格 D 92 张 / 风格 G 13 张；
例外 `scenery-05-tactics-board` 与 `texture-06-grid` 用 G。要整体换画风只需替换提示词里的
`[S-D]` / `[S-G]` 两段，105 条正文不用改。

## 8. 加一条东西的正确流程

| 想加 | 步骤 | 跑什么 |
|---|---|---|
| 一个国家/俱乐部 | 改 `COUNTRIES`（tiers + teamsPerTier）→ 补 `CITY_POOL` | `npm test`（776 的断言会红，需同步改期望值） |
| 一个洲际赛事 | `CONTINENTAL_COMPETITIONS` 加 meta → `CONTINENTAL_RULES` 写名额配方并满足守恒 → `CONTINENTAL_PARTICIPANTS` 补数 | `tests/qualify.spec.ts` |
| 一个关键时刻 / 事件链 / 剧本 | `config/{moments,chains,scenarios}.ts` 追加条目，遵守各自铁律 | `tests/p7.spec.ts` |
| 一个数值旋钮 | 只在 `balance.ts` 加，然后在规则层引用 | `tests/play.spec.ts` |
| 一张图 | `assets/art-manifest.json` 加图位 → `npm run gen:art` → webp 放 `assets/img/<组>/` | `npm run check:art`（`--strict`） |
