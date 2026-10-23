import { BALANCE } from '../balance';
import { generateWorld } from '../world/generate';
import { createSeason } from '../world/schedule';
import { computeStandings } from '../rules/standings';
import { resolveQualifications } from '../rules/qualify';
import { computeNationalTables } from '../national/advance';
import type {
  Club,
  Fixture,
  MatchResult,
  NationalTeam,
  PlayState,
  SaveGame,
  SavedFixture,
  SavedResultColumns,
  SeasonSummary,
  Standing,
  WorldState,
} from '../types';

/**
 * 存档解码：种子重生静态世界 → 复刻赛季骨架 → 回填增量。
 *
 * 与 `encode.ts` 严格对称：
 *  1. `generateWorld(seed)` 得到与存档时完全一致的静态世界；
 *  2. 先应用俱乐部升降级位移（会影响联赛归属 → 影响骨架赛程）；
 *  3. 回填上一季快照与资格，再 `createSeason` 复刻骨架；
 *  4. 把紧凑赛果列写回骨架赛程，追加动态生成的淘汰赛赛程；
 *  5. 回填体能/状态/士气三列、淘汰赛态、国家队线；
 *  6. 积分榜一律重算（`computeStandings` / `computeNationalTables`），不存。
 */

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

function fromB36(ch: string | undefined): number {
  if (!ch || ch === '.') return 0;
  const i = B36.indexOf(ch);
  return i < 0 ? 0 : i;
}

function decodeXg(ch: string | undefined): number {
  return fromB36(ch) / 8;
}

function decodePenalty(ch: string | undefined): MatchResult['penalty'] {
  if (ch === '1') return 'home';
  if (ch === '2') return 'away';
  return 'none';
}

function resultAt(cols: SavedResultColumns, i: number): MatchResult | undefined {
  const home = cols.home[i];
  const away = cols.away[i];
  // 比分列缺一半时按未开赛处理，避免把缺失的客队进球静默当成 0
  if (home === undefined || home === '.' || away === undefined || away === '.') return undefined;
  const halfHome = cols.halfHome?.[i];
  const halfAway = cols.halfAway?.[i];
  const result: MatchResult = {
    homeGoals: fromB36(home),
    awayGoals: fromB36(away),
    homeXg: decodeXg(cols.homeXg[i]),
    awayXg: decodeXg(cols.awayXg[i]),
    penalty: decodePenalty(cols.penalty[i]),
    scorers: [],
    keyEvents: [],
  };
  if (halfHome !== undefined && halfHome !== '.' && halfAway !== undefined && halfAway !== '.') {
    result.halfTime = { homeGoals: fromB36(halfHome), awayGoals: fromB36(halfAway) };
  }
  const score = cols.scores?.[i];
  if (score) result.penaltyScore = score;
  return result;
}

function idAt(code: string | undefined, ids: string[]): string | undefined {
  if (!code || code === '..' || code.length !== 2) return undefined;
  const i = parseInt(code, 36);
  return Number.isInteger(i) && i >= 0 && i < ids.length ? ids[i] : undefined;
}

/**
 * 赛季结算后 clubs 已升降级，骨架对阵与刚踢完的赛季不同；
 * encode 用两位 base36 索引存了骨架每场的实际主客，这里按同一顺序还原。
 */
function applyPairs<T extends { homeId: string; awayId: string }>(
  fixtures: T[],
  pairs: string | undefined,
  ids: string[],
): T[] {
  if (!pairs) return fixtures;
  return fixtures.map((f, i) => {
    const home = idAt(pairs.slice(i * 4, i * 4 + 2), ids);
    const away = idAt(pairs.slice(i * 4 + 2, i * 4 + 4), ids);
    return home && away ? { ...f, homeId: home, awayId: away } : f;
  });
}

function fillFixtures(
  skeleton: Fixture[],
  cols: SavedResultColumns,
  extra: SavedFixture[],
): Fixture[] {
  const filled = skeleton.map((f, i) => {
    const result = resultAt(cols, i);
    if (!result) return f;
    return { ...f, result, played: true };
  });
  for (const e of extra) {
    const fixture: Fixture = {
      id: e.id,
      competitionId: e.competitionId,
      season: e.season,
      week: e.week,
      round: e.round,
      homeId: e.homeId,
      awayId: e.awayId,
      played: false,
    };
    if (e.stage !== undefined) fixture.stage = e.stage;
    if (e.result) {
      fixture.result = e.result;
      fixture.played = true;
    }
    filled.push(fixture);
  }
  return filled.sort(
    (a, b) => a.week - b.week || a.competitionId.localeCompare(b.competitionId),
  );
}

/** 把升/降级位移应用到俱乐部（index 对应 `generateWorld` 的 clubs 顺序） */
function applyMoves(clubs: Club[], moves: [number, number, string][]): Club[] {
  if (moves.length === 0) return clubs;
  const out = clubs.slice();
  for (const [index, tier, competitionId] of moves) {
    const club = out[index];
    if (!club) continue;
    out[index] = { ...club, tier, competitionId };
  }
  return out;
}

/** 把财政/声望/实力变动应用到俱乐部（P5 稀疏列） */
function applyAttrs(
  clubs: Club[],
  attrs: [number, number, number, number, number, number][] | undefined,
): Club[] {
  if (!attrs || attrs.length === 0) return clubs;
  const out = clubs.slice();
  for (const [index, cash, reputation, attack, midfield, defense] of attrs) {
    const club = out[index];
    if (!club) continue;
    out[index] = { ...club, cash, reputation, attack, midfield, defense };
  }
  return out;
}

export function decodeSave(save: SaveGame): { world: WorldState; state: PlayState } {
  const base = generateWorld(save.seed);
  const delta = save.delta;

  const clubsWithMoves = applyAttrs(applyMoves(base.clubs, delta.clubs.moves), delta.clubs.attrs);

  // 国家队 tier 决定国家联赛分组，必须在 createSeason 复刻骨架之前应用（否则赛程按种子 tier 重建）
  const nationalTeams: NationalTeam[] = base.nationalTeams.map((team, i) => {
    const form = delta.nationalTeams.form[i];
    const morale = delta.nationalTeams.morale[i];
    const stamina = delta.nationalTeams.stamina[i];
    const tier = delta.nationalTeams.tiers[i];
    const next: NationalTeam = { ...team };
    if (form !== undefined) next.form = form;
    if (morale !== undefined) next.morale = morale;
    if (stamina !== undefined) next.stamina = stamina;
    if (tier === 'A' || tier === 'B' || tier === 'C' || tier === 'D') next.nationsLeagueTier = tier;
    return next;
  });

  const prevWorld: WorldState = {
    ...base,
    clubs: clubsWithMoves,
    nationalTeams,
    season: delta.season,
    news: delta.news.slice(),
    lastSeasonRanks: delta.lastSeasonRanks,
    lastSeasonChampions: delta.lastSeasonChampions,
    qualifications: [],
    nationalQualifications: delta.nationalQualifications,
  };

  const pairDelta = delta as typeof delta & {
    fixturePairs?: string;
    nationalFixturePairs?: string;
    qualificationSeason?: number;
  };
  // 新版存档不再存参赛权（76KB+），用同一批上季快照按当时赛季号复算；
  // 旧档仍带 delta.qualifications，优先使用以免历史档行为漂移。
  const qualifications =
    delta.qualifications.length > 0
      ? delta.qualifications
      : pairDelta.qualificationSeason !== undefined
        ? resolveQualifications({ ...prevWorld, season: pairDelta.qualificationSeason }).entries
        : [];
  prevWorld.qualifications = qualifications;

  const skeleton = createSeason(prevWorld, delta.season);
  const skeletonFixtures = applyPairs(
    skeleton.fixtures,
    pairDelta.fixturePairs,
    clubsWithMoves.map((c) => c.id),
  );
  const skeletonNationalFixtures = applyPairs(
    skeleton.nationalFixtures,
    pairDelta.nationalFixturePairs,
    nationalTeams.map((t) => t.id),
  );

  const fixtures = fillFixtures(skeletonFixtures, delta.clubResults, delta.extraFixtures);
  const nationalFixtures = fillFixtures(
    skeletonNationalFixtures,
    delta.nationalResults,
    delta.extraNationalFixtures,
  );

  const clubs: Club[] = clubsWithMoves.map((club, i) => {
    const stamina = delta.clubs.stamina[i];
    const form = delta.clubs.form[i];
    const morale = delta.clubs.morale[i];
    const next: Club = { ...club };
    if (stamina !== undefined) next.stamina = stamina;
    if (form !== undefined) next.form = form;
    if (morale !== undefined) next.morale = morale;
    return next;
  });

  const rebuilt: WorldState = {
    ...skeleton,
    season: delta.season,
    week: delta.week,
    finished: delta.finished,
    clubs,
    fixtures,
    standings: skeleton.standings,
    knockouts: delta.knockouts,
    nationalTeams,
    nationalFixtures,
    nationalKnockouts: delta.nationalKnockouts,
    news: delta.news.slice(),
    lastSeasonRanks: delta.lastSeasonRanks,
    lastSeasonChampions: delta.lastSeasonChampions,
    qualifications,
    nationalQualifications: delta.nationalQualifications,
  };
  if (delta.seasonSummary) rebuilt.seasonSummary = delta.seasonSummary;
  if (delta.nationalHostCountryId) rebuilt.nationalHostCountryId = delta.nationalHostCountryId;

  // 结算态里 clubs 已按下一季升降级，直接用它们重算会把已降级队的比赛丢掉；
  // 用 seasonSummary 的 fromTier 反推当季联赛归属，并据此重建积分榜的行集合。
  const standingClubs = standingClubsOf(clubs, delta.seasonSummary);
  const standingBase: WorldState = {
    ...rebuilt,
    clubs: standingClubs,
    standings: historicalStandings(rebuilt, standingClubs),
  };

  return {
    world: {
      ...rebuilt,
      standings: computeStandings(standingBase),
      nationalStandings: computeNationalTables(rebuilt),
    },
    state: save.state,
  };
}

/** 复算当季积分榜时的俱乐部归属：把本季已升降级的队放回 fromTier 对应联赛 */
function standingClubsOf(clubs: Club[], summary: SeasonSummary | undefined): Club[] {
  if (!summary || (summary.promoted.length === 0 && summary.relegated.length === 0)) {
    return clubs;
  }
  const previousTier = new Map<string, number>();
  for (const moved of [...summary.promoted, ...summary.relegated]) {
    previousTier.set(moved.clubId, moved.fromTier);
  }
  return clubs.map((club) => {
    const tier = previousTier.get(club.id);
    if (tier === undefined) return club;
    return { ...club, tier, competitionId: `${club.countryId.toLowerCase()}-l${tier}` };
  });
}

/** 按当季归属生成空积分榜行集合，作为 computeStandings 的记账容器 */
function historicalStandings(world: WorldState, clubs: Club[]): Record<string, Standing> {
  const out: Record<string, Standing> = {};
  for (const comp of world.competitions) {
    if (comp.type !== 'league') continue;
    const rows = clubs
      .filter((club) => club.competitionId === comp.id)
      .map((club) => club.id)
      .sort()
      .map((clubId) => ({
        clubId,
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        points: 0,
      }));
    out[comp.id] = { competitionId: comp.id, season: world.season, rows };
  }
  return out;
}

export interface LoadResult {
  ok: boolean;
  world?: WorldState;
  state?: PlayState;
  /** 归一化时修掉的问题，便于 UI 提示 */
  repaired: string[];
  reason?: string;
}

/** 容错读档：任何坏字段都不能让游戏打不开（设计 §11.2） */
export function loadSave(raw: unknown, seedFallback?: number): LoadResult {
  const repaired: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, repaired, reason: '存档不是对象' };
  }
  const save = raw as Partial<SaveGame>;
  // 版本策略：当前只有 v1，未知版本显式拒绝而不是按新版本半解；将来升级时在此登记迁移函数
  if (save.version === undefined) {
    repaired.push('缺少版本号，按当前版本处理');
  } else if (save.version !== BALANCE.saveVersion) {
    return { ok: false, repaired, reason: `存档版本 ${save.version} 与当前 ${BALANCE.saveVersion} 不符` };
  }
  const seed = typeof save.seed === 'number' && Number.isFinite(save.seed) ? save.seed : seedFallback;
  if (seed === undefined) return { ok: false, repaired, reason: '存档缺少世界种子' };
  if (seed !== save.seed) repaired.push('世界种子缺失，已用回退种子');
  if (!save.state || !save.delta) return { ok: false, repaired, reason: '存档缺少玩家状态或世界增量' };
  const stateMode = (save.state as { mode?: unknown }).mode;
  if (stateMode !== 'career' && stateMode !== 'manager') {
    return { ok: false, repaired, reason: `未知模式 ${String(stateMode)}` };
  }

  const normalized: SaveGame = {
    version: BALANCE.saveVersion,
    createdAt: typeof save.createdAt === 'number' ? save.createdAt : 0,
    seed,
    mode: save.mode === 'manager' ? 'manager' : stateMode,
    state: save.state,
    delta: normalizeDelta(save.delta, repaired),
  };

  try {
    return { ok: true, ...decodeSave(normalized), repaired };
  } catch (error) {
    return {
      ok: false,
      repaired,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeDelta(delta: SaveGame['delta'], repaired: string[]): SaveGame['delta'] {
  const out = { ...delta };
  if (typeof out.season !== 'number' || !Number.isFinite(out.season) || out.season < 1) {
    out.season = 1;
    repaired.push('赛季号非法，已归一到 1');
  }
  if (typeof out.week !== 'number' || !Number.isFinite(out.week) || out.week < 1) {
    out.week = 1;
    repaired.push('周次非法，已归一到 1');
  }
  if (!out.clubs) {
    out.clubs = { stamina: [], form: [], morale: [], moves: [] };
    repaired.push('缺俱乐部动态列，按种子初值补齐');
  }
  if (!Array.isArray(out.clubs.moves)) out.clubs.moves = [];
  if (!Array.isArray(out.clubs.attrs)) out.clubs.attrs = [];
  if (!out.nationalTeams) {
    out.nationalTeams = { form: [], morale: [], stamina: [], tiers: [] };
    repaired.push('缺国家队动态列，按种子初值补齐');
  }
  out.clubResults = normalizeColumns(out.clubResults, repaired, '俱乐部赛果');
  out.nationalResults = normalizeColumns(out.nationalResults, repaired, '国家队赛果');
  if (!Array.isArray(out.extraFixtures)) out.extraFixtures = [];
  if (!Array.isArray(out.extraNationalFixtures)) out.extraNationalFixtures = [];
  if (!out.knockouts || typeof out.knockouts !== 'object') out.knockouts = {};
  if (!out.nationalKnockouts || typeof out.nationalKnockouts !== 'object') {
    out.nationalKnockouts = {};
  }
  if (!out.lastSeasonRanks || typeof out.lastSeasonRanks !== 'object') out.lastSeasonRanks = {};
  if (!out.lastSeasonChampions || typeof out.lastSeasonChampions !== 'object') {
    out.lastSeasonChampions = {};
  }
  if (!Array.isArray(out.qualifications)) out.qualifications = [];
  if (!Array.isArray(out.nationalQualifications)) out.nationalQualifications = [];
  if (!Array.isArray(out.news)) out.news = [];
  return out;
}

const EMPTY_COLUMNS: SavedResultColumns = {
  home: '',
  away: '',
  homeXg: '',
  awayXg: '',
  penalty: '',
  halfHome: '',
  halfAway: '',
  scores: {},
};

function normalizeColumns(
  cols: SavedResultColumns | undefined,
  repaired: string[],
  label: string,
): SavedResultColumns {
  if (!cols || typeof cols !== 'object') {
    repaired.push(`缺少${label}列，按未开赛处理`);
    return { ...EMPTY_COLUMNS };
  }
  const pick = (value: unknown, field: string): string => {
    const s = typeof value === 'string' ? value : '';
    // 非法字符替换为未赛，避免 fromB36 静默返回 0 把坏档读成 0-0
    if (s !== '' && /[^0-9a-z.]/.test(s)) {
      repaired.push(`${label}${field}列含非法字符，已按未赛处理`);
      return s.replace(/[^0-9a-z.]/g, '.');
    }
    return s;
  };
  return {
    home: pick(cols.home, 'home'),
    away: pick(cols.away, 'away'),
    homeXg: pick(cols.homeXg, 'homeXg'),
    awayXg: pick(cols.awayXg, 'awayXg'),
    penalty: pick(cols.penalty, 'penalty'),
    halfHome: pick(cols.halfHome, 'halfHome'),
    halfAway: pick(cols.halfAway, 'halfAway'),
    scores: typeof cols.scores === 'object' && cols.scores !== null ? cols.scores : {},
  };
}
