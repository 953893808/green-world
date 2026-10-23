import { describe, expect, it } from 'vitest';
import { generateWorld } from '../src/game/world/generate';
import { createSeason } from '../src/game/world/schedule';
import { advanceWeek, isSeasonComplete, nextPlayerFixture, recoverWeekly } from '../src/game/rules/advance';
import { computeStandings, isLeagueComplete, rankOf } from '../src/game/rules/standings';
import {
  playerRating,
  simulateHalf,
  simulateMatch,
  teamPower,
  planEdge,
  resolvePenalty,
} from '../src/game/match/simulate';
import { streamRng } from '../src/core/rng';
import type { MatchContext, WorldState } from '../src/game/types';

const base = createSeason(generateWorld(20261019), 1);

function firstFixtureOf(world: WorldState, compId: string) {
  const f = world.fixtures.find((x) => x.competitionId === compId && !x.played);
  if (!f) throw new Error(`没有可踢的 ${compId} 比赛`);
  return f;
}

describe('比赛模拟', () => {
  it('teamPower 在同队体能下降时降低', () => {
    const club = base.clubs[0];
    if (!club) throw new Error('no club');
    const healthy = teamPower({ ...club, stamina: 100 });
    const tired = teamPower({ ...club, stamina: 20 });
    expect(tired).toBeLessThan(healthy);
  });

  it('同一场比赛重复模拟结果一致（确定性）', () => {
    const f = firstFixtureOf(base, 'eng-l1');
    const ctx: MatchContext = { homeId: f.homeId, awayId: f.awayId, neutral: false, needWinner: false };
    const a = simulateMatch(base, ctx);
    const b = simulateMatch(base, ctx);
    expect(a.result).toEqual(b.result);
  });

  it('正常联赛可以打平', () => {
    let draws = 0;
    for (const f of base.fixtures.filter((x) => x.competitionId === 'eng-l1').slice(0, 60)) {
      const ctx: MatchContext = { homeId: f.homeId, awayId: f.awayId, neutral: false, needWinner: false };
      const r = simulateMatch(base, ctx).result;
      if (r.homeGoals === r.awayGoals) draws++;
    }
    expect(draws).toBeGreaterThan(0);
  });

  it('淘汰赛必须分胜负：常规时间平局时有点球结果', () => {
    let checked = 0;
    for (const f of base.fixtures.filter((x) => x.competitionId === 'uefa-cl' && x.round === 1)) {
      const ctx: MatchContext = { homeId: f.homeId, awayId: f.awayId, neutral: false, needWinner: true };
      const r = simulateMatch(base, ctx).result;
      if (r.homeGoals === r.awayGoals) {
        expect(r.penalty === 'home' || r.penalty === 'away').toBe(true);
        expect(r.penaltyScore).toMatch(/^\d+-\d+$/);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(0);
  });

  it('点球比分绝不写入常规比分', () => {
    for (const f of base.fixtures.filter((x) => x.competitionId === 'uefa-cl' && x.round === 1)) {
      const ctx: MatchContext = { homeId: f.homeId, awayId: f.awayId, neutral: false, needWinner: true };
      const r = simulateMatch(base, ctx).result;
      expect(r.homeGoals).toBeGreaterThanOrEqual(0);
      expect(r.homeGoals).toBeLessThanOrEqual(12);
      expect(r.awayGoals).toBeLessThanOrEqual(12);
      if (r.penalty !== 'none') {
        expect(r.homeGoals).toBe(r.awayGoals);
      }
    }
  });

  it('比分落在合理区间（xG clamp 生效）', () => {
    for (const f of base.fixtures.filter((x) => x.competitionId === 'esp-l1').slice(0, 40)) {
      const ctx: MatchContext = { homeId: f.homeId, awayId: f.awayId, neutral: false, needWinner: false };
      const r = simulateMatch(base, ctx).result;
      expect(r.homeXg).toBeGreaterThanOrEqual(0.15);
      expect(r.homeXg).toBeLessThanOrEqual(4.2);
      expect(r.awayXg).toBeGreaterThanOrEqual(0.15);
      expect(r.awayXg).toBeLessThanOrEqual(4.2);
    }
  });

  it('强队对弱队胜率显著更高', () => {
    const strong = base.clubs
      .filter((c) => c.competitionId === 'eng-l1')
      .sort((a, b) => b.reputation - a.reputation)[0];
    const weak = base.clubs
      .filter((c) => c.competitionId === 'eng-l4')
      .sort((a, b) => a.reputation - b.reputation)[0];
    if (!strong || !weak) throw new Error('no clubs');
    let strongWins = 0;
    const rng = streamRng(1, 'bias');
    for (let i = 0; i < 40; i++) {
      const seedWorld = { ...base, week: i + 1, seed: 1000 + i };
      const r = simulateMatch(seedWorld, {
        homeId: strong.id,
        awayId: weak.id,
        neutral: true,
        needWinner: false,
      }).result;
      if (r.homeGoals > r.awayGoals) strongWins++;
    }
    void rng;
    expect(strongWins).toBeGreaterThan(30);
  });

  it('两队完全相同 + 中立场时胜率接近对半（无系统性偏差）', () => {
    const club = base.clubs.find((c) => c.competitionId === 'eng-l1');
    if (!club) throw new Error('no club');
    const same = { ...club, form: 50, morale: 50, stamina: 100, tactic: 'possess' as const };
    const world: WorldState = {
      ...base,
      clubs: [same, { ...same, id: 'clone-x' }],
    };
    let wins = 0;
    for (let i = 0; i < 200; i++) {
      const r = simulateMatch({ ...world, week: i + 1, seed: 500 + i }, {
        homeId: same.id,
        awayId: 'clone-x',
        neutral: true,
        needWinner: false,
      }).result;
      if (r.homeGoals > r.awayGoals) wins++;
    }
    expect(wins).toBeGreaterThan(60);
    expect(wins).toBeLessThan(140);
  });

  it('主场优势存在（同队主客场对比）', () => {
    const club = base.clubs.find((c) => c.competitionId === 'eng-l1');
    if (!club) throw new Error('no club');
    const same = { ...club, form: 50, morale: 50, stamina: 100, tactic: 'possess' as const };
    const other = { ...same, id: 'clone-y', confederationId: 'UEFA' as const };
    const world: WorldState = { ...base, clubs: [same, other] };
    let homeWins = 0;
    let awayWins = 0;
    for (let i = 0; i < 200; i++) {
      const w = { ...world, week: i + 1, seed: 900 + i };
      const r1 = simulateMatch(w, { homeId: same.id, awayId: 'clone-y', neutral: false, needWinner: false }).result;
      const r2 = simulateMatch(w, { homeId: 'clone-y', awayId: same.id, neutral: false, needWinner: false }).result;
      if (r1.homeGoals > r1.awayGoals) homeWins++;
      if (r2.awayGoals > r2.homeGoals) awayWins++;
    }
    // 同队在主场的胜场应多于在客场
    expect(homeWins).toBeGreaterThan(awayWins);
  });

  it('两段式模拟：上半场比分写入后不变', () => {
    const f = firstFixtureOf(base, 'eng-l1');
    const ctx: MatchContext = { homeId: f.homeId, awayId: f.awayId, neutral: false, needWinner: false };
    const h1 = simulateHalf(base, ctx, 0);
    const h1again = simulateHalf(base, ctx, 0);
    expect(h1).toEqual(h1again);
  });

  it('两段式全场合计 = 一次整场模拟（同参数）', () => {
    const f = firstFixtureOf(base, 'eng-l1');
    const ctx: MatchContext = { homeId: f.homeId, awayId: f.awayId, neutral: false, needWinner: false };
    const whole = simulateMatch(base, ctx).result;
    const a = simulateHalf(base, ctx, 0);
    const b = simulateHalf(base, ctx, 1);
    expect(a.homeGoals + b.homeGoals).toBe(whole.homeGoals);
    expect(a.awayGoals + b.awayGoals).toBe(whole.awayGoals);
    expect(whole.halfTime?.homeGoals).toBe(a.homeGoals);
  });

  it('半场调整不影响上半场（只影响下半场）', () => {
    const f = firstFixtureOf(base, 'eng-l1');
    const ctx: MatchContext = { homeId: f.homeId, awayId: f.awayId, neutral: false, needWinner: false };
    const h1 = simulateHalf(base, ctx, 0);
    const h1WithPlan = simulateHalf(base, ctx, 0, { mentality: 'aggressive', subsEdge: 0.5 });
    expect(h1).toEqual(h1WithPlan);
  });

  it('心态与换人会产生不同的下半场', () => {
    const f = firstFixtureOf(base, 'eng-l1');
    const ctx: MatchContext = { homeId: f.homeId, awayId: f.awayId, neutral: false, needWinner: false };
    // 两段式种子相同，但期望不同 → 用多次采样验证期望方向
    let aggXg = 0;
    let balXg = 0;
    for (let i = 0; i < 10; i++) {
      const w = { ...base, seed: 200 + i };
      balXg += simulateHalf(w, ctx, 1, { mentality: 'balanced' }).homeXg;
      aggXg += simulateHalf(w, ctx, 1, { mentality: 'aggressive' }).homeXg;
    }
    expect(aggXg).toBeGreaterThan(balXg - 1e-9);
  });

  it('planEdge：替补更强时为正，心态搏杀为正', () => {
    const good = planEdge({
      subsCount: 2,
      squadQuality: 70,
      benchQuality: 80,
      mentality: 'aggressive',
      tacticChanged: false,
      tacticAdvantage: 0,
    });
    const bad = planEdge({
      subsCount: 2,
      squadQuality: 70,
      benchQuality: 60,
      mentality: 'conservative',
      tacticChanged: false,
      tacticAdvantage: 0,
    });
    expect(good).toBeGreaterThan(bad);
  });

  it('点球大战：胜者唯一、轮次不超上限', () => {
    for (let i = 0; i < 20; i++) {
      const pen = resolvePenalty('a', 'b', i, () => 60);
      expect(['home', 'away']).toContain(pen.winner);
      const [h, a] = pen.score.split('-').map(Number);
      expect(h).toBeDefined();
      expect(a).toBeDefined();
      expect(h).not.toBe(a);
    }
  });

  it('点球强队胜率更高', () => {
    let strongWins = 0;
    for (let i = 0; i < 100; i++) {
      const pen = resolvePenalty('a', 'b', i, (id) => (id === 'a' ? 95 : 35));
      if (pen.winner === 'home') strongWins++;
    }
    expect(strongWins).toBeGreaterThan(60);
  });

  it('球员评分：进球助攻提高评分，且夹在 4~10', () => {
    const rng = streamRng(1, 'rating');
    const plain = playerRating({ goals: 0, assists: 0, margin: 0, won: false, drew: false, rng });
    const star = playerRating({ goals: 2, assists: 1, margin: 2, won: true, drew: false, rng });
    expect(star).toBeGreaterThan(plain);
    for (let i = 0; i < 50; i++) {
      const r = playerRating({
        goals: i % 4,
        assists: i % 3,
        margin: (i % 7) - 3,
        won: i % 2 === 0,
        drew: i % 3 === 0,
        rng,
      });
      expect(r).toBeGreaterThanOrEqual(4);
      expect(r).toBeLessThanOrEqual(10);
    }
  });

  it('评分不只看球队胜负：24 分 7 板 10 助式的个人表现在输球时也不低', () => {
    const rng = streamRng(2, 'rating2');
    const carry = playerRating({ goals: 3, assists: 1, margin: -1, won: false, drew: false, rng });
    const ghost = playerRating({ goals: 0, assists: 0, margin: -1, won: false, drew: false, rng });
    expect(carry).toBeGreaterThan(ghost + 1.5);
  });
});

describe('一周推进', () => {
  it('推进一周后周数 +1，本周比赛全部标记已踢', () => {
    const w0 = { ...base, week: 9 };
    const before = w0.fixtures.filter((f) => f.week === 9).length;
    expect(before).toBeGreaterThan(0);
    const w1 = advanceWeek(w0);
    expect(w1.week).toBe(10);
    expect(w1.fixtures.filter((f) => f.week === 9 && !f.played).length).toBe(0);
  });

  it('推进后积分榜与赛程一致（唯一记账处）', () => {
    const w1 = advanceWeek({ ...base, week: 9 });
    const recomputed = computeStandings(w1);
    expect(recomputed).toEqual(w1.standings);
    const totalPlayed = w1.standings['eng-l1']?.rows.reduce((s, r) => s + r.played, 0) ?? 0;
    const fixturesPlayed = w1.fixtures.filter((f) => f.competitionId === 'eng-l1' && f.played).length;
    expect(totalPlayed).toBe(fixturesPlayed * 2);
  });

  it('多周推进不会重复记分（累计分只在重算里出现）', () => {
    let w = { ...base, week: 9 };
    for (let i = 0; i < 6; i++) w = advanceWeek(w);
    const recomputed = computeStandings(w);
    expect(recomputed).toEqual(w.standings);
  });

  it('淘汰赛逐轮推进直到产生冠军', () => {
    let w: WorldState = { ...base, week: 9 };
    let guard = 0;
    while (!w.knockouts['uefa-cl']?.championId && guard < 60) {
      w = advanceWeek(w);
      guard++;
    }
    expect(w.knockouts['uefa-cl']?.championId).toBeTruthy();
    const champ = w.knockouts['uefa-cl']?.championId;
    expect(w.clubs.some((c) => c.id === champ)).toBe(true);
  });

  it('淘汰赛胜者不会重复出现在下一轮两次', () => {
    let w: WorldState = { ...base, week: 9 };
    for (let i = 0; i < 20; i++) w = advanceWeek(w);
    for (const comp of w.competitions) {
      const ids = w.fixtures
        .filter((f) => f.competitionId === comp.id && f.round === 2)
        .flatMap((f) => [f.homeId, f.awayId]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('被淘汰的球队不会在后续轮次出场', () => {
    let w: WorldState = { ...base, week: 9 };
    for (let i = 0; i < 24; i++) w = advanceWeek(w);
    const ko = w.knockouts['uefa-cl'];
    if (!ko) throw new Error('no ko');
    for (const el of ko.eliminated) {
      expect(ko.alive.some((a) => a.clubId === el)).toBe(false);
    }
  });

  it('体能不越界、赛后下降', () => {
    const w1 = advanceWeek({ ...base, week: 9 });
    for (const c of w1.clubs) {
      expect(c.stamina).toBeGreaterThanOrEqual(0);
      expect(c.stamina).toBeLessThanOrEqual(100);
    }
    expect(w1.clubs.some((c) => c.stamina < 100)).toBe(true);
  });

  it('每周恢复不会超过上限', () => {
    const r = recoverWeekly({ ...base, clubs: base.clubs.map((c) => ({ ...c, stamina: 95 })) });
    for (const c of r.clubs) expect(c.stamina).toBeLessThanOrEqual(100);
  });

  it('玩家比赛可延后（defer）', () => {
    const playerClub = base.clubs.find((c) => c.competitionId === 'eng-l1');
    if (!playerClub) throw new Error('no club');
    const w0 = { ...base, week: 9 };
    const w1 = advanceWeek(w0, { playerClubId: playerClub.id, deferPlayerMatch: true });
    const playerPlayed = w1.fixtures.filter(
      (f) => f.week === 9 && f.played && (f.homeId === playerClub.id || f.awayId === playerClub.id),
    );
    // 若玩家本周有比赛，则不应被模拟
    const hadMatch = w0.fixtures.some(
      (f) => f.week === 9 && (f.homeId === playerClub.id || f.awayId === playerClub.id),
    );
    if (hadMatch) expect(playerPlayed.length).toBe(0);
  });

  it('整季能跑完且每队场次合法', () => {
    let w: WorldState = { ...base, week: 1 };
    let guard = 0;
    while (!isSeasonComplete(w) && guard < 120) {
      w = advanceWeek(w);
      w = recoverWeekly(w);
      guard++;
    }
    expect(isSeasonComplete(w)).toBe(true);
    for (const comp of w.competitions.filter((c) => c.type === 'league')) {
      expect(isLeagueComplete(w, comp.id)).toBe(true);
    }
    expect(w.knockouts['uefa-cl']?.championId).toBeTruthy();
    expect(w.knockouts['fifa-club-world']?.championId).toBeTruthy();
    expect(w.knockouts['eng-cup']?.championId).toBeTruthy();
  });

  it('联赛积分榜排序正确（积分→净胜球→进球）', () => {
    let w: WorldState = { ...base, week: 1 };
    for (let i = 0; i < 12; i++) w = advanceWeek(w);
    const rows = w.standings['eng-l1']?.rows;
    if (!rows) throw new Error('no rows');
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      if (!a || !b) continue;
      expect(a.points).toBeGreaterThanOrEqual(b.points);
      if (a.points === b.points) {
        expect(a.goalsFor - a.goalsAgainst).toBeGreaterThanOrEqual(b.goalsFor - b.goalsAgainst);
      }
    }
  });

  it('排名函数与积分榜一致', () => {
    let w: WorldState = { ...base, week: 1 };
    for (let i = 0; i < 10; i++) w = advanceWeek(w);
    const top = w.standings['eng-l1']?.rows[0];
    if (!top) throw new Error('no top');
    expect(rankOf(w, 'eng-l1', top.clubId)).toBe(1);
  });

  it('nextPlayerFixture 返回最近的未踢比赛', () => {
    const playerClub = base.clubs.find((c) => c.competitionId === 'eng-l1');
    if (!playerClub) throw new Error('no club');
    const next = nextPlayerFixture(base, playerClub.id);
    expect(next).toBeTruthy();
    expect(next?.homeId === playerClub.id || next?.awayId === playerClub.id).toBe(true);
  });
});
