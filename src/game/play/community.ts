import type { Rng } from '../../core/rng';
import { BALANCE } from '../balance';

/**
 * 球迷社区层（设计 §15.5）—— 叙事与软数值，**不改变积分/资格**。
 *
 * 硬约束：热评不超 `hotCommentMaxLen`、不重复模板、不产生空串；
 * 关掉开关后返回空数组且游戏完全正常。
 */
export interface CommentContext {
  club: string;
  opponent: string;
  /** 例：2-1 */
  score: string;
  won: boolean;
  drew: boolean;
  /** 玩家个人评分（生涯模式才有） */
  rating?: number;
  player?: string;
  coach?: string;
}

const WIN_LINES: readonly string[] = [
  '{club} 这半场换人总算像个教练了，早这么打至于这样吗',
  '{score} 拿下 {opponent}，这波我给满分',
  '{club} 现在这套打法是真的顺，别乱动',
  '{player} 这个状态，国家队不考虑一下？',
  '赢球掩盖不了问题，但今天先吹',
];

const DRAW_LINES: readonly string[] = [
  '{score} 跟 {opponent} 握手，这分拿得不亏',
  '又是差一口气，{club} 什么时候能咬死比赛',
  '平局专家，{club} 这赛季第几个了',
  '不输就行，慢慢来吧',
];

const LOSS_LINES: readonly string[] = [
  '输给 {opponent}，{club} 这防线真的没法看',
  '{score} 这个比分，教练位置上得有人负责',
  '{coach} 到底会不会换人？',
  '{player} 全场最低分不是没有原因的',
  '别急，赛季还长——但真的别急吗',
];

const MEME_LINES: readonly string[] = [
  '裁判这哨……算了不说了',
  '{club} 的比赛建议睡前看，助眠',
  '我宣布这是本周最有节目效果的一场',
  '看台上的我在第 80 分钟就开始收拾东西了',
];

const ALL_LINES: readonly string[] = [...WIN_LINES, ...DRAW_LINES, ...LOSS_LINES, ...MEME_LINES];

function fill(template: string, ctx: CommentContext): string {
  const rating = ctx.rating !== undefined ? ctx.rating.toFixed(1) : '6.0';
  return template
    .replace(/\{club\}/g, ctx.club)
    .replace(/\{opponent\}/g, ctx.opponent)
    .replace(/\{score\}/g, ctx.score)
    .replace(/\{rating\}/g, rating)
    .replace(/\{player\}/g, ctx.player ?? '他')
    .replace(/\{coach\}/g, ctx.coach ?? '主帅');
}

/**
 * 生成 3~5 条赛后热评。纯模板 + 变量，不训练模型、不联网。
 * `enabled === false` 时返回空数组（社区层开关）。
 */
export function makeHotComments(ctx: CommentContext, rng: Rng, enabled = true): string[] {
  if (!enabled) return [];
  const pool = [...(ctx.won ? WIN_LINES : ctx.drew ? DRAW_LINES : LOSS_LINES), ...MEME_LINES];
  const wanted = BALANCE.hotCommentCountMin + rng.int(0, BALANCE.hotCommentCountMax - BALANCE.hotCommentCountMin);
  const used = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < wanted && out.length < 5; i++) {
    const raw = pool[rng.int(0, pool.length - 1)] ?? ALL_LINES[0] ?? '';
    if (!raw || used.has(raw)) continue;
    used.add(raw);
    const text = fill(raw, ctx).slice(0, BALANCE.hotCommentMaxLen);
    if (text) out.push(text);
  }
  return out;
}

/** 球迷情绪变化（胜 +、平略正、负 −，按比分差放大） */
export function moodShift(won: boolean, drew: boolean, margin: number): number {
  const base = won ? 5 : drew ? 1 : -5;
  return Math.round(base + (won ? 1 : drew ? 0 : -1) * Math.min(3, Math.abs(margin)));
}

/** 关闭社区层时的空态文案（不给空数组就直接消失，避免 UI 露馅） */
export function communityOffText(): string {
  return '社区层已在设置里关闭：这里不会生成任何热评，也不影响比赛与积分。';
}
