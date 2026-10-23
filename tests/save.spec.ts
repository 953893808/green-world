import { describe, expect, it } from 'vitest';
import { generateWorld } from '../src/game/world/generate';
import { createSeason } from '../src/game/world/schedule';
import { advanceWeek, recoverWeekly, simulateSeason } from '../src/game/rules/advance';
import { finishSeason, startNextSeason } from '../src/game/rules/qualify';
import { BALANCE } from '../src/game/balance';
import { encodeSave, skeletonOf } from '../src/game/save/encode';
import { decodeSave, loadSave } from '../src/game/save/decode';
import {
  MemoryStorage,
  SAVE_KEY,
  SaveController,
  saveSizeKB,
  serialize,
  withinBudget,
} from '../src/game/save/persist';
import { createCareer, careerAdvanceWeek, playCareerSeason, gradeOf } from '../src/game/play/career';
import {
  createManager,
  managerAdvanceWeek,
  rehireManager,
  rollManagerSeason,
  settleManagerSeason,
} from '../src/game/play/manager';
import type { CareerState, ManagerState, WorldState } from '../src/game/types';

const SEED = 20261019;

/** 打到第 N 周（含该周），用于构造「赛季进行中」的存档 */
function weekWorld(target: number): WorldState {
  let world = createSeason(generateWorld(SEED), 1);
  while (world.week < target) {
    world = advanceWeek(world);
    world = recoverWeekly(world);
  }
  return world;
}

function careerOf(world: WorldState): CareerState {
  return createCareer(world, {
    playerName: '测试球员',
    position: 'FW',
    nationality: 'ENG',
  }).state;
}

describe('存档：编码/解码', () => {
  it('同一 seed 重建的骨架赛程 id 与 createSeason 完全一致', () => {
    const world = weekWorld(9);
    const skeleton = skeletonOf(world);
    const direct = createSeason({ ...world, season: world.season - 1 }, world.season);
    expect(skeleton.fixtures.map((f) => f.id)).toEqual(direct.fixtures.map((f) => f.id));
    expect(skeleton.nationalFixtures.map((f) => f.id)).toEqual(
      direct.nationalFixtures.map((f) => f.id),
    );
  });

  it('赛季进行中存档往返：比分与体能状态一致', () => {
    const world = weekWorld(12);
    const state = careerOf(world);
    const save = encodeSave(world, state);
    const { world: restored, state: restoredState } = decodeSave(save);

    expect(restored.seed).toBe(world.seed);
    expect(restored.season).toBe(world.season);
    expect(restored.week).toBe(world.week);
    expect(restored.fixtures.length).toBe(world.fixtures.length);

    for (let i = 0; i < world.fixtures.length; i += 1) {
      const a = world.fixtures[i]!;
      const b = restored.fixtures.find((f) => f.id === a.id)!;
      expect(b, a.id).toBeDefined();
      expect(b.played).toBe(a.played);
      if (a.result) {
        expect(b.result?.homeGoals).toBe(a.result.homeGoals);
        expect(b.result?.awayGoals).toBe(a.result.awayGoals);
        expect(b.result?.penalty).toBe(a.result.penalty);
      }
    }

    for (let i = 0; i < world.clubs.length; i += 1) {
      const a = world.clubs[i]!;
      const b = restored.clubs[i]!;
      expect(Math.abs(b.stamina - a.stamina)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(b.form - a.form)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(b.morale - a.morale)).toBeLessThanOrEqual(0.5);
      expect(b.tier).toBe(a.tier);
      expect(b.competitionId).toBe(a.competitionId);
    }

    expect(restoredState.mode).toBe('career');
    expect((restoredState as CareerState).playerName).toBe('测试球员');
  });

  it('读档后积分榜可由赛果重算且与非联赛淘汰赛态一致', () => {
    const world = weekWorld(20);
    const save = encodeSave(world, careerOf(world));
    const { world: restored } = decodeSave(save);

    const before = world.standings['eng-l1'];
    const after = restored.standings['eng-l1'];
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after!.rows.map((r) => [r.clubId, r.played, r.points])).toEqual(
      before!.rows.map((r) => [r.clubId, r.played, r.points]),
    );
    expect(Object.keys(restored.knockouts).sort()).toEqual(Object.keys(world.knockouts).sort());
  });

  it('赛季结束后存档往返：升降级位移与上一季快照保留', () => {
    const played = simulateSeason(createSeason(generateWorld(SEED), 1));
    const finished = finishSeason(played);
    const next = startNextSeason(finished);
    const save = encodeSave(next, careerOf(next));
    const { world: restored } = decodeSave(save);

    expect(restored.season).toBe(2);
    expect(restored.lastSeasonChampions['eng-l1']).toBe(
      finished.lastSeasonChampions['eng-l1'],
    );
    expect(restored.qualifications.length).toBe(next.qualifications.length);

    // 升降级位移必须被还原（否则联赛归属会退回种子初值）
    const moved = next.clubs.filter((c, i) => c.competitionId !== generateWorld(SEED).clubs[i]!.competitionId);
    expect(moved.length).toBeGreaterThan(0);
    for (const club of moved) {
      const same = restored.clubs.find((c) => c.id === club.id);
      expect(same?.competitionId, club.id).toBe(club.competitionId);
      expect(same?.tier, club.id).toBe(club.tier);
    }
  });
});

describe('存档：体积与持久化', () => {
  it('整季打完后存档不超过设计预算 256 KB', () => {
    const played = simulateSeason(createSeason(generateWorld(SEED), 1));
    const state = careerOf(played);
    const save = encodeSave(played, state);
    const kb = saveSizeKB(save);
    expect(kb).toBeLessThanOrEqual(BALANCE.saveMaxKB);
    expect(withinBudget(save)).toBe(true);
    // 留一点余量给 P5/P6 的字段增长
    expect(kb).toBeLessThan(BALANCE.saveMaxKB * 0.75);
  });

  it('SaveController 防抖写入 + 同内容去重', async () => {
    const storage = new MemoryStorage();
    const controller = new SaveController({ storage, debounceMs: 5 });
    const world = weekWorld(3);
    const state = careerOf(world);

    controller.schedule(world, state);
    controller.schedule(world, state);
    expect(storage.getItem(SAVE_KEY)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const first = storage.getItem(SAVE_KEY);
    expect(first).not.toBeNull();

    controller.schedule(world, state);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(storage.getItem(SAVE_KEY)).toBe(first);
    expect(controller.has()).toBe(true);
  });

  it('写入的 JSON 能原样读回', () => {
    const world = weekWorld(6);
    const state = careerOf(world);
    const save = encodeSave(world, state);
    const parsed = JSON.parse(serialize(save)) as unknown;
    const loaded = loadSave(parsed);
    expect(loaded.ok).toBe(true);
    expect(loaded.world?.week).toBe(world.week);
  });

  it('坏存档不抛异常，并给出可诊断原因', () => {
    expect(loadSave(undefined).ok).toBe(false);
    expect(loadSave('not-a-save').ok).toBe(false);
    expect(loadSave({}).ok).toBe(false);
    expect(loadSave({ version: 999, seed: 1 }).ok).toBe(false);
    expect(loadSave({ version: BALANCE.saveVersion, seed: SEED }).ok).toBe(false);

    // 缺字段但版本对：归一化后仍能打开
    const world = weekWorld(2);
    const save = encodeSave(world, careerOf(world));
    const broken = JSON.parse(serialize(save)) as Record<string, unknown>;
    delete (broken.delta as Record<string, unknown>).clubResults;
    delete (broken.delta as Record<string, unknown>).knockouts;
    const loaded = loadSave(broken);
    expect(loaded.ok).toBe(true);
    expect(loaded.repaired.length).toBeGreaterThan(0);
    expect(loaded.world?.fixtures.length).toBeGreaterThan(0);
  });
});

describe('双模式：生涯', () => {
  it('创建生涯：16 岁、低能力、本国 T3/T4 起步', () => {
    const world = createSeason(generateWorld(SEED), 1);
    const { state } = createCareer(world, {
      playerName: '小李',
      position: 'FW',
      nationality: 'ENG',
    });
    expect(state.player.age).toBe(BALANCE.careerStartAge);
    expect(state.player.position).toBe('FW');
    expect(state.player.ability).toBeLessThan(70);
    const club = world.clubs.find((c) => c.id === state.clubId)!;
    expect(club.countryId).toBe('ENG');
    expect(club.tier).toBeGreaterThanOrEqual(3);
    expect(state.careerValue).toBe(0);
    expect(state.clubHistory).toContain(club.id);
  });

  it('逐周推进：出场会累计数据，赛季结束会结算并年龄增长', () => {
    let world = createSeason(generateWorld(SEED), 1);
    let { state } = createCareer(world, { position: 'FW', nationality: 'ENG' });
    let guard = 0;
    while (!state.retired && (state.seasonsDone ?? 0) < 1 && guard < 60) {
      const weekBefore = world.week;
      const result = careerAdvanceWeek(world, state);
      world = result.world;
      state = result.state;
      if (result.seasonEnded) {
        expect(world.week).toBe(weekBefore + 1);
        world = startNextSeason(finishSeason(world));
        expect(world.week).toBe(1);
      } else {
        expect(world.week).toBeGreaterThanOrEqual(weekBefore);
      }
      guard += 1;
    }
    expect(state.seasonsDone).toBe(1);
    expect(state.player.age).toBe(BALANCE.careerStartAge + 1);
    expect(state.player.apps).toBeGreaterThan(0);
    expect(state.player.ratingSum).toBeGreaterThan(0);
    expect(state.careerValue).toBeGreaterThan(0);
  });

  it('连跑 3 个赛季不崩（MVP 验收）', () => {
    let world = createSeason(generateWorld(SEED), 1);
    let { state } = createCareer(world, { position: 'MF', nationality: 'ENG' });
    for (let season = 0; season < 3; season += 1) {
      const played = playCareerSeason(world, state);
      world = played.world;
      state = played.state;
      expect(state.retired).toBe(false);
      // 赛季末结算 → 下一季
      world = startNextSeason(finishSeason(world));
      state = { ...state, season: world.season, week: world.week };
    }
    expect(state.seasonsDone).toBe(3);
    expect(state.player.age).toBe(BALANCE.careerStartAge + 3);
    expect(state.careerValue).toBeGreaterThan(0);
    expect(['S', 'A', 'B', 'C', 'D']).toContain(gradeOf(state.careerValue ?? 0));
  });
});

describe('双模式：经理', () => {
  it('创建经理：董事会满意度与球迷情绪取初值', () => {
    const world = createSeason(generateWorld(SEED), 1);
    const { state } = createManager(world, { managerName: '老李', tier: 2 });
    expect(state.boardConfidence).toBe(BALANCE.boardConfidenceStart);
    expect(state.fanMood).toBe(BALANCE.fanMoodStart);
    expect(state.fired).toBeUndefined();
    const club = world.clubs.find((c) => c.id === state.clubId)!;
    expect(club.tier).toBe(2);
  });

  it('赛季结算会调整满意度与情绪，并记录为什么', () => {
    const played = simulateSeason(createSeason(generateWorld(SEED), 1));
    const world = { ...played, seasonSummary: played.seasonSummary };
    const { state } = createManager(world, { tier: 1, confederationId: 'UEFA' });
    const { state: next, outcome } = settleManagerSeason(world, state);
    expect(next.seasonsDone).toBe(1);
    expect(outcome.reasons.length).toBeGreaterThan(0);
    expect(next.boardConfidence).toBeGreaterThanOrEqual(0);
    expect(next.boardConfidence).toBeLessThanOrEqual(100);
    expect(next.fanMood).toBeGreaterThanOrEqual(0);
    expect(next.fanMood).toBeLessThanOrEqual(100);
  });

  it('下课条件：满意度低于阈值且连续 2 季无洲际资格', () => {
    const played = simulateSeason(createSeason(generateWorld(SEED), 1));
    const { state: created } = createManager(played, { tier: 1, confederationId: 'UEFA' });
    // 已连续 1 季无洲际资格，且满意度已跌破阈值
    const seeded: ManagerState = {
      ...created,
      boardConfidence: BALANCE.fireBoardThreshold - 1,
      seasonsWithoutContinental: BALANCE.fireStreakSeasons - 1,
    };
    const { state: next, outcome } = settleManagerSeason(played, seeded);
    // 该队若无洲际资格则触发下课；有资格则重置连击
    if (outcome.continental) {
      expect(next.fired).toBeUndefined();
      expect(next.seasonsWithoutContinental).toBe(0);
    } else {
      expect(outcome.fired).toBe(true);
      expect(next.fired).toBe(true);
      expect(next.rehireTierFloor).toBe(2);
    }
  });

  it('下课后可以重新应聘低一档联赛', () => {
    const world = createSeason(generateWorld(SEED), 1);
    const { state } = createManager(world, { tier: 1, confederationId: 'UEFA' });
    const fired: ManagerState = { ...state, fired: true, rehireTierFloor: 2 };
    const rehired = rehireManager(world, fired);
    const club = world.clubs.find((c) => c.id === rehired.state.clubId)!;
    expect(rehired.state.fired).toBe(false);
    expect(club.tier).toBe(2);
    expect(rehired.state.boardConfidence).toBe(BALANCE.boardConfidenceStart);
  });

  it('连跑 3 个赛季不崩（MVP 验收）', () => {
    let world = createSeason(generateWorld(SEED), 1);
    let { state } = createManager(world, { tier: 2, confederationId: 'UEFA' });
    for (let season = 0; season < 3; season += 1) {
      let guard = 0;
      while (guard < 60) {
        const result = managerAdvanceWeek(world, state);
        world = result.world;
        state = result.state;
        guard += 1;
        if (result.seasonEnded) break;
      }
      expect(state.seasonsDone).toBe(season + 1);
      // P0-1 之后结算真的会扣董事会：成绩差就会下课，必须先再就业才能继续下一季。
      if (state.fired) {
        const rehired = rehireManager(world, state);
        world = rehired.world;
        state = rehired.state;
      }
      // 世界在赛季末已经 finish 并结算过，滚动用 rollManagerSeason（内部幂等守卫）。
      world = rollManagerSeason(world);
      state = { ...state, season: world.season, week: world.week };
    }
    expect(state.seasonsDone).toBe(3);
    expect(state.boardConfidence).toBeGreaterThanOrEqual(0);
  });
});
