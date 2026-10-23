# 架构说明（ARCHITECTURE）

> 本文只描述**代码事实**，规格意图见
> 项目规格，数值与表格清单见 `docs/registry/REGISTRY.md`。
> 运行时与体积约束见 `docs/engine-reference/zero-engine/VERSION.md`。

## 1. 一句话架构

**纯函数规则层 + 单一可变存档对象 + 字符串模板界面**：

```
main.ts（路由 + data-act 事件委托）
  └─ ui/（state.ts 状态与动作、views/* 生成 HTML、art.ts 取图、dom.ts 挂载）
       └─ game/game.ts（双模式统一入口：newGame / advanceGame / rollSeason / loadFrom…）
            ├─ world/    生成 12 国 776 俱乐部 + 赛季赛程
            ├─ match/    单场模拟（含 P7 两段式 MatchFlow）
            ├─ rules/    推进 / 积分榜 / 抽签 / 资格 / 升降级 / 赛季结算
            ├─ national/ 国家队线（国家联赛 A–D + 洲际杯 + 世界杯）
            ├─ save/     seed + 增量 编解码与持久化
            └─ play/     双模式状态机（career / manager）+ 财政/声望/成长/转会/征召/事件链/社区/剧本
                 └─ config/ 全部配置表（赛事、国家、资格、链、时刻、剧本、日历）
                 └─ balance.ts 全部数值旋钮
                 └─ types.ts   全部领域类型
```

依赖方向**单向向上**：`core ← game(config/types/balance) ← game/*(world/match/rules/national/save/play) ← game.ts ← ui/* ← main.ts`。
反向依赖（规则层 import 界面、UI 直接 import 世界内部实现）视为缺陷。

## 2. 分层与职责

| 层 | 文件 | 职责 | 不许做什么 |
|---|---|---|---|
| 确定性随机 | `src/core/rng.ts` | `Rng`、`streamRng(worldSeed, ...tags)`、`poisson` | 不许直接 `Math.random()`（全局禁止） |
| 类型 | `src/game/types.ts` | 全部领域类型：`ConfederationId`（六会）、`Mode = 'career'\|'manager'`、`Player` / `Club` / `WorldState` / `Fixture` / `MatchResult` / `QualificationRule` / `DrawRules` … | 不许放逻辑 |
| 数值 | `src/game/balance.ts` | **全部**可调数值（131 个旋钮）+ `BALANCE.saveVersion` | 其他文件不许出现魔法数 |
| 配置表 | `src/game/config/*.ts` | 国家/赛事/资格/抽签/事件链/关键时刻/剧本/日历/位置 | 不许 import 规则层 |
| 世界生成 | `src/game/world/generate.ts` | `generateWorld(seed)`：12 国按层级建 776 俱乐部，程序化城市名 + 后缀，禁真实俱乐部名 | — |
| 赛程 | `src/game/world/schedule.ts` | `createSeason(world, season)`：联赛/杯赛/洲际/国家队赛程落到周；`stageName`、`findSchedulingConflicts` | — |
| 比赛 | `src/game/match/simulate.ts` | 单场比分与事件 | — |
| 两段式比赛 | `src/game/match/flow.ts` | `MatchFlow`：上半场 → 半场决策（心态/战术/换人）→ 下半场 → 关键时刻；出口仍是 `MatchResult` | 不许回改已发生的比分 |
| 周推进 | `src/game/rules/advance.ts` | 一周内所有赛事推进、赛果落库、能量/状态衰减 | — |
| 积分榜 | `src/game/rules/standings.ts` | `computeStandings`：**纯由赛果重算**，不落存档 | — |
| 抽签 | `src/game/rules/draw.ts` | 分档 → 上下档配对 → 回避校验 → 交换最多 200 次 → 失败降级并记 `degraded` | 纯函数，不读 world |
| 资格 | `src/game/rules/qualify.ts` | 按配置表解释名额与资格链，产出 `QualificationEntry[]` | 不许硬编赛事 id 分支 |
| 国家队推进 | `src/game/national/advance.ts` | 国家联赛 A–D + 洲际杯 + 世界杯的赛程推进与结算 | — |
| 国家队生成 | `src/game/national/generate.ts` | 12 支国家队、声望、分档 | — |
| 国家队赛程 | `src/game/national/schedule.ts` | 国家队赛事定义与赛程插入 | — |
| 存档编码 | `src/game/save/encode.ts` | world → `seed + 增量`（骨架赛果压成定长字符列） | 静态世界绝不进存档 |
| 存档解码 | `src/game/save/decode.ts` | 种子重生 → 复刻赛季骨架 → 回填增量；坏字段归一化，版本不符才拒绝 | 与 encode 严格对称 |
| 持久化 | `src/game/save/persist.ts` | `SaveController`：localStorage 读写、防抖、导入导出 | — |
| 双模式入口 | `src/game/game.ts` | `newGame` / `advanceGame` / `rollSeason` / `retire` / `rehire` / `canContinue` / `buildSave` / `loadFrom` / `loadFromStorage` / `roundTrip`，并 re-export 存档 API 与状态类型 | UI 只跟这一层打交道 |
| 生涯模式 | `src/game/play/career.ts` | 创建 → 逐周 → 赛季结算 → 成长/退役 → 评级 | — |
| 经理模式 | `src/game/play/manager.ts` | 创建 → 逐周 → 结算 → 董事会/球迷情绪 → 下课与再就业 | — |
| 财政 | `src/game/play/finance.ts` | 门票+转播+赞助+奖金 − 工资/差旅/青训/利息 | — |
| 声望 | `src/game/play/reputation.ts` | 俱乐部/国家队两类落 `WorldState`，教练与赛事为派生值 | — |
| 成长身价 | `src/game/play/growth.ts` | 成长 = 速率 × 剩余潜力 × 年龄 × 出场 × 训练 | — |
| 转会 | `src/game/play/transfer.ts` | 每周 `transferPerWeek` 笔，AI 按位置需求 × 声望差 × 财政余量挑人 | — |
| 谈判 | `src/game/play/negotiation.ts` | 四关：估价 → 球员意愿 → 经纪人 → 注册与工资帽，失败给原因码 | — |
| 征召 | `src/game/play/callup.ts` | 人气 ≥ `nationalCallFame` 且位置/国籍匹配者入队 | — |
| 事件链 | `src/game/play/chains.ts` | 同时活跃 ≤ `chainMaxActive`，每步有 `dueWeek`，结束记 `chainDone` 不再触发 | 效果只走 `advanceWeek` 入口 |
| 世界活性 | `src/game/play/activity.ts` | 世界新闻 + 董事会简报 + 媒体采访；**只动软数值**（form/morale/董事会/球迷） | 不许改积分与资格 |
| 社区 | `src/game/play/community.ts` | 球迷热评；可整体关闭，关闭后返回空数组且游戏正常 | 同上 |
| 剧本 | `src/game/play/scenario.ts` | 固定种子建经理档 → 真实推进到 `startWeek` → 施加「开场不利」 | 不许伪造积分 |
| 界面状态 | `src/ui/state.ts` | `app`（`AppState`）、`ScreenId`、开局草稿、全部玩家动作（`startNewGame` / `advanceOneWeek` / `startLiveMatch` / `applyHalfTime` / `makeBid` / `answerChain` …） | 不许复制规则逻辑，只调度 |
| 取图 | `src/ui/art.ts` | `img(key)` 唯一入口；断图降级为同色系渐变块；texture 组走 CSS 背景 | 运行时禁 `fetch()` 读 JSON |
| 图位表 | `src/ui/art-manifest.ts` | 由 `assets/art-manifest.json` 经 `npm run gen:art` 生成的紧凑字符串表 | 手改无效，构建会覆盖 |
| DOM | `src/ui/dom.ts` | 字符串拼装 + 一次 `innerHTML` 挂载 + `data-act` 委托 | 不许引入虚拟 DOM 库 |
| 视图 | `src/ui/views/{common,home,dashboard,world,live,match,misc}.ts` | 7 个视图文件承载 21 屏；`common.ts` 是统一外壳（顶栏/底栏/提示条） | 视图只输出字符串 |
| 路由入口 | `src/main.ts` | `ROUTES`（21 屏）+ 46 个 `data-act` 分支 | — |

`src/` 的文件数与行数以 `find src -name "*.ts" | wc -l` 与 `wc -l` 实测为准，**本文不维护行数**：上一版维护了 37 个行数，一次并行改动后 37 个全部漂移，回填只会再错一次。

## 3. 21 屏与视图归属

`src/main.ts:58-80` 的 `ROUTES: Record<ScreenId, () => string>` 是唯一真实清单：

| 视图文件 | 屏 |
|---|---|
| `views/home.ts` | `home`、`setup` |
| `views/dashboard.ts` | `dashboard` |
| `views/live.ts` | `match-live`、`season-end`、`career-end` |
| `views/match.ts` | `match-preview`、`match-report`、`draw` |
| `views/world.ts` | `world-pylon`、`competition`、`qualification` |
| `views/misc.ts` | `calendar`、`squad`、`finance`、`board`、`settings` |
| `views/common.ts` | 外壳（非独立屏） |

其余三屏 `transfer`、`negotiation`、`community`、`scenario` 由 `live.ts` / `match.ts` 的辅助函数与 `dashboard.ts` 局部渲染。
> ⚠️ 若新增屏：`state.ts` 的 `ScreenId` 加成员 → `ROUTES` 加分支 → 视图函数返回字符串 → 每个按钮带 `data-act`。

## 4. 数据流

### 4.1 开局

```
homePage（选模式） → setupPage（四步：kind → country → target → detail）
  → state.startNewGame() → game.newGame({seed, mode, ...}) → GameSession{state, world}
  → persistNow()（存 seed + 玩家状态） → go('dashboard')
```
开局页需要**真实俱乐部/国家队清单**（要拿到 id 才能传给创建函数），世界只生成一次并缓存，避免每次重绘重跑。

### 4.2 每周推进

```
dashboard「推进一周」 → state.advanceOneWeek(playerResult?)
  → game.advanceGame(session, options) → rules/advance 推进全部赛事
  → play/{career,manager} 结算成长/财政/声望 → play/{chains,activity,community} 叙事层
  → 若本周有玩家比赛：先 match-preview → 可选 match-live（两段式）→ match-report
  → state.persistNow()（防抖）
```

### 4.3 比赛（P7 两段式）

`match/flow.ts` 把一场拆成 上/半场决策/下/关键时刻 四段，每段决策只改「剩余比赛的 `attackEdge` / `defenseEdge`、体能、换人名额」，**绝不回改已发生的比分**，最终仍产出单一 `MatchResult`。

### 4.4 赛季结束

```
advanceGame 到最后一周末 → 赛季结算（积分/冠军/资格/升降级/声望/财政）
→ state.rollToNextSeason() → game.rollSeason → 下一季 createSeason
→ season-end 屏 → 若退役/下课 → career-end 屏（retire / rehire）
```

### 4.5 存档（只存增量）

```
world（776 俱乐部 + 全部赛事） --encode--> {seed, mode, state, 增量列}
{seed, mode, ...} --decode--> createSeason(generateWorld(seed)) + 回填 → 与存档前一致的 world
```
静态世界（俱乐部、国家、赛事定义）**永不入档**；积分榜不存，用 `computeStandings` 从赛果重算；已踢赛果按骨架顺序压成每场 1 字符。

## 5. 确定性契约（读档正确性的前提）

1. 所有随机都走 `streamRng(worldSeed, ...tags)` 派生的独立流；同种子 + 同输入 = 同结果。
2. `tags` 按用途分流（如 `('activity', week)`），因此**改动调用顺序会改变结果**——扩功能时新增 tag，不要复用旧 tag。
3. 比赛 RNG 依赖 `world.week`，所以赛果无法重算，必须进存档；能在种子之外推出来的东西（积分榜、赛程骨架）一律不存。
4. `tests/world.spec.ts` 锁「同种子完全一致 / 不同种子不同」，`tests/play.spec.ts` 锁 41 项数值不变量。

## 6. 界面渲染管线

1. `render()`（`main.ts:82`）取 `ROUTES[app.screen]` 的字符串 → `mount()` 一次 `innerHTML`。
2. `document` 上一次性挂 `data-act` 委托；**没有 `data-act` 的按钮是死键**（冒烟断言看守）。
3. 图片只经 `img(key)` 取，`<img>` 必须带 `width`/`height`/`alt`/`loading`/`decoding`；挂图失败降级成同色渐变块，不发 404。
4. `dist/index.html` 用 `<script defer>`（构建期由 `offlineHtml()` 改写并去 `crossorigin`），因为 `type="module"` 在 `file://` 下会被 CORS 整包拦死。

## 7. 改动准则

| 想做的事 | 必须动哪里 | 不许动哪里 |
|---|---|---|
| 调数值 | `balance.ts` | 任何 `play/`、`rules/` 里的字面量 |
| 加赛事/名额 | `config/competitions.ts` + `config/qualification.ts` | `rules/qualify.ts` 里加 id 分支 |
| 加事件/时刻/剧本 | `config/{chains,moments,scenarios}.ts` | 引擎文件里的硬编码文案 |
| 加一屏 | `state.ts:ScreenId` + `main.ts:ROUTES` + `views/*` | `dom.ts`（保持极简） |
| 加存档字段 | `types.ts` → `encode.ts` 与 `decode.ts` **成对**改 → 升 `BALANCE.saveVersion` | 只改一侧（对称性是硬要求） |
| 加图片 | `assets/art-manifest.json` → `npm run gen:art` → 图放 `assets/img/<组>/` | 手改 `art-manifest.ts`、在视图里写死图片路径 |

## 8. 四道校验各守什么

| 命令 | 守的东西 | 现状 |
|---|---|---|
| `npm run typecheck` | 类型 / 未用变量 / 严格模式 | ✅ |
| `npm test`（vitest） | 世界生成、比赛、国家队、资格、存档、P5 数值、P7 玩法 共 15 个 spec / 271 项 | ✅ 271 通过 |
| `npm run build` | `gen:art` → `check:art` → `tsc` → `vite build` → `copy-art` | ✅ 代码约 206.3 KB（app.js 195.6 KiB）+ 847 KB 图 |
| `npm run smoke` | 零依赖 CDP 端到端：全流程无页面错误、`file://` 双击可跑、断图降级、首屏耗时、每个 button 有 `data-act` | ✅ 静态 12/12（完整 98 项需浏览器，本轮沙箱未复跑） |

> Windows 上受限沙箱会让 `vite` 的 `net use` 网络盘探测报 `spawn EPERM`，需放开沙箱后跑（与代码无关）。
