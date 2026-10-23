# ADR-0001: 零引擎原生 TypeScript + 零运行时依赖

## Status

Accepted

> 该决策自 P0 起即已实现并贯穿整个项目（P0–P7 全部按此交付，2026-10 实测项目校验全绿），
> 项目规格把它列为硬要求，故记为 Accepted 而非 Proposed。

## Date

2026-10-22

## Last Verified

2026-10-22

## Decision Makers

用户（产品与验收）+ 本项目技术负责人（架构与实现）

## Summary

成品必须能**双击 `dist/index.html` 离线开玩**，且代码 ≤ 207 KB（app.js ≤ 197 KB）、零第三方运行时依赖（预算按 2026-10-23 实测结果设置）。
为此决定不用任何游戏引擎与 UI 框架：规则层写成纯 TypeScript 函数，界面用字符串模板 + 一次
`innerHTML` 挂载 + `data-act` 事件委托，构建只做类型检查与打包。

## Engine Compatibility

| Field | Value |
|-------|-------|
| **Engine** | 无引擎（zero-engine）：纯 TypeScript 5.9.3 + Vite 8.3.4 + Vitest 5.0.5 |
| **Domain** | Core / UI / Scripting |
| **Layer** | Foundation |
| **Knowledge Risk** | MEDIUM — Vite 8 与 Vitest 5 在模型训练数据之后发版，插件钩子与产物形态必须现场核对 `docs/engine-reference/zero-engine/VERSION.md` |
| **References Consulted** | `docs/engine-reference/zero-engine/VERSION.md`、`vite.config.ts`、`scripts/smoke.mjs` |
| **Post-Cutoff APIs Used** | `node:fs` 的 `cpSync` / `readdirSync({ recursive: true })`；Vite v8 插件钩子 `transformIndexHtml` / `closeBundle` |
| **Verification Required** | 双击 `dist/index.html` 无白屏、105 张图 200 加载、`<script defer>` 而非 module、`npm run smoke` 98/98 |

## ADR Dependencies

| Field | Value |
|-------|-------|
| **Depends On** | None |
| **Enables** | 存档「seed + 增量」方案（ADR 待补）、面板与视图字符串渲染约定（ADR 待补） |
| **Blocks** | 任何引入 UI 框架 / 引擎 / 运行时 npm 包的提案 |
| **Ordering Note** | 这是全项目最底层约束，改动它等于重写界面层与构建流水线 |

## Context

### Problem Statement

目标玩家是「双击一个 HTML 文件就能玩」的桌面用户，产物要能离线、零安装、可放进 U 盘。
若引入引擎或 UI 框架，产物会变成数百 KB 到数百 MB 的 bundle，且 `file://` 下的
module / fetch / WebAssembly 加载会被 CORS 拦死。不决定这一点，后续每个功能都会在
「要不要引依赖」上反复拉扯。

### Current State

项目从 P0 起就是零引擎：`src/` 54 个 `.ts` + 1 个 `.css`，13 110 行；
`package.json` 的 `dependencies` 为空；成品 `dist/` 只有 `app.js`（190,254 B）、
`index.html`（1,475 B）、`style.css`（8,649 B）外加 `assets/img/`（105 张 / 847 KB）。

### Constraints

- **平台**：Windows 桌面，双击 `file://` 打开；origin 为 `null`。
- **产物**：代码 ≤ 207 KB（app.js ≤ 197 KB）、美术 ≤ 1536 KB、整季存档 ≤ 256 KB（2026-10-23 审查修复轮）。
- **离线**：零外网请求，禁用 CDN、外链字体、Service Worker。
- **确定性**：同种子同输入必须同结果（读档靠 seed 重生世界），因此随机必须可控可分流。
- **人力**：单人 + AI 协作，没有引擎编辑器工作流可依赖。

### Requirements

- 功能：21 屏、双模式（球员/主帅）、776 俱乐部世界、国家队线、P7 两段式比赛与事件层。
- 性能：首屏无图也能 1 秒内可交互。
- 可维护：单一数值落点（`balance.ts`）、单向依赖、纯函数规则层。
- 可验证：类型检查 + 单测 + 构建 + 端到端冒烟四道关，且冒烟必须能验证 `file://` 真路径。

## Decision

**不使用任何游戏引擎、UI 框架、状态库、样式预处理器与运行时 npm 依赖。**

- 规则层：纯 TypeScript 纯函数，随机统一走 `streamRng(worldSeed, ...tags)`。
- 界面层：`views/*.ts` 返回 HTML 字符串 → `dom.ts` 一次 `innerHTML` 挂载 →
  `document` 上单点 `data-act` 事件委托；样式手写 CSS（391 行）。
- 构建：`gen:art → check:art → tsc --noEmit → vite build`，再由 `copyArt()` 把 `assets/img`
  搬进 `dist/`，`offlineHtml()` 把 `<script type="module">` 改写成 `<script defer>` 并去 `crossorigin`。
- 端到端验证：`scripts/smoke.mjs` 自带零依赖 CDP 客户端驱动浏览器跑 98 项断言。

### Architecture

```
state.ts (AppState) ──► views/*.ts (返回 HTML 字符串) ──► dom.ts (一次 innerHTML)
      ▲                          │
      │ data-act 委托            │ img(key)
      │                          ▼
main.ts (ROUTES 21 屏)      art.ts ──► art-manifest.ts ──► ./assets/img/<组>/*.webp
      │
      ▼
game.ts (newGame/advanceGame/rollSeason/loadFrom)
      ├─ world/ match/ rules/ national/ save/ play/  ← 纯函数，无 DOM、无 I/O
      └─ config/* + balance.ts + types.ts
```

### Key Interfaces

```ts
// 界面只跟 game.ts 打交道
newGame(options: NewGameOptions): GameSession
advanceGame(session: GameSession, options?: AdvanceOptions): AdvanceResult
rollSeason(session: GameSession): GameSession
loadFrom(raw: unknown):
  | { ok: true; session: LoadedGame }
  | { ok: false; reason: string; repaired: string[] }

// 取图唯一入口
img(key: string): ArtImage                     // 断图时返回同色系渐变块，不发 404

// 确定性随机唯一入口
streamRng(worldSeed: number, ...tags: (string | number)[]): Rng

// 视图契约
type Screen = () => string                     // 纯字符串，无副作用
```

### Implementation Guidelines

1. 任何 `dependencies` 新增都要先写一份 ADR 推翻本决策；devDependency 只允许 TS / Vite / Vitest。
2. 视图函数必须是「输入 state → 输出字符串」，不许在视图里推进状态或算规则。
3. 每个 `<button>` 必须带 `data-act`；图片只经 `img(key)` 取且带
   `width`/`height`/`alt`/`loading`/`decoding`。
4. 禁止 `fetch()` 读本地 JSON（图位表编译进 bundle）。
5. 数值只写 `balance.ts`；随机只走 `streamRng`。

## Alternatives Considered

### Alternative 1: Godot / Unity / Unreal 导出 Web

- **Description**: 用成熟引擎做比赛表现与 UI，导出 Web 或桌面包。
- **Pros**: 动画/音频/物理开箱即用；编辑器所见即所得。
- **Cons**: 产物数 MB 起步，Web 导出的加载依赖 `fetch`/WASM，`file://` 双击基本跑不起来；
  与「≤207 KB、零安装、双击即玩」直接冲突。
- **Estimated Effort**: 更高（要重写全部规则层为引擎脚本）。
- **Rejection Reason**: 与成品形态硬冲突。

### Alternative 2: React / Vue + 路由 + 状态库

- **Description**: 用组件框架做 21 屏，Vite 打包。
- **Pros**: 组件复用、生态成熟、开发体验好。
- **Cons**: 运行时 + 框架体积即顶爆 207 KB 预算；仍需解决 `file://` 下 module 被拦的问题；
  21 屏重度信息展示用模板字符串更直接。
- **Estimated Effort**: 相近。
- **Rejection Reason**: 体积预算不允许，且没有为框架换来必要能力。

### Alternative 3: Canvas 自绘 UI（保留图形能力但不引框架）

- **Description**: 全部界面画在单个 canvas 上。
- **Pros**: 表现自由，无 DOM 布局限制。
- **Cons**: 文本排版、可访问性、滚动区域全部要手写；信息密度高的 21 屏成本极高。
- **Estimated Effort**: 显著更高。
- **Rejection Reason**: 收益低于成本，DOM + CSS 已经够用。

## Consequences

### Positive

- 成品就是三个文件 + 一个图片目录，双击即玩，可离线分发。
- 规则层是纯函数，单测不需要 DOM 环境，271 项测试可快速跑完。
- 依赖面为零，升级风险集中在 TS / Vite / Vitest 三处。
- 数值与配置高度集中，AI 协作时改动边界清晰。

### Negative

- 所有交互与动画要手写；复杂动效（粒子、骨骼）做不了。
- 无组件生态，重复 UI 只能靠模板函数复用。
- `file://` 的坑要自己踩（module/CORS、资源路径、`defer` 改写）。

### Neutral

- 渲染是「整屏重建」而非增量 diff；对 21 屏的信息密度来说足够。
- 图位表选择「编译期字符串」而非运行时 JSON，换来体积与 `file://` 兼容。

## Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| 体积预算随功能增长被顶爆 | 中 | 高 | 每次 `npm run build` 核对 app.js 大小；图位表用紧凑字符串；优先文本而非图片 |
| Vite 大版本升级破坏 `defer` 改写 | 低 | 高 | `npm run smoke` 的 `file://` 断言是硬门；构建日志核对 `copy-art` 计数 |
| 手写 UI 缺乏可访问性 | 中 | 中 | 冒烟断言 `<img>` 属性齐备；`data-act` 全量覆盖 |
| 整屏重建导致输入态丢失 | 中 | 中 | 交互只走 `data-act` 单点委托，输入态统一放 `app`（如开局草稿） |

## Performance Implications

| Metric | Before | Expected After | Budget |
|--------|--------|---------------|--------|
| 代码体积 | — | ≈ 206 KB | ≤ 207 KB（app.js ≤ 197 KB） |
| 美术体积 | — | 847 KB | ≤ 1536 KB |
| 首屏可交互 | — | < 1 s（无图也可玩） | ≤ 1 s |
| 单季存档 | — | ≈ 128 KB | ≤ 256 KB |

## Migration Plan

本决策是既有实现，不需要迁移。若将来要推翻（例如改用引擎）：

1. 先写新 ADR 并标本 ADR 为 `Superseded by ADR-XXXX`。
2. 规则层（`src/game/**`）可原样保留，只重写 `src/ui/**` 与构建流水线。
3. 用 `tests/**` 的 271 项作为回归护栏，确保规则层行为不变。
4. 重跑四道关 + `file://` 双击验收。

**Rollback plan**：无代码回滚需求；决策层面把本 ADR 状态改回 `Proposed` 并附新 ADR 即可。

## Validation Criteria

- [ ] `npm.cmd run typecheck` / `test`（271）/ `build` / `smoke --static`（12/12；完整 98 项需浏览器）全绿
- [ ] 双击 `dist/index.html` 能开局并推进一整周
- [ ] `dist/index.html` 内是 `<script defer>`，无 `crossorigin`、无 `type="module"`
- [ ] 105 张 WebP 全部 200 加载，断图时降级为渐变块且无 404
- [ ] `package.json` 的 `dependencies` 为空

## GDD Requirements Addressed

| GDD Document | System | Requirement | How This ADR Satisfies It |
|---|---|---|---|
| 项目规格 | 全局 | 零引擎：纯 TypeScript + Vite，成品 ≤ 207 KB、零第三方运行时依赖、零外网请求 | 全项目无运行时依赖；`dist/` 三个文件 ≈ 206 KB；冒烟断言无外部请求 |
| 项目规格 §10 | 界面 | 21 屏、每个按钮可点、断图降级 | 字符串模板 + `ROUTES` 21 屏 + `data-act` 委托 + `img()` 降级 |
| 项目规格 §11.2 | 存档 | 只存 seed + 增量，整季 ≤ 256 KB | 纯函数世界生成使「seed 重生」成立；实测 ≈ 128 KB |
| 项目规格 §6–§7 | 比赛/数值 | 同种子同输入同结果；数值集中可调 | `streamRng` 分流 + `balance.ts` 单一数值落点 |

## Related

- `docs/architecture/ARCHITECTURE.md`（分层与模块职责）
- `docs/engine-reference/zero-engine/VERSION.md`（工具链版本基线）
- `docs/registry/REGISTRY.md`（配置表、规则表、图位表索引）
- 代码：`src/game/game.ts`、`src/ui/state.ts`、`src/ui/dom.ts`、`src/ui/art.ts`、`vite.config.ts`
