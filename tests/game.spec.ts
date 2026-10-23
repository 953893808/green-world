import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/game/balance';
import {
  advanceGame,
  buildSave,
  canContinue,
  loadFrom,
  newGame,
  rehire,
  retire,
  rollSeason,
  roundTrip,
  saveInfo,
  saveJson,
} from '../src/game/game';
import type { CareerState, ManagerState } from '../src/game/types';

const SEED = 20261019;

describe('统一入口：开局', () => {
  it('生涯模式开局：世界与玩家状态就位', () => {
    const session = newGame({
      mode: 'career',
      seed: SEED,
      career: { playerName: '青训小将', position: 'MF', nationality: 'ESP' },
    });
    expect(session.state.mode).toBe('career');
    expect(session.world.season).toBe(1);
    expect(session.world.week).toBe(1);
    expect(session.world.fixtures.length).toBeGreaterThan(7000);
    const career = session.state as CareerState;
    expect(career.player.age).toBe(BALANCE.careerStartAge);
    const club = session.world.clubs.find((c) => c.id === career.clubId)!;
    expect(club.countryId).toBe('ESP');
  });

  it('经理模式开局：董事会与球迷情绪取初值', () => {
    const session = newGame({
      mode: 'manager',
      seed: SEED,
      manager: { managerName: '新帅', confederationId: 'UEFA', tier: 2 },
    });
    expect(session.state.mode).toBe('manager');
    const manager = session.state as ManagerState;
    expect(manager.boardConfidence).toBe(BALANCE.boardConfidenceStart);
    expect(manager.fanMood).toBe(BALANCE.fanMoodStart);
    expect(session.world.clubs.find((c) => c.id === manager.clubId)?.tier).toBe(2);
  });
});

describe('统一入口：推进与赛季滚动', () => {
  it('生涯推进一周：周次前进，玩家赛季数据随出场增长', () => {
    let session = newGame({
      mode: 'career',
      seed: SEED,
      career: { position: 'FW', nationality: 'ENG' },
    });
    let guard = 0;
    while (guard < 40) {
      const before = session.world.week;
      const result = advanceGame(session);
      session = { world: result.world, state: result.state };
      if (result.needsRollover) break;
      expect(session.world.week).toBeGreaterThanOrEqual(before);
      guard += 1;
    }
    const career = session.state as CareerState;
    expect(career.player.apps).toBeGreaterThan(0);
    expect(career.week).toBe(session.world.week);
  });

  it('赛季滚动后周次回到 1、赛季号 +1', () => {
    let session = newGame({
      mode: 'manager',
      seed: SEED,
      manager: { tier: 2, confederationId: 'UEFA' },
    });
    let guard = 0;
    while (guard < 80) {
      const result = advanceGame(session);
      session = { world: result.world, state: result.state };
      guard += 1;
      if (result.needsRollover) break;
    }
    const rolled = rollSeason(session);
    expect(rolled.world.season).toBe(2);
    expect(rolled.world.week).toBe(1);
    expect(rolled.state.season).toBe(2);
    expect(rolled.state.week).toBe(1);
    expect(canContinue(rolled.state)).toBe(true);
  });
});

describe('统一入口：存档', () => {
  it('存档体积在设计预算内，且往返等价', () => {
    const session = newGame({
      mode: 'career',
      seed: SEED,
      career: { position: 'DF', nationality: 'GER' },
    });
    const info = saveInfo(buildSave(session));
    expect(info.kb).toBeLessThanOrEqual(BALANCE.saveMaxKB);
    expect(info.withinBudget).toBe(true);

    const back = roundTrip(session);
    expect(back.world.seed).toBe(session.world.seed);
    expect(back.world.season).toBe(session.world.season);
    expect(back.world.week).toBe(session.world.week);
    expect(back.world.fixtures.length).toBe(session.world.fixtures.length);
    expect(back.state.mode).toBe('career');
  });

  it('JSON 字符串存档可以读回', () => {
    const session = newGame({
      mode: 'manager',
      seed: SEED,
      manager: { tier: 1, confederationId: 'UEFA' },
    });
    const json = saveJson(session);
    const loaded = loadFrom(JSON.parse(json) as unknown);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.session.world.season).toBe(session.world.season);
    expect(loaded.session.state.mode).toBe('manager');
    expect(loaded.session.repaired.length).toBe(0);
  });

  it('坏存档读不出来但有明确原因', () => {
    const loaded = loadFrom({ version: 42, seed: 1 });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason.length).toBeGreaterThan(0);
  });
});

describe('统一入口：退役与再就业', () => {
  it('生涯可主动退役，退役后不可继续', () => {
    const session = newGame({
      mode: 'career',
      seed: SEED,
      career: { position: 'GK', nationality: 'ITA' },
    });
    const retired = retire(session);
    expect((retired.state as CareerState).retired).toBe(true);
    expect(canContinue(retired.state)).toBe(false);
  });

  it('经理下课后可再就业，重新拿回满意度初值', () => {
    const session = newGame({
      mode: 'manager',
      seed: SEED,
      manager: { tier: 1, confederationId: 'UEFA' },
    });
    const firedState: ManagerState = {
      ...(session.state as ManagerState),
      fired: true,
      rehireTierFloor: 2,
      boardConfidence: 5,
    };
    const rehired = rehire({ world: session.world, state: firedState });
    const manager = rehired.state as ManagerState;
    expect(manager.fired).toBe(false);
    expect(manager.boardConfidence).toBe(BALANCE.boardConfidenceStart);
    expect(session.world.clubs.find((c) => c.id === manager.clubId)?.tier).toBe(2);
  });
});
