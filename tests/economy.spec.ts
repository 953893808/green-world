/**
 * 经济口径回归测试（fix-play）。
 *
 * 已知设计债（不要误判为漏改）：Player.value 是「身价估算」（ability²×0.9，供生涯/展示），
 * 市场成交价走 transferValueOf（ability×单价×年龄系数）；两者暂不统一，改动会牵动
 * careerValue/合同/存档三处。另：career 层未把 contractYears 传给 marketValueOf。
 */
import { describe, expect, it } from 'vitest';
import {
  BALANCE,
  round2,
  seasonWagesOfWeekly,
  weeklyWageOfAbility,
  weeklyWageOfSeason,
} from '../src/game/balance';
import { generateWorld } from '../src/game/world/generate';
import { createSeason } from '../src/game/world/schedule';
import { financeOf } from '../src/game/play/finance';
import { applyGrowth, growthOf, marketValueOf } from '../src/game/play/growth';
import {
  acceptOffer,
  contractYearsOf,
  evaluateOffer,
  feeFor,
  offersForPlayerClub,
  runTransferWeek,
  transferValueOf,
  wageCapAllows,
} from '../src/game/play/transfer';
import { evaluateBid, marketFor, signBid } from '../src/game/play/negotiation';
import { chainPrompt, resolveChainStep } from '../src/game/play/chains';
import { createManager } from '../src/game/play/manager';
import type { BidTarget } from '../src/game/play/negotiation';
import type { Player, WorldState } from '../src/game/types';
import type { TransferOffer as TransferOfferT } from '../src/game/play/transfer';

const SEED = 20261019;

function freshWorld() {
  return createSeason(generateWorld(SEED), 1);
}

function makePlayer(over: Partial<Player> = {}): Player {
  return {
    id: 'p',
    name: 'x',
    clubId: 'c',
    position: 'MF',
    age: 24,
    ability: 70,
    potential: 90,
    stamina: 100,
    form: 50,
    injuryWeeks: 0,
    value: 1,
    apps: 0,
    goals: 0,
    assists: 0,
    ratingSum: 0,
    ...over,
  };
}

function makeOffer(over: Partial<TransferOfferT> = {}): TransferOfferT {
  return {
    id: 'offer',
    fromClubId: 'a',
    toClubId: 'b',
    playerId: 'p',
    playerName: 'x',
    position: 'MF',
    ability: 70,
    age: 24,
    fee: 100,
    wage: 0.7,
    contractYears: 4,
    stage: 'fee',
    reasons: [],
    loan: false,
    ...over,
  };
}

describe('P1-1 工资单位：一处换算，三处一致', () => {
  it('财报工资 = club.wages（赛季总额，不再乘 52 除 100）', () => {
    const world = freshWorld();
    for (const club of world.clubs) {
      expect(financeOf(world, club).wages).toBe(round2(club.wages));
    }
  });

  it('周薪 ↔ 赛季总额往返无损，且赛季总额 = 周薪 × 52', () => {
    for (const weekly of [0.05, 0.5, 0.91, 1.4, 3]) {
      expect(seasonWagesOfWeekly(weekly)).toBe(round2(weekly * BALANCE.weeksPerSeason));
      expect(weeklyWageOfSeason(seasonWagesOfWeekly(weekly))).toBe(round2(weekly));
    }
  });

  it('同一球员在挂牌/签约/财报三处读到同一份年薪', () => {
    const world = freshWorld();
    const me = world.clubs[0]!;
    const target: BidTarget = {
      id: 't1',
      name: 'T',
      position: 'MF',
      age: 24,
      ability: 80,
      value: transferValueOf(80, 24),
      clubId: world.clubs[1]!.id,
      clubName: 'Seller',
      askingPrice: transferValueOf(80, 24),
      wage: weeklyWageOfAbility(80),
    };
    const before = financeOf(world, me);
    const after = signBid(world, me.id, target, 100, target.wage);
    const meAfter = after.clubs.find((c) => c.id === me.id)!;
    const annual = seasonWagesOfWeekly(target.wage);
    // 签约写入的赛季工资 = 挂牌周薪 × 52
    expect(round2(meAfter.wages - me.wages)).toBe(annual);
    // 财报读到的工资增量与写入一致（同一口径）
    expect(round2(financeOf(after, meAfter).wages - before.wages)).toBe(annual);
    // 佣金真实扣除（8%）
    const agent = round2(100 * BALANCE.agentFeeRatio);
    expect(round2(meAfter.cash - me.cash)).toBe(-round2(100 + agent));
  });
});

describe('P1-2 转会费：单调公式，ability 30..99 全部可成交', () => {
  it('基准价随能力严格递增，且恒为正', () => {
    let prev = 0;
    for (let ability = 30; ability <= 99; ability++) {
      const value = transferValueOf(ability, 24);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeGreaterThan(prev);
      prev = value;
    }
  });

  it('feeFor 是正数，且与 transferValueOf 只差 0.9~1.2 的财力系数', () => {
    const world = freshWorld();
    for (const cash of [0, 100, 800, 5000]) {
      const buyer = { ...world.clubs[0]!, cash };
      const fee = feeFor(makePlayer({ ability: 60, age: 24 }), buyer);
      const base = transferValueOf(60, 24);
      expect(fee).toBeGreaterThan(0);
      expect(fee).toBeGreaterThanOrEqual(Math.round(base * 0.9));
      expect(fee).toBeLessThanOrEqual(Math.round(base * 1.2));
    }
  });

  it('每个能力档位的 AI 报价都能过 evaluateOffer（旧公式 ability<53 永远被拒）', () => {
    const world = freshWorld();
    const buyer = world.clubs[0]!;
    const rich = { ...buyer, cash: 5000 };
    for (let ability = 30; ability <= 99; ability++) {
      const fee = feeFor(makePlayer({ ability, age: 24 }), rich);
      const offer = makeOffer({ ability, age: 24, fee, toClubId: buyer.id, wage: weeklyWageOfAbility(ability) });
      const verdict = evaluateOffer(offer, { ...buyer, id: 'seller' }, rich);
      expect(verdict.ok).toBe(true);
    }
  });
});

describe('财报量级 sanity（每季全部俱乐部结算一次）', () => {
  it('T1 每队净收入落在 -500..+1500 万，工资占比不超过 75% 红线', () => {
    const world = freshWorld();
    const t1 = world.clubs.filter((c) => c.tier === 1);
    expect(t1.length).toBeGreaterThan(0);
    for (const club of t1) {
      const line = financeOf(world, club);
      expect(line.income).toBeGreaterThan(0);
      expect(line.net).toBeGreaterThan(-500);
      expect(line.net).toBeLessThan(1500);
      expect(line.wageRatio).toBeGreaterThan(0.1);
      expect(line.wageRatio).toBeLessThanOrEqual(BALANCE.wageRatioCap);
      expect(line.wageOverCap).toBe(false);
    }
  });

  it('全联盟工资占比中位数落在 0.3~wageRatioCap（工资与收入同量纲）', () => {
    const world = freshWorld();
    const ratios = world.clubs.map((c) => financeOf(world, c).wageRatio).sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)]!;
    expect(median).toBeGreaterThan(0.3);
    expect(median).toBeLessThan(BALANCE.wageRatioCap);
  });
});

describe('P2 成长：30 岁后转为衰退且不越界', () => {
  it('30 岁起 delta 为负，年龄越大掉得越多', () => {
    const at31 = growthOf({ player: makePlayer({ age: 31, ability: 60 }), apps: 30, expected: 38 });
    const at34 = growthOf({ player: makePlayer({ age: 34, ability: 60 }), apps: 30, expected: 38 });
    expect(at31.delta).toBeLessThan(0);
    expect(at34.delta).toBeLessThan(at31.delta);
  });

  it('衰退不会把能力压到 attrMin 以下', () => {
    const old = growthOf({ player: makePlayer({ age: 34, ability: 21 }), apps: 0, expected: 38 });
    const grown = applyGrowth(makePlayer({ age: 34, ability: 21 }), old, {});
    expect(grown.ability).toBeGreaterThanOrEqual(BALANCE.attrMin);
  });

  it('年轻球员仍然只涨不跌', () => {
    const young = growthOf({
      player: makePlayer({ age: 20, ability: 60 }),
      apps: 30,
      expected: 38,
      club: freshWorld().clubs[0],
    });
    expect(young.delta).toBeGreaterThan(0);
  });
});

describe('P2 合同：年限按年龄给，且长合同更值钱', () => {
  it('contractYearsOf 随年龄递减', () => {
    expect(contractYearsOf(20)).toBeGreaterThan(contractYearsOf(25));
    expect(contractYearsOf(25)).toBeGreaterThan(contractYearsOf(29));
    expect(contractYearsOf(33)).toBe(1);
  });

  it('身价随剩余合同年限上升（旧 contractCurve 方向反了）', () => {
    const player = makePlayer({ ability: 70 });
    const long = marketValueOf(player, { contractYears: 5 });
    const mid = marketValueOf(player, { contractYears: 3 });
    const short = marketValueOf(player, { contractYears: 1 });
    expect(long).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(short);
  });
});

describe('P2 报价：同一买家不重复，且必须付得起', () => {
  it('玩家俱乐部收到的报价：买家 id 唯一、现金足够', () => {
    const world = freshWorld();
    const me = world.clubs.reduce((a, b) => (a.reputation <= b.reputation ? a : b));
    const offers = offersForPlayerClub(world, me.id);
    expect(offers.length).toBeGreaterThan(0);
    expect(new Set(offers.map((o) => o.toClubId)).size).toBe(offers.length);
    for (const offer of offers) {
      const bidder = world.clubs.find((c) => c.id === offer.toClubId);
      expect(bidder).toBeDefined();
      expect(bidder!.cash).toBeGreaterThanOrEqual(offer.fee);
    }
  });

  it('买方现金不足时 acceptOffer 不改世界（返回原引用）', () => {
    const world = freshWorld();
    const poor = world.clubs[1]!;
    const offer = makeOffer({ toClubId: poor.id, fee: poor.cash + 1 });
    expect(acceptOffer(world, offer)).toBe(world);
  });
});

describe('P2 事件链：可绑定 chainId，且不会重复结算同一步', () => {
  it('传入不存在的 chainId 时不会结算到别的链上', () => {
    const world = freshWorld();
    const manager = createManager(world, { confederationId: 'UEFA', tier: 1 });
    expect(chainPrompt(manager.state, manager.world.week, 'bench-crisis')).toBeUndefined();
    const out = resolveChainStep(manager.world, manager.state, 0, 'bench-crisis');
    expect(out.world).toBe(manager.world);
    expect(out.state).toBe(manager.state);
  });
});

describe('P3 玩家市场：挂牌价与俱乐部财力同量纲', () => {
  it('marketFor 的挂牌价不超过参考身价 1.6 倍，且 T1 俱乐部买得起', () => {
    const world = freshWorld();
    const manager = createManager(world, { confederationId: 'UEFA', tier: 1 });
    const me = world.clubs.find((c) => c.id === manager.state.clubId)!;
    const targets = marketFor(manager.world, manager.state.clubId, 6);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.askingPrice).toBeGreaterThanOrEqual(target.value);
      expect(target.askingPrice).toBeLessThanOrEqual(Math.round(target.value * 1.6));
    }
    expect(targets.filter((t) => t.askingPrice <= me.cash).length).toBeGreaterThan(0);
  });

  it('按挂牌价 + 期望周薪开价，至少有一名目标可签下（工资帽按赛季口径）', () => {
    const world = freshWorld();
    const manager = createManager(world, { confederationId: 'UEFA', tier: 1 });
    const targets = marketFor(manager.world, manager.state.clubId, 6);
    const done = targets.filter((target) => {
      const agent = round2(target.askingPrice * BALANCE.agentFeeRatio);
      return evaluateBid(manager.world, manager.state.clubId, target, target.askingPrice, target.wage, agent).ok;
    });
    expect(done.length).toBeGreaterThan(0);
  });
});

describe('P2 AI 工资帽：只拦上穿红线，不冻结已超线买方', () => {
  it('接近红线的买方签不下把它推过线的人；已超线的买方不被冻住', () => {
    const world = freshWorld();
    const club = world.clubs.find((c) => c.tier === 1)!;
    const cap = financeOf(world, club).income * BALANCE.wageRatioCap;

    // 距红线 5 万、再签一个 0.91 万/周（≈47 万/赛季）就会上穿 → 拦住
    const near = { ...club, cash: 5000, wages: round2(cap - 5) };
    const nearWorld: WorldState = { ...world, clubs: world.clubs.map((c) => (c.id === club.id ? near : c)) };
    expect(wageCapAllows(nearWorld, club.id, 0.91)).toBe(false);

    // 已经超线：不冻结（仍可操作、靠卖人自救），否则 T3/T4 会变死水
    const over = { ...club, cash: 5000, wages: round2(cap + 10) };
    const overWorld: WorldState = { ...world, clubs: world.clubs.map((c) => (c.id === club.id ? over : c)) };
    expect(wageCapAllows(overWorld, club.id, 0.91)).toBe(true);
  });

  it('整个转会窗没有一笔成交把买方推过红线（除本来就超线的队）', () => {
    const world = freshWorld();
    const capOf = (w: WorldState, club: WorldState['clubs'][number]) =>
      financeOf(w, club).income * BALANCE.wageRatioCap;

    const result = runTransferWeek(world, {});
    expect(result.offers.length).toBeGreaterThan(0);
    for (const after of result.world.clubs) {
      const before = world.clubs.find((c) => c.id === after.id);
      if (!before) continue;
      if (financeOf(world, before).wages > capOf(world, before)) continue; // 超线队豁免
      expect(financeOf(result.world, after).wages).toBeLessThanOrEqual(capOf(result.world, after) + 0.01);
    }
  });
});
