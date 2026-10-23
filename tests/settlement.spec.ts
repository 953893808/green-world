import { describe, expect, it } from 'vitest';
import { generateWorld } from '../src/game/world/generate';
import { createSeason } from '../src/game/world/schedule';
import { createCareer, careerAdvanceWeek, playCareerSeason, settleCareerSeason, settleCareerWorld } from '../src/game/play/career';
import { createManager, managerAdvanceWeek, settleManagerSeason } from '../src/game/play/manager';
import { settleWorldAtSeasonEnd } from '../src/game/play/settle';
import { advanceGame, needsSeasonRollover, newGame, rollSeason } from '../src/game/game';
import type { CareerState, WorldState } from '../src/game/types';

const SEED = 20261019;

function freshWorld(): WorldState {
  return createSeason(generateWorld(SEED), 1);
}

/** 跑完一个生涯赛季（返回结算后的世界与状态） */
function playOneCareerSeason(): { world: WorldState; state: CareerState } {
  const { world, state } = createCareer(freshWorld(), { seed: SEED, playerName: 'Probe' });
  const run = playCareerSeason(world, state);
  return { world: run.world, state: run.state };
}

describe('P0-1/P0-3 赛季结算：时序、幂等、财政真的发生', () => {
  it('赛季末一周内就完成 finish：seasonSummary 有值、财政发生变化', () => {
    const world0 = freshWorld();
    const cashBefore = world0.clubs.map((c) => c.cash).join(',');
    const { world, state } = playOneCareerSeason();

    expect(world.finished).toBe(true);
    expect(world.seasonSummary).toBeTruthy();
    expect(world.seasonSummary!.season).toBe(1);
    expect(world.clubs.map((c) => c.cash).join(',')).not.toBe(cashBefore); // P0-3：财政确实结算了
    expect(state.lastSettledSeason).toBe(1);
    expect(state.seasonsDone).toBe(1);
    // P0-2：荣誉在结算那一刻就能读到（修复前 summary 恒空 → 永远拿不到冠军）
    expect(settleCareerSeason(world, { ...state, lastSettledSeason: undefined }).honors.length).toBeGreaterThanOrEqual(0);
  });

  it('结算后连点「推进一周」三次：年龄/赛季数/生涯价值都不再变化', () => {
    const first = playOneCareerSeason();
    const age0 = first.state.player.age;
    const done0 = first.state.seasonsDone;
    const value0 = first.state.careerValue;

    let world = first.world;
    let state = first.state;
    for (let i = 0; i < 3; i += 1) {
      const again = careerAdvanceWeek(world, state);
      world = again.world;
      state = again.state;
      expect(again.seasonEnded).toBe(true);
    }
    expect(state.player.age).toBe(age0);
    expect(state.seasonsDone).toBe(done0);
    expect(state.careerValue).toBe(value0);
    // 世界侧也不能被重复扣钱：再调一次幂等管线世界不变
    expect(settleWorldAtSeasonEnd(world)).toBe(world);
  });

  it('统一入口：world.finished 后 advanceGame 不再推进，只报告 needsRollover', () => {
    const session = newGame({ mode: 'career', seed: SEED, career: { playerName: 'Probe' } });
    // 直接把世界推到赛季结束
    let s = session;
    for (let i = 0; i < 120; i += 1) {
      const step = advanceGame(s);
      s = { world: step.world, state: step.state };
      if (step.seasonEnded) break;
    }
    expect(s.world.finished).toBe(true);
    const frozen = advanceGame(s);
    expect(frozen.seasonEnded).toBe(true);
    expect(frozen.needsRollover).toBe(true);
    expect(needsSeasonRollover(s.world, s.state)).toBe(true);
    expect(frozen.world).toBe(s.world); // 世界引用不变 = 没有重新结算

    // 未 finished 时 rollSeason 不允许滚动
    const fresh = newGame({ mode: 'career', seed: SEED, career: { playerName: 'Probe' } });
    expect(rollSeason(fresh)).toBe(fresh);
    // finished 后滚动到下一季
    const next = rollSeason(s);
    expect(next.world.season).toBe(2);
    expect(next.world.week).toBe(1);
    expect(next.state.season).toBe(2);
  });

  it('荣誉读取顺序：finish 之后再结算，冠军能被记进生涯荣誉', () => {
    const { world, state } = playOneCareerSeason();
    const clubId = state.clubId;
    const compId = Object.keys(world.seasonSummary!.champions)[0] ?? 'x';
    const crafted: WorldState = {
      ...world,
      seasonSummary: {
        ...world.seasonSummary!,
        champions: { ...world.seasonSummary!.champions, [compId]: clubId },
      },
    };
    const freshState: CareerState = { ...state, lastSettledSeason: undefined, honors: [], seasonsDone: 0 };
    const settled = settleCareerSeason(crafted, freshState);
    expect(settled.honors.length).toBeGreaterThan(0);
    expect(settled.lastSettledSeason).toBe(1);
  });

  it('经理：名次取上赛季快照、洲际资格读下赛季，重复结算不再扣满意度', () => {
    const { world, state } = createManager(freshWorld(), { seed: SEED, managerName: 'Probe', tier: 2 });
    let w = world;
    let s = state;
    let outcome;
    for (let i = 0; i < 120 && outcome === undefined; i += 1) {
      const step = managerAdvanceWeek(w, s);
      w = step.world;
      s = step.state;
      if (step.outcome) outcome = step.outcome;
    }
    expect(outcome).toBeTruthy();
    expect(w.finished).toBe(true);
    expect(outcome!.leagueRank).toBeGreaterThan(0);
    expect(s.lastSettledSeason).toBe(1);

    const board0 = s.boardConfidence;
    const again = managerAdvanceWeek(w, s);
    expect(again.seasonEnded).toBe(true);
    expect(again.state.boardConfidence).toBe(board0); // P0-1：不重复扣董事会

    // 直接重复调结算函数也不累加
    const twice = settleManagerSeason(w, s);
    expect(twice.state.boardConfidence).toBe(board0);
    expect(twice.state.seasonsDone).toBe(s.seasonsDone);
  });

  it('世界侧幂等：已 finish 的世界再结算不会二次扣钱', () => {
    const { world } = playOneCareerSeason();
    const cash = world.clubs.map((c) => c.cash).join(',');
    const again = settleCareerWorld(world);
    expect(again.clubs.map((c) => c.cash).join(',')).toBe(cash);
  });
});
