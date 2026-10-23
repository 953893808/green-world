import { BALANCE } from '../balance';
import { createSeason } from '../world/schedule';
import { generateWorld } from '../world/generate';
import type {
  Fixture,
  MatchResult,
  PlayState,
  SaveGame,
  SavedFixture,
  SavedResultColumns,
  WorldDelta,
  WorldState,
} from '../types';

/**
 * 存档编码：把运行中的 world 压成「种子 + 增量」。
 *
 * 核心约束（设计 §11.2）：静态世界绝不进存档。
 * 这里先用 `createSeason` 在内存里复刻一遍赛季骨架，把「骨架赛程」与
 * 「比赛中动态生成的额外赛程」分开：
 *  - 骨架赛果按骨架顺序编成定长字符串列（每场 1 个字符）；
 *  - 额外赛程（淘汰赛后续轮次）单独存完整数据，因为它们推不出来。
 */

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 骨架赛季所依赖的「上一季」季节号：第 1 季特例，直接用 1 */
export function preSeasonOf(season: number): number {
  return Math.max(1, season - 1);
}

/** 种子基线世界缓存：生成一次 776 家俱乐部约几十毫秒，存档每次都要用 */
const baselineCache = new Map<number, WorldState>();

function baselineOf(seed: number): WorldState {
  const cached = baselineCache.get(seed);
  if (cached) return cached;
  const created = generateWorld(seed);
  baselineCache.set(seed, created);
  return created;
}

function b36(value: number): string {
  const i = Math.max(0, Math.min(35, Math.round(value)));
  return B36[i] ?? '0';
}

/** xG 用 1 位 base36（×8，精度 0.125，上限 4.375 覆盖 xGMax 4.2） */
function xgChar(xg: number): string {
  return b36(xg * 8);
}

function penaltyChar(p: MatchResult['penalty']): string {
  if (p === 'home') return '1';
  if (p === 'away') return '2';
  return '0';
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function toSavedFixture(f: Fixture): SavedFixture {
  const out: SavedFixture = {
    id: f.id,
    competitionId: f.competitionId,
    season: f.season,
    week: f.week,
    round: f.round,
    homeId: f.homeId,
    awayId: f.awayId,
  };
  if (f.stage !== undefined) out.stage = f.stage;
  if (f.result) out.result = f.result;
  return out;
}

/** 把一整季骨架赛程的赛果编成并行字符列 */
export function encodeResults(items: (Fixture | undefined)[]): SavedResultColumns {
  let home = '';
  let away = '';
  let homeXg = '';
  let awayXg = '';
  let penalty = '';
  let halfHome = '';
  let halfAway = '';
  const scores: Record<number, string> = {};
  items.forEach((f, i) => {
    const r = f?.result;
    if (!f || !f.played || !r) {
      home += '.';
      away += '.';
      homeXg += '.';
      awayXg += '.';
      penalty += '.';
      halfHome += '.';
      halfAway += '.';
      return;
    }
    home += b36(r.homeGoals);
    away += b36(r.awayGoals);
    homeXg += xgChar(r.homeXg);
    awayXg += xgChar(r.awayXg);
    penalty += penaltyChar(r.penalty);
    halfHome += r.halfTime ? b36(r.halfTime.homeGoals) : '.';
    halfAway += r.halfTime ? b36(r.halfTime.awayGoals) : '.';
    if (r.penaltyScore) scores[i] = r.penaltyScore;
  });
  return { home, away, homeXg, awayXg, penalty, halfHome, halfAway, scores };
}

/** 复刻当前赛季的赛程骨架（顺序与 `createSeason` 完全一致） */
export function skeletonOf(world: WorldState): WorldState {
  return createSeason({ ...world, season: preSeasonOf(world.season) }, world.season);
}

export function encodeSave(world: WorldState, state: PlayState, createdAt = 0): SaveGame {
  const season = world.season;
  const skeleton = skeletonOf(world);

  const clubById = new Map(world.fixtures.map((f) => [f.id, f] as const));
  const skelClubIds = new Set(skeleton.fixtures.map((f) => f.id));
  const clubResults = encodeResults(skeleton.fixtures.map((f) => clubById.get(f.id)));
  const extraFixtures = world.fixtures.filter((f) => !skelClubIds.has(f.id)).map(toSavedFixture);

  const nationalById = new Map(world.nationalFixtures.map((f) => [f.id, f] as const));
  const skelNationalIds = new Set(skeleton.nationalFixtures.map((f) => f.id));
  const nationalResults = encodeResults(
    skeleton.nationalFixtures.map((f) => nationalById.get(f.id)),
  );
  const extraNationalFixtures = world.nationalFixtures
    .filter((f) => !skelNationalIds.has(f.id))
    .map(toSavedFixture);

  // 赛季已结算时 clubs 已升降级，createSeason 复刻的骨架对阵与刚踢完的赛季不同；
  // 用 base36 两位存骨架每场的实际主客索引（每个约 4 字节），读档时按索引还原对阵。
  const clubIndex = new Map(world.clubs.map((c, i) => [c.id, i] as const));
  const ntIndex = new Map(world.nationalTeams.map((t, i) => [t.id, i] as const));
  const idx2 = (map: Map<string, number>, id: string | undefined): string => {
    const i = id === undefined ? undefined : map.get(id);
    return i === undefined || i < 0 || i >= 1296 ? '..' : i.toString(36).padStart(2, '0');
  };
  const clubPairs = skeleton.fixtures
    .map((f) => {
      const actual = clubById.get(f.id);
      return actual
        ? `${idx2(clubIndex, actual.homeId)}${idx2(clubIndex, actual.awayId)}`
        : '....';
    })
    .join('');
  const baseClubPairs = skeleton.fixtures
    .map((f) => `${idx2(clubIndex, f.homeId)}${idx2(clubIndex, f.awayId)}`)
    .join('');
  const nationalPairs = skeleton.nationalFixtures
    .map((f) => {
      const actual = nationalById.get(f.id);
      return actual
        ? `${idx2(ntIndex, actual.homeId)}${idx2(ntIndex, actual.awayId)}`
        : '....';
    })
    .join('');
  const baseNationalPairs = skeleton.nationalFixtures
    .map((f) => `${idx2(ntIndex, f.homeId)}${idx2(ntIndex, f.awayId)}`)
    .join('');

  // 升降级位移：只记与「种子生成值」不同的俱乐部
  const baseline = baselineOf(world.seed);
  const moves: [number, number, string][] = [];
  const attrs: [number, number, number, number, number, number][] = [];
  world.clubs.forEach((club, i) => {
    const before = baseline.clubs[i];
    if (!before) return;
    if (before.tier !== club.tier || before.competitionId !== club.competitionId) {
      moves.push([i, club.tier, club.competitionId]);
    }
    // 财政/声望/实力：P5 的结算与转会会改这些字段，只记变化项（稀疏，避免 776 行全量）
    if (
      before.cash !== club.cash ||
      before.reputation !== club.reputation ||
      before.attack !== club.attack ||
      before.midfield !== club.midfield ||
      before.defense !== club.defense
    ) {
      attrs.push([i, club.cash, club.reputation, club.attack, club.midfield, club.defense]);
    }
  });

  const delta: WorldDelta & {
    fixturePairs?: string;
    nationalFixturePairs?: string;
    qualificationSeason?: number;
  } = {
    season,
    week: world.week,
    finished: world.finished,
    news: world.news.slice(),
    clubs: {
      stamina: world.clubs.map((c) => Math.round(c.stamina)),
      form: world.clubs.map((c) => round1(c.form)),
      morale: world.clubs.map((c) => Math.round(c.morale)),
      moves,
      attrs,
    },
    nationalTeams: {
      form: world.nationalTeams.map((t) => round1(t.form)),
      morale: world.nationalTeams.map((t) => Math.round(t.morale)),
      stamina: world.nationalTeams.map((t) => Math.round(t.stamina)),
      tiers: world.nationalTeams.map((t) => t.nationsLeagueTier),
    },
    clubResults,
    extraFixtures,
    knockouts: world.knockouts,
    nationalResults,
    extraNationalFixtures,
    nationalKnockouts: world.nationalKnockouts,
    lastSeasonRanks: world.lastSeasonRanks,
    lastSeasonChampions: world.lastSeasonChampions,
    // 参赛权由 resolveQualifications 从上季快照确定性重算，体积 76KB+，不再逐条存；
    // 记下当时使用的赛季号（主机国按 season 选），读档时按同参数复算。
    qualifications: [],
    nationalQualifications: world.nationalQualifications,
  };
  if (world.qualifications.length > 0) {
    delta.qualificationSeason = world.finished ? world.season : Math.max(1, world.season - 1);
  }
  // 只有骨架与真实对阵不一致时才写映射（常规赛季中段为 0 字节）
  if (clubPairs !== baseClubPairs) delta.fixturePairs = clubPairs;
  if (nationalPairs !== baseNationalPairs) delta.nationalFixturePairs = nationalPairs;
  if (world.seasonSummary) {
    // seasonSummary.qualifications 与 delta.qualifications 完全重复（结算后同批 entries），
    // 省略一份以控制赛季末存档体积；UI 只读 promoted/relegated/champions。
    delta.seasonSummary = { ...world.seasonSummary, qualifications: [] };
  }
  if (world.nationalHostCountryId) delta.nationalHostCountryId = world.nationalHostCountryId;

  return {
    version: BALANCE.saveVersion,
    createdAt,
    seed: world.seed,
    mode: state.mode,
    state,
    delta,
  };
}
