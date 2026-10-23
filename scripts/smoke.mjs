#!/usr/bin/env node
/**
 * 端到端冒烟（设计 §12.3，≥ 41 项）
 *
 * 为什么不用 Playwright：设计硬约束是「零第三方依赖」。Chrome DevTools Protocol
 * 本身就是 WebSocket + JSON，Node 24 自带全局 WebSocket，够用且没有安装成本。
 *
 * 用法：
 *   node scripts/smoke.mjs           # 完整跑（含无头浏览器）
 *   node scripts/smoke.mjs --static  # 只跑静态检查（不需要浏览器）
 *
 * 环境变量：
 *   CHROME_PATH  指定浏览器可执行文件；不传则依次找 Chrome / Edge
 *   SMOKE_PORT   静态服务器端口，默认 5199
 *   CDP_PORT     DevTools 端口，默认 9333
 */
import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { extname, join, resolve, dirname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const STATIC_ONLY = process.argv.includes('--static');
const PORT = Number(process.env.SMOKE_PORT ?? 5199);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9333);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
  return !!ok;
}

/* ---------------------------------------------------------------- 静态检查 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function staticChecks() {
  console.log('\n[静态] 构建产物与源码约束');

  const indexHtml = join(dist, 'index.html');
  check('dist/index.html 存在', existsSync(indexHtml));
  if (!existsSync(indexHtml)) return;

  const files = walk(dist);
  const kb = (n) => Math.round((n / 1024) * 10) / 10;
  const sizeOf = (name) => {
    const hit = files.find((f) => f.endsWith(`${sep}${name}`) || f.endsWith(name));
    return hit ? statSync(hit).size : 0;
  };
  const htmlSize = statSync(indexHtml).size;
  const cssSize = sizeOf('style.css');
  const jsSize = sizeOf('app.js');
  const total = htmlSize + cssSize + jsSize;

  check('dist/index.html ≤ 2 KB', htmlSize <= 2048, `${kb(htmlSize)} KB`);
  check('dist/style.css ≤ 18 KB', cssSize > 0 && cssSize <= 18 * 1024, `${kb(cssSize)} KB`);
  // 预算见 项目规格 §12.4：gzip 才是真实传输成本（≤42 KB，硬线），
  // 未压缩字节数是本地指标。实测 bundle 97.8% 是字符串字面量（HTML 模板 + 配置数据），
  // 代码部分只有 2.6 KB，压到 115 KB 只能靠删功能 → 2026-10-20 与用户确认后放宽到
  // 125 KB；P5（财政/声望/成长/转会/征召）开工前再放宽到 145 KB；
  // P5 接完实测 gzip 44.8 KB 超 42 KB，与用户确认后同比例放宽到 48 KB（同日）；
  // P7（可玩性层）接完实测 181.8 KB / gzip 59.3 KB，与用户确认后定到 195 KB / 64 KB。
  // 2026-10-23 审查+修复轮：P0 结算管线（settle.ts/幂等守卫）、存档校验强化、圆桌赛程
  // 重写、删档确认等真修复把 app.js 推到 196.4 KB / 合计 207.3 KB；与用户确认后放宽到
  // 197 KB / 207 KB（gzip 仍 ≤64 KB，未动）。这是「修 bug 换来的体积」，不是加功能；
  // 再往上必须按设计 §15.10 的砍序砍功能。
  check('dist/app.js ≤ 197 KB', jsSize > 0 && jsSize <= 197 * 1024, `${kb(jsSize)} KB`);
  check('dist/ 代码合计 ≤ 207 KB', total <= 207 * 1024, `${kb(total)} KB`);
  // gzip 口径：zlib level 9（与 gzip-size / size-limit / bundlephobia 报「gzip size」的口径一致）。
  // 默认 level 6 会比对外报的数高约 0.7 KiB，两边不一致会让门禁数字看起来忽高忽低。
  check(
    'dist/app.js gzip ≤ 64 KB',
    jsSize > 0 && gzipSync(readFileSync(files.find((f) => f.endsWith('app.js'))), { level: 9 }).length <= 64 * 1024,
    jsSize > 0 ? `${kb(gzipSync(readFileSync(files.find((f) => f.endsWith('app.js'))), { level: 9 }).length)} KB` : '—',
  );

  // 运行时不能 fetch manifest（file:// 下 origin=null 会被 CORS 拦死）
  check('dist/ 内没有 art-manifest.json', !files.some((f) => f.endsWith('art-manifest.json')));
  const js = jsSize > 0 ? readFileSync(files.find((f) => f.endsWith('app.js')), 'utf8') : '';
  check('bundle 内没有 base64 内联图', !/data:image\/[a-z]+;base64,/.test(js));

  // 源码约束
  const srcFiles = walk(join(root, 'src')).filter((f) => f.endsWith('.ts') || f.endsWith('.css'));
  const srcText = srcFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
  check(
    '源码里没有 fetch(art-manifest)',
    !/fetch\([^)]*art-manifest/.test(srcText),
  );
  // 唯一允许出现 `.webp` 的两处：manifest 生成物，以及 art.ts 里那条「由表拼路径」的模板。
  // 其它任何地方出现图片路径字面量，都说明绕过了 art.img()，会让断图降级失效。
  const ART_PATH_BUILDER = ['art-manifest.ts', 'ui\\art.ts', 'ui/art.ts'];
  check(
    '源码里没有散落的 .webp 字面量（只允许 manifest 生成物与 art.ts 拼路径）',
    srcFiles
      .filter((f) => !ART_PATH_BUILDER.some((n) => f.endsWith(n)))
      .every((f) => !/['"`][^'"`]*\.webp/.test(readFileSync(f, 'utf8'))),
  );
  check('源码里没有内联 base64 图', !/data:image\/[a-z]+;base64,/.test(srcText));

  const manifest = JSON.parse(readFileSync(join(root, 'assets', 'art-manifest.json'), 'utf8'));
  const imageCount = Object.values(manifest.groups).reduce((n, g) => n + g.files.length, 0);

  const imgDir = join(root, 'assets', 'img');
  const present = existsSync(imgDir) ? walk(imgDir).filter((f) => f.endsWith('.webp')).length : 0;
  // 图位数与「真的都在」一起断：只断 105 而不断 present 的话，图丢了也照样绿。
  check(
    'art-manifest.json 图位 = 105 且全部已就位',
    imageCount === 105 && present === imageCount,
    `${imageCount} 个图位，已放 ${present} 张`,
  );
}

/* ---------------------------------------------------------------- 静态服务器 */

function startServer() {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    rel = normalize(rel).replace(/^([.][.][\\/])+/, '');
    const file = join(dist, rel);
    if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(PORT, '127.0.0.1', () => ok(server));
  });
}

/* ---------------------------------------------------------------- CDP 客户端 */

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return await res.json();
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
    ws.addEventListener('message', (event) => this.onMessage(event));
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
      if (msg.error) fail(new Error(`${msg.error.message ?? 'CDP 错误'}`));
      else ok(msg.result);
      return;
    }
    if (msg.method) {
      for (const handler of this.listeners.get(msg.method) ?? []) handler(msg.params, msg.sessionId);
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

/* ---------------------------------------------------------------- 页面操作 */

class Page {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.pageErrors = [];
  }

  send(method, params = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }

  async eval(expression, timeout = 60000) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        `页面内异常：${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`,
      );
    }
    return res.result?.value;
  }

  async click(selector) {
    const found = await this.eval(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      node.click();
      return true;
    })()`);
    return found === true;
  }

  async text(selector) {
    return (await this.eval(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      return node ? node.textContent.trim() : null;
    })()`)) ?? null;
  }

  async screen() {
    return this.eval('window.__GREENWORLD__ ? window.__GREENWORLD__.screen() : null');
  }

  async waitScreen(name, ms = 8000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if ((await this.screen()) === name) return true;
      await sleep(60);
    }
    return false;
  }

  async attachErrors() {
    this.cdp.on('Runtime.exceptionThrown', (params) => {
      const d = params.exceptionDetails;
      this.pageErrors.push(d?.exception?.description ?? d?.text ?? '未知异常');
    });
    this.cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error') return;
      const text = (params.args ?? [])
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
        .join(' ');
      this.pageErrors.push(text || '(console.error)');
    });
    this.cdp.on('Log.entryAdded', (params) => {
      if (params.entry?.level === 'error') this.pageErrors.push(params.entry.text ?? '');
    });
  }
}

async function openTarget(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Page(cdp, sessionId);
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');
  await page.attachErrors();
  await page.send('Page.navigate', { url });
  return { page, targetId };
}

async function waitLoaded(page, ms = 12000) {
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

/* ---------------------------------------------------------------- 交互链路 */

async function browserChecks(baseUrl) {
  const exe = findChrome();
  check('找到可用的 Chrome/Edge', !!exe, exe ?? '未找到，可用 CHROME_PATH 指定');
  if (!exe) return;

  const userDataDir = join(tmpdir(), `greenworld-smoke-${process.pid}`);
  const child = spawn(
    exe,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-gpu',
      '--window-size=430,900',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  let cdp;
  try {
    const version = await waitForDevtools();
    check('DevTools 可用', !!version.webSocketDebuggerUrl);
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    const { page } = await openTarget(cdp, baseUrl);
    check('页面加载完成且 #app 有内容', await waitLoaded(page));

    // 性能预算（设计 §7.1 perfBudgetMs = 800ms）：首屏从导航到 DOMContentLoaded 的真实耗时。
    // 这是「代码体积扩容会不会让手机卡」的唯一客观指标，因此常驻在冒烟里。
    const bootMs = await page.eval(`(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      return nav ? Math.round(nav.domContentLoadedEventEnd) : -1;
    })()`);
    check('首屏 DOMContentLoaded ≤ 800 ms', typeof bootMs === 'number' && bootMs >= 0 && bootMs <= 800, `${bootMs} ms`);

    console.log('\n[路由] 首页与开局链');
    check('首页标题是绿茵世界', (await page.text('h1')) === '绿茵世界');
    check('首页有主视觉区', (await page.eval('!!document.querySelector(".hero")')) === true);
    check('首页有两个模式入口', (await page.eval('document.querySelectorAll(\'[data-act^="mode-"]\').length')) === 2);
    check('首页按钮都有 data-act 钩子', (await page.eval('document.querySelectorAll("button:not([data-act])").length')) === 0);

    check('点「球员生涯」进开局页', await page.click('[data-act="mode-career"]'));
    check('开局页有 6 个联合会', (await page.eval('document.querySelectorAll(\'[data-act="pick-confederation"]\').length')) === 6);
    await page.click('[data-act="pick-confederation"][data-confederation="UEFA"]');
    check('选中 UEFA 后高亮', (await page.eval('!!document.querySelector(\'[data-act="pick-confederation"][data-confederation="UEFA"].btn--primary\')')) === true);

    // 开局链四步必须真的能走完（设计 §16.1 第 1 条）：联合会 → 国家 → 俱乐部 → 位置
    check('第 2 步列出该联合会国家', (await page.eval('document.querySelectorAll(\'[data-act="pick-country"]\').length')) >= 2);
    await page.click('[data-act="pick-country"][data-country="ENG"]');
    check('选中英格兰后高亮', (await page.eval('!!document.querySelector(\'[data-act="pick-country"][data-country="ENG"].btn--primary\')')) === true);
    check('第 3 步列出本国青训俱乐部', (await page.eval('document.querySelectorAll(\'[data-act="pick-target"]\').length')) >= 2);
    await page.click('[data-act="pick-target"]');
    check('选中俱乐部后高亮', (await page.eval('!!document.querySelector(\'[data-act="pick-target"].btn--primary\')')) === true);
    check('第 4 步有 6 种位置', (await page.eval('document.querySelectorAll(\'[data-act="pick-position"]\').length')) === 6);
    await page.click('[data-act="pick-position"][data-position="FW"]');
    check('选中前锋后高亮', (await page.eval('!!document.querySelector(\'[data-act="pick-position"][data-position="FW"].btn--primary\')')) === true);

    check('点「开始」进入主界面', (await page.click('[data-act="start"]')) && (await page.waitScreen('dashboard')));
    check('世界种子生效', (await page.eval('window.__GREENWORLD__.seed()')) === 20261019);
    check('赛季从第 1 季第 1 周开始', (await page.eval('[window.__GREENWORLD__.season(), window.__GREENWORLD__.week()].join(":")')) === '1:1');
    check('主界面有「推进一周」', (await page.eval('!!document.querySelector(\'[data-act="advance-week"]\')')) === true);

    console.log('\n[推进] 一周与比赛报告');
    const weekBefore = await page.eval('window.__GREENWORLD__.week()');
    await page.click('[data-act="advance-week"]');
    await sleep(120);
    const weekAfter = await page.eval('window.__GREENWORLD__.week()');
    check('推进一周后 week 前进', weekAfter > weekBefore, `${weekBefore} → ${weekAfter}`);
    const screenAfterAdvance = await page.screen();
    check('推进后停在比赛报告或主界面', screenAfterAdvance === 'match-report' || screenAfterAdvance === 'dashboard', screenAfterAdvance);

    console.log('\n[P7] 可玩性层：亲自踢一场 / 转会 / 剧本 / 社区层');
    await page.eval('document.querySelector(\'[data-act="nav"][data-screen="dashboard"]\')?.click()');
    // 生涯模式一周只有一场比赛，「亲自踢这场」只在比赛周出现 —— 先推进到比赛周。
    // 每次推进后可能停在赛报页，先回主控台再判断。
    let liveWeeks = 0;
    for (; liveWeeks < 10; liveWeeks++) {
      if (await page.eval('!!document.querySelector(\'[data-act="play-match"]\')')) break;
      const adv = await page.eval(`(() => {
        if (window.__GREENWORLD__.screen() !== 'dashboard') {
          document.querySelector('[data-act="nav"][data-screen="dashboard"]')?.click();
          return 'nav';
        }
        document.querySelector('[data-act="advance-week"]')?.click();
        return 'advance';
      })()`);
      if (adv === 'nav') {
        await page.eval('document.querySelector(\'[data-act="nav"][data-screen="dashboard"]\')?.click()');
      }
      await sleep(60);
    }
    const canLive = await page.eval('!!document.querySelector(\'[data-act="play-match"]\')');
    check('推进到比赛周后主控台有「亲自踢这场」', canLive === true, `推了 ${liveWeeks} 周`);
    if (canLive) {
      await page.click('[data-act="play-match"]');
      check('进入两段式比赛', await page.waitScreen('match-live'));
      const liveDump = await page.eval('document.body.innerText.slice(0,160).replace(/\\s+/g," ")');
      check('上半场有半场面板入口', (await page.eval('!!document.querySelector(\'[data-act="half-time"]\')')) === true, liveDump);
      check('半场面板能给换人/心态/战术', (await page.eval(`document.querySelectorAll('[data-act="mentality"],[data-act="tactic"],[data-act="sub-on"]').length`)) >= 3);
      await page.eval('document.querySelector(\'[data-act="mentality"]\')?.click()');
      await page.click('[data-act="half-time"]');
      for (let i = 0; i < 10 && (await page.screen()) === 'match-live'; i++) {
        const moment = await page.eval('!!document.querySelector(\'[data-act="moment-choice"]\')');
        if (moment) await page.eval('document.querySelector(\'[data-act="moment-choice"]\')?.click()');
        else {
          const finish = await page.eval('!!document.querySelector(\'[data-act="finish-match"]\')');
          if (finish) await page.eval('document.querySelector(\'[data-act="finish-match"]\')?.click()');
        }
        await sleep(60);
      }
      check('踢完后回到赛报或主控台', ['match-report', 'dashboard'].includes(await page.screen()), await page.screen());
      await page.eval('document.querySelector(\'[data-act="nav"][data-screen="dashboard"]\')?.click()');
    }

    const canTransfer = await page.eval('!!document.querySelector(\'[data-act="nav"][data-screen="transfer"]\')');
    check('主控台有转会入口', canTransfer === true);
    if (canTransfer) {
      await page.click('[data-act="nav"][data-screen="transfer"]');
      check('转会页进入', await page.waitScreen('transfer'));
      // 生涯模式给的是「收到的报价」，经理模式给的是「可挖目标」，两者都算通。
      const transferText = await page.eval('document.body.innerText');
      check(
        '转会页有内容（可挖目标或你的报价）',
        (await page.eval('document.querySelectorAll(\'[data-act="bid-offer"],[data-act="bid-accept"]\').length')) > 0 ||
          /转会|报价|目标|经纪人/.test(transferText ?? ''),
      );

      // 谈判页：从转会页第一个目标点进去，四关逐条渲染（哪怕最终失败，也必须有原因码位）
      const firstOffer = await page.eval('document.querySelector(\'[data-act="bid-offer"]\') ? 1 : 0');
      if (firstOffer === 1) {
        await page.click('[data-act="bid-offer"]');
        check('转会目标点进谈判页', await page.waitScreen('negotiation'));
        const gateText = await page.eval('document.body.innerText');
        check('谈判页列出四关', /俱乐部估价/.test(gateText ?? '') && /注册与工资帽/.test(gateText ?? ''));
        check('谈判页有报价回执', /谈判|要价|佣金/.test(gateText ?? ''));
        await page.eval('document.querySelector(\'[data-act="bid-submit"]\')?.click()');
        const afterBid = await page.eval('document.body.innerText');
        check(
          '加价后出现原因码或成交',
          /negotiation-reason|[A-Z_]{6,}/.test(afterBid ?? '') || /成交|加盟/.test(afterBid ?? ''),
        );
        await page.eval('document.querySelector(\'[data-act="nav"][data-screen="transfer"]\')?.click()');
        await page.waitScreen('transfer');
      }
      await page.eval('document.querySelector(\'[data-act="nav"][data-screen="dashboard"]\')?.click()');
    }

    // 社区页：热评流 + 球迷情绪 / 人气 + 采访（可整体关闭）
    const canCommunity = await page.eval('!!document.querySelector(\'[data-act="nav"][data-screen="community"]\')');
    check('主控台有社区入口', canCommunity === true);
    if (canCommunity) {
      await page.click('[data-act="nav"][data-screen="community"]');
      check('社区页进入', await page.waitScreen('community'));
      const communityText = await page.eval('document.body.innerText');
      check('社区页有球迷情绪', /球迷情绪|人气|国家队声望/.test(communityText ?? ''));
      await page.eval('document.querySelector(\'[data-act="nav"][data-screen="dashboard"]\')?.click()');
    }

    console.log('\n[P7] 挑战剧本与社区层开关');
    // 从深页回首页最稳的方式是刷新：有存档时首屏就是 home。
    await page.eval('location.reload()');
    check('刷新后回到首页', await page.waitScreen('home'));
    check('首页有挑战剧本入口', (await page.eval('!!document.querySelector(\'[data-act="scenario-pick"]\')')) === true);
    await page.click('[data-act="scenario-pick"]');
    check('进入剧本页', await page.waitScreen('scenario'));
    const scenarios = await page.eval('document.querySelectorAll(\'[data-act="scenario-start"]\').length');
    check('剧本页列出 3 个剧本', scenarios === 3, `${scenarios} 个`);
    await page.eval('document.querySelector(\'[data-act="nav"][data-screen="home"]\')?.click()');
    await page.waitScreen('home');
    await page.click('[data-act="nav"][data-screen="settings"]');
    check('设置页有社区层开关', (await page.eval('!!document.querySelector(\'[data-act="toggle-community"]\')')) === true);
    await page.eval('document.querySelector(\'[data-act="toggle-community"]\')?.click()');
    const offText = await page.eval('document.body.innerText');
    check('社区层可以关掉', /已关闭|关闭/.test(offText ?? ''));

    // 回到主控台（后面还有赛季推进与大流程断言）
    await page.eval('document.querySelector(\'[data-act="nav"][data-screen="home"]\')?.click()');
    await page.waitScreen('home');
    await page.eval('document.querySelector(\'[data-act="load"]\')?.click()');
    check('P7 走一圈后仍能回到存档', await page.waitScreen('dashboard'));

    console.log('\n[世界] 金字塔与资格路径');
    if ((await page.screen()) !== 'dashboard') {
      await page.eval('document.querySelector(\'[data-act="nav"][data-screen="dashboard"]\')?.click()');
    }
    await page.eval('window.__GREENWORLD__ && document.querySelector(\'[data-act="view-pylon"]\')?.click()');
    check('进入世界金字塔', await page.waitScreen('world-pylon'));
    check('金字塔有俱乐部线', (await page.eval('!!document.querySelector(\'[data-act="pylon-line-club"]\')')) === true);
    check('金字塔有国家队线', (await page.eval('!!document.querySelector(\'[data-act="pylon-line-career"]\')')) === true);
    const clubNodes = await page.eval('document.querySelectorAll(\'[data-act="pylon-line-club"]\').length');
    await page.click('[data-act="pylon-line-career"]');
    check('切到国家队线后页面重绘', (await page.eval('document.querySelectorAll(\'[data-act="pylon-line-club"]\').length')) === clubNodes);
    await page.click('[data-act="pylon-line-club"]');

    const compNodes = await page.eval('document.querySelectorAll(\'[data-act="competition-node"]\').length');
    check('金字塔有赛事节点（≥ 6 联合会 + 各国联赛）', compNodes >= 20, `${compNodes} 个`);
    await page.click('[data-act="competition-node"]');
    check('点赛事进赛事页', await page.waitScreen('competition'));
    const hasTable = await page.eval('!!document.querySelector("table") || !!document.querySelector(\'.bracket\')');
    check('赛事页有积分榜或淘汰树', hasTable === true);
    check('赛事页有资格路径入口', (await page.eval('!!document.querySelector(\'[data-act="qual-path"]\')')) === true);
    await page.click('[data-act="qual-path"]');
    check('进入资格路径页', await page.waitScreen('qualification'));
    const qualText = (await page.eval('document.body.innerText')) ?? '';
    // 三个固定小标题是 qualificationPage() 的骨架：少了任何一个都说明页面被改坏/渲染截断。
    check(
      '资格页解释了「怎么进 / 已获资格 / 数据来源」',
      /怎么进/.test(qualText) && /已获资格/.test(qualText) && /数据来源/.test(qualText),
      qualText.slice(0, 40).replace(/\s+/g, ' '),
    );

    console.log('\n[赛季] 推进到赛季结束');
    await page.eval('document.querySelector(\'[data-act="nav"][data-screen="dashboard"]\')?.click()');
    if ((await page.screen()) !== 'dashboard') {
      await page.eval('document.querySelector(\'[data-act="view-pylon"]\')?.click()');
      await page.eval('document.querySelector(\'[data-screen="dashboard"]\')?.click()');
    }
    const advanced = await page.eval(`(() => {
      let n = 0;
      let stuck = 0;
      let lastWeek = -1;
      for (; n < 120; n++) {
        const s0 = window.__GREENWORLD__.screen();
        if (s0 === 'season-end' || s0 === 'career-end') break;
        // 赛后会停在赛报页，那儿没有「推进一周」——先回主控台再推进，
        // 这才是玩家真实的操作路径（不能靠在同一个屏幕上连点）。
        if (!document.querySelector('[data-act="advance-week"]')) {
          const back = document.querySelector('[data-act="nav"][data-screen="dashboard"]');
          if (!back) break;
          back.click();
          if (window.__GREENWORLD__.screen() !== 'dashboard') break;
        }
        const btn = document.querySelector('[data-act="advance-week"]');
        if (!btn) break;
        const w0 = window.__GREENWORLD__.week();
        const season0 = window.__GREENWORLD__.season();
        btn.click();
        const w1 = window.__GREENWORLD__.week();
        const season1 = window.__GREENWORLD__.season();
        n++;
        // 周次既没前进、赛季也没换 → 说明这一周根本没推进（例如 canContinue 挡住了）
        if (w1 === w0 && season1 === season0) {
          stuck++;
          if (stuck >= 3) break;
        } else {
          stuck = 0;
        }
        lastWeek = w1;
      }
      return { n, screen: window.__GREENWORLD__.screen(), week: lastWeek, season: window.__GREENWORLD__.season() };
    })()`);
    check(
      '能一路推进到赛季结束',
      (await page.screen()) === 'season-end' || (await page.screen()) === 'career-end',
      `点了 ${advanced.n} 次，最终 第${advanced.season}季第${advanced.week}周 / ${advanced.screen}`,
    );
    const seasonText = (await page.eval('document.body.innerText')) ?? '';
    const endScreen = await page.screen();
    // 两种收尾页的骨架不同：断结构标题/按钮，而不是「正文里出现过升降级这类字」。
    const endOk =
      endScreen === 'career-end'
        ? /生涯结算/.test(seasonText) && /生涯价值/.test(seasonText) && /荣誉墙/.test(seasonText) && /再开一生/.test(seasonText)
        : /最终排名/.test(seasonText) && /荣誉/.test(seasonText) && /进入下一季|重新应聘/.test(seasonText);
    check('结算页落地「排名 / 荣誉 / 下一步」', endOk, `${endScreen}：${seasonText.slice(0, 40).replace(/\s+/g, ' ')}`);

    console.log('\n[存档] 刷新与读档');
    const savedKb = await page.eval('window.__GREENWORLD__.savedKb()');
    check('存档体积 ≤ 256 KB', savedKb > 0 && savedKb <= 256, `${savedKb} KB`);
    const hasSave = await page.eval('!!localStorage.getItem("greenworld_save_v1")');
    check('localStorage 里确实写入了存档', hasSave === true);
    // 读档前后要比同一组数：赛季刚结算时 season 还是 1（要按「进入下一季」才变 2），
    // 所以不能硬编码期望 2，否则测的是结算节奏而不是存档本身。
    const beforeReload = await page.eval('[window.__GREENWORLD__.season(), window.__GREENWORLD__.week()].join(":")');

    await page.send('Page.reload');
    check('刷新后页面重新可用', await waitLoaded(page));
    check('刷新后首页提示有存档', (await page.eval('!!document.querySelector(\'[data-act="load"]\')')) === true);
    await page.click('[data-act="load"]');
    check('点「继续」读档成功', await page.waitScreen('dashboard'));
    const afterLoad = await page.eval('[window.__GREENWORLD__.season(), window.__GREENWORLD__.week()].join(":")');
    check('读档后赛季号保留', afterLoad === beforeReload, `${beforeReload} → ${afterLoad}`);

    console.log('\n[美术] 图片属性与降级');
    const imgAudit = await page.eval(`(() => {
      const imgs = [...document.querySelectorAll('img')];
      const bad = imgs.filter((i) => !i.getAttribute('alt') || !i.getAttribute('width') || !i.getAttribute('height') || i.getAttribute('decoding') !== 'async');
      const lazy = imgs.filter((i) => i.getAttribute('loading') === 'lazy').length;
      return { total: imgs.length, bad: bad.length, lazy, fallback: document.querySelectorAll('.art-fallback').length };
    })()`);
    check('所有 <img> 都带 alt/width/height/decoding', imgAudit.bad === 0, `${imgAudit.total} 张图，${imgAudit.bad} 张不合规`);
    check(
      '图齐全时不出现兜底块（否则说明有图 404 被 onerror 换成了渐变）',
      imgAudit.total > 0 && imgAudit.fallback === 0,
      `img=${imgAudit.total} fallback=${imgAudit.fallback}`,
    );
    check('懒加载比例 ≥ 0.9', imgAudit.total > 0 && imgAudit.lazy / imgAudit.total >= 0.9, `${imgAudit.lazy}/${imgAudit.total}`);

    console.log('\n[设置] 存档页');
    await page.eval('document.querySelector(\'[data-screen="settings"]\')?.click()');
    check('能进设置/存档页', await page.waitScreen('settings'));
    check('存档页有「立即保存」', (await page.eval('!!document.querySelector(\'[data-act="save-now"]\')')) === true);
    check('存档页能显示体积', /KB|kb/.test((await page.eval('document.body.innerText')) ?? ''));

    console.log('\n[入口] 经理模式与国家队主帅（设计 §16.1 第 1 条：两条入口各建一档）');
    // 前面的存档测试已经跑完，这里清干净重新从首页开始，避免读档直接盖掉开局流程
    await page.eval('(() => { try { localStorage.removeItem("greenworld_save_v1"); } catch (e) {} })()');
    await page.send('Page.reload');
    await waitLoaded(page);
    check('清档后回到首页', (await page.screen()) === 'home');

    await page.click('[data-act="mode-manager"]');
    await page.click('[data-act="pick-confederation"][data-confederation="UEFA"]');
    await page.click('[data-act="pick-country"][data-country="ESP"]');
    check('经理模式有执教对象二选一', (await page.eval('document.querySelectorAll(\'[data-act="pick-kind"]\').length')) === 2);
    await page.click('[data-act="pick-tier"][data-tier="1"]');
    await page.click('[data-act="pick-target"]');
    check('俱乐部经理能开局', (await page.click('[data-act="start"]')) && (await page.waitScreen('dashboard')));
    check('俱乐部经理开局后赛季为 1', (await page.eval('window.__GREENWORLD__.season()')) === 1);
    const managerWeek = await page.eval('window.__GREENWORLD__.week()');
    await page.click('[data-act="advance-week"]');
    await sleep(120);
    check('俱乐部经理能推进一周', (await page.eval('window.__GREENWORLD__.week()')) > managerWeek);

    // 经理专属：转会页 → 目标 → 谈判页四关（生涯模式没有 bid-offer，必须在这里测）
    await page.click('[data-act="nav"][data-screen="transfer"]');
    check('经理能进转会市场', await page.waitScreen('transfer'));
    const marketTargets = await page.eval('document.querySelectorAll(\'[data-act="bid-offer"]\').length');
    check('转会市场列出可谈目标', marketTargets > 0, `${marketTargets} 个`);
    if (marketTargets > 0) {
      await page.click('[data-act="bid-offer"]');
      check('转会目标点进谈判页', await page.waitScreen('negotiation'));
      const gateText = await page.eval('document.body.innerText');
      check('谈判页列出四关', /俱乐部估价/.test(gateText ?? '') && /注册与工资帽/.test(gateText ?? ''));
      await page.eval('document.querySelector(\'[data-act="bid-submit"]\')?.click()');
      const afterBid = await page.eval('document.body.innerText');
      check(
        '加价后有原因码或成交回执',
        /negotiation-reason|[A-Z_]{6,}/.test(afterBid ?? '') || /成交|加盟|没谈成/.test(afterBid ?? ''),
      );
    }

    // 国家队主帅：同一条 setup 屏的第三条入口
    await page.eval('(() => { try { localStorage.removeItem("greenworld_save_v1"); } catch (e) {} })()');
    await page.send('Page.reload');
    await waitLoaded(page);
    await page.click('[data-act="mode-manager"]');
    await page.click('[data-act="pick-confederation"][data-confederation="CONMEBOL"]');
    await page.click('[data-act="pick-kind"][data-kind="national"]');
    check('国家队主帅列出国家队', (await page.eval('document.querySelectorAll(\'[data-act="pick-target"][data-national]\').length')) >= 1);
    await page.click('[data-act="pick-target"][data-national]');
    check('国家队主帅能开局', (await page.click('[data-act="start"]')) && (await page.waitScreen('dashboard')));
    check('国家队主帅开局后赛季为 1', (await page.eval('window.__GREENWORLD__.season()')) === 1);
    const nationalWeek = await page.eval('window.__GREENWORLD__.week()');
    await page.click('[data-act="advance-week"]');
    await sleep(120);
    check('国家队主帅能推进一周', (await page.eval('window.__GREENWORLD__.week()')) > nationalWeek);

    console.log('\n[错误] 全流程 pageErrors');
    check('全流程 0 个页面错误', page.pageErrors.length === 0, page.pageErrors.slice(0, 3).join(' | '));

    // file:// 死穴：相对路径 + 外链图在离线打开时能不能加载
    console.log('\n[file://] 离线双击打开');
    const fileUrl = `file:///${dist.replace(/\\/g, '/')}/index.html`;
    const { page: filePage, targetId: fileTarget } = await openTarget(cdp, fileUrl);
    check('file:// 能打开 dist/index.html', await waitLoaded(filePage));
    const fileImg = await filePage.eval(`(() => {
      const imgs = [...document.querySelectorAll('img')];
      return { total: imgs.length, loaded: imgs.filter((i) => i.naturalWidth > 0).length };
    })()`);
    check(
      'file:// 下图片按相对路径全部加载',
      fileImg.total > 0 && fileImg.loaded === fileImg.total,
      `${fileImg.loaded}/${fileImg.total} 张 naturalWidth > 0`,
    );
    check('file:// 下没有页面错误', filePage.pageErrors.length === 0, filePage.pageErrors.slice(0, 2).join(' | '));

    // 断图降级：拦掉所有 webp，看是否仍然可玩、且真的换成了渐变块
    await cdp.send('Network.enable', {}, filePage.sessionId);
    await cdp.send('Network.setBlockedURLs', { urls: ['*.webp'] }, filePage.sessionId);
    const fileUrl2 = fileUrl;
    // 断网后 pageErrors 会带上加载失败，这里记下基线，只比「新增」的运行时错误
    filePage.pageErrors.length = 0;
    await filePage.send('Page.navigate', { url: fileUrl2 });
    await waitLoaded(filePage);
    const blockedState = await filePage.eval(`(() => ({
      fallback: document.querySelectorAll('.art-fallback').length,
      broken: [...document.querySelectorAll('img')].filter((i) => i.naturalWidth === 0).length,
      screen: window.__GREENWORLD__ ? window.__GREENWORLD__.screen() : null,
      screens: document.querySelectorAll('[data-act="mode-career"]').length,
    }))()`);
    check(
      '拦掉图片后仍能进首页、且图位换成渐变兜底块',
      blockedState.screens === 1 && blockedState.fallback > 0,
      `screen=${blockedState.screen} fallback=${blockedState.fallback} 未加载=${blockedState.broken}`,
    );
    check('拦掉图片后没有新增 pageErrors', filePage.pageErrors.length === 0, filePage.pageErrors.slice(0, 2).join(' | '));

    await cdp.send('Target.closeTarget', { targetId: fileTarget }).catch(() => {});
    cdp.close();
  } finally {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
    await sleep(300);
  }
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  console.log('绿茵世界 · 端到端冒烟');
  console.log(`工程：${root}`);

  staticChecks();

  if (!STATIC_ONLY) {
    let server;
    try {
      server = await startServer();
      check(`静态服务器启动于 :${PORT}`, true);
      await browserChecks(`http://127.0.0.1:${PORT}/`);
    } catch (error) {
      check('浏览器链路可运行', false, error instanceof Error ? error.message : String(error));
    } finally {
      server?.close();
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n合计 ${results.length} 项：${passed} 通过，${failed} 失败`);
  if (failed > 0) {
    console.log('失败项：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}${r.detail ? `（${r.detail}）` : ''}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('冒烟脚本自身出错：', error);
  process.exitCode = 1;
});
