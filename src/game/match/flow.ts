import { streamRng } from '../../core/rng';
import { BALANCE, clamp, round2 } from '../balance';
import type { Fixture, HalfResult, MatchFlow, MatchResult, Mentality, TacticId, WorldState } from '../types';
import { MOMENTS, momentById } from '../config/moments';
import type { MomentTemplate } from '../config/moments';
import { planEdge, resolvePenalty, simulateHalf, teamPower } from './simulate';

/**
 * 两段式比赛（设计 §6.8 / §15.2）。
 *
 * 唯一出口仍然是 `MatchResult`；`MatchFlow` 只是把「上半场 → 半场决策 →
 * 下半场 → 关键时刻」拆开，让玩家有机会插手。
 *
 * 硬约束（单测锁死）：
 * - 半场调整只作用于下半场，`firstHalf` 写入后不许回改；
 * - 换人超过 `subsAllowed`（杯赛 `cupSubsAllowed`）必须拒绝并给原因码；
 * - 关键时刻每场最多 1 次，结果只改剩余比赛的边差。
 */
export interface FlowOptions {
  /** 生涯模式：玩家只能做个人抉择，不能换人（教练 AI 决定） */
  careerPlayer?: boolean;
  /** 杯赛（换人上限 5） */
  cup?: boolean;
}

export interface HalfPlan {
  /** 换人数（0~上限） */
  subs?: number;
  mentality?: Mentality;
  tactic?: TacticId;
}

export interface FlowRejection {
  code: 'SUBS_EXCEEDED' | 'NO_CHANGE';
  text: string;
}

function fixtureOf(world: WorldState, fixtureId: string): Fixture | undefined {
  return world.fixtures.find((f) => f.id === fixtureId);
}

/** 玩家这场的对手/本方教练是否允许换人 */
export function subsLimit(options: FlowOptions = {}): number {
  return options.cup ? BALANCE.cupSubsAllowed : BALANCE.subsAllowed;
}

/** 该场有没有条件触发关键时刻（比分差 ≤ 1；生涯模式只会走个人抉择） */
function pickMoment(world: WorldState, fixtureId: string, diff: number, leading: boolean, options: FlowOptions): string | undefined {
  if (diff > 1) return undefined;
  const rng = streamRng(world.seed, 'moment-pick', fixtureId);
  const eligible = MOMENTS.filter((m) => (options.careerPlayer ? m.careerOnly === true : !m.careerOnly) && (!m.whenLeading || leading));
  if (eligible.length === 0) return undefined;
  // 生涯模式必给一次个人抉择（这是玩家唯一能插手的地方）
  if (options.careerPlayer) return eligible[0]?.id;
  return rng.chance(0.75) ? rng.pick(eligible).id : undefined;
}

/** 开一场比赛：先踢上半场，再决定要不要给关键时刻 */
export function beginFlow(world: WorldState, fixtureId: string, options: FlowOptions = {}): MatchFlow {
  const fixture = fixtureOf(world, fixtureId);
  if (!fixture) throw new Error(`beginFlow: 找不到比赛 ${fixtureId}`);
  const home = world.clubs.find((c) => c.id === fixture.homeId);
  const away = world.clubs.find((c) => c.id === fixture.awayId);
  if (!home || !away) throw new Error(`beginFlow: 球队不存在 ${fixture.homeId} / ${fixture.awayId}`);
  const neutral = fixture.competitionId === 'fifa-club-world' || fixture.competitionId === 'world-cup';
  const ctx = {
    homeId: fixture.homeId,
    awayId: fixture.awayId,
    neutral,
    needWinner: Boolean(fixture.stage),
    homeTactic: home.tactic,
    awayTactic: away.tactic,
  };
  const firstHalf = simulateHalf(world, ctx, 0);
  const diff = Math.abs(firstHalf.homeGoals - firstHalf.awayGoals);
  const leading = firstHalf.homeGoals !== firstHalf.awayGoals;
  const pending = pickMoment(world, fixtureId, diff, leading, options);
  return {
    fixtureId,
    homeId: fixture.homeId,
    awayId: fixture.awayId,
    firstHalf,
    halfTimeActions: [],
    subsUsed: 0,
    mentality: 'balanced',
    moments: [],
    ...(pending ? { pendingMomentId: pending } : {}),
  };
}

/** 当前待抉择的关键时刻模板 */
export function pendingMoment(flow: MatchFlow): MomentTemplate | undefined {
  return flow.pendingMomentId ? momentById(flow.pendingMomentId) : undefined;
}

/**
 * 结算关键时刻：成功率 = difficulty + 能力差 × momentAbilityK。
 * 结果只产出边差，不改已发生的比分。
 */
export function resolveMoment(world: WorldState, flow: MatchFlow, index: number): MatchFlow {
  const template = pendingMoment(flow);
  if (!template) return flow;
  const choice = template.choices[index];
  if (!choice) return flow;
  const home = world.clubs.find((c) => c.id === flow.homeId);
  const away = world.clubs.find((c) => c.id === flow.awayId);
  const mine = home ? teamPower(home) : 60;
  const theirs = away ? teamPower(away) : 60;
  const chance = clamp(choice.difficulty + (mine - theirs) * BALANCE.momentAbilityK, BALANCE.momentSuccessMin, BALANCE.momentSuccessMax);
  const rng = streamRng(world.seed, 'moment', flow.fixtureId);
  const ok = rng.chance(chance);
  const effect = ok ? choice.success : choice.fail;
  const edge = (effect.attackEdge ?? 0) - (effect.defenseEdge ?? 0);
  // 换人上限按赛事：联赛 3 人、杯赛 5 人（不能一律按杯赛上限放行）
  const fixture = fixtureOf(world, flow.fixtureId);
  const comp = fixture ? world.competitions.find((c) => c.id === fixture.competitionId) : undefined;
  const limit = comp && comp.type !== 'league' ? BALANCE.cupSubsAllowed : BALANCE.subsAllowed;
  return {
    ...flow,
    moments: [...flow.moments, { key: template.id, success: ok, text: effect.text }],
    subsUsed: clamp(flow.subsUsed + (effect.subs ?? 0), 0, limit),
    pendingMomentId: undefined,
    ...(edge !== 0 ? { momentEdge: edge } : {}),
  };
}

/**
 * 半场调整：换人 / 心态 / 战术。
 * 超限不静默丢弃，返回原因码。
 */
export function applyHalfTimePlan(flow: MatchFlow, plan: HalfPlan, options: FlowOptions = {}): { flow: MatchFlow; rejected?: FlowRejection } {
  const mentalities: Mentality[] = ['conservative', 'balanced', 'aggressive'];
  const tactics: TacticId[] = ['press', 'possess', 'counter'];
  const subs = plan.subs ?? 0;
  if (subs < 0) return { flow, rejected: { code: 'NO_CHANGE', text: '换人数不能为负。' } };
  if (options.careerPlayer && subs > 0) {
    return { flow, rejected: { code: 'NO_CHANGE', text: '生涯模式下换人由教练决定，你只能决定自己的踢法。' } };
  }
  const used = flow.subsUsed + subs;
  if (used > subsLimit(options)) {
    return {
      flow,
      rejected: { code: 'SUBS_EXCEEDED', text: `换人超限：本场最多 ${subsLimit(options)} 人，已用 ${flow.subsUsed}。` },
    };
  }
  const mentality = plan.mentality && mentalities.includes(plan.mentality) ? plan.mentality : flow.mentality;
  const actions = [...flow.halfTimeActions];
  if (subs > 0) actions.push({ type: 'sub', value: String(subs) });
  if (mentality !== flow.mentality) actions.push({ type: 'mentality', value: mentality });
  if (plan.tactic && tactics.includes(plan.tactic)) actions.push({ type: 'tactic', value: plan.tactic });
  if (actions.length > BALANCE.halfTimeMaxActions * 2) {
    // 换人 + 心态 + 战术最多各一次，超出说明前端传重了
    return { flow, rejected: { code: 'NO_CHANGE', text: '半场动作过多。' } };
  }
  return {
    flow: {
      ...flow,
      halfTimeActions: actions.slice(0, BALANCE.halfTimeMaxActions + 1),
      subsUsed: used,
      mentality,
      ...(plan.tactic ? { planTactic: plan.tactic } : {}),
    },
  };
}

/** 下半场的强度边差：换人体能红利 + 心态 + 战术变化 + 关键时刻 */
function secondHalfEdge(flow: MatchFlow): number {
  const subs = planEdge({
    subsCount: flow.subsUsed,
    squadQuality: 60,
    benchQuality: 66,
    mentality: flow.mentality,
    tacticChanged: Boolean(flow.planTactic),
    tacticAdvantage: 3,
  });
  return round2(subs + (flow.momentEdge ?? 0));
}

/** 踢完下半场，产出最终 `MatchResult` */
export function finishFlow(world: WorldState, flow: MatchFlow): { flow: MatchFlow; result: MatchResult } {
  const fixture = fixtureOf(world, flow.fixtureId);
  const home = world.clubs.find((c) => c.id === flow.homeId);
  const away = world.clubs.find((c) => c.id === flow.awayId);
  if (!fixture || !home || !away) throw new Error(`finishFlow: 比赛或球队不存在 ${flow.fixtureId}`);
  const neutral = fixture.competitionId === 'fifa-club-world' || fixture.competitionId === 'world-cup';
  const ctx = {
    homeId: flow.homeId,
    awayId: flow.awayId,
    neutral,
    needWinner: Boolean(fixture.stage),
    homeTactic: home.tactic,
    awayTactic: away.tactic,
  };
  const second = simulateHalf(world, ctx, 1, {
    mentality: flow.mentality,
    subsEdge: secondHalfEdge(flow),
    ...(flow.planTactic ? { homeTactic: flow.planTactic } : {}),
  });
  const homeGoals = flow.firstHalf.homeGoals + second.homeGoals;
  const awayGoals = flow.firstHalf.awayGoals + second.awayGoals;
  const result: MatchResult = {
    homeGoals,
    awayGoals,
    homeXg: round2(flow.firstHalf.homeXg + second.homeXg),
    awayXg: round2(flow.firstHalf.awayXg + second.awayXg),
    penalty: 'none',
    scorers: [],
    keyEvents: flow.moments.map((m) => m.text),
    halfTime: { homeGoals: flow.firstHalf.homeGoals, awayGoals: flow.firstHalf.awayGoals },
  };
  if (ctx.needWinner && homeGoals === awayGoals) {
    // 与自动模拟共用同一套点球算法/种子，避免交互与 AI 对 AI 结果口径不一致
    const pen = resolvePenalty(flow.homeId, flow.awayId, world.seed + world.week, (clubId) => {
      const club = world.clubs.find((c) => c.id === clubId);
      return club ? (club.attack + club.midfield) / 2 : 50;
    });
    result.penalty = pen.winner;
    result.penaltyScore = pen.score;
  }
  return { flow: { ...flow, result }, result };
}

/** 一场比赛玩家总共做了几个决策（设计 §15.1 公理 1 的统计口径） */
export function decisionsCount(flow: MatchFlow): number {
  return 1 + flow.halfTimeActions.length + (flow.moments.length > 0 ? 1 : 0);
}

/** 只算上半场（供 UI 预览，不推进世界） */
export function halfSummary(half: HalfResult): { goals: string; xg: string } {
  return { goals: `${half.homeGoals}-${half.awayGoals}`, xg: `${half.homeXg.toFixed(2)} / ${half.awayXg.toFixed(2)}` };
}
