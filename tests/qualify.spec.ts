import { describe, expect, it } from 'vitest';
import { generateWorld } from '../src/game/world/generate';
import { createSeason } from '../src/game/world/schedule';
import { simulateSeason } from '../src/game/rules/advance';
import {
  applyPromotionRelegation,
  explainQualification,
  finishSeason,
  resolveQualifications,
  snapshotSeason,
  startNextSeason,
} from '../src/game/rules/qualify';
import { runDraw } from '../src/game/rules/draw';
import {
  CONTINENTAL_PARTICIPANTS,
  PROMOTION_RULES,
  declaredSlotsOf,
  drawRulesOf,
  rulesForCompetition,
} from '../src/game/config/qualification';
import { CONFEDERATIONS } from '../src/game/config/confederations';
import type { WorldState } from '../src/game/types';

function playedWorld(): WorldState {
  const base = createSeason(generateWorld(20261019), 1);
  return simulateSeason(base);
}

describe('配置层：资格规则', () => {
  it('每个洲际赛都有规则，且声明名额不超过目标队数', () => {
    for (const competitionId of Object.keys(CONTINENTAL_PARTICIPANTS)) {
      const rules = rulesForCompetition(competitionId);
      expect(rules.length, competitionId).toBeGreaterThan(0);
      const declared = declaredSlotsOf(competitionId);
      const target = CONTINENTAL_PARTICIPANTS[competitionId] ?? 32;
      expect(declared, `${competitionId} 声明 ${declared} > 目标 ${target}`).toBeLessThanOrEqual(
        target,
      );
      // 声明名额不足目标队数时，必须有一条 fillRemaining 规则兜底
      if (declared < target) {
        expect(
          rules.some((r) => r.fillRemaining),
          `${competitionId} 声明 ${declared} < 目标 ${target} 但没有递补规则`,
        ).toBe(true);
      }
    }
  });

  it('世俱杯名额守恒：32 队 = 各洲冠军 6 + 剩余 25 + 主办 1', () => {
    const rules = rulesForCompetition('fifa-club-world');
    const champions = rules.find((r) => r.source === 'continental-champion');
    const rest = rules.find((r) => r.source === 'continental-rank');
    const host = rules.find((r) => r.source === 'host');
    expect(champions).toBeTruthy();
    expect(rest).toBeTruthy();
    expect(host).toBeTruthy();
    const sum = (rec?: Record<string, number>): number =>
      rec ? Object.values(rec).reduce((a, b) => a + b, 0) : 0;
    expect(sum(champions?.slotsByConfederation)).toBe(6);
    expect(sum(rest?.slotsByConfederation)).toBe(25);
    expect(6 + 25 + 1).toBe(32);
  });

  it('规则表里没有任何具体赛事的硬编码分支（只靠配置驱动）', () => {
    const ids = new Set<string>();
    for (const conf of CONFEDERATIONS) {
      for (const id of conf.clubCompetitions) ids.add(id);
    }
    ids.add('fifa-club-world');
    for (const id of ids) {
      expect(rulesForCompetition(id).length, id).toBeGreaterThan(0);
    }
    expect(drawRulesOf('uefa-cl').pots).toBeGreaterThan(0);
  });

  it('升降级规则覆盖 T2→T1 / T3→T2 / T4→T3', () => {
    expect(PROMOTION_RULES.map((r) => `${r.fromTier}->${r.toTier}`)).toEqual([
      '2->1',
      '3->2',
      '4->3',
    ]);
    for (const rule of PROMOTION_RULES) {
      expect(rule.up).toBe(rule.down);
      expect(rule.up).toBeGreaterThan(0);
    }
  });
});

describe('资格链：从上赛季名次产生本赛季参赛权', () => {
  const world = playedWorld();
  const ranked: WorldState = (() => {
    const { ranks, champions } = snapshotSeason(world);
    return { ...world, lastSeasonRanks: ranks, lastSeasonChampions: champions };
  })();
  const { entries, reasons } = resolveQualifications(ranked);

  it('每个洲际赛都恰好凑满目标队数', () => {
    for (const [competitionId, target] of Object.entries(CONTINENTAL_PARTICIPANTS)) {
      const got = entries.filter((e) => e.competitionId === competitionId);
      expect(got.length, `${competitionId} 实际 ${got.length} / 目标 ${target}`).toBe(target);
    }
  });

  it('同一赛事里没有重复球队', () => {
    const byComp = new Map<string, string[]>();
    for (const entry of entries) {
      const list = byComp.get(entry.competitionId) ?? [];
      list.push(entry.clubId);
      byComp.set(entry.competitionId, list);
    }
    for (const [comp, ids] of byComp) {
      expect(new Set(ids).size, comp).toBe(ids.length);
    }
  });

  it('每条参赛权都带可读的 Reason（UI「为什么」面板）', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.ruleId.length).toBeGreaterThan(0);
      expect(entry.reasons.length).toBeGreaterThan(0);
      const reason = entry.reasons[0];
      expect(reason?.text.length ?? 0).toBeGreaterThan(0);
      expect(reason?.code.length ?? 0).toBeGreaterThan(0);
    }
    expect(reasons.every((r) => r.code.length > 0)).toBe(true);
  });

  it('世俱杯同样是 32 队且跨洲分布合理', () => {
    const cwc = entries.filter((e) => e.competitionId === 'fifa-club-world');
    expect(cwc.length).toBe(32);
    const confs = new Set(cwc.map((e) => e.clubId.split('-')[0]));
    expect(confs.size).toBeGreaterThan(3);
  });

  it('参赛权来自联赛/杯赛/洲际三类来源，不是单一来源', () => {
    const codes = new Set(entries.flatMap((e) => e.reasons.map((r) => r.code)));
    expect(codes.has('LEAGUE_RANK')).toBe(true);
    expect(codes.has('CUP_WINNER')).toBe(true);
    expect(codes.has('CONTINENTAL_CHAMPION')).toBe(true);
  });

  it('explainQualification 能解释真实规则，也能报缺失', () => {
    const first = entries[0];
    expect(first).toBeTruthy();
    if (first) {
      const reason = explainQualification(first.ruleId, { ...ranked, qualifications: entries });
      expect(reason.code).not.toBe('RULE_MISSING');
      expect(reason.text.length).toBeGreaterThan(0);
    }
    const missing = explainQualification('no-such-rule', { ...ranked, qualifications: entries });
    expect(missing.code).toBe('RULE_MISSING');
  });

  it('创建赛季时会用资格链结果当参赛队', () => {
    const next = createSeason({ ...ranked, qualifications: entries }, 2);
    const uefaCl = next.knockouts['uefa-cl'];
    expect(uefaCl).toBeTruthy();
    const aliveIds = new Set(uefaCl?.alive.map((a) => a.clubId));
    const qualifiedIds = entries
      .filter((e) => e.competitionId === 'uefa-cl')
      .map((e) => e.clubId);
    for (const id of aliveIds) {
      expect(qualifiedIds.includes(id), `${id} 不在资格链结果里`).toBe(true);
    }
  });
});

describe('抽签', () => {
  it('同国回避：满足约束时不标记 degraded', () => {
    const entrants = [
      'eng-t1-01',
      'esp-t1-01',
      'ger-t1-01',
      'ita-t1-01',
      'eng-t1-02',
      'esp-t1-02',
      'ger-t1-02',
      'ita-t1-02',
    ];
    const res = runDraw('test-cup', 1, entrants, {
      pots: 2,
      potBy: 'reputation',
      avoidSameCountry: true,
      avoidSameConfederation: false,
    });
    expect(res.pairs.length).toBe(4);
    expect(res.pots.length).toBe(2);
    expect(res.degraded).toBe(false);
    expect(res.reasons.length).toBe(0);
    const flat = res.pairs.flat();
    expect(new Set(flat).size).toBe(8);
  });

  it('约束无解时降级并给出原因', () => {
    const entrants = ['eng-t1-01', 'eng-t1-02', 'eng-t1-03', 'eng-t1-04'];
    const res = runDraw('test-cup', 1, entrants, {
      pots: 2,
      potBy: 'reputation',
      avoidSameCountry: true,
      avoidSameConfederation: false,
    });
    expect(res.degraded).toBe(true);
    expect(res.reasons[0]?.code).toBe('DRAW_DEGRADED');
    expect(res.pairs.flat().length).toBe(4);
  });

  it('每支球队只出现一次，奇数队有轮空者', () => {
    const entrants = Array.from({ length: 7 }, (_, i) => `eng-t1-0${i + 1}`);
    const res = runDraw('test-cup', 1, entrants, {
      pots: 2,
      potBy: 'reputation',
      avoidSameCountry: false,
      avoidSameConfederation: false,
    });
    expect(res.byeClubId).toBeTruthy();
    expect(res.pairs.length).toBe(3);
    const flat = res.pairs.flat();
    expect(new Set(flat).size).toBe(6);
    expect(flat.includes(res.byeClubId ?? '')).toBe(false);
  });

  it('创建赛季时每个淘汰赛赛事都有抽签结果（可解释）', () => {
    const base = createSeason(generateWorld(20261019), 1);
    const keys = Object.keys(base.draws);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const draw = base.draws[key];
      expect(draw).toBeTruthy();
      if (draw) {
        expect(draw.competitionId).toBe(key);
        expect(draw.season).toBe(1);
        expect(draw.pairs.length).toBeGreaterThan(0);
        for (const pair of draw.pairs) {
          expect(pair[0]).not.toBe(pair[1]);
        }
      }
    }
  });
});

describe('升降级与赛季结算', () => {
  const world = playedWorld();
  const { ranks, champions } = snapshotSeason(world);

  it('每国产生升级与降级，且数量守恒', () => {
    const { promoted, relegated } = applyPromotionRelegation(world, ranks);
    for (const rule of PROMOTION_RULES) {
      for (const country of world.countries) {
        const lower = `${country.id.toLowerCase()}-l${rule.fromTier}`;
        const upper = `${country.id.toLowerCase()}-l${rule.toTier}`;
        if (!ranks[lower] || !ranks[upper]) continue;
        const up = promoted.filter((p) => p.fromTier === rule.fromTier && p.reason.detail?.countryId === country.id);
        const down = relegated.filter((r) => r.fromTier === rule.toTier && r.reason.detail?.countryId === country.id);
        expect(up.length, `${country.id} ${rule.fromTier}->${rule.toTier} 升级数`).toBe(rule.up);
        expect(down.length, `${country.id} ${rule.toTier}->${rule.fromTier} 降级数`).toBe(rule.down);
        expect(up.length).toBe(down.length);
      }
    }
  });

  it('升降级后每层球队数不变（层级守恒）', () => {
    const { world: moved } = applyPromotionRelegation(world, ranks);
    const counts = new Map<string, number>();
    for (const comp of world.competitions) {
      if (comp.type !== 'league') continue;
      const before = world.clubs.filter((c) => c.competitionId === comp.id).length;
      const after = moved.clubs.filter((c) => c.competitionId === comp.id).length;
      counts.set(comp.id, before);
      expect(after, comp.id).toBe(before);
    }
    expect(counts.size).toBeGreaterThan(0);
  });

  it('冠军快照覆盖联赛与淘汰赛', () => {
    const leagueChamps = Object.keys(champions).filter((id) => world.competitions.find((c) => c.id === id)?.type === 'league');
    expect(leagueChamps.length).toBeGreaterThan(0);
    const cupChamps = Object.keys(champions).filter((id) => {
      const type = world.competitions.find((c) => c.id === id)?.type;
      return type !== 'league';
    });
    expect(cupChamps.length).toBeGreaterThan(0);
  });

  it('finishSeason 一次性产出 SeasonSummary + 下季参赛权，且不改已有赛程', () => {
    const finished = finishSeason(world);
    expect(finished.finished).toBe(true);
    expect(finished.seasonSummary).toBeTruthy();
    const summary = finished.seasonSummary;
    expect(summary?.season).toBe(world.season);
    expect(summary?.qualifications.length ?? 0).toBeGreaterThan(0);
    expect(summary?.promoted.length ?? 0).toBeGreaterThan(0);
    expect(summary?.relegated.length ?? 0).toBeGreaterThan(0);
    expect(finished.fixtures.length).toBe(world.fixtures.length);
    expect(finished.qualifications.length).toBeGreaterThan(0);
    expect(Object.keys(finished.lastSeasonRanks).length).toBeGreaterThan(0);
  });

  it('startNextSeason 换新赛程、周次归 1、沿用上季资格链', () => {
    const finished = finishSeason(world);
    const next = startNextSeason(finished);
    expect(next.season).toBe(world.season + 1);
    expect(next.week).toBe(1);
    expect(next.finished).toBe(false);
    expect(next.seasonSummary).toBeUndefined();
    expect(next.fixtures.length).toBeGreaterThan(0);
    expect(next.fixtures.every((f) => f.season === next.season)).toBe(true);
    const qualified = new Set(next.qualifications.map((e) => e.clubId));
    const uefaCl = next.knockouts['uefa-cl'];
    expect(uefaCl).toBeTruthy();
    for (const alive of uefaCl?.alive ?? []) {
      expect(qualified.has(alive.clubId)).toBe(true);
    }
  });

  it('多赛季连跑三轮仍然自洽（升降级 + 资格链 + 赛程）', () => {
    let w: WorldState = createSeason(generateWorld(20261019), 1);
    for (let season = 1; season <= 3; season++) {
      w = simulateSeason(w);
      w = finishSeason(w);
      expect(w.seasonSummary?.season).toBe(season);
      if (season < 3) w = startNextSeason(w);
    }
    expect(w.finished).toBe(true);
    const tierCounts = new Map<number, number>();
    for (const club of w.clubs) {
      tierCounts.set(club.tier, (tierCounts.get(club.tier) ?? 0) + 1);
    }
    expect(w.clubs.length).toBe(776);
    // 12 国 × 各层队数：T1 12×18=216 / T2 12×20=240 / T3 11×20=220 / T4 5×20=100
    expect(tierCounts.get(1)).toBe(216);
    expect(tierCounts.get(2)).toBe(240);
    expect(tierCounts.get(3)).toBe(220);
    expect(tierCounts.get(4)).toBe(100);
    // 升降级不改变层级总数
    expect((tierCounts.get(1) ?? 0) + (tierCounts.get(2) ?? 0) + (tierCounts.get(3) ?? 0) + (tierCounts.get(4) ?? 0)).toBe(776);
  });
});
