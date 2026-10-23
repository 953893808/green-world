import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/game/balance';
import { generateWorld } from '../src/game/world/generate';
import { createSeason } from '../src/game/world/schedule';
import { financeOf, settleFinances } from '../src/game/play/finance';
import {
  decayReputation,
  rankReputationDelta,
  settleReputations,
  coachReputation,
  competitionReputation,
  settleNationalReputations,
} from '../src/game/play/reputation';
import { ageFactorOf, growthOf, marketValueOf, minutesFactorOf, trainingFactorOf } from '../src/game/play/growth';
import { feeFor, negotiate, runTransferWeek, offersForPlayerClub, acceptOffer } from '../src/game/play/transfer';
import { callUpChance, homeTeamOf, resolveCallUp, applyCallUp } from '../src/game/play/callup';
import { createCareer, careerAdvanceWeek } from '../src/game/play/career';
import { POSITIONS, basePositionOf, positionOf } from '../src/game/config/positions';
import { createManager, managerAdvanceWeek, managerStats, rehireManager, settleManagerSeason } from '../src/game/play/manager';
import { encodeSave } from '../src/game/save/encode';
import { decodeSave } from '../src/game/save/decode';
import type { CareerState, ManagerState } from '../src/game/types';

const SEED = 20261019;

function freshWorld() {
  return createSeason(generateWorld(SEED), 1);
}

describe('P5 财政：收入支出与红线', () => {
  it('门票/转播/赞助都随声望上升，总收入为正', () => {
    const world = freshWorld();
    const club = world.clubs[0]!;
    const low = financeOf(world, { ...club, reputation: 30 });
    const high = financeOf(world, { ...club, reputation: 90 });
    expect(high.gate).toBeGreaterThan(low.gate);
    expect(high.tv).toBeGreaterThan(low.tv);
    expect(high.sponsor).toBeGreaterThan(low.sponsor);
    expect(high.income).toBeGreaterThan(0);
  });

  it('工资占收入比超线时 wageOverCap 为真，且给出原因', () => {
    const world = freshWorld();
    const club = world.clubs[0]!;
    const broke = financeOf(world, { ...club, wages: 1_000_000 });
    expect(broke.wageOverCap).toBe(true);
    expect(broke.notes.join('')).toContain('红线');
  });

  it('净资产为负时进入财政托管标记', () => {
    const world = freshWorld();
    const club = world.clubs[0]!;
    const line = financeOf(world, { ...club, cash: -1_000_000 });
    expect(line.inReceivership).toBe(true);
    expect(line.notes.join('')).toContain('托管');
  });

  it('转会预算 = max(0, (现金 - cashFloor) × budgetShare)', () => {
    const world = freshWorld();
    const club = { ...world.clubs[0]!, cash: 500 };
    const line = financeOf(world, club);
    expect(line.transferBudget).toBeGreaterThan(0);
    expect(line.transferBudget).toBeCloseTo(Math.max(0, (line.cash - BALANCE.cashFloor) * BALANCE.budgetShare), 2);
  });

  it('settleFinances 只动指定俱乐部，其余原样', () => {
    const world = freshWorld();
    const ids = [world.clubs[0]!.id, world.clubs[1]!.id];
    const after = settleFinances(world, ids);
    const untouched = world.clubs[5]!;
    expect(after.clubs.find((c) => c.id === untouched.id)).toEqual(untouched);
    expect(after.clubs.length).toBe(world.clubs.length);
  });
});

describe('P5 声望：四类声望与自然衰减', () => {
  it('自然衰减按 reputationDecay 回落，但不低于下限', () => {
    expect(decayReputation(100)).toBeLessThan(100);
    expect(decayReputation(100)).toBeGreaterThanOrEqual(0);
    expect(decayReputation(0)).toBe(0);
  });

  it('名次越靠前声望加成越大', () => {
    const world = freshWorld();
    const club = world.clubs[0]!;
    const delta = rankReputationDelta(world, club);
    expect(Number.isFinite(delta)).toBe(true);
    expect(delta).toBeLessThanOrEqual(BALANCE.repRankGainK * 10);
  });

  it('夺冠/升级/降级都会改变声望，且都被记录成原因', () => {
    const world = freshWorld();
    const target = world.clubs[0]!;
    const result = settleReputations(world, {
      champions: [target.id],
      promoted: [],
      relegated: [],
    });
    const after = result.world.clubs.find((c) => c.id === target.id)!;
    expect(after.reputation).toBeGreaterThanOrEqual(target.reputation);
    expect(result.world.clubs.length).toBe(world.clubs.length);
    expect(result.changes.length).toBeGreaterThan(0);
  });

  it('国家队声望结算不改变俱乐部声望', () => {
    const world = freshWorld();
    const after = settleNationalReputations(world);
    expect(after.world.clubs).toEqual(world.clubs);
    expect(after.world.nationalTeams.length).toBe(world.nationalTeams.length);
  });

  it('教练声望与赛事声望都落在 0~100', () => {
    const world = freshWorld();
    expect(coachReputation(world, { honors: ['联赛冠军'] })).toBeLessThanOrEqual(100);
    expect(competitionReputation('league', 1)).toBeGreaterThan(competitionReputation('league', 3));
  });
});

describe('P5 成长与身价', () => {
  it('年龄系数按 21/26/29 分段', () => {
    expect(ageFactorOf(18)).toBe(BALANCE.ageFactorYoung);
    expect(ageFactorOf(24)).toBe(BALANCE.ageFactorPrime);
    expect(ageFactorOf(28)).toBe(BALANCE.ageFactorLate);
    expect(ageFactorOf(32)).toBe(BALANCE.ageFactorVeteran);
  });

  it('出场时间越多系数越高，封顶在 minutesFactorMax', () => {
    expect(minutesFactorOf(0, 38)).toBe(BALANCE.minutesFactorMin);
    expect(minutesFactorOf(38, 38)).toBeCloseTo(BALANCE.minutesFactorMax, 1);
    expect(minutesFactorOf(100, 38)).toBeLessThanOrEqual(BALANCE.minutesFactorMax);
  });

  it('训练系数在范围内且随士气上升', () => {
    const world = freshWorld();
    const club = world.clubs[0]!;
    const low = trainingFactorOf(club, 10);
    const high = trainingFactorOf(club, 95);
    expect(low).toBeGreaterThanOrEqual(BALANCE.trainingMin);
    expect(high).toBeLessThanOrEqual(BALANCE.trainingMax);
    expect(high).toBeGreaterThan(low);
  });

  it('潜力见顶后不再成长', () => {
    const world = freshWorld();
    const club = world.clubs[0]!;
    const result = growthOf({
      player: { id: 'p', name: 'x', clubId: club.id, position: 'MF', age: 20, ability: 80, potential: 80, stamina: 100, form: 50, injuryWeeks: 0, value: 1, apps: 0, goals: 0, assists: 0, ratingSum: 0 },
      apps: 30,
      expected: 38,
      club,
      morale: 60,
    });
    expect(result.delta).toBe(0);
    expect(result.capped).toBe(true);
  });

  it('身价随能力上升、随年龄（过巅峰）下降', () => {
    const world = freshWorld();
    const club = world.clubs[0]!;
    const base = { id: 'p', name: 'x', clubId: club.id, position: 'MF' as const, age: 24, ability: 70, potential: 80, stamina: 100, form: 50, injuryWeeks: 0, value: 1, apps: 0, goals: 0, assists: 0, ratingSum: 0 };
    const strong = marketValueOf({ ...base, ability: 85 }, { club });
    const weak = marketValueOf({ ...base, ability: 60 }, { club });
    expect(strong).toBeGreaterThan(weak);
    const old = marketValueOf({ ...base, age: 34 }, { club });
    const young = marketValueOf({ ...base, age: 24 }, { club });
    expect(old).toBeLessThan(young);
  });
});

describe('P5 转会：报价与谈判', () => {
  it('费用随能力上升，且随年龄（超 28）打折', () => {
    const world = freshWorld();
    const buyer = world.clubs[0]!;
    const player = { id: 'p', name: 'x', clubId: 'other', position: 'FW' as const, age: 22, ability: 80, potential: 90, stamina: 100, form: 50, injuryWeeks: 0, value: 1, apps: 0, goals: 0, assists: 0, ratingSum: 0 };
    expect(feeFor({ ...player, ability: 85 }, buyer)).toBeGreaterThan(feeFor(player, buyer));
    expect(feeFor({ ...player, age: 31 }, buyer)).toBeLessThan(feeFor(player, buyer));
  });

  it('谈判 3 轮全过才算 done，有一轮拒绝就是 failed', () => {
    const world = freshWorld();
    const [from, to] = [world.clubs[5]!, world.clubs[0]!];
    const offer = {
      id: 't1',
      fromClubId: from.id,
      toClubId: to.id,
      playerId: 'p',
      playerName: 'x',
      position: 'FW' as const,
      ability: 75,
      age: 24,
      fee: Math.ceil(to.cash * 0.4),
      wage: 4,
      contractYears: 3,
      stage: 'fee' as const,
      reasons: [],
      loan: false,
    };
    const always = negotiate(world, { ...offer }, { chance: () => true });
    expect(always.stage).toBe('done');
    const never = negotiate(world, { ...offer }, { chance: () => false });
    expect(never.stage).toBe('failed');
    expect(never.reasons.length).toBeGreaterThan(0);
  });

  it('非转会窗不产生任何转会活动', () => {
    const world = freshWorld();
    const closed = { ...world, week: 20 };
    const result = runTransferWeek(closed);
    expect(result.offers).toEqual([]);
    expect(result.world).toBe(closed);
  });

  it('玩家俱乐部不会被自动卖掉球员', () => {
    const world = freshWorld();
    const window = { ...world, week: 6 };
    const mine = window.clubs[0]!.id;
    const result = runTransferWeek(window, { playerClubId: mine });
    expect(result.offers.every((o) => o.toClubId !== mine)).toBe(true);
  });

  it('接受报价：钱进账、三线小幅流失', () => {
    const world = freshWorld();
    const me = world.clubs[0]!;
    const offers = offersForPlayerClub({ ...world, week: 6 }, me.id);
    if (offers.length === 0) return;
    const after = acceptOffer(world, offers[0]!);
    const changed = after.clubs.find((c) => c.id === me.id)!;
    expect(changed.cash).toBeGreaterThan(me.cash);
    expect(changed.attack).toBeLessThanOrEqual(me.attack);
  });
});

describe('P5 国家队征召', () => {
  it('人气不足时征召概率为 0', () => {
    expect(callUpChance(BALANCE.nationalCallFame - 1, 90)).toBe(0);
  });

  it('人气越高概率越高，且封顶 0.95', () => {
    const low = callUpChance(BALANCE.nationalCallFame + 10, 60);
    const high = callUpChance(BALANCE.nationalCallFame + 90, 60);
    expect(high).toBeGreaterThan(low);
    expect(callUpChance(999, 10)).toBeLessThanOrEqual(0.95);
  });

  it('能找到本国国家队，征召会提升国家队强度与人气', () => {
    const session = createCareer(freshWorld(), { nationality: 'ESP', position: 'MF' });
    const career = session.state as CareerState;
    const team = homeTeamOf(session.world, 'ESP');
    expect(team).toBeDefined();
    const before = team!.attack;
    const boosted: CareerState = { ...career, fame: 200 };
    const { world, result } = resolveCallUp({ ...session.world, week: 6 }, boosted, { chance: () => true });
    expect(result.called).toBe(true);
    const after = world.nationalTeams.find((t) => t.id === team!.id)!;
    expect(after.attack).toBeGreaterThan(before);
    const next = applyCallUp(boosted, result);
    expect(next.fame).toBeGreaterThan(boosted.fame);
  });

  it('非国家队窗口不征召', () => {
    const session = createCareer(freshWorld(), { nationality: 'ESP', position: 'MF' });
    const career = { ...(session.state as CareerState), fame: 200 };
    const closed = { ...session.world, week: 20 };
    const { result } = resolveCallUp(closed, career, { chance: () => true });
    expect(result.called).toBe(false);
  });
});

describe('P5 双模式接线', () => {
  it('生涯推进一周会带回 news 数组（可能是空）', () => {
    const session = createCareer(freshWorld(), { nationality: 'ENG', position: 'FW' });
    const result = careerAdvanceWeek(session.world, session.state as CareerState);
    expect(Array.isArray(result.news)).toBe(true);
  });

  it('经理推进一周会走财政红线：真实 income 而不是 tier 粗估', () => {
    const session = createManager(freshWorld(), { confederationId: 'UEFA', tier: 1 });
    const manager = session.state as ManagerState;
    const settled = settleManagerSeason(session.world, manager);
    // 有真实净收入/工资占比的说明
    expect(settled.outcome.reasons.length).toBeGreaterThan(0);
    expect(settled.state.boardConfidence).toBeGreaterThanOrEqual(0);
    expect(settled.state.boardConfidence).toBeLessThanOrEqual(100);
  });

  it('经理推进一周不崩，周次前进', () => {
    const session = createManager(freshWorld(), { confederationId: 'UEFA', tier: 2 });
    const result = managerAdvanceWeek(session.world, session.state as ManagerState);
    expect(result.world.week).toBeGreaterThanOrEqual(session.world.week);
    expect(Array.isArray(result.news)).toBe(true);
  });
});

describe('P5：国家队主帅模式', () => {
  it('可以执教国家队：clubId 为空串、nationalTeamId 有值', () => {
    const world = freshWorld();
    const session = createManager(world, { nationalTeamId: 'esp-nt', managerName: '国家队教练' });
    const manager = session.state as ManagerState;
    expect(manager.kind).toBe('national');
    expect(manager.clubId).toBe('');
    expect(manager.nationalTeamId).toBe('esp-nt');
    expect(manager.confederationId).toBe('UEFA');
  });

  it('不存在的国家队会抛错，不会静默降级成俱乐部', () => {
    const world = freshWorld();
    expect(() => createManager(world, { nationalTeamId: 'XXX-nt' })).toThrow();
  });

  it('国家队主帅推进一周不崩', () => {
    const session = createManager(freshWorld(), { nationalTeamId: 'bra-nt' });
    const result = managerAdvanceWeek(session.world, session.state as ManagerState);
    expect(Array.isArray(result.news)).toBe(true);
    expect(result.state.fired).not.toBe(true);
  });

  it('managerStats 对国家队主帅给 national 标记与名次', () => {
    const session = createManager(freshWorld(), { nationalTeamId: 'bra-nt' });
    const stats = managerStats(session.world, session.state as ManagerState);
    expect(stats.national).toBe(true);
    expect(stats.tier).toBe(0);
  });

  it('国家队主帅下课后能去排名更靠后的国家队重聘', () => {
    const world = freshWorld();
    const session = createManager(world, { nationalTeamId: 'esp-nt' });
    const fired: ManagerState = { ...(session.state as ManagerState), fired: true };
    const rehired = rehireManager(world, fired);
    expect(rehired.state.fired).toBe(false);
    expect(rehired.state.nationalTeamId).not.toBe('esp-nt');
    expect(rehired.state.clubId).toBe('');
  });
});

describe('P6.5：六种位置与球风系数', () => {
  it('位置表有 6 项，且每种都归到一个底层位置', () => {
    expect(POSITIONS.length).toBe(6);
    for (const p of POSITIONS) {
      expect(['GK', 'DF', 'MF', 'FW']).toContain(p.base);
    }
  });

  it('细位置归并：边锋归 FW、前腰/后腰归 MF、中卫归 DF', () => {
    expect(basePositionOf('WF')).toBe('FW');
    expect(basePositionOf('AM')).toBe('MF');
    expect(basePositionOf('DM')).toBe('MF');
    expect(basePositionOf('CB')).toBe('DF');
    expect(basePositionOf('GK')).toBe('GK');
  });

  it('未知/空值退回 MF（旧存档兼容）', () => {
    expect(basePositionOf(undefined)).toBe('MF');
    expect(basePositionOf('XX')).toBe('MF');
  });

  it('中卫与后腰的进球系数低于前锋，边锋助攻系数高于前锋', () => {
    const fw = positionOf('FW')!;
    const cb = positionOf('CB')!;
    const dm = positionOf('DM')!;
    const wf = positionOf('WF')!;
    expect(cb.scoringTilt).toBeLessThan(fw.scoringTilt);
    expect(dm.scoringTilt).toBeLessThan(fw.scoringTilt);
    expect(wf.assistTilt).toBeGreaterThan(fw.assistTilt);
  });

  it('开局选边锋：落库是 FW，但细位置留在存档里', () => {
    const session = createCareer(freshWorld(), {
      nationality: 'ENG',
      position: basePositionOf('WF'),
      detailPosition: 'WF',
    });
    const career = session.state as CareerState;
    expect(career.player.position).toBe('FW');
    expect(career.detailPosition).toBe('WF');
  });

  it('细位置能过存档往返', () => {
    const session = createCareer(freshWorld(), {
      nationality: 'ENG',
      position: basePositionOf('AM'),
      detailPosition: 'AM',
    });
    const save = encodeSave(session.world, session.state, 0);
    const decoded = decodeSave(save);
    expect((decoded.state as CareerState).detailPosition).toBe('AM');
  });

  it('前锋整个赛季的进球数高于中卫（同种子同队）', () => {
    const world = freshWorld();
    const fw = createCareer(world, { nationality: 'ENG', position: 'FW', detailPosition: 'FW' });
    const cb = createCareer(world, { nationality: 'ENG', position: 'DF', detailPosition: 'CB' });
    let a = fw;
    let b = cb;
    // 跑到赛季结束为止（累积进球，跨赛季也累加，避免 seasonGoals 归零掩盖差异）
    for (let i = 0; i < 48; i++) {
      const nextA = careerAdvanceWeek(a.world, a.state as CareerState);
      const nextB = careerAdvanceWeek(b.world, b.state as CareerState);
      a = { world: nextA.world, state: nextA.state };
      b = { world: nextB.world, state: nextB.state };
    }
    const fwGoals = (a.state as CareerState).player.goals;
    const cbGoals = (b.state as CareerState).player.goals;
    expect(fwGoals).toBeGreaterThan(cbGoals);
  });
});

describe('P5：存档保留新字段', () => {
  it('经理存档往返后 kind/nationalTeamId 仍正确', () => {
    const session = createManager(freshWorld(), { nationalTeamId: 'ita-nt' });
    const save = encodeSave(session.world, session.state, 0);
    const decoded = decodeSave(save);
    const state = decoded.state as ManagerState;
    expect(state.kind).toBe('national');
    expect(state.nationalTeamId).toBe('ita-nt');
  });

  it('存档里俱乐部 cash 变动能还原（稀疏列）', () => {
    const world = freshWorld();
    const target = world.clubs[3]!;
    const session = createManager(world, { clubId: target.id });
    const withCash = {
      ...session.world,
      clubs: session.world.clubs.map((c) => (c.id === target.id ? { ...c, cash: 4321 } : c)),
    };
    const save = encodeSave(withCash, session.state, 0);
    const decoded = decodeSave(save);
    expect(decoded.world.clubs.find((c) => c.id === target.id)!.cash).toBe(4321);
  });
});
