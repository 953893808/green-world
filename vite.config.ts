import { cpSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

/**
 * 交付物必须是「双击 dist/index.html 就能玩」的静态产物：
 * - base: './'            相对路径，file:// 下可用
 * - 单一入口 app.js       不许出现上百个 chunk
 * - assetsInlineLimit 16KB 小图/小 CSS 内联，减少请求
 *
 * 另外挂一个构建期插件 `htmlLiteralMin`：视图里的 HTML 都写在模板字符串里，
 * 而压缩器**不会**动字符串内容，缩进与换行就原样进了产物（实测 4.1 KB）。
 * 这里在打包前把「模板字符串文本段」里的换行+缩进折成一个空格：
 * - 只处理 `\`...\`` 的**文本段**，`${...}` 里的代码原样保留（按花括号配平跳过）
 * - 项目里没有任何 `white-space: pre` / `<pre>`，HTML 本身也会折叠连续空白，
 *   因此渲染语义不变，源码可读性也不受影响
 */
function collapseTemplate(x: string): string {
  let out = '';
  let i = 0;
  const n = x.length;
  while (i < n) {
    const c = x[i];
    if (c !== '`') {
      out += c;
      i++;
      continue;
    }
    out += '`';
    i++;
    let depth = 0;
    while (i < n) {
      const ch = x[i];
      if (ch === '\\') {
        out += ch + (x[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (depth === 0 && ch === '`') {
        out += '`';
        i++;
        break;
      }
      if (depth === 0 && ch === '$' && x[i + 1] === '{') {
        out += '${';
        i += 2;
        depth++;
        continue;
      }
      if (depth > 0) {
        if (ch === '{') {
          depth++;
          out += ch;
          i++;
          continue;
        }
        if (ch === '}') {
          depth--;
          out += ch;
          i++;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          const q = ch;
          out += q;
          i++;
          while (i < n) {
            if (x[i] === '\\') {
              out += x[i] + (x[i + 1] ?? '');
              i += 2;
              continue;
            }
            out += x[i];
            if (x[i] === q) {
              i++;
              break;
            }
            i++;
          }
          continue;
        }
        out += ch;
        i++;
        continue;
      }
      if (ch === '\n' || ch === '\t' || ch === ' ') {
        let j = i;
        let hasNewline = false;
        while (j < n && (x[j] === '\n' || x[j] === '\t' || x[j] === ' ')) {
          if (x[j] === '\n') hasNewline = true;
          j++;
        }
        // 标记之间的纯空白（`>   <`）对布局没有意义，直接删掉，别再留一个空格
        const betweenTags = out.endsWith('>') && x[j] === '<';
        if (!betweenTags) out += hasNewline ? ' ' : x.slice(i, j);
        i = j;
        continue;
      }
      out += ch;
      i++;
    }
  }
  return out;
}

function htmlLiteralMin(): Plugin {
  return {
    name: 'html-literal-min',
    enforce: 'pre',
    transform(code, id) {
      const clean = id.replace(/\\/g, '/');
      if (!clean.includes('/src/') || !clean.endsWith('.ts') || clean.endsWith('.d.ts')) return null;
      const out = collapseTemplate(code);
      return out === code ? null : { code: out, map: null };
    },
  };
}

/**
 * 属性引号压缩。
 *
 * `class="card"` → `class=card`。HTML 允许无引号属性值，只要值里不含空格、
 * 引号、`=`、`<`、`>`；这里只匹配 `[A-Za-z0-9_:.-]+`，带空格的值（如
 * `alt="某 某"`）自动跳过。实测省约 0.5 KB。
 *
 * 只作用于 src 目录下的 .ts 文件（视图模板所在处）。
 */
function compactMarkup(): Plugin {
  return {
    name: 'compact-markup',
    enforce: 'pre',
    transform(code, id) {
      const clean = id.replace(/\\/g, '/');
      if (!clean.includes('/src/') || !clean.endsWith('.ts') || clean.endsWith('.d.ts')) return null;
      const out = code.replace(/(\s[a-zA-Z-]+)="([A-Za-z0-9_:.-]+)"/g, '$1=$2');
      return out === code ? null : { code: out, map: null };
    },
  };
}

/**
 * 离线产物：`file://` 双击必须能玩。
 *
 * Chrome 对 `file://` 页面的 `<script type="module">` 一律按 CORS 处理，
 * origin 是 `null`，直接把整包 JS 拦死（ERR_FAILED）—— 页面白屏。
 * 我们的产物本来就是单文件、没有 top-level import/export（format: 'iife'），
 * 所以降级成经典脚本 `<script defer>` 语义完全等价，且不再受 CORS 约束；
 * 同理去掉 stylesheet / script 上的 `crossorigin` 属性（file:// 下发 CORS 请求会失败）。
 */
function offlineHtml(): Plugin {
  return {
    name: 'offline-html',
    enforce: 'post',
    apply: 'build',
    transformIndexHtml(html) {
      return html
        .replace(
          /<script type="module"([^>]*)src="([^"]+)"[^>]*><\/script>/g,
          (_m, _attrs, src) => `<script defer src="${src}"></script>`,
        )
        .replace(/\s+crossorigin(?=[\s>])/g, '');
    },
  };
}

/**
 * 美术目录 `assets/img` 在**项目根**，不在 `src/` 里，也不在 `publicDir` 里，
 * 所以 vite 打包时不会带走它；而 `src/ui/art.ts` 拼的是运行时相对路径
 * `./assets/img/<组>/<文件>.webp`，产物里必须真有这份目录，否则双击
 * `dist/index.html` 时 105 张图全部 404（smoke 的 3 条 pageErrors 就是这么来的）。
 *
 * 这里在构建收尾把整个 `assets/img` 原样递归复制到 `dist/assets/img`。
 * 只复制、不压缩、不改名——文件名与分组是 check-art.mjs 和 manifest 的契约。
 */
function copyArt(): Plugin {
  return {
    name: 'copy-art',
    apply: 'build',
    closeBundle() {
      const from = resolve('assets', 'img');
      const to = resolve('dist', 'assets', 'img');
      if (!existsSync(from)) return;
      cpSync(from, to, { recursive: true, force: true });
      const n = readdirSync(to, { recursive: true }).filter((f) =>
        String(f).endsWith('.webp'),
      ).length;
      this.info(`copy-art: ${n} 张 WebP → dist/assets/img`);
    },
  };
}

export default defineConfig({
  plugins: [htmlLiteralMin(), compactMarkup(), offlineHtml(), copyArt()],
  base: './',
  build: {
    // esnext：现代浏览器都支持，产物里少一批降级包装；target 只影响语法降级，不影响兼容底线
    target: 'esnext',
    assetsInlineLimit: 16 * 1024,
    cssCodeSplit: false,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        format: 'iife',
        entryFileNames: 'app.js',
        chunkFileNames: 'chunk-[name].js',
        assetFileNames: (info) => {
          const name = info.names?.[0] ?? '';
          if (name.endsWith('.css')) return 'style.css';
          return 'assets/[name][extname]';
        },
      },
    },
  },
  server: {
    port: 5199,
  },
});
