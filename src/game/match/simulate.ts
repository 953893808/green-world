import { poisson, streamRng } from '../../core/rng';
import type { Rng } from '../../core/rng';
import { BALANCE, clamp, round2 } from '../balance';
import { CONFEDERATIONS } from '../config/confederations';
import type {
  Club,
  HalfResult,
  MatchContext,
  MatchResult,
  Mentality,
  Player,
  TacticId,
  WorldState,
} from '../types';

/** 球队强度 = 三线加权 × 体能系数 × 状态系数 */
export function teamPower(club: Club, staminaOverride?: number): number {
  const raw = club.attack * BALANCE.wAttack + club.midfield * BALANCE.wMidfield + club.defense * BALANCE.wDefense;
  const stamina = staminaOverride ?? club.stamina;
  const staminaFactor = stamina < BALANCE.lowStaminaWarning
    ? BALANCE.staminaLowFactor + ((1 - BALANCE.staminaLowFactor) * stamina) / BALANCE.lowStaminaWarning
    : 1;
  const formFactor = 0.94 + (club.form / 100) * 0.12;
  return raw * staminaFactor * formFactor;
}

/** 战术对抗：tacticMatrix[a][b] 表示 a 打 b 的边差 */
export function tacticEdge(a: TacticId | undefined, b: TacticId | undefined): number {
  if (!a || !b) return 0;
  const row = BALANCE.tacticMatrix[a];
  const v = row?.[b] ?? 0;
  return v * BALANCE.tacticEdgeK * 10;
}

/** 旅行疲劳：按联合会距离给客队扣体能 */
export function travelFatigue(homeConf: string, awayConf: string): number {
  if (homeConf === awayConf) return 0;
  return BALANCE.travelFatiguePerUnit * 2 * BALANCE.crossConfederationExtra;
}

/** 该俱乐部所属联合会的商业系数，用于主场上座/收入，不影响比分 */
function confederationCommercial(club: Club): number {
  return CONFEDERATIONS.find((c) => c.id === club.confederationId)?.commercial ?? 50;
}

export interface SideContext {
  club: Club;
  tactic: TacticId;
  /** 本场额外修正（半场调整、关键时刻） */
  edge: number;
  stamina: number;
}

/** 单侧 xG：baseXG × exp(diff × strengthK)，再乘客队折减 */
function expectedGoals(diff: number, isHome: boolean): number {
  const xg = BALANCE.baseXG * Math.exp(diff * BALANCE.strengthK);
  return clamp(isHome ? xg : xg * BALANCE.awayXGMultiplier, BALANCE.xGMin, BALANCE.xGMax);
}

export interface SimulateOptions {
  /** 只算一半（0 = 上半场，1 = 下半场），用于两段式交互 */
  half?: 0 | 1;
  /** 上半场已确定的结果（算下半场时传入） */
  firstHalf?: HalfResult;
  /** 场上战术（半场调整后可能变化） */
  homeTactic?: TacticId;
  awayTactic?: TacticId;
  mentality?: Mentality;
  /** 替换带来的强度边差（已折算） */
  subsEdge?: number;
  /** 关键时刻带来的边差 */
  momentEdge?: number;
  /** 球队索引，批量模拟时传入避免 O(n²) 查找 */
  index?: ClubIndex;
}

export type ClubIndex = Map<string, Club>;

export function buildClubIndex(world: WorldState): ClubIndex {
  return new Map(world.clubs.map((c) => [c.id, c]));
}

function lookup(world: WorldState, id: string, index?: ClubIndex): Club | undefined {
  return index ? index.get(id) : world.clubs.find((c) => c.id === id);
}

function zeroHalf(): HalfResult {
  return { homeGoals: 0, awayGoals: 0, homeXg: 0, awayXg: 0 };
}

function hashMatch(seed: number, ...tags: (string | number)[]): Rng {
  return streamRng(seed, 'match', ...tags);
}

/** 计算单侧半场结果（不含点球） */
function playHalf(
  world: WorldState,
  ctx: MatchContext,
  options: SimulateOptions,
  halfIndex: 0 | 1,
): HalfResult {
  const home = lookup(world, ctx.homeId, options.index);
  const away = lookup(world, ctx.awayId, options.index);
  if (!home || !away) throw new Error(`simulateHalf: 球队不存在 ${ctx.homeId} / ${ctx.awayId}`);

  const homeTactic = options.homeTactic ?? ctx.homeTactic ?? home.tactic;
  const awayTactic = options.awayTactic ?? ctx.awayTactic ?? away.tactic;
  // 半场调整只作用于下半场：上半场的期望不受心态/换人/关键时刻影响
  const mentality: Mentality = halfIndex === 0 ? 'balanced' : (options.mentality ?? 'balanced');

  const baseHome = teamPower(home);
  const baseAway = teamPower(away);

  const tacticDiff = tacticEdge(homeTactic, awayTactic);
  const homeAdv = ctx.neutral ? 0 : BALANCE.homeAdvantage;
  const travel = ctx.neutral ? 0 : travelFatigue(home.confederationId, away.confederationId);
  const formDiff = (home.form - away.form) * 0.02;
  const moraleDiff = (home.morale - away.morale) * 0.015;
  const subs = halfIndex === 0 ? 0 : (options.subsEdge ?? 0);
  const mental = BALANCE.mentalityEdge[mentality] ?? 0;
  const moment = halfIndex === 0 ? 0 : (options.momentEdge ?? 0);

  const diff = baseHome - baseAway + homeAdv - travel + tacticDiff + formDiff + moraleDiff + subs + mental + moment;

  const homeXgFull = expectedGoals(diff, true);
  const awayXgFull = expectedGoals(-diff, false);

  // 半场各占一半期望
  const homeXg = homeXgFull / 2;
  const awayXg = awayXgFull / 2;

  const rng = hashMatch(world.seed, ctx.homeId, ctx.awayId, halfIndex, world.week);
  const homeGoals = poisson(rng, homeXg);
  const awayGoals = poisson(rng, awayXg);

  return {
    homeGoals,
    awayGoals,
    homeXg: round2(homeXg),
    awayXg: round2(awayXg),
  };
}

/** 点球大战：5 轮 + 突然死亡，独立字段 */
export function resolvePenalty(
  homeId: string,
  awayId: string,
  seed: number,
  penaltySkill: (clubId: string) => number,
): { winner: 'home' | 'away'; score: string } {
  const rng = streamRng(seed, 'penalty', homeId, awayId);
  const homeSkill = penaltySkill(homeId);
  const awaySkill = penaltySkill(awayId);
  const skillDiff = (homeSkill - awaySkill) * BALANCE.penaltyK;
  const pHome = clamp(BALANCE.penaltyBase + skillDiff, BALANCE.penaltyMin, BALANCE.penaltyMax);
  const pAway = clamp(BALANCE.penaltyBase - skillDiff, BALANCE.penaltyMin, BALANCE.penaltyMax);

  let homeScore = 0;
  let awayScore = 0;
  const homeShots: boolean[] = [];
  const awayShots: boolean[] = [];

  for (let r = 0; r < BALANCE.penaltyRounds; r++) {
    const homeOk = rng.chance(pHome);
    const awayOk = rng.chance(pAway);
    homeShots.push(homeOk);
    awayShots.push(awayOk);
    if (homeOk) homeScore++;
    if (awayOk) awayScore++;
    // 提前结束：剩余轮次无法追平
    const remaining = BALANCE.penaltyRounds - r - 1;
    if (homeScore > awayScore + remaining) break;
    if (awayScore > homeScore + remaining) break;
  }

  let sudden = 0;
  while (homeScore === awayScore && sudden < BALANCE.penaltyMaxSudden) {
    const homeOk = rng.chance(pHome);
    const awayOk = rng.chance(pAway);
    homeShots.push(homeOk);
    awayShots.push(awayOk);
    if (homeOk) homeScore++;
    if (awayOk) awayScore++;
    sudden++;
  }

  return {
    winner: homeScore > awayScore ? 'home' : 'away',
    score: `${homeScore}-${awayScore}`,
  };
}

/** 球员单场评分：比率、进球、助攻、胜负都要吃进去 */
export function playerRating(input: {
  goals: number;
  assists: number;
  margin: number;
  won: boolean;
  drew: boolean;
  rng: Rng;
}): number {
  const margin = input.margin;
  const winBonus = input.won ? BALANCE.ratingWinBonus : input.drew ? 0 : BALANCE.ratingLossPenalty;
  const luck = input.rng.range(-BALANCE.ratingLuckRange, BALANCE.ratingLuckRange);
  const raw =
    BALANCE.ratingBase +
    margin * BALANCE.ratingMarginK +
    input.goals * BALANCE.ratingGoalWeight +
    input.assists * BALANCE.ratingAssistWeight +
    winBonus +
    luck;
  return round2(clamp(raw, BALANCE.ratingMin, BALANCE.ratingMax));
}

export interface SimulateMatchResult {
  result: MatchResult;
  /** 上半场（两段式交互用） */
  firstHalf: HalfResult;
}

/**
 * 一次性模拟整场（AI 对 AI，LOD B/C）。
 * 需要交互时改用 simulateHalf 两段式。
 */
export function simulateMatch(
  world: WorldState,
  ctx: MatchContext,
  options: SimulateOptions = {},
): SimulateMatchResult {
  const firstHalf = playHalf(world, ctx, options, 0);
  const secondHalf = playHalf(world, ctx, options, 1);

  const homeGoals = firstHalf.homeGoals + secondHalf.homeGoals;
  const awayGoals = firstHalf.awayGoals + secondHalf.awayGoals;

  const result: MatchResult = {
    homeGoals,
    awayGoals,
    homeXg: round2(firstHalf.homeXg + secondHalf.homeXg),
    awayXg: round2(firstHalf.awayXg + secondHalf.awayXg),
    penalty: 'none',
    scorers: [],
    keyEvents: [],
    halfTime: { homeGoals: firstHalf.homeGoals, awayGoals: firstHalf.awayGoals },
  };

  if (ctx.needWinner && homeGoals === awayGoals) {
    const pen = resolvePenalty(ctx.homeId, ctx.awayId, world.seed + world.week, (clubId) => {
      const c = world.clubs.find((x) => x.id === clubId);
      return c ? (c.attack + c.midfield) / 2 : 50;
    });
    result.penalty = pen.winner;
    result.penaltyScore = pen.score;
  }

  return { result, firstHalf };
}

/** 只模拟上半场（交互模式第一步） */
export function simulateHalf(
  world: WorldState,
  ctx: MatchContext,
  halfIndex: 0 | 1,
  options: SimulateOptions = {},
): HalfResult {
  return playHalf(world, ctx, options, halfIndex);
}

/**
 * 半场计划的强度边差：换人 + 心态 + 战术变化。
 * 替换质量按球队平均能力近似（LOD A 才有球员个体）。
 */
export function planEdge(input: {
  subsCount: number;
  squadQuality: number;
  benchQuality: number;
  mentality: Mentality;
  tacticChanged: boolean;
  tacticAdvantage: number;
}): number {
  const subGain = (input.benchQuality - input.squadQuality) / 11 * BALANCE.subsK * input.subsCount;
  const mental = BALANCE.mentalityEdge[input.mentality] ?? 0;
  const tactic = input.tacticChanged ? input.tacticAdvantage * 0.5 : 0;
  return round2(subGain + mental + tactic);
}

/** 客队体能消耗（按旅行距离） */
export function staminaCostFor(isAway: boolean, crossConf: boolean): number {
  const base = BALANCE.staminaPerMatch;
  const travel = isAway ? (crossConf ? BALANCE.travelFatiguePerUnit * BALANCE.crossConfederationExtra : BALANCE.travelFatiguePerUnit) : 0;
  return Math.max(4, Math.round(base + travel));
}

/**
 * 应用一场比赛后的世界变化（体能、状态、士气）。
 * 纯函数：返回新的 clubs 数组，不修改入参。
 */
export function applyMatchEffects(
  world: WorldState,
  ctx: MatchContext,
  result: MatchResult,
): Club[] {
  const home = world.clubs.find((c) => c.id === ctx.homeId);
  const away = world.clubs.find((c) => c.id === ctx.awayId);
  if (!home || !away) return world.clubs;

  const crossConf = home.confederationId !== away.confederationId;
  const homeWin = result.homeGoals > result.awayGoals;
  const awayWin = result.awayGoals > result.homeGoals || result.penalty === 'away';
  const homeLost = result.awayGoals > result.homeGoals || result.penalty === 'away';
  const awayLost = result.homeGoals > result.awayGoals || result.penalty === 'home';

  return world.clubs.map((club) => {
    if (club.id !== ctx.homeId && club.id !== ctx.awayId) {
      // 非参赛队不在单场里恢复：本函数每场调用一次，一周恢复 F 次会把状态/体能拉满
      return club;
    }
    const isHome = club.id === ctx.homeId;
    const won = isHome ? homeWin : awayWin;
    const lost = isHome ? homeLost : awayLost;
    const cost = staminaCostFor(!isHome, crossConf);
    const moraleDelta = won ? 4 : lost ? -4 : 1;
    const formDelta = won ? 3 : lost ? -3 : 0;
    return {
      ...club,
      stamina: clamp(club.stamina - cost, 0, BALANCE.staminaMax),
      form: clamp(club.form + formDelta + (50 - club.form) * 0.05, 0, 100),
      morale: clamp(club.morale + moraleDelta, 0, 100),
    };
  });
}

/** 给玩家球员记数据（生涯模式） */
export function creditPlayer(
  player: Player,
  line: { goals: number; assists: number; rating: number },
): Player {
  return {
    ...player,
    apps: player.apps + 1,
    goals: player.goals + line.goals,
    assists: player.assists + line.assists,
    ratingSum: player.ratingSum + line.rating,
  };
}

/** 本赛季平均评分 */
export function averageRating(player: Player): number {
  if (player.apps === 0) return 0;
  return round2(player.ratingSum / player.apps);
}

export { zeroHalf };
export { confederationCommercial };
