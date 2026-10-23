#!/usr/bin/env node
/**
 * assets/art-manifest.json  →  src/ui/art-manifest.ts
 *
 * 为什么要有这一步（设计 §10.5.2 / 美术分册 §5.1b）：
 * 运行时绝不能 `fetch('art-manifest.json')` —— 双击 file:// 打开时 origin 为 null，
 * fetch 会被 CORS 拦死，整套美术直接失效。所以把 manifest 在构建前编译进 bundle。
 *
 * 为什么输出的是「紧凑表」而不是对象字面量：
 * 105 条 `{ src, w, h, group, tier }` 字面量要吃掉 ~14 KB，直接顶爆 app.js 的预算。
 * 这里压成一张字符串表 + 一个 0/1 落盘标记串，由 art.ts 在启动时解析一次，
 * 体积从 ~14 KB 降到 ~3 KB；`ArtKey` 仍然是字面量联合类型（类型在编译后被抹掉，不占字节）。
 *
 * 用法：node scripts/gen-art.mjs [--check]
 *   --check  只校验不写文件（CI 用）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'assets', 'art-manifest.json');
const outPath = join(root, 'src', 'ui', 'art-manifest.ts');
const checkOnly = process.argv.includes('--check');

/** brand-02-hero-keyart → heroKeyart；event-c01-extra-training → extraTraining */
function keyOf(file, prefix) {
  const tail = file.startsWith(prefix) ? file.slice(prefix.length) : file;
  const parts = tail.split('-');
  // 首段是序号（02、c01、m12），丢掉
  const words = parts.slice(1);
  if (words.length === 0) throw new Error(`gen-art: 无法从 ${file} 推导 key`);
  return words
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
}

function main() {
  if (!existsSync(manifestPath)) {
    console.error(`gen-art: 找不到 ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const groups = []; // { name, dir, prefix, entries: [[tail, w, h, tier]] }
  const keyList = [];
  const seen = new Set();

  for (const [groupName, group] of Object.entries(manifest.groups)) {
    if (!group.dir || !group.prefix || !Array.isArray(group.files)) {
      throw new Error(`gen-art: 分组 ${groupName} 缺 dir / prefix / files`);
    }
    // art.ts 从「目录」反推分组名（省掉表里 11 份重复名字），所以两者必须同名
    if (group.dir !== groupName) {
      throw new Error(`gen-art: 分组 ${groupName} 的 dir=${group.dir} 与分组名不同名，art.ts 无法解析`);
    }
    const entries = [];
    for (const entry of group.files) {
      const [file, w, h, tier] = entry;
      if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
        throw new Error(`gen-art: ${file} 的宽高非法`);
      }
      // tier 只有两种合法值：不写 = 懒加载，'preload' = 首屏预取。
      // 以前写错（如 'eager'）会被静默降级成 lazy，这里改成直接报错。
      if (tier !== undefined && tier !== 'preload') {
        throw new Error(`gen-art: ${file} 的 tier="${tier}" 非法（只能是 'preload' 或省略）`);
      }
      const key = keyOf(file, group.prefix);
      if (seen.has(key)) throw new Error(`gen-art: key 冲突 "${key}"（${file}）`);
      seen.add(key);
      keyList.push(key);
      // 表里只留「前缀之后的尾名」，前缀放进组头，省 105 × 8 字节。
      // key 不写进表：运行时按同一规则从尾名推导（丢掉序号段再驼峰化），
      // 两边规则必须一致，tests/art.spec.ts 会逐条比对 105 个 key。
      const tail = file.startsWith(group.prefix) ? file.slice(group.prefix.length) : file;
      entries.push([tail, w, h, tier === 'preload' ? '*' : '']);
    }
    groups.push({ name: groupName, dir: group.dir, prefix: group.prefix, entries });
  }

  // 哪些图真的落盘了（缺图时 UI 直接走渐变块，避免 105 个 404）
  const bits = [];
  let presentCount = 0;
  for (const g of groups) {
    for (const [tail] of g.entries) {
      const rel = `assets/img/${g.dir}/${g.prefix}${tail}.webp`;
      const exists = existsSync(join(root, rel));
      bits.push(exists ? '1' : '0');
      if (exists) presentCount += 1;
    }
  }

  const table = groups
    .map((g) => {
      const body = g.entries
        .map(([tail, w, h, mark]) => (mark ? `${tail},${w},${h},${mark}` : `${tail},${w},${h}`))
        .join(';');
      return `${g.dir}:${g.prefix}~${body}`;
    })
    .join('|');

  if (table.includes("'") || table.includes('\\')) {
    throw new Error('gen-art: 文件名里出现了引号或反斜杠，无法安全写入字符串字面量');
  }

  const total = seen.size;
  const keyUnion = keyList.map((k) => `'${k}'`).join(' | ');
  const groupUnion = groups.map((g) => `'${g.name}'`).join(' | ');

  const lines = [];
  lines.push('// 自动生成，请勿手改。改 assets/art-manifest.json 后跑 node scripts/gen-art.mjs');
  lines.push(`export const ART_BUDGET_KB = ${String(manifest.budgetKB ?? 1536)};`);
  lines.push(`export const ART_COUNT = ${total};`);
  lines.push('');
  lines.push('/**');
  lines.push(' * 图位表（紧凑）：组之间用 `|` 分隔；每组 `目录:前缀~尾名,宽,高[,*];...`，');
  lines.push(' * `*` 表示 preload（全套只有 hero 一张）。运行时在 art.ts 里解析一次。');
  lines.push(' */');
  lines.push(`export const ART_TABLE = '${table}';`);
  lines.push('');
  lines.push('/** 与 ART_TABLE 条目同序的落盘标记：1 = 文件已在 assets/img/ 下 */');
  lines.push(`export const ART_PRESENT_BITS = '${bits.join('')}';`);
  lines.push('');
  lines.push(`export type ArtKey = ${keyUnion};`);
  lines.push(`export type ArtGroup = ${groupUnion};`);
  lines.push('');

  const out = lines.join('\n');
  if (checkOnly) {
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
    if (current !== out) {
      console.error('gen-art --check: src/ui/art-manifest.ts 与 manifest 不一致，请重新生成');
      process.exit(1);
    }
    console.log(`gen-art --check: 一致（${total} 张）`);
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out, 'utf8');
  console.log(
    `gen-art: 写入 ${outPath}（${total} 张 / ${groups.length} 组，已落盘 ${presentCount} 张）`,
  );
}

main();
