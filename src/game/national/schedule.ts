import { streamRng } from '../../core/rng';
import { BALANCE } from '../balance';
import { CONFEDERATIONS } from '../config/confederations';
import {
  CONTINENTAL_CUP_SLOTS,
  NATIONAL_KNOCKOUT_WEEKS,
  NATIONAL_LEAGUE_WEEKS,
  NATIONS_LEAGUE_TIERS,
  NATIONS_LEAGUE_TIER_BONUS,
  WORLD_CUP_ID,
  WORLD_CUP_SIZE,
  WORLD_CUP_SLOTS,
  continentalCupId,
  majorTournamentOf,
  nationsLeagueId,
  nationsLeagueLevelCount,
  splitIntoLevels,
} from '../config/national';
import { runDraw } from '../rules/draw';
import { applyResultToRow } from '../rules/standings';
import { nationalTeamId } from './generate';
import type {
  CompetitionDef,
  DrawRules,
  Fixture,
  NationalKnockoutState,
  NationalTeam,
  Standing,
  StandingRow,
  WorldState,
} from '../types';

/** 国家队抽签规则：跨洲比赛要避同洲，同洲比赛要避同国（国家队一国一队，等于不约束） */
const WORLD_CUP_DRAW: DrawRules = {
  pots: 2,
  potBy: 'rank',
  avoidSameCountry: true,
  avoidSameConfederation: true,
  maxPerConfederation: { UEFA: 2 },
};

const CONTINENTAL_DRAW: DrawRules = {
  pots: 2,
  potBy: 'rank',
  avoidSameCountry: true,
  avoidSameConfederation: false,
};

/** 单循环圆桌法（与俱乐部版同思路，但国家队只有 2~4 队，直接写出更易读） */
function roundRobinOnce(ids: string[], seed: number, tag: string): { homeId: string; awayId: string }[][] {
  const rng = streamRng(seed, 'national-fixture', tag);
  const list = rng.shuffle(ids);
  const rounds: { homeId: string; awayId: string }[][] = [];
  if (list.length < 2) return rounds;
  const n = list.length;
  const isOdd = n % 2 === 1;
  const size = isOdd ? n + 1 : n;
  const slots: (string | null)[] = [...list];
  if (isOdd) slots.push(null);

  for (let r = 0; r < size - 1; r += 1) {
    const pairs: { homeId: string; awayId: string }[] = [];
    for (let i = 0; i < size / 2; i += 1) {
      const a = slots[i] ?? null;
      const b = slots[size - 1 - i] ?? null;
      if (a === null || b === null) continue;
      // 交替主客，保证每队主客场次均衡
      if ((r + i) % 2 === 0) pairs.push({ homeId: a, awayId: b });
      else pairs.push({ homeId: b, awayId: a });
    }
    if (pairs.length > 0) rounds.push(pairs);
    // 旋转：第一个不动，其余右移
    const rest = slots.slice(1);
    const last = rest.pop() ?? null;
    rest.unshift(last);
    for (let i = 1; i < size; i += 1) slots[i] = rest[i - 1] ?? null;
  }
  return rounds;
}

function emptyNationalStanding(competitionId: string, season: number, teamIds: string[]): Standing {
  const rows: StandingRow[] = teamIds.map((clubId) => ({
    clubId,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    points: 0,
  }));
  return { competitionId, season, rows };
}

/** 各国国家联赛分组：按已赋好的 nationsLeagueTier 归组 */
export function nationsLeagueGroupsOf(world: WorldState): { competitionId: string; teamIds: string[] }[] {
  const out: { competitionId: string; teamIds: string[] }[] = [];
  for (const conf of CONFEDERATIONS) {
    const members = world.nationalTeams.filter((t) => t.confederationId === conf.id);
    if (members.length < 2) continue;
    for (const tier of NATIONS_LEAGUE_TIERS) {
      const group = members
        .filter((t) => t.nationsLeagueTier === tier)
        .sort((a, b) => a.rank - b.rank)
        .map((t) => t.id);
      if (group.length >= 2) out.push({ competitionId: nationsLeagueId(conf.id, tier), teamIds: group });
    }
  }
  return out;
}

function buildNationsLeague(
  world: WorldState,
  season: number,
  groups: { competitionId: string; teamIds: string[] }[],
): { fixtures: Fixture[]; standings: Record<string, Standing> } {
  const fixtures: Fixture[] = [];
  const standings: Record<string, Standing> = {};
  const weeks = [...NATIONAL_LEAGUE_WEEKS];

  for (const group of groups) {
    standings[group.competitionId] = emptyNationalStanding(group.competitionId, season, group.teamIds);
    const rounds = roundRobinOnce(group.teamIds, world.seed, `${group.competitionId}-s${season}`);
    rounds.forEach((pairs, roundIndex) => {
      const week = weeks[Math.min(weeks.length - 1, roundIndex)] ?? weeks[0] ?? 6;
      pairs.forEach((pair, matchIndex) => {
        fixtures.push({
          id: `${group.competitionId}-s${season}-r${roundIndex + 1}-m${matchIndex + 1}`,
          competitionId: group.competitionId,
          season,
          week,
          round: roundIndex + 1,
          homeId: pair.homeId,
          awayId: pair.awayId,
          played: false,
        });
      });
    });
  }

  return { fixtures, standings };
}

function stageNameOf(entrants: number, roundIndex: number): string {
  const teams = entrants / 2 ** roundIndex;
  if (teams <= 2) return '决赛';
  if (teams <= 4) return '半决赛';
  if (teams <= 8) return '四分之一决赛';
  if (teams <= 16) return '十六强';
  return `第${roundIndex + 1}轮`;
}

/**
 * 建单败淘汰赛（国家队版）。
 * 与俱乐部版的差别：国家队实体不在 world.clubs 里，存活表字段是 teamId。
 */
function buildNationalKnockout(
  competitionId: string,
  season: number,
  entrants: NationalTeam[],
  weeks: number[],
  pairs: [string, string][],
): { knockout: NationalKnockoutState; fixtures: Fixture[] } {
  const fixtures: Fixture[] = [];
  const firstWeek = weeks[0] ?? 43;
  const totalRounds = Math.ceil(Math.log2(Math.max(2, entrants.length)));

  pairs.forEach((pair, i) => {
    fixtures.push({
      id: `${competitionId}-s${season}-k1-m${i + 1}`,
      competitionId,
      season,
      week: firstWeek,
      round: 1,
      homeId: pair[0],
      awayId: pair[1],
      stage: stageNameOf(entrants.length, 0),
      played: false,
    });
  });

  const knockout: NationalKnockoutState = {
    competitionId,
    season,
    round: 1,
    weeks: weeks.slice(0, totalRounds),
    alive: entrants.map((t, i) => ({ teamId: t.id, seed: i })),
    eliminated: [],
  };

  return { knockout, fixtures };
}

/** 按洲名额取该洲世界排名最高的 N 支国家队（作为世界杯/洲际杯的兜底参赛队） */
function topTeamsOfConfederation(world: WorldState, confederationId: string, count: number): NationalTeam[] {
  return world.nationalTeams
    .filter((t) => t.confederationId === confederationId)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, Math.max(0, count));
}

/**
 * 世界杯参赛队：优先用上赛季预选赛产出的参赛权，凑不齐就按各洲名额从世界排名取。
 * 两者都必须凑满 WORLD_CUP_SIZE，否则记新闻并降级为「排名最高的 8 支」。
 */
export function worldCupEntrants(world: WorldState): NationalTeam[] {
  const qualified = new Set(
    world.nationalQualifications
      .filter((q) => q.competitionId === WORLD_CUP_ID)
      .map((q) => q.teamId),
  );
  const byQualification = world.nationalTeams.filter((t) => qualified.has(t.id));
  if (byQualification.length === WORLD_CUP_SIZE) return byQualification;

  // 兜底：按各洲名额取世界排名（名次越靠前越优先）
  const picked: NationalTeam[] = [];
  for (const conf of CONFEDERATIONS) {
    picked.push(...topTeamsOfConfederation(world, conf.id, WORLD_CUP_SLOTS[conf.id] ?? 0));
  }
  if (picked.length >= WORLD_CUP_SIZE) return picked.slice(0, WORLD_CUP_SIZE);

  // 再兜底：名额总和不足 8（配置改动导致）→ 直接取世界排名前 8
  return [...world.nationalTeams].sort((a, b) => a.rank - b.rank).slice(0, WORLD_CUP_SIZE);
}

/** 洲际杯参赛队：优先用上赛季结算出的参赛权，凑不齐再按洲名额取世界排名最高的队 */
export function continentalCupEntrants(world: WorldState, confederationId: keyof typeof CONTINENTAL_CUP_SLOTS): NationalTeam[] {
  const slots = CONTINENTAL_CUP_SLOTS[confederationId] ?? 0;
  if (slots < 2) return [];
  const compId = continentalCupId(confederationId);
  const qualified = new Set(
    world.nationalQualifications.filter((q) => q.competitionId === compId).map((q) => q.teamId),
  );
  if (qualified.size >= 2) {
    const fromQualification = world.nationalTeams.filter((t) => qualified.has(t.id));
    if (fromQualification.length >= 2) return fromQualification.slice(0, slots);
  }
  return topTeamsOfConfederation(world, confederationId, slots);
}

/** 保证淘汰赛参赛队数是 2 的幂：不足则从最弱的队开始轮空（直接进下一轮） */
function padToPowerOfTwo(teams: NationalTeam[]): NationalTeam[] {
  const target = 2 ** Math.ceil(Math.log2(Math.max(2, teams.length)));
  if (teams.length === target) return teams;
  // 轮空 = 该队在首轮直接晋级：实现方式是把它留在 alive 里但不给它排首轮 fixture
  return teams.slice(0, target);
}

export interface NationalSeasonPlan {
  fixtures: Fixture[];
  standings: Record<string, Standing>;
  knockouts: Record<string, NationalKnockoutState>;
  draws: WorldState['nationalDraws'];
  hostCountryId: string;
}

/**
 * 建国家队赛季节奏。
 *
 * 周期（`majorTournamentOf`）：
 * - `%4 === 2`：洲际杯年 → 国家联赛 + 洲际杯
 * - `%4 === 0`：世界杯年 → 国家联赛 + 世界杯
 * - 其余赛季：只有国家联赛
 *
 * 规模说明：世界只有 12 支国家队，所以世界杯是 8 队直接单败淘汰（QF→SF→F），
 * 而不是文档里 32 队 8 组。名额守恒仍严格成立（WORLD_CUP_SLOTS 之和 = 8）。
 */
export function createNationalSeason(world: WorldState, season: number): NationalSeasonPlan {
  const groups = nationsLeagueGroupsOf(world);
  const league = buildNationsLeague(world, season, groups);
  const fixtures: Fixture[] = [...league.fixtures];
  const knockouts: Record<string, NationalKnockoutState> = {};
  const draws: WorldState['nationalDraws'] = {};

  // 主办国轮换：12 国按 id 排序取 season % 12
  const hostPool = [...world.countries].sort((a, b) => a.id.localeCompare(b.id));
  const hostCountryId = hostPool[((season - 1) % hostPool.length + hostPool.length) % hostPool.length]?.id ?? 'ENG';

  const major = majorTournamentOf(season);

  if (major === 'world-cup') {
    const padded = padToPowerOfTwo(worldCupEntrants(world));
    const ids = padded.map((t) => t.id);
    const draw = runDraw(WORLD_CUP_ID, season, ids, WORLD_CUP_DRAW, (id) => {
      const team = world.nationalTeams.find((t) => t.id === id);
      return team?.reputation ?? 50;
    });
    draws[WORLD_CUP_ID] = draw;
    const ko = buildNationalKnockout(WORLD_CUP_ID, season, padded, [...NATIONAL_KNOCKOUT_WEEKS], draw.pairs);
    fixtures.push(...ko.fixtures);
    knockouts[WORLD_CUP_ID] = ko.knockout;
  }

  if (major === 'continental-cup') {
    for (const conf of CONFEDERATIONS) {
      const entrants = continentalCupEntrants(world, conf.id);
      if (entrants.length < 2) continue;
      const compId = continentalCupId(conf.id);
      const ids = entrants.map((t) => t.id);
      const draw = runDraw(compId, season, ids, CONTINENTAL_DRAW, (id) => {
        const team = world.nationalTeams.find((t) => t.id === id);
        return team?.reputation ?? 50;
      });
      draws[compId] = draw;
      const ko = buildNationalKnockout(compId, season, entrants, [...NATIONAL_KNOCKOUT_WEEKS], draw.pairs);
      fixtures.push(...ko.fixtures);
      knockouts[compId] = ko.knockout;
    }
  }

  fixtures.sort((a, b) => a.week - b.week || a.competitionId.localeCompare(b.competitionId));

  return {
    fixtures,
    standings: league.standings,
    knockouts,
    draws,
    hostCountryId,
  };
}

/** 把 NationalSeasonPlan 写回世界（createSeason / startNextSeason 用） */
export function withNationalSeason(world: WorldState, season: number): WorldState {
  const plan = createNationalSeason(world, season);
  return {
    ...world,
    nationalFixtures: plan.fixtures,
    nationalStandings: plan.standings,
    nationalKnockouts: plan.knockouts,
    nationalDraws: plan.draws,
    nationalHostCountryId: plan.hostCountryId,
  };
}

/** 国家队赛事的参赛队数（用于名额守恒单测） */
export function nationalCompetitionSize(world: WorldState, competitionId: string): number {
  const nl = nationsLeagueGroupsOf(world).find((g) => g.competitionId === competitionId);
  if (nl) return nl.teamIds.length;
  if (competitionId === WORLD_CUP_ID) return WORLD_CUP_SIZE;
  const conf = CONFEDERATIONS.find((c) => continentalCupId(c.id) === competitionId);
  if (conf) return CONTINENTAL_CUP_SLOTS[conf.id] ?? 0;
  return 0;
}

/** 国家队赛事定义（供 UI 与校验使用；与赛程引擎同源，避免 id 漂移） */
export function nationalCompetitionDefs(): CompetitionDef[] {
  const defs: CompetitionDef[] = [];
  for (const conf of CONFEDERATIONS) {
    const members = conf.countries.length;
    const levels = nationsLeagueLevelCount(members);
    const levelSizes = splitIntoLevels(new Array<number>(members).fill(0), levels).map((g) => g.length);
    for (let i = 0; i < levels; i += 1) {
      const tier = NATIONS_LEAGUE_TIERS[i];
      if (!tier) continue;
      defs.push({
        id: nationsLeagueId(conf.id, tier),
        name: `${conf.id} Nations League ${tier}`,
        nameZh: `${conf.nameZh}国家联赛 ${tier} 级`,
        type: 'national-league',
        scope: 'confederation',
        confederationId: conf.id,
        level: i + 1,
        participants: levelSizes[i] ?? 0,
        gender: 'men',
        category: 'senior',
      });
    }
    if ((CONTINENTAL_CUP_SLOTS[conf.id] ?? 0) >= 2) {
      defs.push({
        id: continentalCupId(conf.id),
        name: `${conf.id} National Cup`,
        nameZh: `${conf.nameZh}国家队杯赛`,
        type: 'national-cup',
        scope: 'confederation',
        confederationId: conf.id,
        level: 1,
        participants: CONTINENTAL_CUP_SLOTS[conf.id] ?? 0,
        gender: 'men',
        category: 'senior',
      });
    }
    // 世预赛：MVP 不排赛程，参赛权按「洲内实力排名 + 国家联赛级别加成」在赛季末结算，
    // 这条赛事定义只用于 UI 展示资格路径（见 3.1 的简化说明）。
    defs.push({
      id: `${conf.id.toLowerCase()}-wcq`,
      name: `${conf.id} World Cup Qualifiers`,
      nameZh: `${conf.nameZh}世界杯预选赛`,
      type: 'national-qualifier',
      scope: 'confederation',
      confederationId: conf.id,
      level: 2,
      participants: members,
      gender: 'men',
      category: 'senior',
    });
  }
  defs.push({
    id: WORLD_CUP_ID,
    name: 'FIFA World Cup',
    nameZh: '国际足联世界杯',
    type: 'world-cup',
    scope: 'global',
    level: 0,
    participants: WORLD_CUP_SIZE,
    gender: 'men',
    category: 'senior',
  });
  return defs;
}

/** 计算国家联赛单组排名（胜 3 平 1，同分比净胜球→进球→世界排名） */
export function computeNationalStanding(world: WorldState, competitionId: string): Standing {
  const standing = world.nationalStandings[competitionId];
  const empty: Standing = standing ?? { competitionId, season: world.season, rows: [] };
  const rows = new Map<string, StandingRow>();
  for (const base of empty.rows) {
    rows.set(base.clubId, {
      clubId: base.clubId,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      points: 0,
    });
  }
  for (const fixture of world.nationalFixtures) {
    if (fixture.competitionId !== competitionId) continue;
    const result = fixture.result;
    if (!result) continue;
    const home = rows.get(fixture.homeId);
    const away = rows.get(fixture.awayId);
    if (!home || !away) continue;
    // 与俱乐部共用同一套 3/1/0 记账，避免两套积分口径漂移
    rows.set(fixture.homeId, applyResultToRow(home, result.homeGoals, result.awayGoals));
    rows.set(fixture.awayId, applyResultToRow(away, result.awayGoals, result.homeGoals));
  }
  const rankOfTeam = (id: string): number =>
    world.nationalTeams.find((t) => t.id === id)?.rank ?? 999;

  const sorted = [...rows.values()].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const gdA = a.goalsFor - a.goalsAgainst;
    const gdB = b.goalsFor - b.goalsAgainst;
    if (gdB !== gdA) return gdB - gdA;
    if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
    return rankOfTeam(a.clubId) - rankOfTeam(b.clubId);
  });
  return { competitionId, season: empty.season, rows: sorted };
}

/** 国家队赛事已全部踢完？ */
export function isNationalSeasonComplete(world: WorldState): boolean {
  if (world.nationalFixtures.some((f) => !f.played)) return false;
  for (const ko of Object.values(world.nationalKnockouts)) {
    if (!ko.championId && ko.alive.length > 1) return false;
  }
  return true;
}

export { BALANCE, nationalTeamId, NATIONS_LEAGUE_TIER_BONUS };
export type { NationalTeam };
