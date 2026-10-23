# 验收截图（docs/screenshots/）

本目录的自动生成手机端验收截图共 11 张 PNG，390×844 逻辑像素、DPR 3（实际 1170×2532），
由 `npm run mobile` 用 Chrome DevTools Protocol 真实点击走完流程后逐屏截取。

## 为什么是手机视口

游戏面向手机竖屏 webview 环境，页面由单个 HTML 文件承载。
那边没有地址栏、没有桌面窗口，所以「桌面 1280×720 好看」不代表能玩；
真正要证明的是 390 px 宽度下不横滚、图能解码、返回键能退。

同时它仍然证明「离线可玩」：截图跑的目标就是单文件离线产物 `single/__ai_app.html`，
用 `file://` 加载，全程 0 个页面错误。

## 怎么重新生成

```powershell
npm.cmd run build        # 出 dist/
npm.cmd run build:single   # 压成 single/__ai_app.html（单文件）
npm.cmd run mobile       # 手机视口实测 + 覆盖本目录 11 张图
```

只想查桌面 `dist/` 不截图：`npm.cmd run mobile -- --target dist --no-shots`。

## 清单（11 张）

|  # | 文件名 | 屏 | 这一张证明什么 |
| -: | --- | --- | --- |
| 1 | `01-home.png` | 首页 | 首屏带 hero 图、无白屏、两个模式入口都在 |
| 2 | `02-setup-career.png` | 开局（联合会→国家→俱乐部→位置） | 世界已生成、能选到具体球队 |
| 3 | `03-dashboard.png` | 主控台 | 赛季/周次/下一场/关键指标齐全，底下动作条固定在拇指区 |
| 4 | `04-match-preview.png` | 赛前简报 | 对手与战术可选（仅本周有比赛时出现该入口） |
| 5 | `05-match-live.png` | 比赛中（半场面板） | P7 两段式：心态/战术按钮在 390 px 下不换行错位 |
| 6 | `06-match-report.png` | 赛后战报 | 比分、评分、关键时刻结果落地 |
| 7 | `07-transfer.png` | 转会 | 报价列表在窄屏下不横滚 |
| 8 | `08-season-end.png` | 赛季结算 | 名次、财政、声望、升降级结论 |
| 9 | `09-world-pylon.png` | 世界金字塔 | 六大洲金字塔在同一屏内可读 |
| 10 | `10-community.png` | 社区热评 | 舆情层默认可用 |
| 11 | `11-settings.png` | 设置 / 存档 | 可整体关闭社区、可导出导入存档 |

## 自动化同时断言的三件事

1. **无横向溢出**：每屏量 `document.documentElement.scrollWidth <= innerWidth`，
   越界会点名元素（`.table` / `.honor-grid` 之类），不是只看「截图好不好看」。
2. **图真的解码了**：所有 `<img>` 的 `naturalWidth > 0`；单文件包还额外要求
   `currentSrc` 是内联 `data:` 串。
3. **返回键可用**：`history.back()` 必须能退回上一屏并重绘（webview 里那是唯一退路）。

## 已知坑

- 用 `npm run dev`（端口 5199）看到的是开发服务器，**不是** `file://`，不能作为离线证据。
  而且它占着 5199 时，`npm run smoke` 会报 `EADDRINUSE`；先关掉 dev 再跑冒烟。
- `npm run dev` 下若 `127.0.0.1` 打不开，改用 `localhost`。
- 受限沙箱下 `npm run build` / `smoke` 可能报 `spawn EPERM`（Vite 探测网络盘），放开沙箱再跑。

## 桌面人工验收（可选补充）

需要「桌面窗口里双击 dist/index.html」的证据时，另存为 `desktop-*.png` 放本目录，
别覆盖上面的 11 张：两套口径不同，混在一起会分不清哪张证明了什么。
