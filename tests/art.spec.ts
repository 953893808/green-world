import { describe, expect, it } from 'vitest';
import manifestJson from '../assets/art-manifest.json';
import {
  ART_BUDGET_KB,
  ART_COUNT,
  ART_ORDER,
  GROUPS,
  IMAGES,
  artSrc,
  fallbackBlock,
  heroPreload,
  img,
  isPresent,
  textureUrl,
} from '../src/ui/art';

/**
 * 美术图位的一致性看守（src/ui/art.ts:16 的注释点名要这个文件）。
 *
 * 这条线有三份数据必须永远对齐，任何一份漂移都会在运行时表现成「图裂了 / 兜底块盖住内容」：
 *  1. `assets/art-manifest.json` —— 人写的源（含声明宽高）；
 *  2. `src/ui/art-manifest.ts`   —— gen-art.mjs 生成的紧凑表（src + w/h + present 位）；
 *  3. `assets/img/**\/*.webp`    —— 磁盘上真实的图。
 *
 * 本文件用 `import.meta.glob` 无 fs 地核对第 3 份的**存在性与命名**（这样 `npm test`
 * 在纯 Node 环境、没有 @types/node 也能跑）；**真实像素尺寸与体积**由
 * `scripts/check-art.mjs` 读 WebP 头核对，`npm run build` 与 CI 都会跑它。
 */

interface ManifestFile extends Array<string | number> {
  0: string;
  1: number;
  2: number;
}

interface ManifestGroup {
  dir: string;
  prefix: string;
  files: ManifestFile[];
}

interface Manifest {
  version: number;
  budgetKB: number;
  groups: Record<string, ManifestGroup>;
}

const manifest = manifestJson as unknown as Manifest;

/** 与 src/ui/art.ts:28 `keyOfTail` 完全同规则（故意复制一份：写错会立刻在比对上暴露） */
function keyOfTail(tail: string): string {
  const words = tail.split('-').slice(1);
  return words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');
}

const declared = Object.entries(manifest.groups).flatMap(([group, g]) =>
  g.files.map((f) => ({
    group,
    dir: g.dir,
    file: `${f[0]}.webp`,
    src: `./assets/img/${g.dir}/${f[0]}.webp`,
    key: keyOfTail(f[0].slice(g.prefix.length)),
    w: f[1],
    h: f[2],
  })),
);

/** 构建期就展开的图清单：文件缺失时这里会少条目，不依赖 fs。 */
const onDisk = Object.keys(import.meta.glob('../assets/img/**/*.webp')).map((p) =>
  p.replace('../', '').split('\\').join('/'),
);

describe('art：manifest 与生成物', () => {
  it('manifest 声明 105 个图位 / 11 个分组 / 预算与 ART_BUDGET_KB 一致', () => {
    expect(declared).toHaveLength(105);
    expect(Object.keys(manifest.groups)).toHaveLength(11);
    expect(ART_COUNT).toBe(105);
    expect(ART_BUDGET_KB).toBe(manifest.budgetKB);
  });

  it('ART_ORDER 的 key 唯一且与 IMAGES 一一对应', () => {
    expect(ART_ORDER).toHaveLength(105);
    expect(new Set(ART_ORDER).size).toBe(105);
    expect(Object.keys(IMAGES)).toHaveLength(105);
    expect([...ART_ORDER].sort()).toEqual(Object.keys(IMAGES).sort());
  });

  it('manifest 每个图位在运行时都有 key，src 双向一一相等', () => {
    const dict = IMAGES as Record<string, { src: string; w: number; h: number; group: string }>;
    for (const d of declared) {
      expect(dict[d.key], `manifest 图位 ${d.key} 在 art-manifest.ts 里缺失`).toBeDefined();
      expect(artSrc(d.key as never)).toBe(d.src);
    }
    const runtimeSrcs = new Set(ART_ORDER.map((k) => artSrc(k)));
    expect(runtimeSrcs.size).toBe(105);
    const declaredSrcs = new Set(declared.map((d) => d.src));
    expect([...runtimeSrcs].sort()).toEqual([...declaredSrcs].sort());
  });

  it('每组声明的宽高与运行时 artMeta 完全一致', () => {
    const dict = IMAGES as Record<string, { src: string; w: number; h: number; group: string }>;
    for (const d of declared) {
      const meta = dict[d.key]!;
      expect(meta.w, `${d.key} 宽`).toBe(d.w);
      expect(meta.h, `${d.key} 高`).toBe(d.h);
      expect(meta.src).toBe(d.src);
      expect(meta.group).toBe(d.group);
    }
  });

  it('GROUPS 的目录名与计数与 manifest 一致', () => {
    for (const [group, g] of Object.entries(manifest.groups)) {
      expect(GROUPS[g.dir], `${group} 组缺失`).toBeDefined();
      expect(GROUPS[g.dir]!.count).toBe(g.files.length);
      expect(g.dir).toBe(group);
    }
    expect(Object.keys(GROUPS)).toHaveLength(11);
  });

  it('preload 档只有 hero 一张，其余都是 lazy', () => {
    expect(ART_ORDER.filter((k) => IMAGES[k].tier === 'preload')).toEqual(['heroKeyart']);
  });
});

describe('art：磁盘上的图片文件', () => {
  it('105 张 WebP 都在 assets/img 下（多一张少一张都算漂移）', () => {
    expect(onDisk.sort()).toEqual(declared.map((d) => `assets/img/${d.dir}/${d.file}`).sort());
  });

  it('文件名符合「组-序号-名.webp」规范', () => {
    const nameRe = /^[a-z]+-[a-z]?\d{2}-[a-z0-9-]+\.webp$/;
    for (const d of declared) expect(nameRe.test(d.file), `${d.file} 命名不合规`).toBe(true);
  });

  it('105 张全部标记为 present（缺任何一张都会退化成兜底块）', () => {
    expect(ART_ORDER.filter((k) => !isPresent(k))).toEqual([]);
    expect(heroPreload()).toContain('assets/img/brand/');
  });
});

describe('art：渲染契约', () => {
  it('img() 带齐 width/height/loading/decoding/alt/onerror 兜底', () => {
    const html = img('heroKeyart', { alt: '球场' });
    expect(html).toContain('<img src="./assets/img/brand/');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('alt="球场"');
    expect(html).toContain('loading="eager"');
    expect(html).toContain('onerror=');
    expect(html).toContain('art-fallback');
    expect(html).toContain('data-art="heroKeyart"');
    // width/height 必须是真实像素（不是 0），否则 CLS 挡不住
    expect(html).toMatch(/width="[1-9]\d*"/);
    expect(html).toMatch(/height="[1-9]\d*"/);
  });

  it('懒加载图带 loading="lazy"，且尺寸按显示宽度等比缩放', () => {
    const html = img('stadiumDay', { displayWidth: 320 });
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('width="320"');
    // 640×360 的图缩到 320 宽 → 180 高
    expect(html).toContain('height="180"');
  });

  it('fallbackBlock 产出同组的渐变块', () => {
    expect(fallbackBlock('heroKeyart')).toContain('art-fallback art-fallback--brand');
    expect(fallbackBlock('leagueTitle')).toContain('art-fallback--honor');
  });

  it('texture 组只走 CSS 背景，误用时报错', () => {
    expect(textureUrl('paperGrain')).toMatch(/^url\('\.\/assets\/img\/texture\/.*\.webp'\)$/);
    expect(() => textureUrl('heroKeyart')).toThrow(/texture/);
  });
});
