/**
 * 极简 DOM 层：全部界面用字符串拼装 + 一次性 innerHTML 挂载。
 *
 * 为什么不用框架：设计硬约束要求零第三方依赖、dist 三个文件 ≤140 KB。
 * 这个规模下模板字符串比任何虚拟 DOM 都便宜，而且首屏无图片也能 1 秒可交互。
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 拼 class：忽略假值 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function root(): HTMLElement {
  const node = document.getElementById('app');
  if (!node) throw new Error('mount: 找不到 #app');
  return node;
}

export interface MountOptions {
  /** 同屏局部重绘时保留滚动位置；只有跨屏切换才需要回到顶部 */
  keepScroll?: boolean;
}

export function mount(html: string, options: MountOptions = {}): void {
  root().innerHTML = html;
  document.getElementById('boot')?.setAttribute('hidden', '');
  // 修复：以前无条件 scrollTo(0,0)，点一次心态/战术按钮整页就跳回顶部
  if (!options.keepScroll) window.scrollTo(0, 0);
}

/**
 * 渲染失败兜底页：整屏崩了也必须给玩家一条出路（回首页 / 读档 / 导出）。
 * 只在 #app 内容为空或首屏渲染失败时调用，避免覆盖还能玩的界面。
 */
export function fatalError(message: string): void {
  const node = document.getElementById('app');
  if (!node) return;
  node.innerHTML = `
    <div class="card stack" style="margin:24px 0">
      <b>界面没能加载出来</b>
      <div class="small dim">可能是存档损坏、浏览器本地存储不可用，或页面脚本出错。</div>
      <div class="small mono" style="word-break:break-all">${escapeHtml(message)}</div>
      <div class="row--wrap" style="margin-top:6px">
        <button class="btn btn--primary" data-act="nav" data-screen="home">回首页</button>
        <button class="btn" data-act="load">读档</button>
        <button class="btn" data-act="export">导出存档</button>
      </div>
    </div>`;
  document.getElementById('boot')?.setAttribute('hidden', '');
}

/**
 * 事件委托：所有交互都靠 data-act 属性，扫描一遍根节点注册。
 * 这样界面重绘后不需要重新绑定，也避免内联 onclick 里的转义地狱。
 */
type ActHandler = (act: string, node: HTMLElement, event: Event) => void;

export function delegate(handler: ActHandler): void {
  const node = root();
  node.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const hit = target.closest<HTMLElement>('[data-act]');
    if (!hit || !node.contains(hit)) return;
    // 修复：被遮挡时命中的可能是外层容器（本身没有 data-act），
    // 这里只认真实按钮，并吞掉冒泡，避免一次点击触发两层动作。
    if ((hit as HTMLButtonElement).disabled === true) return;
    const act = hit.dataset.act;
    if (!act) return;
    event.preventDefault();
    event.stopPropagation();
    handler(act, hit, event);
  });
}

/** 输入框同样走委托：只注册一次，重绘后依然有效 */
export function delegateInput(handler: (value: string, node: HTMLElement) => void): void {
  const node = root();
  node.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement | null;
    if (!target) return;
    const named = target.closest<HTMLElement>('[data-field]');
    if (!named || !node.contains(named)) return;
    handler(target.value, named);
  });
}

/** 数字格式化：小数位可指定，千分位只用于大额 */
export function num(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  const fixed = digits > 0 ? value.toFixed(digits) : String(Math.round(value));
  return fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function pct(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/** 0~100 的条 */
export function bar(value: number, tone: 'green' | 'gold' | 'red' = 'green'): string {
  const safe = Math.max(0, Math.min(100, Math.round(value)));
  return `<span class="bar bar--${tone}" role="img" aria-label="${safe}%"><i style="width:${safe}%"></i></span>`;
}

export function scoreLine(home: number, away: number): string {
  return `<span class="score-big"><b>${home}</b><em>:</em><b>${away}</b></span>`;
}
