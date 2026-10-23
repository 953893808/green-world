#!/usr/bin/env node
/**
 * 单文件打包：把 dist/ 压成一个自包含的 `__ai_app.html`。
 *
 * 为什么要这一步：移动端 H5 平台只托管一个 HTML
 * （典型的托管路径形如 <host>/activity/<id>/__ai_app.html），
 * 由 App 内 webview 打开。我们平时构建出的是 index.html + app.js + style.css + 105 张图，
 * 直接扔进去图片全 404，所以这里把三样东西内联、把图转成 base64。
 *
 * 做法刻意保持「零依赖 + 纯文本替换」：
 *  - 图不入打包器的模块图（运行时是字符串路径），所以只能在这里转 base64；
 *  - 注入 window.__ART_INLINE__，由 src/ui/art.ts 的钩子把 src 换成 data URI，
 *    不注入时行为与普通构建一致 —— 因此 file:// 双击版与 dev 服都不受影响。
 *
 * 用法：
 *   npm run build          # 先出 dist/
 *   npm run build:single     # 再压成 single/__ai_app.html
 *
 * 环境变量：
 *   SINGLEFILE_OUT  输出文件路径，默认 single/__ai_app.html
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const outFile = resolve(root, process.env.SINGLEFILE_OUT ?? join('single', '__ai_app.html'));

const MIME = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
};

function die(message) {
  console.error(`build-singlefile: ${message}`);
  process.exit(1);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

if (!existsSync(join(dist, 'index.html'))) {
  die('找不到 dist/index.html —— 先跑 `npm run build`');
}

/**
 * manifest 是「这个包该内联多少张图」的唯一事实源。
 * 少了就是**残包**（webview 里整页只剩渐变块），必须失败而不是打个日志。
 */
const manifestPath = join(root, 'assets', 'art-manifest.json');
if (!existsSync(manifestPath)) die('找不到 assets/art-manifest.json —— 无法核对内联图数量');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const expectedImages = new Set(
  Object.values(manifest.groups).flatMap((group) => group.files.map((f) => `assets/img/${group.dir}/${f[0]}.webp`)),
);

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const cssPath = join(dist, 'style.css');
const jsPath = join(dist, 'app.js');
if (!existsSync(cssPath) || !existsSync(jsPath)) die('dist/ 里缺 style.css 或 app.js');

const css = readFileSync(cssPath, 'utf8');
const js = readFileSync(jsPath, 'utf8');

/* ------------------------------------------------------- 1. 图片转 data URI */

const imgDir = join(dist, 'assets', 'img');
/** key 用 dist 相对路径（art.ts 会把 './assets/img/x.webp' 去掉 './' 来查） */
const inline = Object.create(null);
let imgCount = 0;
let imgBytes = 0;

if (!existsSync(imgDir)) {
  die('dist/assets/img 不存在 —— 图片没进构建产物（vite 的 copy-art 没跑？），拒绝打残包');
}
{
  for (const file of walk(imgDir)) {
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    const mime = MIME[ext];
    if (!mime) continue;
    const buf = readFileSync(file);
    const key = relative(dist, file).split(sep).join('/');
    inline[key] = `data:${mime};base64,${buf.toString('base64')}`;
    imgCount += 1;
    imgBytes += buf.length;
  }
}

/* 残包守卫：内联张数必须与 manifest 完全一致（缺一张都不行） */
{
  const inlined = new Set(Object.keys(inline));
  const missing = [...expectedImages].filter((k) => !inlined.has(k));
  const extra = [...inlined].filter((k) => !expectedImages.has(k));
  if (imgCount === 0) die('dist/assets/img 里一张图都没有 —— 拒绝产出无美术的「单文件包」（先跑 npm run build）');
  if (missing.length > 0) {
    die(
      `manifest 声明 ${expectedImages.size} 张图，dist 里只内联了 ${imgCount} 张，缺 ${missing.length} 张：` +
        `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`,
    );
  }
  if (extra.length > 0) {
    console.warn(`  提示：dist/assets/img 有 ${extra.length} 张 manifest 外的多余文件，已一并内联`);
  }
}

/* ------------------------------------------------------------ 2. 文本内联 */

// `</script` 出现在 JS 字符串里会提前闭合脚本块，必须切开
const safeJs = js.replace(/<\/script/gi, '<\\/script');
const inlineJson = JSON.stringify(inline).replace(/</g, '\\u003c');

let out = html;

const scriptTag = /<script\b[^>]*\bsrc=["']\.?\/?app\.js["'][^>]*>\s*<\/script>/i;
if (!scriptTag.test(out)) die('index.html 里找不到 <script src="app.js">');
const jsBlock = `<script>window.__ART_INLINE__=${inlineJson};</script>\n    <script>${safeJs}</script>`;
out = out.replace(scriptTag, jsBlock);

const cssTag = /<link\b[^>]*\bhref=["']\.?\/?style\.css["'][^>]*>/i;
if (!cssTag.test(out)) die('index.html 里找不到 <link href="style.css">');
const cssBlock = `<style>${css}</style>`;
out = out.replace(cssTag, cssBlock);

/* -------------------------------------------------------------- 3. 自检 */

// 只查外壳（把刚内联进去的 JS/CSS 块先摘掉）：app.js 源码里本来就有
// `src="${n.src}"` 这类模板字符串，扫全文件会误报。图与外链只可能出现在外壳与 CSS 里。
const probe = out.split(jsBlock).join('').split(cssBlock).join('');
// 单文件包的铁律是「零外链」：`https://` 也一并不放过（webview 里离线打开时同样会挂）。
const leftovers = [...probe.matchAll(/(?:src|href)=["'](?!data:|#)([^"']+)["']/gi)].map((m) => m[1]);
if (leftovers.length > 0) {
  die(`index.html 还有未内联的外部引用：${[...new Set(leftovers)].join(', ')}`);
}
const cssUrls = [...css.matchAll(/url\(\s*['"]?(?!data:)([^'")]+)/gi)].map((m) => m[1]);
if (cssUrls.length > 0) {
  die(`style.css 还有未内联的 url()：${[...new Set(cssUrls)].slice(0, 5).join(', ')}`);
}
if (/<\/script>/i.test(safeJs)) die('app.js 内联后仍含 </script>，转义漏了');

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, out, 'utf8');

const kb = (n) => Math.round((n / 1024) * 10) / 10;
console.log('build-singlefile: 单文件打包完成');
console.log(`  输出    ${relative(root, outFile)}`);
console.log(`  大小    ${kb(Buffer.byteLength(out))} KB（html ${kb(Buffer.byteLength(html))} + css ${kb(Buffer.byteLength(css))} + js ${kb(Buffer.byteLength(js))} + 图 ${kb(imgBytes)} 原始 → base64 约 ${kb(imgBytes / 3 * 4)}）`);
console.log(`  内联图  ${imgCount} 张，外部引用 0 个`);
if (statSync(outFile).size > 4 * 1024 * 1024) {
  console.warn('  提示：超过 4 MB，部分 webview 首次解析会明显变慢');
}
