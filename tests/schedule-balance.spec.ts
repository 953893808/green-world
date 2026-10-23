import { describe, expect, it } from 'vitest';
import { circleMethod, createSeason } from '../src/game/world/schedule';
import { generateWorld } from '../src/game/world/generate';

const SEED = 20261019;

function checkRoundRobin(n: number): void {
  const ids = Array.from({ length: n }, (_, i) => `t${i}`);
  const rounds = circleMethod(ids);
  expect(rounds.length).toBe(n % 2 === 0 ? n - 1 : n);

  const home = new Map(ids.map((id) => [id, 0]));
  const away = new Map(ids.map((id) => [id, 0]));
  const seen = new Set<string>();
  let matches = 0;

  for (const round of rounds) {
    const used = new Set<string>();
    for (const pair of round) {
      expect(pair.home).not.toBe(pair.away);
      expect(used.has(pair.home), `${pair.home} 同一轮出现两次`).toBe(false);
      expect(used.has(pair.away), `${pair.away} 同一轮出现两次`).toBe(false);
      used.add(pair.home);
      used.add(pair.away);
      const key = [pair.home, pair.away].sort().join('|');
      expect(seen.has(key), `重复对阵 ${key}`).toBe(false);
      seen.add(key);
      home.set(pair.home, (home.get(pair.home) ?? 0) + 1);
      away.set(pair.away, (away.get(pair.away) ?? 0) + 1);
      matches += 1;
    }
  }

  expect(matches).toBe((n * (n - 1)) / 2);
  for (const id of ids) {
    expect(Math.abs((home.get(id) ?? 0) - (away.get(id) ?? 0)), `${id} 主客失衡`).toBeLessThanOrEqual(1);
  }
}

describe('圆桌赛程主客平衡', () => {
  for (const n of [6, 7, 8, 9, 10, 11, 12, 17, 18, 19, 20, 21, 24]) {
    it(`n=${n} 无重复、主客差 ≤1、场次正确`, () => {
      checkRoundRobin(n);
    });
  }

  it('真实世界全部联赛：每队主客差 ≤1、无重复对阵', () => {
    const world = createSeason(generateWorld(SEED), 1);
    const leagues = world.competitions.filter((c) => c.type === 'league');
    expect(leagues.length).toBeGreaterThan(0);
    for (const comp of leagues) {
      const fixtures = world.fixtures.filter((f) => f.competitionId === comp.id);
      const home = new Map<string, number>();
      const away = new Map<string, number>();
      const seen = new Set<string>();
      for (const f of fixtures) {
        expect(f.homeId).not.toBe(f.awayId);
        home.set(f.homeId, (home.get(f.homeId) ?? 0) + 1);
        away.set(f.awayId, (away.get(f.awayId) ?? 0) + 1);
        const key = [f.homeId, f.awayId].sort().join('|');
        expect(seen.has(key), `${comp.id} 重复对阵 ${key}`).toBe(false);
        seen.add(key);
      }
      for (const id of new Set(fixtures.flatMap((f) => [f.homeId, f.awayId]))) {
        expect(Math.abs((home.get(id) ?? 0) - (away.get(id) ?? 0)), `${comp.id} ${id} 主客失衡`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('真实世界第 1 季：同一俱乐部/国家队同一周最多 1 场', () => {
    const world = createSeason(generateWorld(SEED), 1);
    const byEntityWeek = new Map<string, number>();
    for (const f of [...world.fixtures, ...world.nationalFixtures]) {
      for (const id of [f.homeId, f.awayId]) {
        const key = `${id}|${f.week}`;
        byEntityWeek.set(key, (byEntityWeek.get(key) ?? 0) + 1);
      }
    }
    const doubled = [...byEntityWeek.entries()].filter(([, count]) => count > 1);
    expect(doubled).toEqual([]);
  });
});
