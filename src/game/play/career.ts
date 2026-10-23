import { streamRng } from '../../core/rng';
import { BALANCE, clamp, round2 } from '../balance';
import { generateSquad } from '../world/generate';
import { advanceWeek, isSeasonComplete, nextPlayerFixture } from '../rules/advance';
import { finishSeason, startNextSeason } from '../rules/qualify';
import { rankOf } from '../rules/standings';
import { averageRating, creditPlayer, playerRating, simulateMatch } from '../match/simulate';
import { growthOf, applyGrowth } from '../play/growth';
import { positionOf } from '../config/positions';
import { applyCallUp, resolveCallUp } from '../play/callup';
import { isSeasonSettled, settleWorldAtSeasonEnd } from '../play/settle';
import { runTransferWeek } from '../play/transfer';
import { runWorldActivity } from '../play/activity';
import { makeHotComments } from '../play/community';
import { tickChains } from '../play/chains';
import type { Club, Fixture, MatchResult, Player, WorldState } from '../types';
import type { CareerState } from '../types';

/**
 * 生涯模式（球员）：创建 → 逐周推进 → 赛季结算 → 成长/退役 → 评级。
 *
 * 设计要点（§4.1 / §7.4 / §7.5）：
 *  - 玩家只控制自己的比赛，世界其余部分沿用 `advanceWeek` 的 AI 全自动；
 *  - 年龄 16→34，最多 18 赛季，可随时退役；
 *  - 成长 = abilityGrowthRate × (potential - ability) × 年龄系数；
 *  - 生涯价值 = 赛季累计(联赛积分×4 + 杯赛胜场×25 + 洲际胜场×35 + 世俱杯胜场×50)
 *    + 荣誉数×honorValue + max(0, 场均评分-6.0)×scorePerRatingPoint + 人气×5。
 */

export interface CareerCreateOptions {
  seed?: number;
  playerName?: string;
  /** 惯用位置（底层四类），直接决定个人数据分布 */
  position?: Player['position'];
  /** 开局选的细位置（设计 §4.1 六种）；只用于展示与球风系数，落库仍走 position */
  detailPosition?: string;
  /** 国籍（国家 id，大写），决定起始俱乐部所在国 */
  nationality?: string;
  /** 指定起始俱乐部；不给就从本国 T3/T4 里挑声望最低的 */
  clubId?: string;
}

export interface CareerWeekResult {
  world: WorldState;
  state: CareerState;
  /** 本周玩家是否出场 */
  played: boolean;
  /** 赛季是否在本周结束并完成结算 */
  seasonEnded: boolean;
  /** 本周玩家数据（未出场为 undefined） */
  line?: { goals: number; assists: number; rating: number };
  /** 本周是否被国家队征召 */
  calledUp?: boolean;
  /** 本周转会与新闻（P5） */
  news: string[];
}

const SCORING_SHARE: Record<Player['position'], number> = {
  FW: 0.55,
  MF: 0.34,
  DF: 0.12,
  GK: 0.01,
};

const ASSIST_SHARE: Record<Player['position'], number> = {
  FW: 0.28,
  MF: 0.42,
  DF: 0.3,
  GK: 0.05,
};

function pickStartClub(world: WorldState, nationality: string): Club {
  const home = world.clubs.filter((c) => c.countryId === nationality);
  const pool = home.filter((c) => c.tier >= 3);
  const candidates = pool.length > 0 ? pool : home;
  if (candidates.length === 0) throw new Error(`career: 国家 ${nationality} 没有可用俱乐部`);
  return candidates.slice().sort((a, b) => a.reputation - b.reputation || a.id.localeCompare(b.id))[0]!;
}

function pickSquadPlayer(club: Club, position: Player['position'], seed: number): Player {
  const squad = generateSquad(streamRng(seed, 'career-squad', club.id), club);
  const same = squad.filter((p) => p.position === position);
  const pool = same.length > 0 ? same : squad;
  return pool[0]!;
}

export function createCareer(
  world: WorldState,
  options: CareerCreateOptions = {},
): { world: WorldState; state: CareerState } {
  const seed = options.seed ?? world.seed;
  const position = options.position ?? 'MF';
  const club = options.clubId
    ? world.clubs.find((c) => c.id === options.clubId)
    : undefined;
  const startClub = club ?? pickStartClub(world, options.nationality ?? 'ENG');
  const template = pickSquadPlayer(startClub, position, seed);

  const player: Player = {
    ...template,
    clubId: startClub.id,
    position,
    age: BALANCE.careerStartAge,
    ability: clamp(Math.round(template.ability * 0.55), 18, BALANCE.attrMax),
    potential: clamp(Math.round(template.ability + 12), 30, BALANCE.potentialMax),
    stamina: BALANCE.staminaMax,
    form: 50,
    injuryWeeks: 0,
    apps: 0,
    goals: 0,
    assists: 0,
    ratingSum: 0,
  };
  player.value = Math.round(player.ability * player.ability * 0.9);

  const state: CareerState = {
    mode: 'career',
    playerName: options.playerName ?? '无名球员',
    player,
    clubId: startClub.id,
    season: world.season,
    week: world.week,
    fame: 0,
    honors: [],
    nationality: options.nationality ?? startClub.countryId,
    confederationId: startClub.confederationId,
    seasonApps: 0,
    seasonGoals: 0,
    seasonAssists: 0,
    seasonRatingSum: 0,
    seasonsDone: 0,
    careerValue: 0,
    clubHistory: [startClub.id],
    ...(options.detailPosition ? { detailPosition: options.detailPosition } : {}),
  };
  return { world, state };
}

function needWinnerOf(world: WorldState, fixture: Fixture): boolean {
  const comp = world.competitions.find((c) => c.id === fixture.competitionId);
  return comp !== undefined && comp.type !== 'league';
}

/** 算本赛季玩家所在俱乐部的联赛积分与赛事胜场，用于生涯价值累积 */
function seasonScoreOf(world: WorldState, clubId: string): number {
  let score = 0;
  const club = world.clubs.find((c) => c.id === clubId);
  if (club) {
    const rows = world.standings[club.competitionId]?.rows ?? [];
    const row = rows.find((r) => r.clubId === clubId);
    if (row) score += row.points * 4;
  }
  for (const fixture of world.fixtures) {
    if (!fixture.played || !fixture.result) continue;
    if (fixture.homeId !== clubId && fixture.awayId !== clubId) continue;
    const comp = world.competitions.find((c) => c.id === fixture.competitionId);
    if (!comp || comp.type === 'league') continue;
    const won =
      (fixture.homeId === clubId && fixture.result.homeGoals > fixture.result.awayGoals) ||
      (fixture.awayId === clubId && fixture.result.awayGoals > fixture.result.homeGoals);
    if (!won) continue;
    if (comp.type === 'domestic-cup') score += 25;
    else if (comp.type === 'club-world') score += 50;
    else score += 35;
  }
  return score;
}

/** 赛季末荣誉：玩家俱乐部拿到的冠军 + 个人奖项 */
function honorsOf(world: WorldState, state: CareerState): string[] {
  const honors: string[] = [];
  const club = world.clubs.find((c) => c.id === state.clubId);
  if (!club) return honors;
  const summary = world.seasonSummary;
  if (!summary) return honors;
  for (const [competitionId, championId] of Object.entries(summary.champions)) {
    if (championId !== state.clubId) continue;
    const comp = world.competitions.find((c) => c.id === competitionId);
    if (!comp) continue;
    if (comp.type === 'league') honors.push(`${comp.nameZh}冠军`);
    else if (comp.type === 'domestic-cup') honors.push(`${comp.nameZh}冠军`);
    else if (comp.type === 'club-world') honors.push('世俱杯冠军');
    else honors.push(`${comp.nameZh}冠军`);
  }
  const avg = state.seasonApps > 0 ? state.seasonRatingSum / state.seasonApps : 0;
  if (state.seasonGoals >= 10) honors.push('联赛金靴');
  if (state.seasonAssists >= 9) honors.push('助攻王');
  if ((state.seasonsDone ?? 0) === 0 && state.seasonApps >= 10 && avg >= 7.0) {
    honors.push('最佳新人');
  }
  return honors;
}

function simulatePlayerFixture(
  world: WorldState,
  state: CareerState,
  fixture: Fixture,
): { result: MatchResult; line: { goals: number; assists: number; rating: number } } {
  const ctx = {
    homeId: fixture.homeId,
    awayId: fixture.awayId,
    neutral: false,
    needWinner: needWinnerOf(world, fixture),
  };
  const { result } = simulateMatch(world, ctx, {});
  return { result, line: lineFromResult(world, state, fixture, result) };
}

/**
 * 从**已经产生**的比分反推玩家个人数据（设计 §6.8 两段式收尾）：
 * 交互比赛走完 `finishFlow` 之后，同样按份额规则从最终比分分配个人数据，
 * 保证「自动模拟」与「玩家亲手踢」两条路的归因完全一致。
 */
export function lineFromResult(
  world: WorldState,
  state: CareerState,
  fixture: Fixture,
  result: MatchResult,
): { goals: number; assists: number; rating: number } {
  const isHome = fixture.homeId === state.clubId;
  const teamGoals = isHome ? result.homeGoals : result.awayGoals;
  const oppGoals = isHome ? result.awayGoals : result.homeGoals;

  const rng = streamRng(world.seed, 'career-line', fixture.id);
  // 细位置（边锋/前腰/后腰/中卫）在四类份额上再乘一个球风系数，
  // 这样同样归 MF 的前腰与后腰会打出明显不同的数据。
  const detail = positionOf(state.detailPosition ?? state.player.position);
  const scoringTilt = detail?.scoringTilt ?? 1;
  const assistTilt = detail?.assistTilt ?? 1;
  const share = SCORING_SHARE[state.player.position] * scoringTilt;
  const expected = teamGoals * share;
  let goals = Math.floor(expected);
  if (rng.chance(expected - goals)) goals += 1;
  if (goals > teamGoals) goals = teamGoals;

  const assistExpected = (teamGoals - goals) * ASSIST_SHARE[state.player.position] * assistTilt;
  let assists = Math.floor(assistExpected);
  if (rng.chance(assistExpected - assists)) assists += 1;
  if (assists > teamGoals - goals) assists = Math.max(0, teamGoals - goals);

  const drew = teamGoals === oppGoals;
  const won =
    teamGoals > oppGoals ||
    (drew && ((isHome && result.penalty === 'home') || (!isHome && result.penalty === 'away')));
  const rating = playerRating({
    goals,
    assists,
    margin: teamGoals - oppGoals,
    won,
    drew,
    rng,
  });
  return { goals, assists, rating };
}

/**
 * 赛季结束后的唯一收尾路径（P0-1）：
 * 世界侧 finish + 财政 + 声望（幂等），玩家侧荣誉/成长只按 lastSettledSeason 结算一次。
 * 连点「推进一周」时第二次进来只会原样返回 seasonEnded，不会再把年龄 +1。
 */
function closeCareerSeason(world: WorldState, state: CareerState): CareerWeekResult {
  const settledWorld = settleWorldAtSeasonEnd(world);
  const settledState = isSeasonSettled(state, world.season)
    ? state
    : settleCareerSeason(settledWorld, state);
  return { world: settledWorld, state: settledState, played: false, seasonEnded: true, news: [] };
}

/** 推进一周（含玩家自己的比赛） */
export function careerAdvanceWeek(
  world: WorldState,
  state: CareerState,
  options: { deferPlayerMatch?: boolean; playerResult?: MatchResult } = {},
): CareerWeekResult {
  if (state.retired) {
    return { world, state, played: false, seasonEnded: false, news: [] };
  }

  // P0-1：赛季已结束 / 已 finish 时，任何「推进一周」都只能回到结算态，
  // 不能再走 advanceWeek 把周次推进到下一季之外，也不能重复结算。
  if (world.finished || isSeasonComplete(world)) {
    return closeCareerSeason(world, state);
  }

  const fixture = nextPlayerFixture(world, state.clubId);
  const isThisWeek = fixture !== undefined && fixture.week === world.week;

  if (isThisWeek && options.deferPlayerMatch) {
    const next = advanceWeek(world, { playerClubId: state.clubId, deferPlayerMatch: true });
    return {
      world: next,
      state: { ...state, week: next.week, season: next.season },
      played: false,
      seasonEnded: false,
      news: [],
    };
  }

  let line: { goals: number; assists: number; rating: number } | undefined;
  let playerResult: MatchResult | undefined;
  if (isThisWeek && fixture) {
    if (options.playerResult) {
      // 交互比赛：结果来自 finishFlow，个人数据从最终比分反推
      playerResult = options.playerResult;
      line = lineFromResult(world, state, fixture, playerResult);
    } else {
      const simulated = simulatePlayerFixture(world, state, fixture);
      playerResult = simulated.result;
      line = simulated.line;
    }
  }

  let nextWorld = advanceWeek(world, {
    playerClubId: state.clubId,
    ...(playerResult ? { playerResult } : {}),
  });

  let nextState: CareerState = { ...state, week: nextWorld.week, season: nextWorld.season };
  if (line) {
    nextState = {
      ...nextState,
      player: creditPlayer(nextState.player, line),
      seasonApps: nextState.seasonApps + 1,
      seasonGoals: nextState.seasonGoals + line.goals,
      seasonAssists: nextState.seasonAssists + line.assists,
      seasonRatingSum: round2(nextState.seasonRatingSum + line.rating),
    };
  }

  const news: string[] = [];

  // 国家队征召（只在国家队窗口判定）
  const callRng = streamRng(nextWorld.seed, 'callup', nextWorld.season, nextWorld.week);
  const call = resolveCallUp(nextWorld, nextState, callRng);
  if (call.result.called) {
    nextWorld = call.world;
    nextState = applyCallUp(nextState, call.result);
    news.push(call.result.reasons[0] ?? '被国家队征召');
  }

  // 转会窗：AI 之间买卖（本周）
  const transfer = runTransferWeek(nextWorld, { playerClubId: nextState.clubId });
  if (transfer.offers.length > 0) {
    nextWorld = transfer.world;
    news.push(...transfer.news);
  }

  // 世界活性：随机 2 家俱乐部的 form/morale 波动 + 一条叙事新闻（不改积分与资格）
  const activity = runWorldActivity(nextWorld);
  nextWorld = activity.world;
  news.push(...activity.news);

  // 赛后热评（社区层关闭时返回空数组，游戏照常）
  if (line && fixture) {
    const mine = nextWorld.clubs.find((c) => c.id === nextState.clubId);
    const oppId = fixture.homeId === nextState.clubId ? fixture.awayId : fixture.homeId;
    const opp = nextWorld.clubs.find((c) => c.id === oppId);
    const isHome = fixture.homeId === nextState.clubId;
    const myGoals = isHome ? (playerResult?.homeGoals ?? 0) : (playerResult?.awayGoals ?? 0);
    const oppGoals = isHome ? (playerResult?.awayGoals ?? 0) : (playerResult?.homeGoals ?? 0);
    const comments = makeHotComments(
      {
        club: mine?.name ?? '本队',
        opponent: opp?.name ?? '对手',
        score: `${myGoals}-${oppGoals}`,
        won: myGoals > oppGoals,
        drew: myGoals === oppGoals,
        rating: line.rating,
        player: nextState.playerName,
      },
      streamRng(nextWorld.seed, 'hot-comment', fixture.id),
      nextState.communityOn !== false,
    );
    if (comments.length > 0) nextState = { ...nextState, hotComments: comments };
  }

  // 事件链：补满空位、触发新链
  nextState = tickChains(nextWorld, nextState);

  const seasonEnded = isSeasonComplete(nextWorld);
  if (seasonEnded) {
    // P0-1：先完成世界侧结算（finishSeason 写 seasonSummary），再结算玩家侧，
    // 否则 honorsOf 读到的 seasonSummary 还是空 → 冠军/荣誉永远拿不到。
    const closed = closeCareerSeason(nextWorld, nextState);
    return { ...closed, played: line !== undefined, news, ...(line ? { line } : {}) };
  }
  return {
    world: nextWorld,
    state: nextState,
    played: line !== undefined,
    seasonEnded,
    news,
    ...(line ? { line } : {}),
    ...(call.result.called ? { calledUp: true } : {}),
  };
}

/** 赛季结算：荣誉 / 生涯价值 / 成长 / 年龄 / 退役判定（P5：成长走 growth.ts 完整公式） */
export function settleCareerSeason(world: WorldState, state: CareerState): CareerState {
  // P0-1：同一赛季只结算一次。marker 随 state 落盘，重进游戏后依然有效。
  if (isSeasonSettled(state, world.season)) return state;
  const honors = honorsOf(world, state);
  const score = seasonScoreOf(world, state.clubId);
  const avg = state.seasonApps > 0 ? state.seasonRatingSum / state.seasonApps : 0;
  const value =
    (state.careerValue ?? 0) +
    score +
    honors.length * BALANCE.honorValue +
    Math.max(0, avg - 6.0) * BALANCE.scorePerRatingPoint +
    state.fame * 5;

  const club = world.clubs.find((c) => c.id === state.clubId);
  const expected = world.fixtures.filter(
    (f) => f.homeId === state.clubId || f.awayId === state.clubId,
  ).length;
  // 成长按「结算后的年龄」算：以前把旧 age 传给 growthOf，衰退/停滞整体滞后一季。
  const aged = { ...state.player, age: state.player.age + 1 };
  const growth = growthOf({
    player: aged,
    apps: state.seasonApps,
    expected,
    club,
    morale: club?.morale ?? 55,
  });
  const grown = applyGrowth(aged, growth, {
    club,
    form: clamp(state.player.form / 100, 0, 1),
  });

  const seasonsDone = (state.seasonsDone ?? 0) + 1;
  const retired = grown.age > BALANCE.careerEndAge || seasonsDone >= BALANCE.careerMaxSeasons;

  const fameGain = Math.round(honors.length * 6 + Math.max(0, avg - 6.0) * 4);

  return {
    ...state,
    player: grown,
    fame: state.fame + fameGain,
    honors: [...state.honors, ...honors],
    seasonApps: 0,
    seasonGoals: 0,
    seasonAssists: 0,
    seasonRatingSum: 0,
    seasonsDone,
    careerValue: Math.round(value),
    retired,
    confederationId: club?.confederationId ?? state.confederationId,
    lastSettledSeason: world.season,
  };
}

/**
 * 赛季末的世界侧结算（P5）：财政 + 声望。
 *
 * P0-3：这个函数此前**没有任何生产调用点**（财政从不结算）。现在委托给统一管线：
 * 未 finish 时先 finishSeason 再结算，已 finish 时只做财政 + 声望。
 */
export function settleCareerWorld(world: WorldState): WorldState {
  return settleWorldAtSeasonEnd(world);
}

/** 赛季结算后进入下一季（未退役时） */
export function rollCareerSeason(world: WorldState): WorldState {
  // P0-1：只有完成 finishSeason 的世界才能开下一季；重复点「进入下一季」不再二次 finish。
  const finished = world.finished ? world : finishSeason(world);
  return startNextSeason(finished);
}

/** 一口气跑完当前赛季（测试与快速推进用） */
export function playCareerSeason(
  world: WorldState,
  state: CareerState,
): { world: WorldState; state: CareerState; weeks: number } {
  let currentWorld = world;
  let currentState = state;
  let weeks = 0;
  while (!isSeasonComplete(currentWorld) && weeks < BALANCE.weeksPerSeason * 3) {
    const result = careerAdvanceWeek(currentWorld, currentState);
    currentWorld = result.world;
    currentState = result.state;
    weeks += 1;
    if (result.seasonEnded) break;
  }
  return { world: currentWorld, state: currentState, weeks };
}

/** 评级：S/A/B/C/D */
export function gradeOf(value: number): string {
  const lines = BALANCE.gradeLines;
  if (value >= lines.S!) return 'S';
  if (value >= lines.A!) return 'A';
  if (value >= lines.B!) return 'B';
  if (value >= lines.C!) return 'C';
  return 'D';
}

export interface CareerStats {
  seasonsDone: number;
  age: number;
  ability: number;
  apps: number;
  goals: number;
  assists: number;
  avgRating: number;
  fame: number;
  honors: number;
  careerValue: number;
  grade: string;
  leagueRank: number;
}

export function careerStats(world: WorldState, state: CareerState): CareerStats {
  const club = world.clubs.find((c) => c.id === state.clubId);
  const leagueRank = club ? rankOf(world, club.competitionId, club.id) : 0;
  return {
    seasonsDone: state.seasonsDone ?? 0,
    age: state.player.age,
    ability: state.player.ability,
    apps: state.player.apps,
    goals: state.player.goals,
    assists: state.player.assists,
    avgRating: averageRating(state.player),
    fame: state.fame,
    honors: state.honors.length,
    careerValue: state.careerValue ?? 0,
    grade: gradeOf(state.careerValue ?? 0),
    leagueRank,
  };
}

/** 主动退役（可随时提前结算） */
export function retireCareer(state: CareerState): CareerState {
  return {
    ...state,
    retired: true,
    grade: gradeOf(state.careerValue ?? 0),
    careerValue: state.careerValue ?? 0,
  };
}
