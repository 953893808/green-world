#!/usr/bin/env node
/**
 * 美术验收（设计 §12.5 / 美术分册 §5.1）。
 *
 * 检查项：
 *  1. manifest 里每个 src 对应文件是否存在；
 *  2. 各组实际文件数 = manifest 声明数；
 *  3. assets/img 总体积 ≤ budgetKB；
 *  4. 文件名符合 ^[a-z]+-[a-z]?\d{2}-[a-z0-9-]+\.webp$；
 *  5. 图片真实像素尺寸与声明一致（读 WebP 头，不解码像素；文件非空）；
 *  6. dist/ 里不得出现 art-manifest.json（防止有人又回去 fetch）。
 *
 * 缺图不算失败（P6 之前美术是用户正在补的活），默认只 warning；
 * 加 --strict 则缺图也算失败。**尺寸不符、超预算、命名不合规永远算失败**（exit 1）：
 * 这些是「已经放了图但放错了」，不是「还没放」，不能靠 --strict 才拦。
 *
 * `npm run build` 用 --strict；`npm run check:art` 保持宽松，方便边补图边跑。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWebpSize } from './lib/webp-dims.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'assets', 'art-manifest.json');
const imgRoot = join(root, 'assets', 'img');
const strict = process.argv.includes('--strict');
const NAME_RE = /^[a-z]+-[a-z]?\d{2}-[a-z0-9-]+\.webp$/;

const errors = [];
const warnings = [];

function main() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const budget = manifest.budgetKB ?? 1536;

  let totalBytes = 0;
  let found = 0;
  let missing = 0;
  let dimsChecked = 0;
  const dimsBad = [];

  for (const [groupName, group] of Object.entries(manifest.groups)) {
    const dir = join(imgRoot, group.dir);
    const expected = new Map(group.files.map((f) => [`${f[0]}.webp`, f]));

    if (existsSync(dir)) {
      const actual = readdirSync(dir).filter((n) => !n.startsWith('.'));
      for (const name of actual) {
        if (!NAME_RE.test(name)) errors.push(`${group.dir}/${name} 命名不合规`);
        if (!expected.has(name)) warnings.push(`${group.dir}/${name} 不在 manifest 里（多余文件）`);
      }
      for (const [name, entry] of expected) {
        if (!actual.includes(name)) {
          missing += 1;
          continue;
        }
        found += 1;
        // 像素级核对：manifest 声明 [名字, 宽, 高]，实图头里的宽高必须完全一致。
        const [, declaredW, declaredH] = entry;
        const file = join(dir, name);
        const size = statSync(file).size;
        if (size === 0) {
          errors.push(`${group.dir}/${name} 是 0 字节空文件`);
          continue;
        }
        let real;
        try {
          real = readWebpSize(readFileSync(file));
        } catch (error) {
          errors.push(`${group.dir}/${name} 不是可解析的 WebP：${error.message}`);
          continue;
        }
        dimsChecked += 1;
        if (real.width !== declaredW || real.height !== declaredH) {
          dimsBad.push(`${group.dir}/${name} 声明 ${declaredW}×${declaredH}，实图 ${real.width}×${real.height}`);
        }
      }
      // 体积
      const walk = (d) => {
        for (const n of readdirSync(d)) {
          const p = join(d, n);
          const st = statSync(p);
          if (st.isDirectory()) walk(p);
          else totalBytes += st.size;
        }
      };
      walk(dir);
    } else {
      missing += expected.size;
    }
  }

  if (found + missing !== Object.values(manifest.groups).reduce((a, g) => a + g.files.length, 0)) {
    errors.push('manifest 声明数与检查数不符（内部错误）');
  }
  for (const bad of dimsBad) errors.push(`像素尺寸不符：${bad}`);
  const totalKB = Math.round(totalBytes / 1024);
  if (totalKB > budget) errors.push(`美术总体积 ${totalKB} KB 超过预算 ${budget} KB`);

  // dist/ 不得出现 art-manifest.json
  const distManifest = join(root, 'dist', 'art-manifest.json');
  if (existsSync(distManifest)) {
    errors.push('dist/ 里出现 art-manifest.json —— 运行时只能 import TS 模块，不许 fetch JSON');
  }

  const hasAny = found > 0;
  console.log(
    hasAny
      ? `check-art: ${found} 张已就位 / ${missing} 张待补；像素核对 ${dimsChecked} 张（${dimsBad.length} 张不符）；共 ${totalKB} KB / 预算 ${budget} KB`
      : `check-art: 尚未放入任何图片（${missing} 张待补）。界面会用同色系渐变块兜底，这不影响可玩性。`,
  );
  for (const w of warnings.slice(0, 10)) console.warn('  warn ' + w);
  if (warnings.length > 10) console.warn(`  … 另有 ${warnings.length - 10} 条 warn`);

  if (errors.length > 0) {
    for (const e of errors) console.error('  error ' + e);
    process.exit(1);
  }
  if (strict && missing > 0) {
    console.error(`check-art --strict: 还缺 ${missing} 张图`);
    process.exit(1);
  }
  console.log('check-art: OK');
}

main();
