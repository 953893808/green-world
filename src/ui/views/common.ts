import { escapeHtml } from '../dom';
import { app } from '../state';
import type { ScreenId } from '../state';

/**
 * 页面外壳。所有屏都用 here，保证顶栏/底栏/提示条一致。
 *
 * 为什么把动作条做成参数而不是全局：不同屏的主动作不同（首页是「开始」，
 * 主控台是「推进一周」），而固定底栏能省掉滚动找按钮。
 */

export interface PageOptions {
  title: string;
  /** 返回按钮目标；不传则不显示返回 */
  back?: ScreenId;
  /** 顶栏右侧小字（赛季/周次之类） */
  meta?: string;
  /** 底部固定动作条 HTML（一般是 .btn） */
  actions?: string;
  /** 主内容 */
  body: string;
}

export function page(options: PageOptions): string {
  const back = options.back
    ? `<button class="btn btn--ghost btn--sm" data-act="nav" data-screen="${options.back}">← 返回</button>`
    : '';
  // 深页（赛事/积分榜/资格路径/淘汰树）离主控台可能隔了三四层，
  // 给一个一步回家的出口；返回目标本身就是 dashboard 时不重复显示。
  const home = options.back && options.back !== 'dashboard'
    ? `<button class="btn btn--ghost btn--sm" data-act="nav" data-screen="dashboard">主控台</button>`
    : '';
  const meta = options.meta ? `<span class="topbar__meta mono">${escapeHtml(options.meta)}</span>` : '';
  const actions = options.actions ? `<div class="actionbar">${options.actions}</div>` : '';
  return `
    <div class="topbar">
      ${back}${home}
      <span class="topbar__title">${escapeHtml(options.title)}</span>
      ${meta}
    </div>
    ${options.body}
    ${actions}
  `;
}

/** 简单的进度条行 */
export function meterRow(label: string, value: number, tone: 'green' | 'gold' | 'red' = 'green'): string {
  const safe = Math.max(0, Math.min(100, Math.round(value)));
  return `
    <div class="bar-row">
      <span class="bar-row__label">${escapeHtml(label)}</span>
      <span class="grow bar bar--${tone}"><i style="width:${safe}%"></i></span>
      <span class="bar-row__value">${safe}</span>
    </div>`;
}

/** 空态块 */
export function emptyState(text: string): string {
  return `<div class="card card--flat center dim small">${escapeHtml(text)}</div>`;
}

/** 未开局时各屏统一的兜底空态（重复 7 处，收成常量省字节） */
export const noCareer = '<div class="dim">没有进行中的生涯。</div>';

/** 提示条（读档修复、降级说明等） */
export function repairNotice(): string {
  if (app.repaired.length === 0) return '';
  const items = app.repaired.map((r) => `<li>${escapeHtml(r)}</li>`).join('');
  return `<div class="notice"><b>存档已修复</b><ul class="small" style="margin:4px 0 0;padding-left:18px">${items}</ul></div>`;
}

/** 玩家视角的比赛结果标签 */
export function outcomeChip(outcome: 'win' | 'draw' | 'loss'): string {
  const map = { win: ['chip--win', '胜'], draw: ['chip--draw', '平'], loss: ['chip--loss', '负'] } as const;
  const [cls, label] = map[outcome];
  return `<span class="chip ${cls}">${label}</span>`;
}
