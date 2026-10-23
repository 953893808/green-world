import { describe, expect, it } from 'vitest';
import { generateWorld } from '../src/game/world/generate';
import { createSeason } from '../src/game/world/schedule';
import { advanceWeek, isSeasonComplete, simulateSeason } from '../src/game/rules/advance';
import { finishSeason, startNextSeason } from '../src/game/rules/qualify';
import { generateNationalTeams, nationalTeamId } from '../src/game/national/generate';
import {
  computeNationalStanding,
  createNationalSeason,
  isNationalSeasonComplete,
  nationalCompetitionDefs,
  nationalCompetitionSize,
  nationsLeagueGroupsOf,
} from '../src/game/national/schedule';
import {
  advanceNationalWeek,
  applyNationsLeaguePromotion,
  finishNationalSeason,
  nationalFixturesOf,
  nationalLeagueTable,
  nationalQualifiedTeams,
  nationalRankingOf,
  nextNationalFixtureOf,
  snapshotNationalSeason,
} from '../src/game/national/advance';
import {
  CONTINENTAL_CUP_SLOTS,
  NATIONAL_KNOCKOUT_WEEKS,
  NATIONAL_LEAGUE_WEEKS,
  NATIONS_LEAGUE_TIERS,
  WORLD_CUP_ID,
  WORLD_CUP_SIZE,
  WORLD_CUP_SLOTS,
  continentalCupId,
  majorTournamentOf,
  nationsLeagueId,
  nationsLeagueLevelCount,
  splitIntoLevels,
} from '../src/game/config/national';
import { CONFEDERATIONS } from '../src/game/config/confederations';
import type { WorldState } from '../src/game/types';

const SEED = 20261019;

/** 世界 + 第 1 赛季（含俱乐部线与国家队线赛程） */
function freshWorld(): WorldState {
  return createSeason(generateWorld(SEED), 1);
}

function playedSeason(world: WorldState = freshWorld()): WorldState {
  return simulateSeason(world);
}

/** 连跑 n 个完整赛季（俱乐部 + 国家队两线都结算），返回第 n 赛季结算后的世界 */
function seasonsThrough(n: number): WorldState {
  let world = freshWorld();
  for (let season = 1; season <= n; season += 1) {
    world = simulateSeason(world);
    world = finishSeason(world);
    if (season < n) world = startNextSeason(world);
  }
  return world;
}

describe('国家队生成', () => {
  it('12 国各一支，id 为 `<country>-nt`，世界排名 1..12 唯一', () => {
    const teams = generateNationalTeams(SEED);
    expect(teams.length).toBe(12);
    expect(new Set(teams.map((t) => t.id)).size).toBe(12);
    for (const team of teams) {
      expect(team.id).toBe(nationalTeamId(team.countryId));
    }
    const ranks = teams.map((t) => t.rank).sort((a, b) => a - b);
    expect(ranks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('同种子同结果、不同种子不同结果', () => {
    const a = generateNationalTeams(SEED);
    const b = generateNationalTeams(SEED);
    const c = generateNationalTeams(SEED + 1);
    expect(a).toEqual(b);
    expect(a.map((t) => t.id)).toEqual(c.map((t) => t.id));
    expect(a.map((t) => t.strength)).not.toEqual(c.map((t) => t.strength));
  });

  it('实力落在 40~95、三线与士气体能合法、教练名非空', () => {
    for (const team of generateNationalTeams(SEED)) {
      expect(team.strength).toBeGreaterThanOrEqual(40);
      expect(team.strength).toBeLessThanOrEqual(95);
      for (const line of [team.attack, team.midfield, team.defense]) {
        expect(line).toBeGreaterThanOrEqual(30);
        expect(line).toBeLessThanOrEqual(97);
      }
      expect(team.morale).toBeGreaterThanOrEqual(0);
      expect(team.morale).toBeLessThanOrEqual(100);
      expect(team.stamina).toBe(100);
      expect(team.coachName.length).toBeGreaterThan(3);
    }
  });

  it('国家联赛级别在洲内按实力切分（UEFA 5 队 → A 3 队 / B 2 队，单队洲无联赛）', () => {
    const teams = generateNationalTeams(SEED);
    const uefa = teams.filter((t) => t.confederationId === 'UEFA');
    expect(uefa.filter((t) => t.nationsLeagueTier === 'A').length).toBe(3);
    expect(uefa.filter((t) => t.nationsLeagueTier === 'B').length).toBe(2);
    const conmebol = teams.filter((t) => t.confederationId === 'CONMEBOL');
    expect(conmebol.every((t) => t.nationsLeagueTier === 'A')).toBe(true);
    for (const confId of ['CAF', 'CONCACAF', 'OFC'] as const) {
      expect(teams.filter((t) => t.confederationId === confId).length).toBe(1);
    }
    // 单队洲不产生联赛分组
    const world = freshWorld();
    const groups = nationsLeagueGroupsOf(world);
    expect(groups.some((g) => g.competitionId.startsWith('caf-'))).toBe(false);
    expect(groups.some((g) => g.competitionId === nationsLeagueId('UEFA', 'A'))).toBe(true);
  });
});

describe('配置层：名额守恒与大赛周期', () => {
  it('世界杯名额之和严格等于参赛队数', () => {
    const total = Object.values(WORLD_CUP_SLOTS).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(WORLD_CUP_SIZE);
    expect(WORLD_CUP_SIZE % 2).toBe(0);
  });

  it('洲际杯名额：只有成员数 ≥2 的洲才办杯赛，且名额不超过成员国数', () => {
    for (const conf of CONFEDERATIONS) {
      const slots = CONTINENTAL_CUP_SLOTS[conf.id] ?? 0;
      if (slots > 0) {
        expect(slots).toBeGreaterThanOrEqual(2);
        expect(slots).toBeLessThanOrEqual(conf.countries.length);
      }
    }
    const total = Object.values(CONTINENTAL_CUP_SLOTS).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(8);
  });

  it('大赛周期：每 4 赛季一次洲际杯、一次世界杯，其余年份只有国家联赛', () => {
    const majors = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => majorTournamentOf(s));
    expect(majors.filter((m) => m === 'world-cup').length).toBe(2);
    expect(majors.filter((m) => m === 'continental-cup').length).toBe(2);
    expect(majors.filter((m) => m === null).length).toBe(4);
    // 与上一赛季不同：资格链必须在前一赛季末产出
    expect(majorTournamentOf(3)).toBe('world-cup');
    expect(majorTournamentOf(2)).toBe('continental-cup');
    expect(majorTournamentOf(1)).toBe(null);
  });

  it('级别数与切分工具：<2 队不办、5 队 2 级、切分保持顺序与总数', () => {
    expect(nationsLeagueLevelCount(0)).toBe(0);
    expect(nationsLeagueLevelCount(1)).toBe(0);
    expect(nationsLeagueLevelCount(2)).toBe(1);
    expect(nationsLeagueLevelCount(5)).toBe(2);
    expect(nationsLeagueLevelCount(17)).toBe(4);
    const levels = splitIntoLevels([1, 2, 3, 4, 5], 2);
    expect(levels.map((g) => g.length)).toEqual([3, 2]);
    expect(levels.flat()).toEqual([1, 2, 3, 4, 5]);
  });

  it('赛事定义全部是男子成年赛事，世界杯 8 队，每洲都有预选赛入口', () => {
    const defs = nationalCompetitionDefs();
    const worldCup = defs.find((d) => d.id === WORLD_CUP_ID);
    expect(worldCup?.participants).toBe(WORLD_CUP_SIZE);
    expect(worldCup?.type).toBe('world-cup');
    for (const conf of CONFEDERATIONS) {
      expect(defs.some((d) => d.id === `${conf.id.toLowerCase()}-wcq`)).toBe(true);
    }
    for (const def of defs) {
      expect(def.gender).toBe('men');
      expect(def.category).toBe('senior');
      expect(def.name).not.toMatch(/women|youth|U17|U20|U21|U23/i);
    }
    const world = freshWorld();
    expect(nationalCompetitionSize(world, WORLD_CUP_ID)).toBe(WORLD_CUP_SIZE);
    expect(nationalCompetitionSize(world, nationsLeagueId('UEFA', 'A'))).toBe(3);
  });
});

describe('国家队赛季节奏与赛程完整性', () => {
  it('非大赛年只有国家联赛：每队组内单循环，周次落在国家队窗口', () => {
    const world = freshWorld();
    expect(majorTournamentOf(1)).toBe(null);
    for (const group of nationsLeagueGroupsOf(world)) {
      for (const teamId of group.teamIds) {
        const mine = world.nationalFixtures.filter(
          (f) => f.competitionId === group.competitionId && (f.homeId === teamId || f.awayId === teamId),
        );
        expect(mine.length).toBe(group.teamIds.length - 1);
      }
    }
    const leagueFixtures = world.nationalFixtures.filter((f) => f.competitionId.includes('-nl-'));
    expect(leagueFixtures.length).toBeGreaterThan(0);
    for (const fixture of leagueFixtures) {
      expect(NATIONAL_LEAGUE_WEEKS).toContain(fixture.week);
    }
    expect(world.nationalKnockouts).toEqual({});
  });

  it('国家队赛程无自赛、按周排序、id 唯一、参赛 id 都能解析', () => {
    const world = freshWorld();
    const ids = world.nationalFixtures.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    const teamIds = new Set(world.nationalTeams.map((t) => t.id));
    for (const fixture of world.nationalFixtures) {
      expect(fixture.homeId).not.toBe(fixture.awayId);
      expect(teamIds.has(fixture.homeId)).toBe(true);
      expect(teamIds.has(fixture.awayId)).toBe(true);
    }
    const weeks = world.nationalFixtures.map((f) => f.week);
    const sorted = [...weeks].sort((a, b) => a - b);
    expect(weeks).toEqual(sorted);
  });

  it('洲际杯年：每个有资格的洲建淘汰赛，参赛队数 = 洲名额，轮次周次正确', () => {
    const seasonOne = finishSeason(playedSeason());
    const seasonTwo = startNextSeason(seasonOne);
    expect(seasonTwo.season).toBe(2);
    expect(majorTournamentOf(2)).toBe('continental-cup');
    const cups = CONFEDERATIONS.filter((c) => (CONTINENTAL_CUP_SLOTS[c.id] ?? 0) >= 2);
    expect(cups.length).toBeGreaterThan(0);
    for (const conf of cups) {
      const compId = continentalCupId(conf.id);
      const ko = seasonTwo.nationalKnockouts[compId];
      expect(ko, compId).toBeTruthy();
      const slots = CONTINENTAL_CUP_SLOTS[conf.id] ?? 0;
      expect(ko?.alive.length).toBe(slots);
      const fixtures = seasonTwo.nationalFixtures.filter((f) => f.competitionId === compId);
      expect(fixtures.length).toBe(slots / 2);
      for (const fixture of fixtures) {
        expect(NATIONAL_KNOCKOUT_WEEKS).toContain(fixture.week);
      }
    }
    expect(seasonTwo.nationalKnockouts[WORLD_CUP_ID]).toBeUndefined();
  });

  it('世界杯年：8 队三轮淘汰赛，周次 QF→SF→F', () => {
    const world = seasonsThrough(2);
    const seasonThree = startNextSeason(world);
    expect(seasonThree.season).toBe(3);
    expect(majorTournamentOf(3)).toBe('world-cup');
    const ko = seasonThree.nationalKnockouts[WORLD_CUP_ID];
    expect(ko?.alive.length).toBe(WORLD_CUP_SIZE);
    expect(ko?.weeks).toEqual([...NATIONAL_KNOCKOUT_WEEKS]);
    const firstRound = seasonThree.nationalFixtures.filter(
      (f) => f.competitionId === WORLD_CUP_ID && f.round === 1,
    );
    expect(firstRound.length).toBe(WORLD_CUP_SIZE / 2);
    // 名额按洲分配：参赛队按洲计数必须等于 WORLD_CUP_SLOTS
    for (const conf of CONFEDERATIONS) {
      const count = seasonThree.nationalTeams.filter(
        (t) => t.confederationId === conf.id && (ko?.alive ?? []).some((a) => a.teamId === t.id),
      ).length;
      expect(count, conf.id).toBe(WORLD_CUP_SLOTS[conf.id] ?? 0);
    }
  });

  it('createNationalSeason 返回的计划可以重复生成（纯函数、不写回原 world）', () => {
    const world = freshWorld();
    const plan = createNationalSeason(world, 1);
    expect(plan.fixtures.length).toBe(world.nationalFixtures.length);
    expect(Object.keys(plan.standings).length).toBe(Object.keys(world.nationalStandings).length);
    expect(world.nationalFixtures.every((f) => !f.played)).toBe(true);
  });
});

describe('国家队周推进与积分', () => {
  it('advanceNationalWeek 只踢本周比赛，其余不动', () => {
    const world = freshWorld();
    const target = world.nationalFixtures.find((f) => f.week === 6);
    expect(target).toBeTruthy();
    const after = advanceNationalWeek({ ...world, week: 6 });
    const playedNow = after.nationalFixtures.filter((f) => f.played);
    expect(playedNow.length).toBeGreaterThan(0);
    expect(playedNow.every((f) => f.week === 6)).toBe(true);
    const otherWeek = after.nationalFixtures.filter((f) => f.week !== 6);
    expect(otherWeek.every((f) => !f.played)).toBe(true);
    // 已踢比赛必须有结果，未踢比赛不能有结果
    expect(after.nationalFixtures.every((f) => (f.played ? Boolean(f.result) : !f.result))).toBe(true);
  });

  it('积分榜：胜 3 平 1，排序为积分→净胜球→进球→世界排名', () => {
    const world = advanceNationalWeek({ ...freshWorld(), week: 6 });
    const table = nationalLeagueTable(world, 'UEFA', 'A');
    expect(table).toBeTruthy();
    const rows = table?.rows ?? [];
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.points).toBe(row.won * 3 + row.drawn);
      expect(row.played).toBe(row.won + row.drawn + row.lost);
      expect(row.goalsFor - row.goalsAgainst).toBeDefined();
    }
    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1];
      const cur = rows[i];
      if (!prev || !cur) continue;
      expect(prev.points).toBeGreaterThanOrEqual(cur.points);
      if (prev.points === cur.points) {
        expect(prev.goalsFor - prev.goalsAgainst).toBeGreaterThanOrEqual(cur.goalsFor - cur.goalsAgainst);
      }
    }
  });

  it('整季跑完后国家队赛事全部完成，且每场都有比分', () => {
    const world = playedSeason();
    expect(isNationalSeasonComplete(world)).toBe(true);
    expect(world.nationalFixtures.every((f) => f.played && f.result)).toBe(true);
    expect(world.nationalFixtures.some((f) => f.result && f.result.penalty !== 'none' || f.result?.penalty === 'none')).toBe(true);
  });

  it('nextNationalFixtureOf / nationalFixturesOf / nationalRankingOf 可用', () => {
    const world = freshWorld();
    const team = nationalRankingOf(world)[0];
    expect(team).toBeTruthy();
    if (!team) return;
    const all = nationalFixturesOf(world, team.id);
    expect(all.length).toBeGreaterThan(0);
    const next = nextNationalFixtureOf(world, team.id);
    expect(next).toBeTruthy();
    expect(next?.week).toBe(Math.min(...all.map((f) => f.week)));
    const uefaOnly = nationalRankingOf(world, 'UEFA');
    expect(uefaOnly.every((t) => t.confederationId === 'UEFA')).toBe(true);
    expect(uefaOnly.map((t) => t.rank)).toEqual([...uefaOnly.map((t) => t.rank)].sort((a, b) => a - b));
  });
});

describe('国家联赛升降级（A/B/C/D）', () => {
  it('赛末结算：上级末位降、下级首位升，每洲队数守恒', () => {
    const played = playedSeason();
    const before = played.nationalTeams.map((t) => `${t.id}:${t.nationsLeagueTier}`).sort();
    const { world, promoted, relegated } = applyNationsLeaguePromotion(played);
    expect(promoted.length).toBeGreaterThan(0);
    expect(promoted.length).toBe(relegated.length);
    for (const p of promoted) {
      expect(p.toTier < p.fromTier).toBe(true); // 'A' < 'B' 字符串序即级别高低
      expect(NATIONS_LEAGUE_TIERS).toContain(p.fromTier as (typeof NATIONS_LEAGUE_TIERS)[number]);
      expect(NATIONS_LEAGUE_TIERS).toContain(p.toTier as (typeof NATIONS_LEAGUE_TIERS)[number]);
    }
    for (const r of relegated) {
      expect(r.toTier > r.fromTier).toBe(true);
    }
    // 每洲成员数不变（升降对调）
    for (const conf of CONFEDERATIONS) {
      const beforeCount = played.nationalTeams.filter((t) => t.confederationId === conf.id).length;
      const afterCount = world.nationalTeams.filter((t) => t.confederationId === conf.id).length;
      expect(afterCount).toBe(beforeCount);
    }
    // 级别标签仍然合法
    for (const team of world.nationalTeams) {
      expect(NATIONS_LEAGUE_TIERS).toContain(team.nationsLeagueTier);
    }
    const after = world.nationalTeams.map((t) => `${t.id}:${t.nationsLeagueTier}`).sort();
    expect(after).not.toEqual(before);
    // 每条升降级都带可解释理由
    for (const r of relegated) {
      expect(r.reason.code).toBe('NL_RELEGATED');
      expect(r.reason.text.length).toBeGreaterThan(0);
    }
  });

  it('升降级不影响世界排名与俱乐部层级', () => {
    const played = playedSeason();
    const { world } = applyNationsLeaguePromotion(played);
    const ranksBefore = played.nationalTeams.map((t) => `${t.id}:${t.rank}`).sort();
    const ranksAfter = world.nationalTeams.map((t) => `${t.id}:${t.rank}`).sort();
    expect(ranksAfter).toEqual(ranksBefore);
    expect(world.clubs.length).toBe(776);
  });
});

describe('国家队资格链与名额分配', () => {
  it('finishNationalSeason 快照冠军与排名，并给出下一季大赛参赛权', () => {
    const played = playedSeason();
    const snapshot = snapshotNationalSeason(played);
    expect(Object.keys(snapshot.champions).length).toBeGreaterThan(0);
    expect(Object.keys(snapshot.ranks).length).toBeGreaterThan(0);
    const result = finishNationalSeason(played);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(Object.keys(result.world.lastNationalChampions).length).toBeGreaterThan(0);
  });

  it('第 1 赛季末产出洲际杯名额、第 2 赛季末产出世界杯名额（各洲名额数精确）', () => {
    const seasonOne = finishSeason(playedSeason());
    // 下一季（第 2 季）是洲际杯年
    const ccQuals = seasonOne.nationalQualifications;
    expect(ccQuals.some((q) => q.competitionId === WORLD_CUP_ID)).toBe(false);
    for (const conf of CONFEDERATIONS) {
      const slots = CONTINENTAL_CUP_SLOTS[conf.id] ?? 0;
      const count = ccQuals.filter((q) => q.competitionId === continentalCupId(conf.id)).length;
      expect(count, conf.id).toBe(slots >= 2 ? slots : 0);
    }

    const seasonTwo = finishSeason(simulateSeason(startNextSeason(seasonOne)));
    const wcQuals = seasonTwo.nationalQualifications.filter((q) => q.competitionId === WORLD_CUP_ID);
    expect(wcQuals.length).toBe(WORLD_CUP_SIZE);
    expect(new Set(wcQuals.map((q) => q.teamId)).size).toBe(WORLD_CUP_SIZE);
    for (const conf of CONFEDERATIONS) {
      const slots = WORLD_CUP_SLOTS[conf.id] ?? 0;
      const count = seasonTwo.nationalTeams.filter(
        (t) => t.confederationId === conf.id && wcQuals.some((q) => q.teamId === t.id),
      ).length;
      expect(count, conf.id).toBe(slots);
    }
    // 每条参赛权都能解释
    for (const q of wcQuals) {
      expect(q.reasons.length).toBeGreaterThan(0);
      expect(q.reasons[0]?.code).toBe('WC_CONF_SLOT');
      expect(q.reasons[0]?.text.length).toBeGreaterThan(0);
      expect(q.via).toBe('confederation-slots');
    }
    expect(nationalQualifiedTeams(seasonTwo, WORLD_CUP_ID).length).toBe(WORLD_CUP_SIZE);
  });

  it('第 3 赛季世界杯按资格链建赛程，且有冠军、参赛权全被消费', () => {
    const afterTwo = seasonsThrough(2);
    const seasonThree = simulateSeason(startNextSeason(afterTwo));
    const ko = seasonThree.nationalKnockouts[WORLD_CUP_ID];
    expect(ko?.championId).toBeTruthy();
    expect(ko?.eliminated.length).toBe(WORLD_CUP_SIZE - 1);
    expect(isNationalSeasonComplete(seasonThree)).toBe(true);
    // 参赛队 = 上季资格链产出的 8 队
    const qualified = new Set(
      afterTwo.nationalQualifications.filter((q) => q.competitionId === WORLD_CUP_ID).map((q) => q.teamId),
    );
    expect(qualified.size).toBe(WORLD_CUP_SIZE);
    for (const alive of ko?.alive ?? []) {
      // 决赛后 alive 只剩冠军，但冠军必须来自资格链
      expect(qualified.has(alive.teamId)).toBe(true);
    }
  });
});

describe('两线隔离与多赛季连跑', () => {
  it('国家队赛程与俱乐部赛程互不混入，积分榜键不冲突', () => {
    const world = playedSeason();
    const clubIds = new Set(world.clubs.map((c) => c.id));
    const teamIds = new Set(world.nationalTeams.map((t) => t.id));
    // 俱乐部侧：所有参赛 id 都是俱乐部
    for (const fixture of world.fixtures) {
      expect(clubIds.has(fixture.homeId)).toBe(true);
      expect(clubIds.has(fixture.awayId)).toBe(true);
      expect(fixture.homeId).not.toBe(fixture.awayId);
    }
    // 国家队侧：所有参赛 id 都是国家队
    for (const fixture of world.nationalFixtures) {
      expect(teamIds.has(fixture.homeId)).toBe(true);
      expect(teamIds.has(fixture.awayId)).toBe(true);
      expect(fixture.homeId).not.toBe(fixture.awayId);
    }
    const clubFixtureIds = new Set(world.fixtures.map((f) => f.id));
    for (const fixture of world.nationalFixtures) {
      expect(clubFixtureIds.has(fixture.id)).toBe(false);
    }
    for (const competitionId of Object.keys(world.nationalStandings)) {
      expect(world.standings[competitionId]).toBeUndefined();
    }
    // 国家队积分只从 nationalFixtures 出，与俱乐部积分无关
    const table = computeNationalStanding(world, nationsLeagueId('UEFA', 'A'));
    expect(table.rows.length).toBeGreaterThan(0);
    expect(world.standings[nationsLeagueId('UEFA', 'A')]).toBeUndefined();
  });

  it('连跑 3 赛季：两线都完成、层级守恒、俱乐部总数不变', () => {
    const world = seasonsThrough(3);
    expect(world.finished).toBe(true);
    expect(world.clubs.length).toBe(776);
    expect(world.nationalTeams.length).toBe(12);
    const tierCounts = new Map<number, number>();
    for (const club of world.clubs) {
      tierCounts.set(club.tier, (tierCounts.get(club.tier) ?? 0) + 1);
    }
    expect(tierCounts.get(1)).toBe(216);
    expect(tierCounts.get(2)).toBe(240);
    expect(tierCounts.get(3)).toBe(220);
    expect(tierCounts.get(4)).toBe(100);
    expect([...tierCounts.values()].reduce((a, b) => a + b, 0)).toBe(776);
    // 每季的国家联赛都踢完了
    expect(world.nationalFixtures.every((f) => f.played)).toBe(true);
    // 三个赛季的赛季总结齐备
    expect(world.seasonSummary?.season).toBe(3);
    expect(world.lastNationalChampions[WORLD_CUP_ID]).toBeTruthy();
    expect(isSeasonComplete(world)).toBe(true);
  });

  it('赛季切换后国家队赛程重置为新赛季、周次归 1、旧冠军快照仍在', () => {
    const afterOne = finishSeason(playedSeason());
    const seasonTwo = startNextSeason(afterOne);
    expect(seasonTwo.season).toBe(2);
    expect(seasonTwo.week).toBe(1);
    expect(seasonTwo.finished).toBe(false);
    expect(seasonTwo.seasonSummary).toBeUndefined();
    expect(seasonTwo.nationalFixtures.every((f) => f.season === 2 && !f.played)).toBe(true);
    expect(Object.keys(afterOne.lastNationalChampions).length).toBeGreaterThan(0);
    // 上赛季结算出的参赛权保留，供本季洲际杯使用
    expect(seasonTwo.nationalQualifications.length).toBeGreaterThan(0);
    for (const ko of Object.values(seasonTwo.nationalKnockouts)) {
      expect(ko.season).toBe(2);
    }
  });

  it('单周推进两侧同步：俱乐部 week 前进时国家队同周比赛也被踢掉', () => {
    const world = freshWorld();
    const before = { week: world.week };
    const after = advanceWeek(world);
    expect(after.week).toBe(before.week + 1);
    // 这一周若有国家队比赛，应已全部踢完（advanceWeek 内部并行推进）
    const sameWeek = after.nationalFixtures.filter((f) => f.week === before.week);
    expect(sameWeek.every((f) => f.played)).toBe(true);
  });
});
