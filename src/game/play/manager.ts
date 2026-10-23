import { BALANCE, clamp, round2 } from '../balance';
import { advanceWeek, isSeasonComplete } from '../rules/advance';
import { finishSeason, startNextSeason } from '../rules/qualify';
import { rankOf, seasonRankOf } from '../rules/standings';
import { computeNationalStanding } from '../national/schedule';
import { financeOf } from './finance';
import { isSeasonSettled, settleWorldAtSeasonEnd } from './settle';
import { runTransferWeek } from './transfer';
import { runWorldActivity } from './activity';
import { makeHotComments } from './community';
import { tickChains } from './chains';
import { streamRng } from '../../core/rng';
import type { Club, MatchResult, WorldState } from '../types';
import type { ManagerState } from '../types';

/**
 * 经理模式（俱乐部经理）：创建 → 逐周推进 → 赛季结算 → 董事会/球迷情绪 → 下课与再就业。
 *
 * 设计要点（§4.2 / §7.2）：
 *  - 任期 = 董事会满意度 < fireBoardThreshold 且连续 fireStreakSeasons 个赛季无洲际资格 → 下课；
 *  - 下课不是 Game Over：可以重新应聘低一档（tier+1，最大 4）的联赛俱乐部；
 *  - fanMood 0~100，按 fanMoodSmoothing 平滑；
 *  - 财政红线：工资总额 > 收入 × wageRatioCap → 董事会满意度持续下降。
 */

export interface ManagerCreateOptions {
  seed?: number;
  managerName?: string;
  /** 执教俱乐部 id；不给就按 confederationId + tier 选一支中游队 */
  clubId?: string;
  confederationId?: string;
  tier?: number;
  /** 国家队主帅：给国家队 id（`${countryId}-nt`）就执教国家队 */
  nationalTeamId?: string;
}

export interface ManagerWeekResult {
  world: WorldState;
  state: ManagerState;
  seasonEnded: boolean;
  /** 本周转会新闻（P5） */
  news: string[];
  /** 赛季在本周结束时的结算结果（UI 要展示真实的董事会/球迷变化） */
  outcome?: ManagerSeasonOutcome;
}

export interface ManagerSeasonOutcome {
  /** 联赛名次（1 起，0 = 未知） */
  leagueRank: number;
  /** 是否拿到下赛季洲际资格 */
  continental: boolean;
  /** 董事会满意度变化 */
  boardDelta: number;
  /** 球迷情绪变化 */
  fanDelta: number;
  /** 本赛季荣誉 */
  honors: string[];
  /** 是否被解雇 */
  fired: boolean;
  reasons: string[];
}

function pickManagedClub(
  world: WorldState,
  confederationId: string,
  tier: number,
): Club {
  const pool = world.clubs.filter(
    (c) => c.confederationId === confederationId && c.tier === tier,
  );
  const candidates = pool.length > 0 ? pool : world.clubs.filter((c) => c.tier === tier);
  if (candidates.length === 0) throw new Error(`manager: 找不到 tier ${tier} 的俱乐部`);
  const sorted = candidates.slice().sort((a, b) => b.reputation - a.reputation || a.id.localeCompare(b.id));
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid]!;
}

export function createManager(
  world: WorldState,
  options: ManagerCreateOptions = {},
): { world: WorldState; state: ManagerState } {
  // 国家队主帅分支（§4.2 二选一）：clubId 为空串，用 nationalTeamId 定位
  if (options.nationalTeamId) {
    const team = world.nationalTeams.find((t) => t.id === options.nationalTeamId);
    if (!team) throw new Error(`manager: 找不到国家队 ${options.nationalTeamId}`);
    return {
      world,
      state: {
        mode: 'manager',
        managerName: options.managerName ?? '无名主帅',
        clubId: '',
        kind: 'national',
        nationalTeamId: team.id,
        season: world.season,
        week: world.week,
        boardConfidence: BALANCE.boardConfidenceStart,
        fanMood: BALANCE.fanMoodStart,
        honors: [],
        confederationId: team.confederationId,
        seasonsDone: 0,
        seasonsWithoutContinental: 0,
      },
    };
  }

  const club = options.clubId
    ? world.clubs.find((c) => c.id === options.clubId)
    : undefined;
  const target =
    club ?? pickManagedClub(world, options.confederationId ?? 'UEFA', options.tier ?? 2);

  const state: ManagerState = {
    mode: 'manager',
    managerName: options.managerName ?? '无名主帅',
    clubId: target.id,
    kind: 'club',
    season: world.season,
    week: world.week,
    boardConfidence: BALANCE.boardConfidenceStart,
    fanMood: BALANCE.fanMoodStart,
    honors: [],
    confederationId: target.confederationId,
    seasonsDone: 0,
    seasonsWithoutContinental: 0,
  };
  return { world, state };
}

/** 国家队主帅的「俱乐部视角」目标 id（用于统一赛程查询） */
export function managedTeamId(state: ManagerState): string {
  return state.kind === 'national' ? (state.nationalTeamId ?? '') : state.clubId;
}

/**
 * 赛季结束后的唯一收尾路径（P0-1 / P0-3）：
 * 先 finish（写 seasonSummary + 下赛季参赛权），再做世界侧财政/声望，
 * 最后按 lastSettledSeason 只结算一次董事会/球迷。重复调用不再扣分。
 */
function closeManagerSeason(
  world: WorldState,
  state: ManagerState,
): { world: WorldState; state: ManagerState; outcome?: ManagerSeasonOutcome } {
  const settledWorld = settleWorldAtSeasonEnd(world);
  const settled = settleManagerSeason(settledWorld, state);
  return { world: settledWorld, state: settled.state, outcome: settled.outcome };
}

/** 推进一周（经理不介入单场比赛，全 AI 结算） */
export function managerAdvanceWeek(
  world: WorldState,
  state: ManagerState,
  options: { playerResult?: MatchResult } = {},
): ManagerWeekResult {
  if (state.fired) return { world, state, seasonEnded: false, news: [] };
  // P0-1：赛季结束/已结算后，连点「推进一周」只能回到结算页，不能重复结算。
  if (world.finished || isSeasonComplete(world)) {
    const closed = closeManagerSeason(world, state);
    return {
      world: closed.world,
      state: closed.state,
      seasonEnded: true,
      news: [],
      ...(closed.outcome ? { outcome: closed.outcome } : {}),
    };
  }
  // 俱乐部经理：玩家俱乐部本周的比赛默认由 AI 结算；
  // 若玩家亲手踢完（P7 两段式），用 options.playerResult 覆盖。
  // 国家队主帅：nationalFixtures 与 playerClubId 无关，传不传都一样。
  let nextWorld = advanceWeek(
    world,
    state.kind === 'national' ? {} : { playerClubId: state.clubId, ...(options.playerResult ? { playerResult: options.playerResult } : {}) },
  );
  const news: string[] = [];

  // 转会窗：AI 之间买卖（玩家俱乐部只收报价，不自动卖人）
  const transfer = runTransferWeek(nextWorld, { playerClubId: state.clubId });
  if (transfer.offers.length > 0) {
    nextWorld = transfer.world;
    news.push(...transfer.news);
  }

  let nextState: ManagerState = { ...state, week: nextWorld.week, season: nextWorld.season };

  // 世界活性（叙事 + form/morale 波动，不改积分与资格）
  const activity = runWorldActivity(nextWorld);
  nextWorld = activity.world;
  news.push(...activity.news);

  // 赛后热评：经理模式看的是「这一轮球迷怎么骂你」
  if (nextState.communityOn !== false) {
    const club = nextWorld.clubs.find((c) => c.id === state.clubId);
    const played = nextWorld.fixtures.filter(
      (f) => f.week === nextWorld.week - 1 && f.played && (f.homeId === state.clubId || f.awayId === state.clubId),
    );
    const last = played[played.length - 1];
    if (club && last?.result) {
      const isHome = last.homeId === state.clubId;
      const mine = isHome ? last.result.homeGoals : last.result.awayGoals;
      const theirs = isHome ? last.result.awayGoals : last.result.homeGoals;
      const oppId = isHome ? last.awayId : last.homeId;
      const comments = makeHotComments(
        {
          club: club.name,
          opponent: nextWorld.clubs.find((c) => c.id === oppId)?.name ?? '对手',
          score: `${mine}-${theirs}`,
          won: mine > theirs,
          drew: mine === theirs,
          coach: state.managerName,
        },
        streamRng(nextWorld.seed, 'hot-comment', last.id),
        true,
      );
      if (comments.length > 0) nextState = { ...nextState, hotComments: comments };
    }
  }

  nextState = tickChains(nextWorld, nextState);

  const seasonEnded = isSeasonComplete(nextWorld);
  let outcome: ManagerSeasonOutcome | undefined;
  if (seasonEnded) {
    // P0-3：世界侧结算（finish → 全部俱乐部财政 → 声望）必须在玩家侧考核之前，
    // 这样 board 读到的洲际资格才是「下赛季」的（P1-3 语义修正）。
    const closed = closeManagerSeason(nextWorld, nextState);
    nextState = closed.state;
    outcome = closed.outcome;
    nextWorld = closed.world;
  }
  return {
    world: nextWorld,
    state: nextState,
    seasonEnded,
    news,
    ...(outcome ? { outcome } : {}),
  };
}

/** 赛季末世界侧结算（财政 + 声望），经理模式与生涯模式共用同一套规则 */
export function settleManagerWorld(world: WorldState): WorldState {
  // P0-3：此前这里只结算声望，财政从不结算；统一委托到结算管线。
  return settleWorldAtSeasonEnd(world);
}

function hasContinentalQualification(world: WorldState, clubId: string): boolean {
  return world.qualifications.some((q) => q.clubId === clubId);
}

/** 国家队主帅：本赛季是否打进洲际杯/世界杯正赛 */
function hasNationalMajor(world: WorldState, teamId: string): boolean {
  return world.nationalQualifications.some((q) => q.teamId === teamId);
}

/** 国家队主帅的名次：国家联赛所在级别里的排名（1 起，0 = 未知） */
function nationalRankOf(world: WorldState, teamId: string): number {
  const team = world.nationalTeams.find((t) => t.id === teamId);
  if (!team) return 0;
  for (const [compId, standing] of Object.entries(world.nationalStandings)) {
    if (!compId.startsWith(team.confederationId.toLowerCase())) continue;
    const keys = standing.rows.map((r) => r.clubId);
    if (!keys.includes(teamId)) continue;
    const table = computeNationalStanding(world, compId);
    const idx = table.rows.findIndex((r) => r.clubId === teamId);
    if (idx >= 0) return idx + 1;
  }
  return 0;
}

/** 国家队主帅的预期名次：按世界排名在洲内的相对位置给一个宽容的目标 */
function nationalExpected(teamSize: number, rank: number, total: number): number {
  if (total <= 0) return 1;
  const relative = rank / Math.max(1, total);
  return Math.max(1, Math.min(teamSize, Math.round(relative * teamSize)));
}

function championsOf(world: WorldState, clubId: string): string[] {
  const summary = world.seasonSummary;
  if (!summary) return [];
  const honors: string[] = [];
  for (const [competitionId, championId] of Object.entries(summary.champions)) {
    if (championId !== clubId) continue;
    const comp = world.competitions.find((c) => c.id === competitionId);
    if (comp) honors.push(`${comp.nameZh}冠军`);
  }
  return honors;
}

/** 已结算时的占位 outcome（UI 只知道「本赛季已经结算过」） */
function settledOutcome(world: WorldState, state: ManagerState): ManagerSeasonOutcome {
  const club = world.clubs.find((c) => c.id === state.clubId);
  const snap = club ? seasonRankOf(world, club.id) : { rank: 0, total: 0, competitionId: '' };
  return {
    leagueRank:
      snap.rank > 0
        ? snap.rank
        : club
          ? rankOf(world, club.competitionId, club.id)
          : 0,
    continental:
      state.kind === 'national'
        ? hasNationalMajor(world, state.nationalTeamId ?? '')
        : hasContinentalQualification(world, state.clubId),
    boardDelta: 0,
    fanDelta: 0,
    honors: [],
    fired: state.fired === true,
    reasons: ['本赛季已结算，不再重复计分'],
  };
}

/** 赛季结算：名次 → 满意度/球迷情绪 → 下课判定 */
export function settleManagerSeason(
  world: WorldState,
  state: ManagerState,
): { state: ManagerState; outcome: ManagerSeasonOutcome } {
  if (state.kind === 'national') return settleNationalManagerSeason(world, state);
  // P0-1：同一赛季只结算一次（lastSettledSeason 随 state 落盘）。
  if (isSeasonSettled(state, world.season)) return { state, outcome: settledOutcome(world, state) };

  const club = world.clubs.find((c) => c.id === state.clubId);
  const reasons: string[] = [];
  let leagueRank = 0;
  let boardDelta = 0;
  let fanDelta = 0;

  if (club) {
    // P0-1：finishSeason 已升降级，club.competitionId 指向新联赛；名次必须取上赛季快照。
    const snap = seasonRankOf(world, club.id);
    leagueRank = snap.rank > 0 ? snap.rank : rankOf(world, club.competitionId, club.id);
    const teamCount = snap.total > 0 ? snap.total : (world.standings[club.competitionId]?.rows.length ?? 0);
    const expected = club.tier === 1 ? 6 : club.tier === 2 ? 8 : 10;
    if (leagueRank > 0) {
      boardDelta += clamp((expected - leagueRank) * 2.2, -22, 20);
      fanDelta += clamp((expected - leagueRank) * 1.6, -18, 16);
      if (leagueRank <= 4) reasons.push(`联赛第 ${leagueRank}，董事会满意`);
      else if (leagueRank >= teamCount - 3 && teamCount > 6) {
        reasons.push(`联赛第 ${leagueRank}，接近降级区`);
      }
    }
  }

  const continental = hasContinentalQualification(world, state.clubId);
  if (continental) {
    boardDelta += 8;
    fanDelta += 6;
    reasons.push('拿到下赛季洲际资格');
  } else {
    reasons.push('本赛季未拿到洲际资格');
  }

  const honors = championsOf(world, state.clubId);
  if (honors.length > 0) {
    boardDelta += 10 * honors.length;
    fanDelta += 12 * honors.length;
  }

  // 财政红线：工资占收入比例过高持续扣满意度（用真实财政而不是 tier 粗估，设计 §7.2）
  if (club) {
    const line = financeOf(world, club);
    if (line.wageOverCap) {
      boardDelta -= 6;
      reasons.push(
        `工资占收入 ${Math.round(line.wageRatio * 100)}%，超过 ${Math.round(BALANCE.wageRatioCap * 100)}% 红线，董事会不满`,
      );
    }
    if (line.inReceivership) {
      boardDelta -= 4;
      reasons.push('净资产为负，进入财政托管');
    }
    if (line.net > 0) reasons.push(`本赛季净收入 ${line.net} 万`);
  }

  const boardConfidence = clamp(round2(state.boardConfidence + boardDelta), 0, 100);
  const smoothedFan = clamp(
    round2(state.fanMood + (50 + fanDelta * 2 - state.fanMood) * BALANCE.fanMoodSmoothing),
    0,
    100,
  );

  const seasonsWithoutContinental = continental ? 0 : (state.seasonsWithoutContinental ?? 0) + 1;
  const fired =
    boardConfidence < BALANCE.fireBoardThreshold &&
    seasonsWithoutContinental >= BALANCE.fireStreakSeasons;

  let nextState: ManagerState = {
    ...state,
    boardConfidence,
    fanMood: smoothedFan,
    honors: [...state.honors, ...honors],
    seasonsDone: (state.seasonsDone ?? 0) + 1,
    seasonsWithoutContinental,
    confederationId: club?.confederationId ?? state.confederationId,
    lastSettledSeason: world.season,
  };
  if (fired) {
    nextState = {
      ...nextState,
      fired: true,
      rehireTierFloor: Math.min(4, (club?.tier ?? 2) + 1),
    };
    reasons.push('董事会满意度跌破阈值且连续无洲际资格，下课');
  }

  return {
    state: nextState,
    outcome: {
      leagueRank,
      continental,
      boardDelta,
      fanDelta,
      honors,
      fired,
      reasons,
    },
  };
}

/**
 * 国家队主帅的赛季结算（§4.2 二选一里的「国家队主帅」分支）。
 *
 * 与俱乐部经理的差异（设计 §4.3 差异表）：
 *  - 没有董事会，但有足协耐心（同样用 boardConfidence 表示，阈值一致）；
 *  - 没有工资/转会，考核只看国家联赛名次 + 大赛资格 + 冠军；
 *  - 下课同样不是 Game Over，可去其他国家队重聘。
 */
function settleNationalManagerSeason(
  world: WorldState,
  state: ManagerState,
): { state: ManagerState; outcome: ManagerSeasonOutcome } {
  // P0-1：国家队线同样只能结算一次。
  if (isSeasonSettled(state, world.season)) return { state, outcome: settledOutcome(world, state) };
  const teamId = state.nationalTeamId ?? '';
  const team = world.nationalTeams.find((t) => t.id === teamId);
  const reasons: string[] = [];
  let leagueRank = 0;
  let boardDelta = 0;
  let fanDelta = 0;

  if (team) {
    leagueRank = nationalRankOf(world, teamId);
    const confTeams = world.nationalTeams.filter((t) => t.confederationId === team.confederationId);
    const expected = nationalExpected(confTeams.length, team.rank, world.nationalTeams.length);
    if (leagueRank > 0) {
      // 国家队一场定生死，权重比俱乐部略低（样本少、波动大）
      boardDelta += clamp((expected - leagueRank) * 2.0, -18, 18);
      fanDelta += clamp((expected - leagueRank) * 1.5, -16, 14);
      reasons.push(`国家联赛第 ${leagueRank}（预期第 ${expected}）`);
    }
  }

  const continental = hasNationalMajor(world, teamId);
  if (continental) {
    boardDelta += 6;
    fanDelta += 6;
    reasons.push('拿到下届大赛正赛资格');
  } else {
    reasons.push('本届大赛未拿到正赛资格');
  }

  const honors = championsOf(world, teamId);
  if (honors.length > 0) {
    boardDelta += 12 * honors.length;
    fanDelta += 14 * honors.length;
  }

  const boardConfidence = clamp(round2(state.boardConfidence + boardDelta), 0, 100);
  const smoothedFan = clamp(
    round2(state.fanMood + (50 + fanDelta * 2 - state.fanMood) * BALANCE.fanMoodSmoothing),
    0,
    100,
  );

  const seasonsWithoutContinental = continental ? 0 : (state.seasonsWithoutContinental ?? 0) + 1;
  const fired =
    boardConfidence < BALANCE.fireBoardThreshold &&
    seasonsWithoutContinental >= BALANCE.fireStreakSeasons;

  let nextState: ManagerState = {
    ...state,
    boardConfidence,
    fanMood: smoothedFan,
    honors: [...state.honors, ...honors],
    seasonsDone: (state.seasonsDone ?? 0) + 1,
    seasonsWithoutContinental,
    confederationId: team?.confederationId ?? state.confederationId,
    lastSettledSeason: world.season,
  };
  if (fired) {
    nextState = { ...nextState, fired: true, rehireTierFloor: 4 };
    reasons.push('足协耐心耗尽且连续两届无大赛资格，卸任');
  }

  return {
    state: nextState,
    outcome: {
      leagueRank,
      continental,
      boardDelta,
      fanDelta,
      honors,
      fired,
      reasons,
    },
  };
}

export function rollManagerSeason(world: WorldState): WorldState {
  // P0-1：已 finish 的世界不再二次 finish（否则重复升降级 / 资格重算）。
  const finished = world.finished ? world : finishSeason(world);
  return startNextSeason(finished);
}

/** 下课后再就业：俱乐部经理去低一档联赛，国家队主帅去排名更靠后的国家队 */
export function rehireManager(
  world: WorldState,
  state: ManagerState,
): { world: WorldState; state: ManagerState } {
  if (!state.fired) return { world, state };

  if (state.kind === 'national') {
    const oldRank = world.nationalTeams.find((t) => t.id === state.nationalTeamId)?.rank ?? 0;
    const pool = world.nationalTeams
      .filter((t) => t.id !== state.nationalTeamId && t.rank > oldRank)
      .sort((a, b) => a.rank - b.rank);
    const target = pool[0] ?? world.nationalTeams.slice().sort((a, b) => b.rank - a.rank)[0];
    if (!target) throw new Error('manager: 没有可应聘的国家队');
    return {
      world,
      state: {
        ...state,
        managerName: state.managerName,
        clubId: '',
        nationalTeamId: target.id,
        confederationId: target.confederationId,
        boardConfidence: BALANCE.boardConfidenceStart,
        fanMood: BALANCE.fanMoodStart,
        season: world.season,
        week: world.week,
        fired: false,
        seasonsWithoutContinental: 0,
      },
    };
  }

  const tierFloor = state.rehireTierFloor ?? 4;
  const oldClub = world.clubs.find((c) => c.id === state.clubId);
  const confederationId = oldClub?.confederationId ?? state.confederationId;
  const pool = world.clubs
    .filter((c) => c.tier === tierFloor && c.confederationId === confederationId)
    .sort((a, b) => a.reputation - b.reputation || a.id.localeCompare(b.id));
  const fallback = world.clubs
    .filter((c) => c.tier === tierFloor)
    .sort((a, b) => a.reputation - b.reputation || a.id.localeCompare(b.id));
  const target = pool[0] ?? fallback[0];
  if (!target) throw new Error(`manager: tier ${tierFloor} 没有可应聘俱乐部`);

  return {
    world,
    state: {
      ...state,
      clubId: target.id,
      confederationId: target.confederationId,
      boardConfidence: BALANCE.boardConfidenceStart,
      fanMood: BALANCE.fanMoodStart,
      season: world.season,
      week: world.week,
      fired: false,
      seasonsWithoutContinental: 0,
    },
  };
}

export interface ManagerStats {
  seasonsDone: number;
  honors: number;
  boardConfidence: number;
  fanMood: number;
  leagueRank: number;
  tier: number;
  fired: boolean;
  /** 国家队主帅时为 true */
  national: boolean;
}

export function managerStats(world: WorldState, state: ManagerState): ManagerStats {
  if (state.kind === 'national') {
    return {
      seasonsDone: state.seasonsDone ?? 0,
      honors: state.honors.length,
      boardConfidence: state.boardConfidence,
      fanMood: state.fanMood,
      leagueRank: nationalRankOf(world, state.nationalTeamId ?? ''),
      tier: 0,
      fired: state.fired === true,
      national: true,
    };
  }
  const club = world.clubs.find((c) => c.id === state.clubId);
  return {
    seasonsDone: state.seasonsDone ?? 0,
    honors: state.honors.length,
    boardConfidence: state.boardConfidence,
    fanMood: state.fanMood,
    leagueRank: club ? rankOf(world, club.competitionId, club.id) : 0,
    tier: club?.tier ?? 0,
    fired: state.fired === true,
    national: false,
  };
}
