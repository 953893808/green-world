import { BALANCE } from './balance';
import { generateWorld } from './world/generate';
import { createSeason } from './world/schedule';
import { finishSeason, startNextSeason } from './rules/qualify';
import { SaveController, defaultStorage, saveSizeKB, serialize, withinBudget } from './save/persist';
import { encodeSave } from './save/encode';
import { decodeSave, loadSave } from './save/decode';
import { careerAdvanceWeek, createCareer, retireCareer, rollCareerSeason } from './play/career';
import { createManager, managerAdvanceWeek, rehireManager, rollManagerSeason } from './play/manager';
import type { CareerState, ManagerState, MatchResult, Mode, PlayState, SaveGame, WorldState } from './types';
import type { CareerCreateOptions } from './play/career';
import type { ManagerCreateOptions, ManagerSeasonOutcome } from './play/manager';

/**
 * 双模式统一入口（P4）。UI 只需要跟这一层打交道：
 *  - `newGame` 建世界 + 建玩家状态；
 *  - `advanceGame` 推一周（按模式分派）；
 *  - `rollSeason` 赛季结算后进入下一季；
 *  - `saveNow` / `loadFromStorage` 存档读写。
 */

export interface NewGameOptions {
  mode: Mode;
  seed?: number;
  career?: CareerCreateOptions;
  manager?: ManagerCreateOptions;
}

export interface GameSession {
  world: WorldState;
  state: PlayState;
}

export interface AdvanceResult extends GameSession {
  seasonEnded: boolean;
  played: boolean;
  /** 本赛季是否结束且需要进入下一季 */
  needsRollover: boolean;
  /** 本周新闻（转会、征召等），UI 直接展示 */
  news: string[];
  /** 经理模式：赛季结束时的董事会/球迷结算（生涯模式为空） */
  outcome?: ManagerSeasonOutcome;
  /** 生涯模式：本周是否被国家队征召 */
  calledUp?: boolean;
}

export function newGame(options: NewGameOptions): GameSession {
  const seed = options.seed ?? BALANCE.worldSeedDefault;
  const world = createSeason(generateWorld(seed), 1);
  if (options.mode === 'career') {
    const { state } = createCareer(world, options.career ?? {});
    return { world, state };
  }
  const { state } = createManager(world, options.manager ?? {});
  return { world, state };
}

export interface AdvanceOptions {
  /** 交互比赛：玩家亲手踢完的结果（没有就由 AI 结算） */
  playerResult?: MatchResult;
}

export function advanceGame(session: GameSession, options: AdvanceOptions = {}): AdvanceResult {
  // P0-1：赛季已经结算（world.finished）时不再推进——UI 此时应显示「进入下一季」。
  // 以前这里会继续走 careerAdvanceWeek，结算页退回主控台后连点「推进一周」会重复结算。
  if (session.world.finished) {
    return {
      world: session.world,
      state: session.state,
      seasonEnded: true,
      played: false,
      needsRollover: needsSeasonRollover(session.world, session.state),
      news: [],
    };
  }
  if (session.state.mode === 'career') {
    const result = careerAdvanceWeek(session.world, session.state, options.playerResult ? { playerResult: options.playerResult } : {});
    return {
      world: result.world,
      state: result.state,
      seasonEnded: result.seasonEnded,
      played: result.played,
      needsRollover: result.seasonEnded && !result.state.retired,
      news: result.news,
      ...(result.calledUp ? { calledUp: true } : {}),
    };
  }
  const result = managerAdvanceWeek(session.world, session.state, options.playerResult ? { playerResult: options.playerResult } : {});
  return {
    world: result.world,
    state: result.state,
    seasonEnded: result.seasonEnded,
    played: Boolean(options.playerResult),
    needsRollover: result.seasonEnded && result.state.fired !== true,
    news: result.news,
    ...(result.outcome ? { outcome: result.outcome } : {}),
  };
}

/** 赛季结束 → 结算 → 进入下一季（并按模式同步玩家状态的赛季/周次） */
export function rollSeason(session: GameSession): GameSession {
  // P0-1：只有已经 finish（赛季结算完成）的世界才能开下一季。
  // 未结算时原样返回，避免连点「进入下一季」把同一个赛季 finish 两次。
  if (!session.world.finished) return session;
  const world = session.state.mode === 'career'
    ? rollCareerSeason(session.world)
    : rollManagerSeason(session.world);
  return { world, state: { ...session.state, season: world.season, week: world.week } };
}

/** 主动退役 / 下课后重新应聘 */
export function retire(session: GameSession): GameSession {
  if (session.state.mode !== 'career') return session;
  return { world: session.world, state: retireCareer(session.state) };
}

export function rehire(session: GameSession): GameSession {
  if (session.state.mode !== 'manager') return session;
  const { state } = rehireManager(session.world, session.state);
  return { world: session.world, state };
}

/** 赛季结束后是否还能继续（生涯：未退役；经理：未被解雇或已再就业） */
export function canContinue(state: PlayState): boolean {
  if (state.mode === 'career') return state.retired !== true;
  return state.fired !== true;
}

/**
 * 赛季是否已经结算完、只差「进入下一季」（P0-1：UI 用它决定按钮文案，
 * 不能在 world.finished 时还显示「推进一周」）。
 */
export function needsSeasonRollover(world: WorldState, state: PlayState): boolean {
  return world.finished && canContinue(state);
}

export interface SaveInfo {
  save: SaveGame;
  kb: number;
  withinBudget: boolean;
}

export function buildSave(session: GameSession, createdAt = Date.now()): SaveGame {
  return encodeSave(session.world, session.state, createdAt);
}

export function saveInfo(save: SaveGame): SaveInfo {
  return { save, kb: saveSizeKB(save), withinBudget: withinBudget(save) };
}

export function saveJson(session: GameSession): string {
  return serialize(buildSave(session));
}

export interface LoadedGame extends GameSession {
  repaired: string[];
}

/** 从原始 JSON/对象读档；失败返回 null 并给出原因 */
export function loadFrom(raw: unknown): { ok: true; session: LoadedGame } | { ok: false; reason: string; repaired: string[] } {
  const loaded = loadSave(raw);
  if (!loaded.ok || !loaded.world || !loaded.state) {
    return { ok: false, reason: loaded.reason ?? '存档无法读取', repaired: loaded.repaired };
  }
  return { ok: true, session: { world: loaded.world, state: loaded.state, repaired: loaded.repaired } };
}

/** 从存储读档（浏览器 localStorage / 测试内存） */
export function loadFromStorage(
  controller: SaveController = new SaveController({ storage: defaultStorage() }),
): { ok: true; session: LoadedGame } | { ok: false; reason: string; repaired: string[] } {
  return loadFrom(controller.readRaw());
}

/** 存档往返校验：编码→解码后关键字段一致 */
export function roundTrip(session: GameSession): GameSession {
  const save = buildSave(session);
  const { world, state } = decodeSave(save);
  return { world, state };
}

export type { CareerState, ManagerState, PlayState, SaveGame, WorldState };
export { SaveController, finishSeason, startNextSeason, encodeSave, decodeSave, loadSave };
