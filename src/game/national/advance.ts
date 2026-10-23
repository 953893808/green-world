import { streamRng } from '../../core/rng';
import { BALANCE, clamp } from '../balance';
import { CONFEDERATIONS } from '../config/confederations';
import {
  CONTINENTAL_CUP_SLOTS,
  NATIONAL_KNOCKOUT_WEEKS,
  NATIONS_LEAGUE_TIERS,
  NATIONS_LEAGUE_TIER_BONUS,
  WORLD_CUP_ID,
  WORLD_CUP_SLOTS,
  continentalCupId,
  majorTournamentOf,
  nationsLeagueId,
} from '../config/national';
import { simulateMatch } from '../match/simulate';
import { buildNationalIndex, nationalTeamAsClub } from './generate';
import { computeNationalStanding, isNationalSeasonComplete } from './schedule';
import type {
  Fixture,
  MatchResult,
  NationalQualificationEntry,
  NationalTeam,
  Reason,
  SeasonSummary,
  Standing,
  WorldState,
} from '../types';

export interface NationalMatchOutcome {
  fixtureId: string;
  competitionId: string;
  homeId: string;
  awayId: string;
  result: MatchResult;
}

/**
 * 给 simulateMatch 用的「世界 + 国家队俱乐部化副本」。
 * simulateMatch 算点球强度时会去 world.clubs 里查人，国家队不在里面，
 * 所以把国家队拼成 Club 形状追加进去，点球概率才有强弱差别。
 */
function nationalWorld(world: WorldState): WorldState {
  return {
    ...world,
    clubs: [...world.clubs, ...world.nationalTeams.map(nationalTeamAsClub)],
  };
}

/** 模拟一场国家队比赛（复用俱乐部版 simulateMatch 的全部公式） */
export function simulateNationalMatch(
  world: WorldState,
  homeId: string,
  awayId: string,
  needWinner: boolean,
): MatchResult {
  const home = world.nationalTeams.find((t) => t.id === homeId);
  const away = world.nationalTeams.find((t) => t.id === awayId);
  if (!home || !away) throw new Error(`simulateNationalMatch: 国家队不存在 ${homeId} / ${awayId}`);
  const augmented = nationalWorld(world);
  const index = buildNationalIndex(world);
  for (const club of augmented.clubs) index.set(club.id, club);
  const { result } = simulateMatch(
    augmented,
    {
      homeId,
      awayId,
      neutral: false,
      needWinner,
      homeTactic: home.tactic,
      awayTactic: away.tactic,
    },
    { index },
  );
  return result;
}

/** 从 nationalFixtures 全量重算所有国家队积分榜（幂等，不做增量累加） */
export function computeNationalTables(world: WorldState): Record<string, Standing> {
  const out: Record<string, Standing> = {};
  for (const competitionId of Object.keys(world.nationalStandings)) {
    out[competitionId] = computeNationalStanding(world, competitionId);
  }
  return out;
}

/** 国家队比赛后的体能/状态/士气结算（只改 nationalTeams，不碰 clubs） */
export function applyNationalMatchEffects(world: WorldState, outcomes: NationalMatchOutcome[]): WorldState {
  if (outcomes.length === 0) return world;
  const touched = new Map<string, { goalsFor: number; goalsAgainst: number }>();
  for (const o of outcomes) {
    const home = touched.get(o.homeId) ?? { goalsFor: 0, goalsAgainst: 0 };
    home.goalsFor += o.result.homeGoals;
    home.goalsAgainst += o.result.awayGoals;
    touched.set(o.homeId, home);

    const away = touched.get(o.awayId) ?? { goalsFor: 0, goalsAgainst: 0 };
    away.goalsFor += o.result.awayGoals;
    away.goalsAgainst += o.result.homeGoals;
    touched.set(o.awayId, away);
  }

  const nationalTeams = world.nationalTeams.map((team) => {
    const stats = touched.get(team.id);
    if (!stats) return team;
    const won = stats.goalsFor > stats.goalsAgainst;
    const drew = stats.goalsFor === stats.goalsAgainst;
    return {
      ...team,
      stamina: clamp(team.stamina - BALANCE.staminaPerMatch, 0, BALANCE.staminaMax),
      form: clamp(team.form + (won ? 3 : drew ? 0 : -3), 0, 100),
      morale: clamp(team.morale + (won ? 4 : drew ? 1 : -4), 0, 100),
    };
  });

  return { ...world, nationalTeams };
}

/** 周恢复：体能回升、状态向 50 回归 */
export function recoverNationalWeekly(world: WorldState): WorldState {
  const nationalTeams = world.nationalTeams.map((team) => ({
    ...team,
    stamina: clamp(team.stamina + BALANCE.betweenMatchRecovery, 0, BALANCE.staminaMax),
    form: clamp(team.form + (50 - team.form) * 0.05, 0, 100),
  }));
  return { ...world, nationalTeams };
}

function winnerOf(fixture: Fixture, result: MatchResult): string {
  if (result.homeGoals > result.awayGoals) return fixture.homeId;
  if (result.awayGoals > result.homeGoals) return fixture.awayId;
  if (result.penalty === 'away') return fixture.awayId;
  return fixture.homeId;
}

function stageNameOf(round: number): string {
  if (round >= 3) return '决赛';
  if (round === 2) return '半决赛';
  return '四分之一决赛';
}

/**
 * 推进国家队淘汰赛。
 * `NationalKnockoutState.round` 表示「已生成的轮次」（1 起）：
 * 因此本轮比赛 = round 字段相同的 fixture，下一轮号 = round + 1，比赛周 = weeks[round]。
 * （与俱乐部版 KnockoutState.round=已完成轮次 的语义不同，别混淆。）
 */
function progressNationalKnockouts(world: WorldState): WorldState {
  let changed = false;
  const newFixtures: Fixture[] = [];
  const knockouts = { ...world.nationalKnockouts };

  for (const [competitionId, ko] of Object.entries(world.nationalKnockouts)) {
    if (ko.championId) continue;
    const roundFixtures = world.nationalFixtures.filter(
      (f) => f.competitionId === competitionId && f.round === ko.round,
    );
    if (roundFixtures.length === 0) continue;
    if (roundFixtures.some((f) => !f.played || !f.result)) continue;

    const winners: string[] = [];
    const eliminated: string[] = [...ko.eliminated];
    const playedIds = new Set<string>();
    for (const fixture of roundFixtures) {
      const result = fixture.result;
      if (!result) continue;
      const winnerId = winnerOf(fixture, result);
      const loserId = winnerId === fixture.homeId ? fixture.awayId : fixture.homeId;
      winners.push(winnerId);
      eliminated.push(loserId);
      playedIds.add(fixture.homeId);
      playedIds.add(fixture.awayId);
    }
    if (winners.length === 0) continue;

    const byeIds = ko.alive.map((a) => a.teamId).filter((id) => !playedIds.has(id));
    const seedOf = new Map(ko.alive.map((a) => [a.teamId, a.seed] as const));
    const nextIds = [...winners, ...byeIds].sort((a, b) => (seedOf.get(a) ?? 99) - (seedOf.get(b) ?? 99));

    if (nextIds.length <= 1) {
      knockouts[competitionId] = {
        ...ko,
        round: ko.round + 1,
        alive: nextIds.map((teamId, i) => ({ teamId, seed: i })),
        eliminated,
        ...(nextIds[0] ? { championId: nextIds[0] } : {}),
      };
      changed = true;
      continue;
    }

    const nextRound = ko.round + 1;
    const nextWeek = ko.weeks[ko.round];
    if (nextWeek === undefined) {
      // 预留周次用完：按种子直接收束出冠军，避免赛季卡死
      knockouts[competitionId] = {
        ...ko,
        round: nextRound,
        alive: nextIds.map((teamId, i) => ({ teamId, seed: i })),
        eliminated,
        ...(nextIds[0] ? { championId: nextIds[0] } : {}),
      };
      changed = true;
      continue;
    }

    const entrants = nextIds.length;
    for (let i = 0; i < Math.floor(entrants / 2); i += 1) {
      const home = nextIds[i];
      const away = nextIds[entrants - 1 - i];
      if (!home || !away) continue;
      newFixtures.push({
        id: `${competitionId}-s${ko.season}-k${nextRound}-m${i + 1}`,
        competitionId,
        season: ko.season,
        week: nextWeek,
        round: nextRound,
        homeId: home,
        awayId: away,
        stage: stageNameOf(nextRound),
        played: false,
      });
    }

    knockouts[competitionId] = {
      ...ko,
      round: nextRound,
      alive: nextIds.map((teamId, i) => ({ teamId, seed: i })),
      eliminated,
    };
    changed = true;
  }

  if (!changed) return world;
  const nationalFixtures = [...world.nationalFixtures, ...newFixtures].sort(
    (a, b) => a.week - b.week || a.competitionId.localeCompare(b.competitionId),
  );
  return { ...world, nationalFixtures, nationalKnockouts: knockouts };
}

/**
 * 推进一周国家队赛事（与俱乐部 advanceWeek 平行，只碰 national* 字段）。
 * 调用时机：与俱乐部周推进同一周、在 week 自增之前。
 */
export function advanceNationalWeek(world: WorldState): WorldState {
  if (world.finished) return world;
  const week = world.week;
  const pending = world.nationalFixtures.filter((f) => f.week === week && !f.played);
  if (pending.length === 0) return world;

  const outcomes: NationalMatchOutcome[] = [];
  const updated = new Map<string, Fixture>();

  for (const fixture of pending) {
    const competition = world.competitions.find((c) => c.id === fixture.competitionId);
    const needWinner = competition ? competition.type !== 'national-league' : true;
    const result = simulateNationalMatch(world, fixture.homeId, fixture.awayId, needWinner);
    updated.set(fixture.id, { ...fixture, result, played: true });
    outcomes.push({
      fixtureId: fixture.id,
      competitionId: fixture.competitionId,
      homeId: fixture.homeId,
      awayId: fixture.awayId,
      result,
    });
  }

  let next: WorldState = {
    ...world,
    nationalFixtures: world.nationalFixtures.map((f) => updated.get(f.id) ?? f),
  };
  next = applyNationalMatchEffects(next, outcomes);
  next = progressNationalKnockouts(next);
  return { ...next, nationalStandings: computeNationalTables(next) };
}

/** 一次性跑完国家队赛季（测试 / 快进用） */
export function simulateNationalSeason(world: WorldState): WorldState {
  let next = world;
  const weeks = [...new Set(world.nationalFixtures.filter((f) => !f.played).map((f) => f.week))].sort(
    (a, b) => a - b,
  );
  for (const week of weeks) {
    next = advanceNationalWeek({ ...next, week });
    next = recoverNationalWeekly(next);
  }
  if (!isNationalSeasonComplete(next)) next = flushNationalFixtures(next);
  return next;
}

/** 兜底：把排不上周的国家队比赛一次性模拟完，避免赛季卡死 */
function flushNationalFixtures(world: WorldState): WorldState {
  let next = world;
  for (let guard = 0; guard < 8 && !isNationalSeasonComplete(next); guard += 1) {
    const pending = next.nationalFixtures.filter((f) => !f.played);
    if (pending.length === 0) break;
    const outcomes: NationalMatchOutcome[] = [];
    const updated = new Map<string, Fixture>();
    for (const fixture of pending) {
      const competition = next.competitions.find((c) => c.id === fixture.competitionId);
      const needWinner = competition ? competition.type !== 'national-league' : true;
      const result = simulateNationalMatch(next, fixture.homeId, fixture.awayId, needWinner);
      updated.set(fixture.id, { ...fixture, result, played: true });
      outcomes.push({
        fixtureId: fixture.id,
        competitionId: fixture.competitionId,
        homeId: fixture.homeId,
        awayId: fixture.awayId,
        result,
      });
    }
    let stage: WorldState = {
      ...next,
      nationalFixtures: next.nationalFixtures.map((f) => updated.get(f.id) ?? f),
    };
    stage = applyNationalMatchEffects(stage, outcomes);
    stage = progressNationalKnockouts(stage);
    stage = { ...stage, nationalStandings: computeNationalTables(stage) };
    if (stage.nationalFixtures.length === next.nationalFixtures.length && pending.length === 0) return stage;
    next = stage;
  }
  return next;
}

/** 国家联赛升降级：每级末位降、下级首位升（洲内，A/B/C/D） */
export function applyNationsLeaguePromotion(world: WorldState): {
  world: WorldState;
  promoted: { teamId: string; fromTier: string; toTier: string; reason: Reason }[];
  relegated: { teamId: string; fromTier: string; toTier: string; reason: Reason }[];
} {
  const promoted: { teamId: string; fromTier: string; toTier: string; reason: Reason }[] = [];
  const relegated: { teamId: string; fromTier: string; toTier: string; reason: Reason }[] = [];
  const tierChanges = new Map<string, NationalTeam['nationsLeagueTier']>();

  for (const conf of CONFEDERATIONS) {
    const members = world.nationalTeams.filter((t) => t.confederationId === conf.id);
    if (members.length < 2) continue;
    const tables = new Map<(typeof NATIONS_LEAGUE_TIERS)[number], Standing>();
    for (const tier of NATIONS_LEAGUE_TIERS) {
      const compId = nationsLeagueId(conf.id, tier);
      if (!world.nationalStandings[compId]) continue;
      const table = computeNationalStanding(world, compId);
      if (table.rows.length >= 2) tables.set(tier, table);
    }
    for (let i = 0; i < NATIONS_LEAGUE_TIERS.length - 1; i += 1) {
      const upper = NATIONS_LEAGUE_TIERS[i];
      const lower = NATIONS_LEAGUE_TIERS[i + 1];
      if (!upper || !lower) continue;
      const upperTable = tables.get(upper);
      const lowerTable = tables.get(lower);
      if (!upperTable || !lowerTable) continue;

      const lastUpper = upperTable.rows[upperTable.rows.length - 1];
      const firstLower = lowerTable.rows[0];
      if (!lastUpper || !firstLower) continue;
      // 上下各动一支，级别内队数守恒
      tierChanges.set(lastUpper.clubId, lower);
      tierChanges.set(firstLower.clubId, upper);
      relegated.push({
        teamId: lastUpper.clubId,
        fromTier: upper,
        toTier: lower,
        reason: { code: 'NL_RELEGATED', text: `${conf.nameZh}国家联赛 ${upper} 级末位降入 ${lower} 级` },
      });
      promoted.push({
        teamId: firstLower.clubId,
        fromTier: lower,
        toTier: upper,
        reason: { code: 'NL_PROMOTED', text: `${conf.nameZh}国家联赛 ${lower} 级首位升入 ${upper} 级` },
      });
    }
  }

  const nationalTeams = world.nationalTeams.map((team) => {
    const tier = tierChanges.get(team.id);
    return tier ? { ...team, nationsLeagueTier: tier } : team;
  });

  return { world: { ...world, nationalTeams }, promoted, relegated };
}

/** 上赛季国家队各赛事排名/冠军快照 */
export function snapshotNationalSeason(world: WorldState): {
  ranks: Record<string, string[]>;
  champions: Record<string, string>;
} {
  const ranks: Record<string, string[]> = {};
  const champions: Record<string, string> = {};

  for (const competitionId of Object.keys(world.nationalStandings)) {
    const table = computeNationalStanding(world, competitionId);
    if (table.rows.length === 0) continue;
    ranks[competitionId] = table.rows.map((r) => r.clubId);
    const top = table.rows[0]?.clubId;
    if (top) champions[competitionId] = top;
  }
  for (const [competitionId, ko] of Object.entries(world.nationalKnockouts)) {
    if (!ko.championId) continue;
    champions[competitionId] = ko.championId;
    ranks[competitionId] = [ko.championId, ...ko.eliminated.filter((id) => id !== ko.championId)];
  }

  return { ranks, champions };
}

function strengthScore(team: NationalTeam): number {
  return team.strength + NATIONS_LEAGUE_TIER_BONUS[team.nationsLeagueTier] + team.reputation * 0.15;
}

/**
 * 结算国家队赛季：快照 → 国家联赛升降级 → 下赛季世界杯/洲际杯参赛权。
 * 纯函数，返回新 world。
 */
export function finishNationalSeason(world: WorldState): {
  world: WorldState;
  promoted: { teamId: string; fromTier: string; toTier: string }[];
  relegated: { teamId: string; fromTier: string; toTier: string }[];
  reasons: Reason[];
} {
  const { ranks, champions } = snapshotNationalSeason(world);
  const withSnapshots: WorldState = { ...world, lastNationalRanks: ranks, lastNationalChampions: champions };
  const { world: afterMovement, promoted, relegated } = applyNationsLeaguePromotion(withSnapshots);

  const reasons: Reason[] = [];
  const qualifications: NationalQualificationEntry[] = [];
  const nextSeason = world.season + 1;
  const major = majorTournamentOf(nextSeason);

  if (major === 'world-cup') {
    for (const conf of CONFEDERATIONS) {
      const slots = WORLD_CUP_SLOTS[conf.id] ?? 0;
      if (slots <= 0) continue;
      const ranked = afterMovement.nationalTeams
        .filter((t) => t.confederationId === conf.id)
        .sort((a, b) => strengthScore(b) - strengthScore(a) || a.rank - b.rank)
        .slice(0, slots);
      for (const team of ranked) {
        qualifications.push({
          competitionId: WORLD_CUP_ID,
          teamId: team.id,
          via: 'confederation-slots',
          reasons: [
            {
              code: 'WC_CONF_SLOT',
              text: `${conf.nameZh}世界杯名额：${team.nameZh}以洲内实力排名入选`,
              detail: { confederationId: conf.id, slots },
            },
          ],
        });
      }
    }
    reasons.push({
      code: 'WC_QUALIFIED',
      text: `第 ${nextSeason} 赛季世界杯参赛队已确定（${qualifications.length} 队）`,
    });
  }

  if (major === 'continental-cup') {
    for (const conf of CONFEDERATIONS) {
      const slots = CONTINENTAL_CUP_SLOTS[conf.id] ?? 0;
      if (slots < 2) continue;
      const ranked = afterMovement.nationalTeams
        .filter((t) => t.confederationId === conf.id)
        .sort((a, b) => strengthScore(b) - strengthScore(a) || a.rank - b.rank)
        .slice(0, slots);
      for (const team of ranked) {
        qualifications.push({
          competitionId: continentalCupId(conf.id),
          teamId: team.id,
          via: 'confederation-slots',
          reasons: [
            {
              code: 'CC_CONF_SLOT',
              text: `${conf.nameZh}国家队杯赛名额：${team.nameZh}以洲内实力排名入选`,
              detail: { confederationId: conf.id, slots },
            },
          ],
        });
      }
    }
    reasons.push({ code: 'CC_QUALIFIED', text: `第 ${nextSeason} 赛季洲际杯参赛队已确定` });
  }

  // 合并进赛季总结：俱乐部字段原样保留，只把国家队冠军并进 champions
  const base: SeasonSummary = world.seasonSummary ?? {
    season: world.season,
    champions: {},
    promoted: [],
    relegated: [],
    qualifications: [],
    playerHonors: [],
  };
  const summary: SeasonSummary = {
    ...base,
    champions: { ...base.champions, ...champions },
  };

  return {
    world: {
      ...afterMovement,
      nationalQualifications: qualifications,
      seasonSummary: summary,
      news: [...afterMovement.news, ...reasons.map((r) => r.text)].slice(-8),
    },
    promoted: promoted.map((p) => ({ teamId: p.teamId, fromTier: p.fromTier, toTier: p.toTier })),
    relegated: relegated.map((r) => ({ teamId: r.teamId, fromTier: r.fromTier, toTier: r.toTier })),
    reasons,
  };
}

/** 本赛季某赛事（世界杯/洲际杯）的参赛队 id */
export function nationalQualifiedTeams(world: WorldState, competitionId: string): string[] {
  return world.nationalQualifications.filter((q) => q.competitionId === competitionId).map((q) => q.teamId);
}

/** 国家队模式：某队下一场比赛 */
export function nextNationalFixtureOf(world: WorldState, teamId: string): Fixture | undefined {
  return world.nationalFixtures
    .filter((f) => !f.played && (f.homeId === teamId || f.awayId === teamId))
    .sort((a, b) => a.week - b.week)[0];
}

/** 某队本赛季全部国家队赛程 */
export function nationalFixturesOf(world: WorldState, teamId: string): Fixture[] {
  return world.nationalFixtures
    .filter((f) => f.homeId === teamId || f.awayId === teamId)
    .sort((a, b) => a.week - b.week);
}

/** 国家联赛某级别积分榜 */
export function nationalLeagueTable(
  world: WorldState,
  confederationId: string,
  tier: string,
): Standing | undefined {
  const conf = CONFEDERATIONS.find((c) => c.id === confederationId);
  if (!conf) return undefined;
  const idx = NATIONS_LEAGUE_TIERS.indexOf(tier as (typeof NATIONS_LEAGUE_TIERS)[number]);
  if (idx < 0) return undefined;
  const tierName = NATIONS_LEAGUE_TIERS[idx];
  if (!tierName) return undefined;
  const compId = nationsLeagueId(conf.id, tierName);
  if (!world.nationalStandings[compId]) return undefined;
  return computeNationalStanding(world, compId);
}

/** 世界排名表（可按洲过滤） */
export function nationalRankingOf(world: WorldState, confederationId?: string): NationalTeam[] {
  const list = world.nationalTeams.filter((t) => !confederationId || t.confederationId === confederationId);
  return [...list].sort((a, b) => a.rank - b.rank);
}

export { NATIONAL_KNOCKOUT_WEEKS, isNationalSeasonComplete, streamRng };
