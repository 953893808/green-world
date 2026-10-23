import { ART_BUDGET_KB, ART_COUNT, ART_PRESENT_BITS, ART_TABLE } from './art-manifest';
import type { ArtGroup, ArtKey } from './art-manifest';
import { escapeHtml } from './dom';

/**
 * 唯一取图入口（设计 §10.5 / 美术分册 §5.2）。
 *
 * 铁律：
 *  - 代码里禁止出现散落的 `'../assets/img/xxx.webp'` 字面量，只能走 `img()` / `ART_IMAGES`；
 *  - 所有 `<img>` 必须带 width/height/loading/decoding/alt；
 *  - 图挂了必须降级成同色系渐变块，不许露裂图；
 *  - texture 组走 CSS 背景，不进 `<img>`；
 *  - 运行时**不许** fetch manifest（`file://` 下 origin 为 null，会被 CORS 拦死）。
 *
 * 图位表为什么是字符串而不是对象字面量：105 条 `{src,w,h,group,tier}` 要 14 KB，
 * 会顶爆 app.js 的体积预算。这里在模块初始化时把紧凑表解析一次（O(105)），
 * 换来 11 KB；key 由尾名按同一规则推导，`tests/art.spec.ts` 逐条比对生成侧与运行时。
 */

export interface ImgMeta {
  src: string;
  w: number;
  h: number;
  group: ArtGroup;
  tier: 'preload' | 'lazy';
}

/** brand-02-hero-keyart 的尾名 `02-hero-keyart` → heroKeyart */
function keyOfTail(tail: string): string {
  const words = tail.split('-').slice(1);
  return words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');
}

const IMAGES = Object.create(null) as Record<ArtKey, ImgMeta>;
const GROUPS = Object.create(null) as Record<string, { dir: string; count: number }>;
const PRESENT = new Set<string>();
const ORDER: ArtKey[] = [];

let cursor = 0;
for (const chunk of ART_TABLE.split('|')) {
  const [head = '', body = ''] = chunk.split('~');
  // 组头是 `目录:前缀`；分组名与目录同名（gen-art.mjs 会强制校验这一点，
  // 目录名就是美术分册 §1 的 11 个分组，多写一份名字只为了省 11 个重复字面量）
  const [dir = '', prefix = ''] = head.split(':');
  if (!dir || !prefix || !body) throw new Error(`art: 图位表格式错误 ${chunk}`);
  GROUPS[dir] = { dir, count: 0 };
  for (const row of body.split(';')) {
    const [tail = '', w = '', h = '', mark = ''] = row.split(',');
    if (!tail || !w || !h) throw new Error(`art: 图位行格式错误 ${row}`);
    const key = keyOfTail(tail) as ArtKey;
    IMAGES[key] = {
      src: `./assets/img/${dir}/${prefix}${tail}.webp`,
      w: Number(w),
      h: Number(h),
      group: dir as ArtGroup,
      tier: mark ? 'preload' : 'lazy',
    };
    GROUPS[dir]!.count += 1;
    ORDER.push(key);
    if (ART_PRESENT_BITS[cursor] === '1') PRESENT.add(key);
    cursor += 1;
  }
}

/*
 * 单文件内联钩子（球迷 AI工坊等平台只收一个 __ai_app.html）。
 *
 * scripts/build-singlefile.mjs 会在 app.js 之前注入 window.__ART_INLINE__：
 * 一张「dist 相对路径 → 内联图片串」的映射。命中就把 src 换成内联串；
 * 没有注入时行为与普通构建完全一致，因此 file:// 双击版、dev 服、单测三条路径都不受影响。
 */
const INLINE = (globalThis as { __ART_INLINE__?: Record<string, string> }).__ART_INLINE__;
if (INLINE) {
  for (const key of ORDER) {
    const meta = IMAGES[key];
    const data = INLINE[meta.src.replace(/^\.\//, '')];
    if (data) meta.src = data;
  }
}

const DARK_BG = 'linear-gradient(135deg,#14332A,#2F6B4F)';
const LIGHT_BG = 'linear-gradient(135deg,#EFE7D6,#E4D8BE)';
const GOLD_BG = 'linear-gradient(135deg,#D9A441,#8A5F17)';

const GROUP_FALLBACK: Record<string, { label: string; css: string }> = {
  brand: { label: '绿茵世界', css: DARK_BG },
  confederation: { label: '联合会', css: DARK_BG },
  scenery: { label: '球场', css: DARK_BG },
  event: { label: '事件', css: LIGHT_BG },
  moment: { label: '关键时刻', css: LIGHT_BG },
  honor: { label: '荣誉', css: GOLD_BG },
  scenario: { label: '剧本', css: GOLD_BG },
  pylon: { label: '赛事金字塔', css: DARK_BG },
  community: { label: '球迷', css: DARK_BG },
  end: { label: '结算', css: LIGHT_BG },
  texture: { label: '', css: DARK_BG },
};

export interface ImgOptions {
  /** 人能读的一句中文；不传则用分组兜底文案 */
  alt?: string;
  className?: string;
  /** 仅 hero 图用：其余一律懒加载 */
  eager?: boolean;
  /** 覆盖显示宽度（height 按比例）；用于小徽标 */
  displayWidth?: number;
}

function groupLabel(group: ArtGroup): string {
  return GROUP_FALLBACK[group]?.label ?? '插图';
}

export function artSrc(key: ArtKey): string {
  return IMAGES[key].src;
}

export function artMeta(key: ArtKey): ImgMeta {
  return IMAGES[key];
}

/** 该分组是否有实体图（没有就整块走兜底，避免 105 个 404） */
export function hasArt(): boolean {
  return PRESENT.size > 0;
}

export function isPresent(key: ArtKey): boolean {
  return PRESENT.has(key);
}

/**
 * 生成一段 `<img>` HTML。图加载失败时由内联 onerror 换成渐变块。
 * 注意 alt 必须转义，避免引号截断属性。
 */
export function img(key: ArtKey, opts: ImgOptions = {}): string {
  const meta = IMAGES[key];
  // 图还没做：直接给兜底块，不发无谓请求（设计 §10.5.3 第 1 条）
  if (!PRESENT.has(key)) return fallbackStyle(meta.group);
  const cls = opts.className ? ` class="${escapeHtml(opts.className)}"` : '';
  const alt = escapeHtml(opts.alt ?? groupLabel(meta.group));
  const loading = opts.eager || meta.tier === 'preload' ? 'eager' : 'lazy';
  const width = opts.displayWidth ?? meta.w;
  const height = Math.round((width * meta.h) / meta.w);
  const fallback = fallbackStyle(meta.group);
  return (
    `<img src="${meta.src}" width="${width}" height="${height}"` +
    ` loading="${loading}" decoding="async" alt="${alt}"${cls}` +
    ` data-art="${key}" data-art-group="${meta.group}"` +
    ` style="aspect-ratio:${meta.w}/${meta.h}"` +
    ` onerror="this.onerror=null;this.insertAdjacentHTML('afterend','${fallbackLiteral(fallback)}');this.remove()">`
  );
}

/** 兜底块：同色系渐变 + 一行小字，图挂了也不难看（设计 §10.5.3） */
export function fallbackStyle(group: ArtGroup): string {
  const css = GROUP_FALLBACK[group]?.css ?? GROUP_FALLBACK.texture!.css;
  return `<div class="art-fallback art-fallback--${group}" style="background:${css}" aria-hidden="true"><span>${escapeHtml(groupLabel(group))}</span></div>`;
}

/** img() 的兜底直接用这段 HTML 内联替换 */
export function fallbackBlock(key: ArtKey): string {
  return fallbackStyle(IMAGES[key].group);
}

/** texture 组走 CSS：返回可直接塞进 style 的 url(...) */
export function textureUrl(key: ArtKey): string {
  const meta = IMAGES[key];
  if (meta.group !== 'texture') throw new Error(`textureUrl: ${key} 不属于 texture 组`);
  return `url('${meta.src}')`;
}

/**
 * 内联 onerror 里的兜底 HTML：先按 JS 字符串转义（反斜杠/单引号），再做 HTML 属性转义。
 * 单引号只能写成 \' —— 写成 &#39; 会被 HTML 解码回 ' 反而截断 JS 字符串。
 */
function fallbackLiteral(html: string): string {
  return html
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

/** 首页 hero 的 preload 标签（唯一允许预加载的一张）；图没落盘时返回空串 */
export function heroPreload(): string {
  if (!PRESENT.has('heroKeyart')) return '';
  return `<link rel="preload" as="image" href="${IMAGES.heroKeyart.src}">`;
}

export { ART_BUDGET_KB, ART_COUNT, IMAGES, GROUPS, ORDER as ART_ORDER };
export type { ArtGroup, ArtKey };
