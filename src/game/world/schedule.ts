import { streamRng } from '../../core/rng';
import type { Rng } from '../../core/rng';
import { BALANCE } from '../balance';
import { CONFEDERATIONS } from '../config/confederations';
import { COUNTRIES } from '../config/countries';
import { CALENDAR, leagueWeeks } from '../config/calendar';
import { CONTINENTAL_PARTICIPANTS, drawRulesOf } from '../config/qualification';
import { withNationalSeason } from '../national/schedule';
import { runDraw } from '../rules/draw';
import type {
  Club,
  CompetitionDef,
  DrawResult,
  Fixture,
  KnockoutState,
  Standing,
  StandingRow,
  WorldState,
} from '../types';

/** 杯赛/淘汰赛占用的周（联赛不能占这些周，避免同一队同周撞两场） */
export const KNOCKOUT_WEEKS = {
  /** 国内杯赛：16 队 → 4 轮 */
  domesticCup: [12, 18, 33, 43],
  /** 洲际俱乐部赛：32 队 → 5 轮 */
  continental: [9, 15, 21, 31, 39],
  /** 世俱杯：32 队 → 5 轮，赛季末 */
  clubWorld: [44, 45, 46, 47, 48],
} as const;

/** 联赛轮次可用的周：联赛周里剔除杯赛周 */
function leagueFixtureWeeks(): number[] {
  const knockout = new Set<number>([
    ...KNOCKOUT_WEEKS.domesticCup,
    ...KNOCKOUT_WEEKS.continental,
    ...KNOCKOUT_WEEKS.clubWorld,
  ]);
  return leagueWeeks().filter((w) => !knockout.has(w));
}

/** 把 rounds 个轮次均匀铺到 weeks 上（见 buildLeagueFixtures 内的取周公式） */

/**
 * 圆桌法单循环赛程：返回 rounds × (n/2) 对阵。
 * n 为奇数时补一个虚拟轮空（对手 id 为 null）。
 */
export function circleMethod(ids: string[]): { home: string; away: string }[][] {
  const list = ids.slice();
  if (list.length % 2 === 1) list.push('');
  const n = list.length;
  const rounds: { home: string; away: string }[][] = [];
  const m = n - 1;
  for (let r = 0; r < m; r++) {
    const pairs: { home: string; away: string }[] = [];
    for (let i = 0; i < n / 2; i++) {
      // 经典圆桌：固定末位，其余 n-1 个位置按轮次旋转（旧实现的主客奇偶与旋转同步导致失衡）
      const a = i === 0 ? (list[r] as string) : (list[(r + i) % m] as string);
      const b = i === 0 ? (list[m] as string) : (list[(r - i + m) % m] as string);
      if (a === '' || b === '') continue;
      // 轮次与配对位置共同决定主客，保证每队主客差 ≤1
      const homeFirst = i === 0 ? r % 2 === 0 : i % 2 === 0;
      pairs.push(homeFirst ? { home: a, away: b } : { home: b, away: a });
    }
    rounds.push(pairs);
  }
  return rounds;
}

/** 联赛赛程：单循环。18 队 17 轮、20 队 19 轮，都能落在联赛周内。 */
function buildLeagueFixtures(
  world: WorldState,
  comp: CompetitionDef,
  season: number,
  weeks: number[],
): Fixture[] {
  const clubs = world.clubs.filter((c) => c.competitionId === comp.id);
  if (clubs.length < 2) return [];
  const rng = streamRng(world.seed, 'fixture', season, comp.id);
  const ids = rng.shuffle(clubs.map((c) => c.id));
  const rounds = circleMethod(ids);
  const fixtures: Fixture[] = [];

  // 轮次均匀铺到可用周：第 r 轮用 weeks[floor(r * weeks.length / rounds.length)]
  for (let r = 0; r < rounds.length; r++) {
    const weekIndex = Math.min(
      weeks.length - 1,
      Math.floor((r * weeks.length) / rounds.length),
    );
    const week = weeks[weekIndex];
    if (week === undefined) continue;
    for (const [i, pair] of (rounds[r] ?? []).entries()) {
      fixtures.push({
        id: `${comp.id}-s${season}-r${r + 1}-m${i + 1}`,
        competitionId: comp.id,
        season,
        week,
        round: r + 1,
        homeId: pair.home,
        awayId: pair.away,
        played: false,
      });
    }
  }
  return fixtures;
}

/** 淘汰赛种子：按声望降序（第一赛季）；后续赛季可用上赛季名次 */
function seedEntrants(world: WorldState, clubs: Club[], count: number): Club[] {
  const ranked = clubs.slice().sort((a, b) => {
    const ra = world.lastSeasonRanks[a.competitionId]?.indexOf(a.id) ?? -1;
    const rb = world.lastSeasonRanks[b.competitionId]?.indexOf(b.id) ?? -1;
    if (ra >= 0 && rb >= 0 && ra !== rb) return ra - rb;
    if (ra >= 0 && rb < 0) return -1;
    if (rb >= 0 && ra < 0) return 1;
    return b.reputation - a.reputation;
  });
  return ranked.slice(0, count);
}

/** 标准种子配对：1v32、2v31 …… 保证强队分散。奇数队时正中那支轮空。 */
export function seedPairs(count: number): { pairs: [number, number][]; bye: number | null } {
  const pairs: [number, number][] = [];
  const half = Math.floor(count / 2);
  for (let i = 0; i < half; i++) pairs.push([i, count - 1 - i]);
  const bye = count % 2 === 1 ? half : null;
  return { pairs, bye };
}

function createKnockout(
  compId: string,
  season: number,
  entrants: Club[],
  weeks: readonly number[],
  drawPairs?: [string, string][],
): { knockout: KnockoutState; fixtures: Fixture[] } {
  const n = entrants.length;
  const alive = entrants.map((c, i) => ({ clubId: c.id, seed: i }));
  const fixtures: Fixture[] = [];
  const week = weeks[0] ?? 10;
  // 有抽签结果就按抽签配对，否则按标准种子配对（1vN）
  const pairs: [string, string][] = drawPairs
    ? drawPairs.map(([a, b]) => [a, b] as [string, string])
    : seedPairs(n).pairs.map<[string, string]>(([a, b]) => {
        const home = alive[a];
        const away = alive[b];
        return [home?.clubId ?? '', away?.clubId ?? ''];
      });
  pairs.forEach(([homeId, awayId], i) => {
    if (!homeId || !awayId) return;
    fixtures.push({
      id: `${compId}-s${season}-k1-m${i + 1}`,
      competitionId: compId,
      season,
      week,
      round: 1,
      homeId,
      awayId,
      stage: stageName(n, 0),
      played: false,
    });
  });
  return {
    knockout: { competitionId: compId, season, round: 0, weeks: [...weeks], alive, eliminated: [] },
    fixtures,
  };
}

export function stageName(entrants: number, roundIndex: number): string {
  const teams = entrants / 2 ** roundIndex;
  if (teams <= 2) return '决赛';
  if (teams === 4) return '半决赛';
  if (teams === 8) return '四分之一决赛';
  if (teams === 16) return '十六强';
  if (teams === 32) return '三十二强';
  return `第${roundIndex + 1}轮`;
}

function emptyStanding(compId: string, season: number, clubIds: string[]): Standing {
  return {
    competitionId: compId,
    season,
    rows: clubIds.map<StandingRow>((clubId) => ({
      clubId,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      points: 0,
    })),
  };
}

/**
 * 洲际俱乐部赛参赛队：优先用上个赛季资格链算出的参赛权（world.qualifications）；
 * 第 1 赛季没有上季快照时，退回按声望/名次排序兜底。规则层不在这里写死任何名额。
 */
function continentalEntrants(world: WorldState, comp: CompetitionDef): Club[] {
  // 目标队数以资格表为准（CAF 冠军联赛 16 队），与资格层 participantsOf 同源
  const target = CONTINENTAL_PARTICIPANTS[comp.id] ?? comp.participants ?? 32;
  const byId = new Map(world.clubs.map((c) => [c.id, c]));
  const qualified: Club[] = [];
  for (const entry of world.qualifications) {
    if (entry.competitionId !== comp.id) continue;
    const club = byId.get(entry.clubId);
    if (club) qualified.push(club);
  }
  if (qualified.length >= 2) return qualified.slice(0, target);

  const conf = CONFEDERATIONS.find((c) => c.id === comp.confederationId);
  if (!conf) return [];
  // 兜底池要覆盖该洲全部级别：旧实现只取顶级联赛，二级赛事 start=idx*32 会切空
  const pool = world.clubs.filter((c) => c.confederationId === conf.id);
  if (pool.length < 2) return [];
  const ranked = seedEntrants(world, pool, pool.length);
  const tiers = conf.clubCompetitions;
  const idx = Math.max(0, tiers.indexOf(comp.id));
  // 按本洲前面各赛的目标数累加起点，而不是固定 32——否则 CAF/CONCACAF 的第二项赛事会越界
  let start = 0;
  for (let i = 0; i < idx; i++) {
    const id = tiers[i];
    start += id ? CONTINENTAL_PARTICIPANTS[id] ?? 32 : 32;
  }
  return ranked.slice(start, start + target);
}

/** 世俱杯参赛队：优先用资格链结果；兜底为各洲顶级赛头名 + 主办国 1 队 */
function clubWorldEntrants(world: WorldState): Club[] {
  const byId = new Map(world.clubs.map((c) => [c.id, c]));
  const qualified: Club[] = [];
  for (const entry of world.qualifications) {
    if (entry.competitionId !== 'fifa-club-world') continue;
    const club = byId.get(entry.clubId);
    if (club && !qualified.some((q) => q.id === club.id)) qualified.push(club);
  }
  if (qualified.length >= 2) return qualified.slice(0, 32);

  const out: Club[] = [];
  for (const conf of CONFEDERATIONS) {
    const topId = conf.clubCompetitions[0];
    if (!topId) continue;
    const pool = continentalEntrants(world, {
      id: topId,
      name: '',
      nameZh: '',
      type: 'continental-club',
      scope: 'confederation',
      confederationId: conf.id,
      level: 1,
      participants: 32,
      gender: 'men',
      category: 'senior',
    });
    out.push(...pool.slice(0, conf.clubWorldSlots));
  }
  // 主办名额：按赛季轮换一个国家，取其顶级联赛里还没入选的最高声望球队
  const hostPool = COUNTRIES.slice().sort((a, b) => a.id.localeCompare(b.id));
  const hostCountry = hostPool[world.season % hostPool.length];
  if (hostCountry) {
    const topTier = world.competitions.find(
      (c) => c.type === 'league' && c.countryId === hostCountry.id && c.level === 1,
    );
    const candidates = topTier
      ? world.clubs
          .filter((c) => c.competitionId === topTier.id)
          .sort((a, b) => b.reputation - a.reputation)
      : [];
    const hostClub = candidates.find((c) => !out.some((o) => o.id === c.id));
    if (hostClub) out.push(hostClub);
  }
  return out.slice(0, 32);
}

/**
 * 构建一个赛季的全部俱乐部赛程（联赛 + 国内杯赛 + 洲际 + 世俱杯）。
 * 纯函数：不修改入参 world，返回新 WorldState。
 */
export function createSeason(world: WorldState, season: number): WorldState {
  const weeks = leagueFixtureWeeks();
  const fixtures: Fixture[] = [];
  const standings: Record<string, Standing> = {};
  const knockouts: Record<string, KnockoutState> = {};
  const draws: Record<string, DrawResult> = {};
  const repOf = (clubId: string): number =>
    world.clubs.find((c) => c.id === clubId)?.reputation ?? 0;
  const drawFor = (compId: string, entrants: Club[]): [string, string][] | undefined => {
    if (entrants.length < 2) return undefined;
    const result = runDraw(
      compId,
      season,
      entrants.map((c) => c.id),
      drawRulesOf(compId),
      repOf,
    );
    draws[compId] = result;
    return result.pairs;
  };

  // 1) 联赛
  for (const comp of world.competitions) {
    if (comp.type !== 'league') continue;
    const clubIds = world.clubs.filter((c) => c.competitionId === comp.id).map((c) => c.id);
    standings[comp.id] = emptyStanding(comp.id, season, clubIds);
    fixtures.push(...buildLeagueFixtures(world, comp, season, weeks));
  }

  // 2) 国内杯赛：每国顶级联赛前 16 队
  for (const comp of world.competitions) {
    if (comp.type !== 'domestic-cup' || !comp.countryId) continue;
    const topTier = world.competitions.find(
      (c) => c.type === 'league' && c.countryId === comp.countryId && c.level === 1,
    );
    if (!topTier) continue;
    const pool = world.clubs.filter((c) => c.competitionId === topTier.id);
    const entrants = seedEntrants(world, pool, 16);
    if (entrants.length < 2) continue;
    const { knockout, fixtures: fs } = createKnockout(
      comp.id,
      season,
      entrants,
      KNOCKOUT_WEEKS.domesticCup,
      drawFor(comp.id, entrants),
    );
    knockouts[comp.id] = knockout;
    fixtures.push(...fs);
  }

  // 3) 洲际俱乐部赛
  for (const comp of world.competitions) {
    if (
      comp.type !== 'continental-club' &&
      comp.type !== 'continental-club-2' &&
      comp.type !== 'continental-club-3'
    ) {
      continue;
    }
    const entrants = continentalEntrants(world, comp);
    if (entrants.length < 2) continue;
    const { knockout, fixtures: fs } = createKnockout(
      comp.id,
      season,
      entrants,
      KNOCKOUT_WEEKS.continental,
      drawFor(comp.id, entrants),
    );
    knockouts[comp.id] = knockout;
    fixtures.push(...fs);
  }

  // 4) 世俱杯
  const cwc = world.competitions.find((c) => c.type === 'club-world');
  if (cwc) {
    const entrants = clubWorldEntrants(world);
    if (entrants.length >= 2) {
      const { knockout, fixtures: fs } = createKnockout(
        cwc.id,
        season,
        entrants,
        KNOCKOUT_WEEKS.clubWorld,
        drawFor(cwc.id, entrants),
      );
      knockouts[cwc.id] = knockout;
      fixtures.push(...fs);
    }
  }

  fixtures.sort((a, b) => a.week - b.week || a.competitionId.localeCompare(b.competitionId));
  const clubSeason: WorldState = {
    ...world,
    season,
    week: 1,
    fixtures,
    standings,
    knockouts,
    draws,
    finished: false,
    seasonSummary: undefined,
  };
  // 国家队线：与俱乐部线同一次 createSeason 里建好，两套赛程互不引用
  return withNationalSeason(clubSeason, season);
}

/** 当前周要踢的比赛，按 competitionId 排序保证确定性 */
export function fixturesOfWeek(world: WorldState, week: number): Fixture[] {
  return world.fixtures.filter((f) => f.week === week && !f.played);
}

/** 某队本赛季剩余比赛数 */
export function remainingMatchesOf(world: WorldState, clubId: string, fromWeek: number): number {
  return world.fixtures.filter(
    (f) => !f.played && f.week >= fromWeek && (f.homeId === clubId || f.awayId === clubId),
  ).length;
}

/** 赛程密度：给规则层判定「一周双赛」用 */
export function matchesInWeekOf(world: WorldState, clubId: string, week: number): number {
  return world.fixtures.filter(
    (f) => f.week === week && (f.homeId === clubId || f.awayId === clubId),
  ).length;
}

/** 联赛周数（调试 / 测试用） */
export function leagueWeeksCount(): number {
  return leagueFixtureWeeks().length;
}

/** 校验：任何一队同周不应超过 maxMatchesPerWeek 场 */
export function findSchedulingConflicts(world: WorldState): { week: number; clubId: string; count: number }[] {
  const map = new Map<string, number>();
  for (const f of world.fixtures) {
    for (const clubId of [f.homeId, f.awayId]) {
      const key = `${f.week}|${clubId}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
  }
  const out: { week: number; clubId: string; count: number }[] = [];
  for (const [key, count] of map) {
    if (count > CALENDAR.maxMatchesPerWeek) {
      const [weekStr, clubId] = key.split('|') as [string, string];
      out.push({ week: Number(weekStr), clubId, count });
    }
  }
  return out;
}

export { BALANCE };
export type { Rng };
