import { streamRng } from '../../core/rng';
import { BALANCE, clamp } from '../balance';
import { CHAINS, chainById } from '../config/chains';
import type { ChainChoice, ChainDef, ChainEffect } from '../config/chains';
import { rankOf } from '../rules/standings';
import type { ActiveChain, PlayState, WorldState } from '../types';

/**
 * 事件链引擎（设计 §15.4）。
 *
 * 规则：
 * - 同一时刻活跃链 ≤ `chainMaxActive`，满了就排队，**不丢弃**；
 * - 每条链的每一步都有一个 `dueWeek`，到点才可抉择；
 * - 效果只走 `advanceWeek` 这一条入口（本模块返回新 world/state，由调用方接线）；
 * - 一条链结束（success/fail/abandon）后记入 `chainDone`，同档不再重触发。
 */
export interface ChainPrompt {
  chainId: string;
  stepId: string;
  title: string;
  desc: string;
  choices: { label: string }[];
}

function chainList(state: PlayState): ActiveChain[] {
  return state.chains ?? [];
}

function managedClubId(state: PlayState): string {
  return state.mode === 'career' ? state.clubId : (state.nationalTeamId ?? state.clubId);
}

/** 当前名次是否明显低于预期（用于 `below-target` 触发） */
function belowTarget(world: WorldState, state: PlayState): boolean {
  if (state.mode !== 'manager' || state.kind === 'national') return false;
  const club = world.clubs.find((c) => c.id === state.clubId);
  if (!club) return false;
  const rank = rankOf(world, club.competitionId, club.id);
  if (rank <= 0) return false;
  const expected = club.tier === 1 ? 6 : club.tier === 2 ? 8 : 10;
  return rank > expected + 2;
}

/** 链是否可以开始：模式 + 触发条件 + 周次 + 没在活跃/排队/已结束 */
function startable(def: ChainDef, world: WorldState, state: PlayState): boolean {
  if (def.mode !== state.mode) return false;
  if (world.week < def.weekFrom) return false;
  if (chainList(state).some((c) => c.id === def.id)) return false;
  if ((state.chainQueue ?? []).includes(def.id)) return false;
  if ((state.chainDone ?? []).includes(def.id)) return false;
  if (def.startWhen === 'below-target') return belowTarget(world, state);
  if (def.startWhen === 'youth-window') return state.mode === 'manager' && state.kind !== 'national';
  return state.mode === 'career';
}

/**
 * 每周推进时调用：先补满空位（常驻链 + 排队链），再返回 state。
 * 纯函数，不改入参。
 */
export function tickChains<T extends PlayState>(world: WorldState, state: T): T {
  const done = state.chainDone ?? [];
  let active = [...chainList(state)];
  let queue = [...(state.chainQueue ?? [])];
  const max = BALANCE.chainMaxActive;

  const spawn = (id: string): boolean => {
    const def = chainById(id);
    const first = def?.steps[0];
    if (!def || !first) return false;
    active.push({ id: def.id, stepId: first.id, dueWeek: world.week + first.weekOffset });
    return true;
  };

  // 1) 先消化排队（按入队顺序）
  while (active.length < max && queue.length > 0) {
    const id = queue[0];
    if (!id) break;
    queue = queue.slice(1);
    if (!done.includes(id) && !spawn(id)) continue;
  }

  // 2) 再尝试触发新链（每条链一生一次）
  for (const def of CHAINS) {
    if (active.length >= max) {
      if (startable(def, world, state) && !queue.includes(def.id)) queue.push(def.id);
      continue;
    }
    if (startable(def, world, state)) spawn(def.id);
  }

  return { ...state, chains: active, chainQueue: queue, chainDone: done };
}

/**
 * 到点可抉择的链（一次只给一条，避免弹窗叠弹窗）。
 * `chainId` 可选：UI 结算时必须把「玩家看到的链」传回来，否则多链同周到期时
 * 会按最早到期重新挑一条，把选项结算到另一条链上（越权结算）。
 */
export function chainPrompt(state: PlayState, week: number, chainId?: string): ChainPrompt | undefined {
  const hit = chainList(state)
    .filter((c) => c.dueWeek <= week && (chainId === undefined || c.id === chainId))
    .sort((a, b) => a.dueWeek - b.dueWeek)[0];
  if (!hit) return undefined;
  const def = chainById(hit.id);
  const step = def?.steps.find((s) => s.id === hit.stepId);
  if (!def || !step) return undefined;
  return {
    chainId: def.id,
    stepId: step.id,
    title: step.title,
    desc: step.desc,
    choices: step.choices.map((c) => ({ label: c.label })),
  };
}

function scaleAll(clubFields: { attack: number; midfield: number; defense: number }, delta: number) {
  return {
    attack: clamp(clubFields.attack + delta / 3, 10, 99),
    midfield: clamp(clubFields.midfield + delta / 3, 10, 99),
    defense: clamp(clubFields.defense + delta / 3, 10, 99),
  };
}

/** 把链效果写进 world / state（只动被允许的字段） */
function applyEffect(world: WorldState, state: PlayState, effect: ChainEffect): { world: WorldState; state: PlayState; texts: string[] } {
  const texts: string[] = [];
  const clubId = managedClubId(state);
  const nextWorld =
    effect.budget || effect.teamPower
      ? {
          ...world,
          clubs: world.clubs.map((c) => {
            if (c.id !== clubId) return c;
            const scaled = scaleAll(c, effect.teamPower ?? 0);
            return {
              ...c,
              ...scaled,
              cash: Math.round(c.cash + (effect.budget ?? 0)),
            };
          }),
        }
      : world;
  if (effect.budget) texts.push(`预算 ${effect.budget > 0 ? '+' : ''}${effect.budget} 万`);
  if (effect.teamPower) texts.push(`球队强度 ${effect.teamPower > 0 ? '+' : ''}${effect.teamPower}`);

  let nextState: PlayState = state;
  if (state.mode === 'career') {
    let career = state;
    if (effect.fame) {
      career = { ...career, fame: clamp(state.fame + effect.fame, 0, BALANCE.reputationMax) };
      texts.push(`人气 ${effect.fame > 0 ? '+' : ''}${effect.fame}`);
    }
    if (effect.stamina) {
      career = { ...career, player: { ...career.player, stamina: clamp(career.player.stamina + effect.stamina, 0, BALANCE.staminaMax) } };
      texts.push(`体能 ${effect.stamina > 0 ? '+' : ''}${effect.stamina}`);
    }
    nextState = career;
  } else {
    let manager = state;
    if (effect.boardConfidence) {
      manager = { ...manager, boardConfidence: clamp(manager.boardConfidence + effect.boardConfidence, 0, 100) };
      texts.push(`董事会 ${effect.boardConfidence > 0 ? '+' : ''}${effect.boardConfidence}`);
    }
    if (effect.fanMood) {
      manager = { ...manager, fanMood: clamp(manager.fanMood + effect.fanMood, 0, 100) };
      texts.push(`球迷 ${effect.fanMood > 0 ? '+' : ''}${effect.fanMood}`);
    }
    nextState = manager;
  }
  return { world: nextWorld, state: nextState, texts };
}

/**
 * 结算一步：先掷风险（如有），再应用效果，然后把链推进到下一步或收束。
 * 返回新的 world/state 与给玩家看的文本。
 */
export function resolveChainStep(
  world: WorldState,
  state: PlayState,
  index: number,
  chainId?: string,
): { world: WorldState; state: PlayState; text: string; ended?: string } {
  const prompt = chainPrompt(state, world.week, chainId);
  if (!prompt) return { world, state, text: '这条链已经结束了。' };
  const def = chainById(prompt.chainId);
  const step = def?.steps.find((s) => s.id === prompt.stepId);
  const choice: ChainChoice | undefined = step?.choices[index];
  if (!def || !step || !choice) return { world, state, text: '没有这个选项。' };

  const rng = streamRng(world.seed, 'chain', def.id, step.id, index);
  const risky = choice.risk ? !rng.chance(choice.risk.chance) : false;
  const effect = risky && choice.risk ? choice.risk.failEffect : choice.effect;
  const applied = applyEffect(world, state, effect);
  const texts = [...applied.texts];
  if (risky && choice.risk) texts.unshift(choice.risk.failText);
  else texts.unshift(choice.label);

  const active = chainList(applied.state);
  let activeNext: ActiveChain[];
  let ended: string | undefined;
  if (choice.endChain) {
    ended = choice.endChain;
    activeNext = active.filter((c) => c.id !== def.id);
  } else {
    const nextStep = def.steps.find((s) => s.id === choice.nextStepId);
    // P2：数据里 nextStepId 缺失/自指时，旧实现把 active 原样保留（stepId 与 dueWeek 都不变）→
    // 同一步可以无限重复 resolve，每次都会 applyEffect（反复加预算/人气/球队强度）。这里直接以 abandon 收束。
    if (!nextStep || nextStep.id === step.id) {
      ended = 'abandon';
      activeNext = active.filter((c) => c.id !== def.id);
    } else {
      activeNext = active.map((c) =>
        c.id === def.id ? { ...c, stepId: nextStep.id, dueWeek: world.week + nextStep.weekOffset } : c,
      );
    }
  }
  const chainDone = ended ? [...(applied.state.chainDone ?? []), def.id] : (applied.state.chainDone ?? []);
  const nextState = { ...applied.state, chains: activeNext, chainDone } as PlayState;
  return { world: applied.world, state: nextState, text: texts.join('；'), ...(ended ? { ended } : {}) };
}

/** 给主控台用的一行摘要（没有活跃链就返回 undefined） */
export function chainTeaser(state: PlayState, week: number): string | undefined {
  const hit = chainList(state)
    .filter((c) => c.dueWeek <= week)
    .sort((a, b) => a.dueWeek - b.dueWeek)[0];
  if (!hit) return undefined;
  const def = chainById(hit.id);
  const step = def?.steps.find((s) => s.id === hit.stepId);
  if (!def || !step) return undefined;
  return `${def.title}：${step.title}`;
}
