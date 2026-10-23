import { streamRng } from '../../core/rng';
import { BALANCE, clamp } from '../balance';
import { CALENDAR, isNationalWindow } from '../config/calendar';
import {
  applyMatchEffects,
  buildClubIndex,
  simulateMatch,
} from '../match/simulate';
import type { ClubIndex } from '../match/simulate';
import { computeStandings } from './standings';
import { advanceNationalWeek, recoverNationalWeekly } from '../national/advance';
import type {
  Club,
  Fixture,
  KnockoutState,
  MatchContext,
  MatchResult,
  WorldState,
} from '../types';
import { stageName } from '../world/schedule';

/** 一场已模拟的比赛及其副作用 */
export interface PlayedFixture {
  fixture: Fixture;
  result: MatchResult;
}

export interface AdvanceOptions {
  /** 玩家所在俱乐部：该队的比赛由 UI 两段式驱动，这里只补记结果 */
  playerClubId?: string;
  /** 玩家比赛的结果（UI 已打完时传入），不传则自动模拟 */
  playerResult?: MatchResult;
  /** 是否跳过玩家比赛（UI 会单独处理） */
  deferPlayerMatch?: boolean;
}

function determineWinnerId(fixture: Fixture, result: MatchResult): string | undefined {
  if (result.homeGoals > result.awayGoals) return fixture.homeId;
  if (result.awayGoals > result.homeGoals) return fixture.awayId;
  if (result.penalty === 'home') return fixture.homeId;
  if (result.penalty === 'away') return fixture.awayId;
  return undefined;
}

/** 淘汰赛是否必须分胜负 */
function isKnockoutCompetition(competitionId: string, world: WorldState): boolean {
  const comp = world.competitions.find((c) => c.id === competitionId);
  if (!comp) return false;
  return comp.type !== 'league';
}

/** 打一周：模拟该周所有未踢比赛，返回新 WorldState（纯函数） */
export function advanceWeek(world: WorldState, options: AdvanceOptions = {}): WorldState {
  if (world.finished) return world;

  const week = world.week;
  const index = buildClubIndex(world);
  const weekFixtures = world.fixtures.filter((f) => f.week === week && !f.played);

  const updated = new Map<string, Fixture>();
  const results = new Map<string, MatchResult>();

  for (const fixture of weekFixtures) {
    const isPlayerMatch =
      options.playerClubId !== undefined &&
      (fixture.homeId === options.playerClubId || fixture.awayId === options.playerClubId);

    if (isPlayerMatch && options.deferPlayerMatch && !options.playerResult) continue;

    let result: MatchResult;
    if (isPlayerMatch && options.playerResult) {
      result = options.playerResult;
    } else {
      result = autoResolve(world, fixture, index);
    }

    updated.set(fixture.id, { ...fixture, result, played: true });
    results.set(fixture.id, result);
  }

  let nextWorld: WorldState = {
    ...world,
    fixtures: world.fixtures.map((f) => updated.get(f.id) ?? f),
  };

  // 淘汰赛推进：本轮全部踢完后生成下一轮
  nextWorld = progressKnockouts(nextWorld, results, week);

  // 赛后世界副作用（体能/状态/士气）
  let clubs = nextWorld.clubs;
  for (const fixture of weekFixtures) {
    const result = results.get(fixture.id);
    if (!result) continue;
    const ctx: MatchContext = {
      homeId: fixture.homeId,
      awayId: fixture.awayId,
      neutral:
        fixture.competitionId === 'fifa-club-world' || fixture.competitionId === 'world-cup',
      needWinner: isKnockoutCompetition(fixture.competitionId, nextWorld),
    };
    clubs = applyMatchEffects({ ...nextWorld, clubs }, ctx, result);
  }
  nextWorld = { ...nextWorld, clubs };

  // 积分榜重算
  nextWorld = { ...nextWorld, standings: computeStandings(nextWorld) };

  // 国家队线：同一周内并行推进（只碰 national* 字段，不影响俱乐部积分）
  nextWorld = advanceNationalWeek(nextWorld);

  // 周推进：自然恢复每星期只做一次（旧实现按每场调用 applyMatchEffects，非参赛队一周恢复 F 次）
  const advanced = { ...nextWorld, week: Math.min(CALENDAR.weeks, week + 1) };
  return recoverWeekly(advanced);
}

/** AI 对 AI：LOD B/C 直接出比分，不生成球员个体 */
export function autoResolve(world: WorldState, fixture: Fixture, index?: ClubIndex): MatchResult {
  // 与交互模式共用中立场判定：世俱杯/世界杯不设主场优势
  const neutral =
    fixture.competitionId === 'fifa-club-world' || fixture.competitionId === 'world-cup';
  const ctx: MatchContext = {
    homeId: fixture.homeId,
    awayId: fixture.awayId,
    neutral,
    needWinner: isKnockoutCompetition(fixture.competitionId, world),
  };
  const { result } = simulateMatch(world, ctx, { index });
  return result;
}

/** 淘汰赛推进：某轮所有比赛结束后，为下一轮生成对阵 */
function progressKnockouts(
  world: WorldState,
  results: Map<string, MatchResult>,
  week: number,
): WorldState {
  let changed = false;
  const knockouts: Record<string, KnockoutState> = { ...world.knockouts };
  const newFixtures: Fixture[] = [];

  for (const [compId, ko] of Object.entries(world.knockouts)) {
    const roundFixtures = world.fixtures.filter(
      (f) => f.competitionId === compId && f.round === ko.round + 1,
    );
    if (roundFixtures.length === 0) continue;
    const allPlayed = roundFixtures.every((f) => results.has(f.id) || f.played);
    if (!allPlayed) continue;

    const winners: string[] = [];
    const eliminated: string[] = [];
    const playedIds = new Set<string>();
    for (const f of roundFixtures) {
      const res = results.get(f.id) ?? f.result;
      if (!res) continue;
      const w = determineWinnerId(f, res);
      if (w) winners.push(w);
      playedIds.add(f.homeId);
      playedIds.add(f.awayId);
      eliminated.push(w === f.homeId ? f.awayId : f.homeId);
    }
    if (winners.length === 0) continue;

    // 本轮轮空的球队（alive 里但没有比赛）直接带进下一轮
    const byeIds = ko.alive.map((a) => a.clubId).filter((id) => !playedIds.has(id));

    // 用种子顺序保留强弱分布
    const seedOf = new Map(ko.alive.map((a) => [a.clubId, a.seed]));
    const nextWinnerIds = [...winners, ...byeIds].sort(
      (a, b) => (seedOf.get(a) ?? 99) - (seedOf.get(b) ?? 99),
    );

    const nextRound = ko.round + 1;
    const nextWeek = ko.weeks[nextRound];
    const nextAlive = nextWinnerIds.map((clubId, i) => ({ clubId, seed: i }));

    if (nextWinnerIds.length === 1) {
      knockouts[compId] = {
        ...ko,
        round: nextRound,
        alive: nextAlive,
        eliminated: [...ko.eliminated, ...eliminated],
        championId: nextWinnerIds[0],
      };
      changed = true;
      continue;
    }

    if (nextWeek === undefined) continue;
    const entrants = nextWinnerIds.length;
    for (let i = 0; i < Math.floor(entrants / 2); i++) {
      const home = nextWinnerIds[i];
      const away = nextWinnerIds[entrants - 1 - i];
      if (!home || !away) continue;
      newFixtures.push({
        id: `${compId}-s${ko.season}-k${nextRound + 1}-m${i + 1}`,
        competitionId: compId,
        season: ko.season,
        week: nextWeek,
        round: nextRound + 1,
        homeId: home,
        awayId: away,
        stage: stageName(entrants, 0),
        played: false,
      });
    }
    // 奇数队时中间那支轮空：不生成假的 homeId===awayId 占位赛，
    // 它留在 alive 里等下一轮自己配对即可（否则会污染积分与"同轮不重队"断言）。
    knockouts[compId] = {
      ...ko,
      round: nextRound,
      alive: nextAlive,
      eliminated: [...ko.eliminated, ...eliminated],
    };
    changed = true;
  }

  if (!changed && newFixtures.length === 0) return world;
  void week;
  const fixtures = [...world.fixtures, ...newFixtures].sort(
    (a, b) => a.week - b.week || a.competitionId.localeCompare(b.competitionId),
  );
  return { ...world, knockouts, fixtures };
}

/** 每周自然恢复：体能 +、状态回归、伤病倒计时 */
export function recoverWeekly(world: WorldState): WorldState {
  const clubs = world.clubs.map<Club>((club) => ({
    ...club,
    stamina: clamp(club.stamina + BALANCE.betweenMatchRecovery, 0, BALANCE.staminaMax),
    form: clamp(club.form + (50 - club.form) * 0.05, 0, 100),
  }));
  // 国家队窗口：小幅提升士气（代表被征召的荣誉感）
  const boosted = isNationalWindow(world.week)
    ? clubs.map((c) => ({ ...c, morale: clamp(c.morale + 2, 0, 100) }))
    : clubs;
  // 国家队线同步恢复（与俱乐部线互不引用）
  return recoverNationalWeekly({ ...world, clubs: boosted });
}

/** 赛季是否已全部踢完（俱乐部 + 国家队两条线都算） */
export function isSeasonComplete(world: WorldState): boolean {
  const unplayed = world.fixtures.filter((f) => !f.played);
  if (unplayed.length > 0) return false;
  if (world.nationalFixtures.some((f) => !f.played)) return false;
  // 所有淘汰赛都必须产生冠军（轮空/种子不足的赛事除外）
  for (const ko of Object.values(world.knockouts)) {
    if (!ko.championId && ko.alive.length > 1) return false;
  }
  for (const ko of Object.values(world.nationalKnockouts)) {
    if (!ko.championId && ko.alive.length > 1) return false;
  }
  return true;
}

/** 当前周的赛程（给 UI） */
export function weekFixtures(world: WorldState, week: number): Fixture[] {
  return world.fixtures.filter((f) => f.week === week);
}

/** 下一场玩家比赛 */
export function nextPlayerFixture(
  world: WorldState,
  playerClubId: string,
): Fixture | undefined {
  return world.fixtures
    .filter(
      (f) =>
        !f.played &&
        (f.homeId === playerClubId || f.awayId === playerClubId),
    )
    .sort((a, b) => a.week - b.week)[0];
}

/** 玩家本赛季已踢场次（事件页进度必须从这里推，不能从周推） */
export function playerMatchesPlayed(world: WorldState, playerClubId: string): number {
  return world.fixtures.filter(
    (f) => f.played && (f.homeId === playerClubId || f.awayId === playerClubId),
  ).length;
}

/** 玩家赛季预计总场次 */
export function playerMatchesTotal(world: WorldState, playerClubId: string): number {
  return world.fixtures.filter(
    (f) => f.homeId === playerClubId || f.awayId === playerClubId,
  ).length;
}

/** 供测试/调试：把整个世界推进到赛季结束（每场自动模拟） */
export function simulateSeason(world: WorldState): WorldState {
  let w = world;
  let guard = 0;
  while (!isSeasonComplete(w) && guard < CALENDAR.weeks * 3) {
    // advanceWeek 内部已做每周一次的自然恢复，这里不能再调 recoverWeekly（否则双倍恢复）
    w = advanceWeek(w);
    guard++;
    if (w.week >= CALENDAR.weeks && !isSeasonComplete(w)) break;
  }
  return w;
}

/** 随机给两队生成一个「赛前宣传」文案种子，用于新闻 */
export function matchSeedText(world: WorldState, fixture: Fixture): string {
  const rng = streamRng(world.seed, 'promo', fixture.id);
  const home = world.clubs.find((c) => c.id === fixture.homeId);
  const away = world.clubs.find((c) => c.id === fixture.awayId);
  if (!home || !away) return '';
  const templates = [
    `${home.name} 主场迎战 ${away.name}`,
    `${away.name} 客场挑战 ${home.name}`,
    `本轮焦点：${home.name} vs ${away.name}`,
  ];
  return rng.pick(templates);
}


