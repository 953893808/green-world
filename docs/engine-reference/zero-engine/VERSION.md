# 引擎参考：零引擎（zero-engine）

**Last verified: 2026-10-22**

> 本项目的「引擎」是**没有引擎**：没有 Godot / Unity / Unreal，没有 ECS、渲染器、
> 资源加载器或物理中间件。这里钉的不是引擎 API，而是**运行时与构建工具链的版本**，
> 版本信息以项目配置与实际校验结果为准。
>
> 本项目唯一相关的「引擎参考」是本文件：它记录运行时与构建工具链的版本基线。

## 1. 版本基线（改动前先看这张表）

| 项 | 钉死版本 | 出现位置 | 说明 |
|---|---|---|---|
| Node.js | **>= 24.20** | `package.json` → `engines.node` | 用原生 `--experimental-strip-types` 以外的一切都按 24 的特性写 |
| TypeScript | **5.9.3** | `devDependencies` | `tsc --noEmit` 即全部类型校验，无 bundler 类型插件 |
| Vite | **8.3.4** | `devDependencies` | 构建与开发服；插件 API 是 v8 形态 |
| Vitest | **5.0.5** | `devDependencies` | 15 个 spec / 271 项 |
| 运行时依赖 | **无** | `package.json` → `dependencies` 为空 | 见 §4 |
| 浏览器基线 | 现代 Chromium / Edge（冒烟用 CDP 驱动） | `scripts/smoke.mjs` | 只用 ES2022 稳定语法 + `<script defer>` |

工具链版本**逐字钉死、不用 `^` 或 `~`**：Vite 8 与 Vitest 5 都是大版本跃迁，
semver 范围内的行为差异足以让 `file://` 产物或测试基线翻车。

## 2. 为什么这几个版本重要（训练数据之后的变化）

| 主题 | 容易写错的旧习惯 | 本项目必须怎么写 |
|---|---|---|
| Vite 插件 | 用 Rollup 2 时代 `generateBundle` 拼字符串 | 用 v8 的 `transformIndexHtml` / `closeBundle` 钩子，见 `vite.config.ts` 的 `htmlLiteralMin()`、`compactMarkup()`、`offlineHtml()`、`copyArt()` |
| ESM 解析 | 以为 `type="module"` 在本地能直接双开 | `file://` 下 origin 为 `null`，module 与 `fetch()` 全被 CORS 拦死 → 构建期改写为 `<script defer>` |
| TypeScript 5.9 | 用 `enum` / 装饰器 / `namespace` 图省事 | 只用 `type` / `interface` / `as const` / 字面量联合，产物零运行时开销 |
| Node 24 | `fs.existsSync` 之外的老式回调写法 | `node:fs` 同步 API + `readdirSync({recursive:true})`，见 `copyArt()` |
| 测试 | 用 jest 形态的 `jest.fn()` | Vitest 的 `vi.*`；规则层 spec 全是纯函数/快照式断言，`tests/ui-*.spec.ts` 另外覆盖 DOM 挂载与动作分发 |

## 3. 「零引擎」的五个具体含义

1. **渲染**：没有渲染管线。界面是字符串模板 → 一次 `innerHTML` 挂载（`src/ui/dom.ts`）。
2. **资源**：没有资源加载器。105 张 WebP 走运行时相对路径 `./assets/img/...`，由构建期
   `copyArt()` 搬进 `dist/`；图位表是**编译进 bundle 的字符串**（`src/ui/art-manifest.ts`），
   运行时绝不 `fetch()` JSON。
3. **物理/动画**：没有。所有「动」都是 CSS transition。
4. **状态**：没有 ECS。单一可变 `AppState`（`src/ui/state.ts`）+ 纯函数规则层。
5. **声音**：无音频资源，无音频引擎。

## 4. 依赖政策（硬性）

- **运行时依赖必须为 0**。任何 `dependencies` 新增都会让 `file://` 成品多一个打包风险，PR 直接拒。
- devDependency 只允许：`typescript` / `vite` / `vitest` + 它们的传递依赖。
- 禁止引入 UI 框架（React/Vue/Svelte）、状态库、样式预处理（Sass/Tailwind）、图标库。
- 需要新能力时先问：能不能 30 行内自己写完（`scripts/smoke.mjs` 的 CDP 客户端就是自写的零依赖实现）。

## 5. 体积与性能预算（有断言看守）

| 预算项 | 上限 | 现状 | 看守者 |
|---|---:|---:|---|
| 代码（`dist/app.js` + `index.html` + `style.css`） | ≤ 207 KB（app.js ≤ 197 KB、gzip ≤ 64 KB；2026-10-23 审查修复轮，与用户确认） | 2026-10-23 实测快照：app.js 195.6 KB + index 1.5 KB + style 9.2 KB = 206.3 KB，gzip 63.9 KB（修复前基线 186.5 KB / 60.6 KB） | `npm run smoke:static`（3 条硬断言，失败 exit 1） |
| 美术总量 | ≤ 1536 KB | 847 KB | `scripts/check-art.mjs`（`budgetKB`） |
| 单季存档 | ≤ 256 KB | ≈ 128 KB | `tests/save.spec.ts` + `state.saveSizeText()` |
| 首屏可交互 | ≤ 1 s（无图也能玩） | 冒烟断言 | `npm run smoke` |

## 6. `file://` 兼容硬约束清单

双击 `dist/index.html` 必须能玩，因此：

1. `<script defer>`，**不是** `type="module"`（`offlineHtml()` 构建期改写并去 `crossorigin`）。
2. 禁止 `fetch()` / `XMLHttpRequest` / `import()` 动态加载任何本地文件。
3. 禁止 Service Worker、`localStorage` 以外的一切存储（存档就是 localStorage）。
4. 资源路径必须是**相对路径**（`./assets/...`），不能以 `/` 开头。
5. 不许用绝对 URL、CDN 字体、外链图片——成品要能完全离线。

## 7. 升级流程（把基线往上抬时）

1. 只改 `package.json` 里对应一项的版本，`npm.cmd install` 重装。
2. 依次跑：`npm.cmd run typecheck` → `npm.cmd run test` → `npm.cmd run build` → `npm.cmd run smoke`。
3. 四项全绿才更新本文件的版本表与 `Last verified` 日期。
4. 若 Vite 大版本升级：重点复验 `vite.config.ts` 四个插件的钩子是否还存在、构建日志是否仍打印
   `copy-art: 105 张 WebP → dist/assets/img`、`dist/index.html` 是否仍是 `defer`。
5. 若 Node 升级：复验 `copyArt()` 的 `readdirSync({recursive:true})` 与 `cpSync` 行为。

> 在受限 Windows 沙箱中，Vite 可能因子进程权限限制报 `spawn EPERM`；在常规本地终端运行构建命令。

## 8. 相关文件

- 工具链配置：`package.json`、`tsconfig.json`、`vite.config.ts`
- 校验脚本：`scripts/gen-art.mjs` / `scripts/check-art.mjs` / `scripts/smoke.mjs`（行数不在此维护，以文件为准）
- 架构总览：`docs/architecture/ARCHITECTURE.md`
- 关键决策：`docs/architecture/ADR-0001-zero-engine-and-no-runtime-deps.md`
