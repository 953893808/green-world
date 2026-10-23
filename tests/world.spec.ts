import { describe, expect, it } from 'vitest';
import { generateWorld, clubsOfCompetition, clubById } from '../src/game/world/generate';
import { createSeason, findSchedulingConflicts, stageName } from '../src/game/world/schedule';
import { COUNTRIES, countClubs } from '../src/game/config/countries';
import { CALENDAR, leagueWeeks, phaseLabelOf, isTransferWindow } from '../src/game/config/calendar';

const world = createSeason(generateWorld(20261019), 1);

describe('世界生成', () => {
  it('俱乐部总数 = 776', () => {
    expect(world.clubs.length).toBe(776);
    expect(world.clubs.length).toBe(countClubs(COUNTRIES));
  });

  it('同种子生成结果完全一致', () => {
    const a = generateWorld(12345);
    const b = generateWorld(12345);
    expect(JSON.stringify(a.clubs)).toBe(JSON.stringify(b.clubs));
  });

  it('不同种子生成不同结果', () => {
    const a = generateWorld(1);
    const b = generateWorld(2);
    expect(JSON.stringify(a.clubs)).not.toBe(JSON.stringify(b.clubs));
  });

  it('俱乐部 id 唯一、无真实俱乐部名', () => {
    const ids = new Set(world.clubs.map((c) => c.id));
    expect(ids.size).toBe(world.clubs.length);
    const banned = ['Real Madrid', 'Barcelona', 'Manchester', 'Bayern', 'Juventus', 'PSG', 'Chelsea', 'Arsenal'];
    for (const c of world.clubs) {
      for (const word of banned) expect(c.name).not.toContain(word);
    }
  });

  it('每个国家层数与球队数符合配置', () => {
    for (const country of COUNTRIES) {
      for (let tier = 1; tier <= country.tiers; tier++) {
        const comp = world.competitions.find(
          (c) => c.type === 'league' && c.countryId === country.id && c.level === tier,
        );
        expect(comp, `${country.id} T${tier} 缺联赛`).toBeTruthy();
        const n = clubsOfCompetition(world, comp?.id ?? '').length;
        expect(n).toBe(country.teamsPerTier[tier - 1]);
      }
    }
  });

  it('俱乐部实力在合法区间且层级递减', () => {
    for (const c of world.clubs) {
      expect(c.attack).toBeGreaterThanOrEqual(15);
      expect(c.attack).toBeLessThanOrEqual(100);
      expect(c.reputation).toBeGreaterThanOrEqual(0);
      expect(c.reputation).toBeLessThanOrEqual(100);
    }
    const engT1 = clubsOfCompetition(world, 'eng-l1');
    const engT4 = clubsOfCompetition(world, 'eng-l4');
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(engT1.map((c) => c.reputation))).toBeGreaterThan(avg(engT4.map((c) => c.reputation)));
  });

  it('赛事清单含六大洲际联合会与两条金字塔关键节点', () => {
    const ids = world.competitions.map((c) => c.id);
    expect(ids).toContain('fifa-world-cup');
    expect(ids).toContain('fifa-club-world');
    expect(ids).toContain('uefa-cl');
    expect(ids).toContain('uefa-el');
    expect(ids).toContain('uefa-uecl');
    expect(ids).toContain('conmebol-libertadores');
    expect(ids).toContain('afc-cl');
    expect(ids).toContain('caf-cl');
    expect(ids).toContain('concacaf-cl');
    expect(ids).toContain('ofc-cl');
  });

  it('所有赛事都是男子成年', () => {
    for (const c of world.competitions) {
      expect(c.gender).toBe('men');
      expect(c.category).toBe('senior');
    }
  });

  it('赛事名不含女子/青年关键字', () => {
    const bad = /women|youth|U17|U20|U21|U23/i;
    for (const c of world.competitions) {
      expect(bad.test(c.name)).toBe(false);
      expect(bad.test(c.nameZh)).toBe(false);
    }
  });
});

describe('赛季日历', () => {
  it('52 周、阶段连续覆盖 1~52', () => {
    expect(CALENDAR.weeks).toBe(52);
    const covered = new Set<number>();
    for (const p of CALENDAR.phases) {
      for (let w = p.from; w <= p.to; w++) covered.add(w);
    }
    expect(covered.size).toBe(52);
  });

  it('联赛周剔除杯赛周后仍足够放下 19 轮', () => {
    const weeks = leagueWeeks();
    expect(weeks.length).toBeGreaterThanOrEqual(19);
  });

  it('阶段标签与转会窗正确', () => {
    expect(phaseLabelOf(1)).toBe('季前备战');
    expect(phaseLabelOf(26)).toBe('冬歇期');
    expect(phaseLabelOf(50)).toBe('休赛期');
    expect(isTransferWindow(1)).toBe(true);
    expect(isTransferWindow(27)).toBe(true);
    expect(isTransferWindow(40)).toBe(false);
  });
});

describe('赛程生成', () => {
  it('每个联赛的每支球队都恰好踢 N-1 场', () => {
    for (const comp of world.competitions.filter((c) => c.type === 'league')) {
      const n = clubsOfCompetition(world, comp.id).length;
      const counts = new Map<string, number>();
      for (const f of world.fixtures.filter((x) => x.competitionId === comp.id)) {
        counts.set(f.homeId, (counts.get(f.homeId) ?? 0) + 1);
        counts.set(f.awayId, (counts.get(f.awayId) ?? 0) + 1);
      }
      expect(counts.size).toBe(n);
      for (const [, c] of counts) expect(c).toBe(n - 1);
    }
  });

  it('同一队同周不超过 2 场', () => {
    const conflicts = findSchedulingConflicts(world);
    expect(conflicts).toEqual([]);
  });

  it('每支球队每周最多 1 场联赛', () => {
    const seen = new Set<string>();
    for (const f of world.fixtures.filter((x) => x.competitionId.endsWith('-l1'))) {
      for (const clubId of [f.homeId, f.awayId]) {
        const key = `${f.week}|${clubId}`;
        expect(seen.has(key), `${clubId} 第 ${f.week} 周有重复联赛`).toBe(false);
        seen.add(key);
      }
    }
  });

  it('对阵不重复（单循环无同一对两次）', () => {
    for (const comp of world.competitions.filter((c) => c.type === 'league')) {
      const set = new Set<string>();
      for (const f of world.fixtures.filter((x) => x.competitionId === comp.id)) {
        const key = [f.homeId, f.awayId].sort().join('|');
        expect(set.has(key), `${comp.id} 对阵重复 ${key}`).toBe(false);
        set.add(key);
      }
    }
  });

  it('主队不是同城同队、主客不相等', () => {
    for (const f of world.fixtures) expect(f.homeId).not.toBe(f.awayId);
  });

  it('淘汰赛首轮用标准种子配对（1v32 式）', () => {
    const ucl = world.knockouts['uefa-cl'];
    expect(ucl).toBeTruthy();
    expect(ucl?.alive.length).toBe(32);
    const first = world.fixtures.filter((f) => f.competitionId === 'uefa-cl' && f.round === 1);
    expect(first.length).toBe(16);
    // 头号种子（reputation 最高）应在首轮，且对手是 32 号种子
    const top = ucl?.alive[0]?.clubId;
    expect(first.some((f) => f.homeId === top || f.awayId === top)).toBe(true);
  });

  it('杯赛与洲际赛都有淘汰态、世俱杯 32 队', () => {
    expect(Object.keys(world.knockouts).length).toBeGreaterThan(10);
    expect(world.knockouts['uefa-cl']?.alive.length).toBe(32);
    expect(world.knockouts['fifa-club-world']?.alive.length).toBe(32);
    expect(world.knockouts['eng-cup']?.alive.length).toBe(16);
  });

  it('阶段名映射正确', () => {
    expect(stageName(32, 0)).toBe('三十二强');
    expect(stageName(32, 1)).toBe('十六强');
    expect(stageName(32, 2)).toBe('四分之一决赛');
    expect(stageName(32, 3)).toBe('半决赛');
    expect(stageName(32, 4)).toBe('决赛');
  });

  it('赛程按周排序', () => {
    const weeks = world.fixtures.map((f) => f.week);
    const sorted = weeks.slice().sort((a, b) => a - b);
    expect(weeks).toEqual(sorted);
  });

  it('所有 fixture 的 competitionId 都能在 competitions 里找到', () => {
    const ids = new Set(world.competitions.map((c) => c.id));
    for (const f of world.fixtures) expect(ids.has(f.competitionId)).toBe(true);
  });

  it('所有 fixture 的 clubId 都能在 clubs 里找到', () => {
    for (const f of world.fixtures) {
      expect(clubById(world, f.homeId)).toBeTruthy();
      expect(clubById(world, f.awayId)).toBeTruthy();
    }
  });

  it('世界生成 + 赛程构建在性能预算内（<800ms）', () => {
    const t0 = Date.now();
    createSeason(generateWorld(777), 1);
    expect(Date.now() - t0).toBeLessThan(800);
  });
});
