#!/usr/bin/env node
/**
 * 移动端实测（390×844，DPR 3，触摸模拟）+ 出图。
 *
 * 为什么单独一个脚本而不是塞进 smoke.mjs：
 * smoke 验的是「桌面 file:// 能不能玩、有没有页面错误」，这里验的是另一件事 ——
 * 手机宽度下会不会横向溢出、那种单文件包在 webview 里图能不能解码。
 * 两件事的失败原因完全不同，混在一起报错会互相污染。
 *
 * 与 smoke 一样刻意不用 Playwright：设计硬约束是「零第三方依赖」，
 * 直接走 Chrome DevTools Protocol（Node 24 自带 WebSocket）。
 *
 * 用法：
 *   npm run mobile                      # 默认查单文件包，出 8 张图到 docs/screenshots/
 *   npm run mobile -- --target dist     # 改成查 dist/index.html
 *   npm run mobile -- --no-shots        # 只查不截图
 *
 * 环境变量：
 *   CHROME_PATH   浏览器路径（显式给了但文件不存在 → 视为没有浏览器，方便复现 SKIP 分支）
 *                 不传则依次找 Chrome / Edge
 *   MOBILE_PORT   CDP 端口，默认 9334（避开 smoke 的 9333，两者可同时跑）
 *
 * 退出码（CI 靠它区分「通过」和「没验」）：
 *   0 = 35 项全过
 *   1 = 有断言失败，或浏览器起来了但 CDP 连不上/超时
 *   2 = 找不到浏览器 —— 一项都没跑，**不是通过**
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const WIDTH = Number(opt('width', 390));
const HEIGHT = Number(opt('height', 844));
const CDP_PORT = Number(process.env.MOBILE_PORT ?? 9334);
const SHOTS = !flag('no-shots');
const shotsDir = join(root, 'docs', 'screenshots');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (n) => `${Math.round((n / 1024) * 10) / 10} KB`;

/* ------------------------------------------------------------------ 目标 */

function pickTarget() {
  const want = opt('target', 'single');
  if (want === 'dist') {
    const file = join(root, 'dist', 'index.html');
    if (!existsSync(file)) throw new Error('dist/index.html 不存在，先跑 npm run build');
    return { kind: 'dist', file };
  }
  const file = join(root, 'single', '__ai_app.html');
  if (!existsSync(file)) throw new Error('single/__ai_app.html 不存在，先跑 npm run build:single');
  return { kind: 'single', file };
}

/* ------------------------------------------------------------- CDP 骨架 */

function findChrome() {
  // 显式指定了 CHROME_PATH 就以它为准：路径不存在时**视为没有浏览器**，
  // 而不是偷偷回退到自动探测（否则「强制无浏览器」没法复现 SKIP 分支）。
  if (process.env.CHROME_PATH) return existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
  ].find((p) => existsSync(p)) ?? null;
}

async function waitForDevtools(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(120);
  }
  throw new Error(`DevTools 在 ${timeoutMs}ms 内没起来（端口 ${CDP_PORT}）`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (e) => this.onMessage(e));
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', fail, { once: true });
    });
    return new Cdp(ws);
  }

  onMessage(event) {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { ok, fail } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) fail(new Error(msg.error.message ?? 'CDP 错误'));
      else ok(msg.result);
      return;
    }
    if (msg.method) {
      for (const handler of this.listeners.get(msg.method) ?? []) handler(msg.params);
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          fail(new Error(`CDP 超时：${method}`));
        }
      }, 60000);
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 已关 */
    }
  }
}

class Page {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.errors = [];
  }

  send(method, params = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`页面内异常：${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }

  async click(selector) {
    const hit = await this.eval(
      `(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.click(); return true; })()`,
    );
    await sleep(60);
    return hit === true;
  }

  screen() {
    return this.eval('window.__GREENWORLD__ ? window.__GREENWORLD__.screen() : null');
  }

  async waitScreen(name, ms = 8000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if ((await this.screen()) === name) return true;
      await sleep(50);
    }
    return false;
  }

  attachErrors() {
    this.cdp.on('Runtime.exceptionThrown', (p) => {
      this.errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '未知异常');
    });
    this.cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error') return;
      this.errors.push(
        (p.args ?? []).map((a) => a.value ?? a.description ?? a.unserializableValue ?? '').join(' ') || '(console.error)',
      );
    });
    this.cdp.on('Log.entryAdded', (p) => {
      if (p.entry?.level === 'error') this.errors.push(p.entry.text ?? '');
    });
  }

  async shot(name) {
    if (!SHOTS) return 0;
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const file = join(shotsDir, name);
    writeFileSync(file, Buffer.from(data, 'base64'));
    return statSync(file).size;
  }

  /** 横向溢出检测：滚不动的页面在 webview 里最丢人，逐屏量 */
  layout() {
    return this.eval(`(() => {
      const w = window.innerWidth;
      const bad = [];
      for (const el of document.querySelectorAll('#app *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > w + 1) {
          bad.push((el.className && String(el.className).split(' ')[0]) || el.tagName);
        }
      }
      return { innerW: w, scrollW: document.documentElement.scrollWidth, offenders: [...new Set(bad)].slice(0, 5), count: bad.length };
    })()`);
  }
}

async function openTarget(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Page(cdp, sessionId);
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');
  page.attachErrors();
  return page;
}

async function waitLoaded(page, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const ready = await page.eval('document.readyState');
      const hasApp = await page.eval('!!document.querySelector("#app") && document.querySelector("#app").children.length > 0');
      if (ready === 'complete' && hasApp) return true;
    } catch {
      /* 导航中 */
    }
    await sleep(80);
  }
  return false;
}

/* ------------------------------------------------------------------ 主流程 */

/** 每屏都量一次布局；返回是否全部合格 */
async function auditScreen(page, label, shotName) {
  const lay = await page.layout();
  const ok = lay.scrollW <= lay.innerW + 1;
  check(
    `${label} 无横向溢出`,
    ok,
    ok ? `${lay.innerW}px` : `scrollWidth ${lay.scrollW} > ${lay.innerW}，越界元素：${lay.offenders.join(', ') || '匿名'}（${lay.count} 个）`,
  );
  if (shotName) {
    const size = await page.shot(shotName);
    check(`${label} 已截图 ${shotName}`, size > 1024, kb(size));
  }
  return ok;
}

async function run() {
  const target = pickTarget();
  const url = pathToFileURL(target.file).href;
  console.log(`\n目标：${target.kind} → ${target.file}（${kb(statSync(target.file).size)}）`);
  console.log(`视口：${WIDTH}×${HEIGHT} DPR 3 触摸模拟\n`);

  const exe = findChrome();
  if (!exe) {
    // 关键：没有浏览器时**绝不能 exit 0**。以前这里 `if (!exe) return;` 直接跳过汇总，
    // 脚本以 0 退出，CI 会把「一项都没跑」当成「35 项全过」。
    console.log('\n[SKIP] 找不到可用的 Chrome/Edge —— 手机端 35 项（含 11 张截图）一项都没执行。');
    console.log('       这不是 PASS。装 Chrome/Edge，或用 CHROME_PATH 指定可执行文件后重跑：');
    console.log('       CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" npm run mobile');
    console.log('       退出码约定：0 = 全过，1 = 有失败，2 = SKIP（CI 必须把 2 当作「未验证」而非通过）。');
    process.exitCode = 2;
    return;
  }
  check('找到可用的 Chrome/Edge', true, exe);

  const child = spawn(
    exe,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${join(tmpdir(), `greenworld-mobile-${process.pid}`)}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-gpu',
      `--window-size=${WIDTH},${HEIGHT}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp;
  try {
    const version = await waitForDevtools();
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    const page = await openTarget(cdp, url);

    // 手机形态：视口 + DPR + 触摸 + UA，缺一条都不算真机近似
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.send('Emulation.setUserAgentOverride', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    });
    await page.send('Page.navigate', { url });
    check('页面加载完成且 #app 有内容', await waitLoaded(page));

    if (SHOTS) mkdirSync(shotsDir, { recursive: true });

    console.log('\n[图片] 内联图能不能解码');
    const art = await page.eval(`(() => {
      const imgs = [...document.querySelectorAll('img')];
      const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0);
      const dataUri = imgs.filter((i) => i.currentSrc.startsWith('data:')).length;
      return { total: imgs.length, broken: broken.length, dataUri, first: imgs[0]?.currentSrc.slice(0, 24) ?? '' };
    })()`);
    check('首页 <img> 全部解码成功', art.total > 0 && art.broken === 0, `${art.total} 张，坏 ${art.broken} 张`);
    if (target.kind === 'single') {
      check('图是内联 data URI（单文件包）', art.dataUri === art.total, `${art.dataUri}/${art.total}，首张 ${art.first}…`);
    }

    console.log('\n[路由] 首页 → 开局 → 主控台');
    await auditScreen(page, '首页', '01-home.png');

    check('点「球员生涯」进开局页', (await page.click('[data-act="mode-career"]')) && (await page.waitScreen('setup')));
    await page.click('[data-act="pick-confederation"][data-confederation="UEFA"]');
    await page.click('[data-act="pick-country"][data-country="ENG"]');
    await page.click('[data-act="pick-target"]');
    await page.click('[data-act="pick-position"][data-position="FW"]');
    await auditScreen(page, '开局', '02-setup-career.png');

    check('开局成功进主控台', (await page.click('[data-act="start"]')) && (await page.waitScreen('dashboard')));
    await auditScreen(page, '主控台', '03-dashboard.png');

    console.log('\n[比赛] 赛前 → 半场 → 战报');
    // 本周就有比赛时才有「赛前简报」入口；没有就先推进到有比赛的那一周
    for (let i = 0; i < 8 && !(await page.eval('!!document.querySelector(`[data-act="nav"][data-screen="match-preview"]`)')); i++) {
      await page.click('[data-act="advance-week"]');
      if ((await page.screen()) !== 'dashboard') {
        await page.eval('document.querySelector(`[data-act="nav"][data-screen="dashboard"]`)?.click()');
        await sleep(80);
      }
    }
    if (await page.click('[data-act="nav"][data-screen="match-preview"]')) {
      check('赛前简报可进入', await page.waitScreen('match-preview'));
      await auditScreen(page, '赛前简报', '04-match-preview.png');
      await page.eval('document.querySelector(`[data-act="nav"][data-screen="dashboard"]`)?.click()');
      await sleep(80);
    } else {
      check('赛前简报可进入', false, '主控台没有该入口');
    }

    if (await page.click('[data-act="play-match"]')) {
      check('进入比赛（半场面板）', await page.waitScreen('match-live'));
      await auditScreen(page, '比赛中', '05-match-live.png');
      await page.eval('document.querySelector(`[data-act="mentality"]`)?.click()');
      await page.click('[data-act="half-time"]');
      await sleep(80);
      const moment = await page.eval('!!document.querySelector(`[data-act="moment-choice"]`)');
      if (moment) await page.eval('document.querySelector(`[data-act="moment-choice"]`)?.click()');
      const fin = await page.eval('!!document.querySelector(`[data-act="finish-match"]`)');
      if (fin) await page.eval('document.querySelector(`[data-act="finish-match"]`)?.click()');
      await sleep(120);
      check('赛后有战报', (await page.screen()) === 'match-report');
      await auditScreen(page, '赛后战报', '06-match-report.png');
    } else {
      check('进入比赛（半场面板）', false, '主控台没有「亲自踢」入口');
    }

    console.log('\n[其他屏] 转会 / 社区 / 金字塔 / 设置');
    await page.eval('document.querySelector(`[data-act="nav"][data-screen="dashboard"]`)?.click()');
    await sleep(80);
    if (await page.click('[data-act="nav"][data-screen="transfer"]')) await auditScreen(page, '转会', '07-transfer.png');
    await page.eval('document.querySelector(`[data-act="nav"][data-screen="dashboard"]`)?.click()');
    await sleep(80);
    if (await page.click('[data-act="nav"][data-screen="community"]')) await auditScreen(page, '社区', '10-community.png');
    await page.eval('document.querySelector(`[data-act="nav"][data-screen="dashboard"]`)?.click()');
    await sleep(80);
    if (await page.click('[data-act="view-pylon"]')) await auditScreen(page, '世界金字塔', '09-world-pylon.png');
    await page.eval('document.querySelector(`[data-act="nav"][data-screen="dashboard"]`)?.click()');
    await sleep(80);
    if (await page.click('[data-act="nav"][data-screen="settings"]')) await auditScreen(page, '设置', '11-settings.png');

    console.log('\n[赛季] 推到结算屏');
    await page.eval('document.querySelector(`[data-act="nav"][data-screen="dashboard"]`)?.click()');
    await sleep(80);
    let reached = false;
    for (let i = 0; i < 60; i++) {
      if ((await page.screen()) === 'season-end') {
        reached = true;
        break;
      }
      if (!(await page.eval('!!document.querySelector(`[data-act="advance-week"]`)'))) {
        await page.eval('document.querySelector(`[data-act="nav"][data-screen="dashboard"]`)?.click()');
        await sleep(60);
      }
      await page.eval('document.querySelector(`[data-act="advance-week"]`)?.click()');
      await sleep(40);
    }
    check('能推进到赛季结算', reached);
    if (reached) await auditScreen(page, '赛季结算', '08-season-end.png');

    // webview 没有地址栏和后退按钮，只有系统返回键/侧滑手势 —— 它走的就是 history.back()
    // webview 没有地址栏和后退按钮，只有系统返回键/侧滑手势 —— 它走的就是 history.back()。
    // 这里不假设上一屏是谁，只验证「按下去确实会退，并且界面跟着重绘」。
    console.log('\n[返回] 返回键能退回上一屏');
    const from = await page.screen();
    await page.eval('history.back()');
    let to = from;
    for (let i = 0; i < 40; i++) {
      to = await page.screen();
      if (to !== from) break;
      await sleep(50);
    }
    check('history.back() 能退回上一屏', to !== from, `${from} → ${to}`);
    check('返回后界面重新渲染', (await page.eval('!!document.querySelector("#app .topbar")')) === true);

    console.log('\n[错误] 全程页面错误');
    check('全程 0 个页面错误', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
  } finally {
    cdp?.close();
    child.kill();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项：通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('mobile-check 崩了：', error);
  process.exitCode = 1;
});
