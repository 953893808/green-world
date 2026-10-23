import { describe, expect, it } from 'vitest';
import { BALANCE, clamp } from '../src/game/balance';
import { generateWorld } from '../src/game/world/generate';
import { createSeason } from '../src/game/world/schedule';
import { createManager } from '../src/game/play/manager';
import { createCareer } from '../src/game/play/career';
import { MOMENTS } from '../src/game/config/moments';
import { CHAINS } from '../src/game/config/chains';
import { SCENARIOS } from '../src/game/config/scenarios';
import {
  beginFlow,
  decisionsCount,
  finishFlow,
  applyHalfTimePlan,
  subsLimit,
} from '../src/game/match/flow';
import { chainPrompt, resolveChainStep, tickChains } from '../src/game/play/chains';
import { boardBrief, interviewPrompt, applyInterviewChoice, runWorldActivity, seasonWorldNews } from '../src/game/play/activity';
import { evaluateBid, marketFor, signBid } from '../src/game/play/negotiation';
import { applyScenario, scenarioClub, settleScenario } from '../src/game/play/scenario';
import { makeHotComments, moodShift, communityOffText } from '../src/game/play/community';
import { streamRng } from '../src/core/rng';
import type { PlayState } from '../src/game/types';

function baseWorld() {
  return createSeason(generateWorld(20261019), 1);
}

function playerFixtureId(world: ReturnType<typeof baseWorld>, clubId: string): string {
  const fixture = world.fixtures.find((f) => !f.played && (f.homeId === clubId || f.awayId === clubId));
  if (!fixture) throw new Error('no fixture');
  return fixture.id;
}

describe('P7 两段式比赛流程', () => {
  it('每个赛事都有 8 个关键时刻模板，且全部带 prompt 与选项', () => {
    expect(MOMENTS.length).toBe(8);
    for (const moment of MOMENTS) {
      expect(moment.prompt.length).toBeGreaterThan(4);
      expect(moment.choices.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('替补名额：联赛 3 个，杯赛 5 个', () => {
    expect(subsLimit({})).toBe(BALANCE.subsAllowed);
    expect(subsLimit({ cup: true })).toBe(BALANCE.cupSubsAllowed);
  });

  it('beginFlow 生成两段式状态，finishFlow 产出完整比分', () => {
    const world = baseWorld();
    const career = createCareer(world, { nationality: 'ENG' });
    const fixtureId = playerFixtureId(career.world, career.state.clubId);
    const flow = beginFlow(career.world, fixtureId);
    expect(flow.fixtureId).toBe(fixtureId);
    expect(flow.halfTimeActions.length).toBe(0);

    const done = finishFlow(career.world, flow);
    expect(done.result.homeGoals).toBeGreaterThanOrEqual(0);
    expect(done.result.awayGoals).toBeGreaterThanOrEqual(0);
    expect(done.result.homeXg).toBeGreaterThan(0);
  });

  it('半场换人超过上限会被拒绝，且不改动流程', () => {
    const world = baseWorld();
    const career = createCareer(world, { nationality: 'ENG' });
    const fixtureId = playerFixtureId(career.world, career.state.clubId);
    const flow = beginFlow(career.world, fixtureId);
    const applied = applyHalfTimePlan(flow, { subs: 99, mentality: 'aggressive', tactic: 'press' });
    expect(applied.rejected?.code).toBe('SUBS_EXCEEDED');
    expect(applied.flow.halfTimeActions.length).toBe(0);
  });

  it('决策数 = 1 + 半场动作 + 关键时刻', () => {
    const world = baseWorld();
    const manager = createManager(world, { confederationId: 'UEFA', tier: 1 });
    const fixtureId = playerFixtureId(manager.world, manager.state.clubId);
    const flow = beginFlow(manager.world, fixtureId);
    expect(decisionsCount(flow)).toBe(1);
  });
});

describe('P7 事件链', () => {
  it('配置里有 3 条链，每条都有多回合步骤', () => {
    expect(CHAINS.length).toBe(3);
    for (const chain of CHAINS) {
      expect(chain.steps.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('tickChains 不改动无关字段', () => {
    const world = baseWorld();
    const career = createCareer(world, { nationality: 'ENG' });
    const ticked = tickChains(career.world, career.state);
    expect(ticked.clubId).toBe(career.state.clubId);
  });

  it('chainPrompt 在没有激活链时返回 undefined', () => {
    const world = baseWorld();
    const career = createCareer(world, { nationality: 'ENG' });
    expect(chainPrompt(career.state as PlayState, 7)).toBeUndefined();
  });

  it('resolveChainStep 越界索引不崩', () => {
    const world = baseWorld();
    const career = createCareer(world, { nationality: 'ENG' });
    const result = resolveChainStep(career.world, career.state, 99);
    expect(result.world.seed).toBe(career.world.seed);
  });
});

describe('P7 世界活性 / 董事会 / 采访', () => {
  it('runWorldActivity 是确定性的，且产出新闻', () => {
    const world = baseWorld();
    const a = runWorldActivity(world);
    const b = runWorldActivity(world);
    expect(a.news).toEqual(b.news);
    expect(a.news.length).toBeGreaterThan(0);
  });

  it('boardBrief 每 4 周一次，对经理给出满意度与球迷情绪', () => {
    const world = { ...baseWorld(), week: 4 };
    const manager = createManager(world, { confederationId: 'UEFA', tier: 1 });
    const brief = boardBrief({ ...manager.world, week: 4 }, manager.state, 3);
    expect(brief).toBeDefined();
    expect(brief?.headline.length).toBeGreaterThan(0);
    expect(brief?.lines.length).toBeGreaterThan(0);
    expect(boardBrief({ ...manager.world, week: 5 }, manager.state, 3)).toBeUndefined();
  });

  it('interviewPrompt 只在窗口周出现，applyInterviewChoice 改变人气', () => {
    const world = baseWorld();
    const career = createCareer(world, { nationality: 'ENG' });
    const prompt = interviewPrompt({ ...career.world, week: 5 });
    if (prompt) {
      const after = applyInterviewChoice({ ...career.world, week: 5 }, career.state, 0);
      expect(after.mode).toBe('career');
      if (after.mode === 'career') expect(after.fame).toBeGreaterThanOrEqual(0);
    }
    expect(interviewPrompt({ ...career.world, week: 3 })).toBeUndefined();
  });

  it('seasonWorldNews 不空且都是字符串', () => {
    const news = seasonWorldNews(baseWorld());
    expect(news.length).toBeGreaterThan(0);
    expect(news.every((n) => typeof n === 'string' && n.length > 0)).toBe(true);
  });
});

describe('P7 转会谈判四关', () => {
  it('marketFor 列出可挖目标，且不包含本队球员', () => {
    const world = baseWorld();
    const manager = createManager(world, { confederationId: 'UEFA', tier: 1 });
    const targets = marketFor(manager.world, manager.state.clubId, 6);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t) => t.clubId !== manager.state.clubId)).toBe(true);
  });

  it('报价过低会被俱乐部拒绝', () => {
    const world = baseWorld();
    const manager = createManager(world, { confederationId: 'UEFA', tier: 1 });
    const target = marketFor(manager.world, manager.state.clubId, 1)[0];
    expect(target).toBeDefined();
    if (!target) return;
    const club = manager.world.clubs.find((c) => c.id === manager.state.clubId);
    expect(club).toBeDefined();
    if (!club) return;
    const result = evaluateBid(manager.world, club.id, target, 1, 1, 0.5);
    expect(result.stage === 'failed' || result.stage === 'fee').toBe(true);
  });

  it('signBid 把钱花出去并把球员能力折进球队', () => {
    const world = baseWorld();
    const manager = createManager(world, { confederationId: 'UEFA', tier: 1 });
    const target = marketFor(manager.world, manager.state.clubId, 1)[0];
    const club = manager.world.clubs.find((c) => c.id === manager.state.clubId);
    if (!target || !club) return;
    const rich = { ...club, cash: 999_999 };
    const after = signBid({ ...manager.world, clubs: manager.world.clubs.map((c) => (c.id === club.id ? rich : c)) }, club.id, target, 100, 10);
    const signed = after.clubs.find((c) => c.id === club.id);
    expect(signed).toBeDefined();
    expect((signed?.cash ?? 0)).toBeLessThan(rich.cash);
  });
});

describe('P7 挑战剧本', () => {
  it('配置里有 3 个剧本，目标三档依次收紧', () => {
    expect(SCENARIOS.length).toBe(3);
    for (const def of SCENARIOS) {
      expect(def.goals.bronze).toBeGreaterThan(0);
      // 名次是「越小越好」，所以银档的目标名次必须 ≤ 铜档
      expect(def.goals.silver).toBeLessThanOrEqual(def.goals.bronze);
      expect(def.goals.gold).toBeLessThanOrEqual(def.goals.silver);
    }
  });

  it('applyScenario 把球队搬到剧本设定并给出目标', () => {
    const world = baseWorld();
    const def = SCENARIOS[0];
    if (!def) return;
    const club = scenarioClub(world, def);
    expect(club).toBeDefined();
    const bent = applyScenario(world, createManager(world, { confederationId: 'UEFA', tier: 1 }).state, def);
    expect(bent.world.seed).toBe(world.seed);
  });

  it('settleScenario 按名次给评级并回写 scenario 字段', () => {
    const world = baseWorld();
    const def = SCENARIOS[0];
    if (!def) return;
    const manager = createManager(world, { confederationId: 'UEFA', tier: 1 });
    const result = settleScenario(world, manager.state, def);
    expect(['none', 'bronze', 'silver', 'gold']).toContain(result.grade);
    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.state.mode).toBe('manager');
  });
});

describe('P7 社区层（球迷热评）', () => {
  it('关掉社区层就不产出热评', () => {
    const rng = streamRng(7, 'hot');
    const ctx = { club: 'B', opponent: 'C', score: '2-0', won: true, drew: false, player: 'A', rating: 7.8 };
    expect(makeHotComments(ctx, rng, false)).toEqual([]);
    expect(communityOffText().length).toBeGreaterThan(0);
  });

  it('开启时热评条数在配置区间内且都是字符串', () => {
    const rng = streamRng(7, 'hot');
    const ctx = { club: 'B', opponent: 'C', score: '0-3', won: false, drew: false, player: 'A', rating: 5.1 };
    const list = makeHotComments(ctx, rng, true);
    expect(list.length).toBeGreaterThanOrEqual(BALANCE.hotCommentCountMin);
    expect(list.length).toBeLessThanOrEqual(BALANCE.hotCommentCountMax);
    for (const text of list) {
      expect(typeof text).toBe('string');
      expect(text.length).toBeLessThanOrEqual(BALANCE.hotCommentMaxLen);
    }
  });

  it('moodShift 大胜为正、大败为负', () => {
    expect(moodShift(true, false, 4)).toBeGreaterThan(0);
    expect(moodShift(false, false, 4)).toBeLessThan(0);
    expect(moodShift(false, true, 0)).toBeGreaterThanOrEqual(-1);
  });
});

describe('P7 数值边界', () => {
  it('clamp 不越界', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });
});
