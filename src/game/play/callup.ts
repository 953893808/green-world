import { BALANCE, clamp, round2 } from '../balance';
import { isNationalWindow } from '../config/calendar';
import type { CareerState, NationalTeam, WorldState } from '../types';

/**
 * 国家队征召（设计 §7.1 / §3.1）。
 *
 * 规则：人气 ≥ nationalCallFame 且位置/国籍匹配的球员，在征召周被招入本国国家队。
 * 征召带来人气与国家队强度提升，并在赛季末结算「国家队出场」荣誉。
 *
 * MVP 只做「球员生涯模式」一侧：经理模式的「国家队主帅」入口在 P6.5 用
 * `nationalTeamMode` 单独处理，这里只负责把征召结果落进 CareerState。
 */

export interface CallUpResult {
  called: boolean;
  /** 被征召的国家队名（中文） */
  teamName?: string;
  /** 本次是否首次入选 */
  firstTime: boolean;
  reasons: string[];
}

/** 征召难度按联合会 sporting 值调整：足球越强越难进 */
export function callUpChance(fame: number, confederationSporting: number): number {
  if (fame < BALANCE.nationalCallFame) return 0;
  const base = clamp((fame - BALANCE.nationalCallFame) / 60, 0, 1);
  const hardness = clamp(confederationSporting / 100, 0.3, 1);
  return round2(clamp(base * (1.4 - hardness * BALANCE.callUpDifficultyBySporting), 0, 0.95));
}

/** 找到球员所属国家的国家队 */
export function homeTeamOf(world: WorldState, nationality: string): NationalTeam | undefined {
  return world.nationalTeams.find((t) => t.countryId === nationality);
}

/**
 * 本周是否征召（只在国家队窗口判定，且同一赛季不重复调用）。
 * 返回新的 world（国家队强度上升）与征召结果。
 */
export function resolveCallUp(
  world: WorldState,
  state: CareerState,
  rng: { chance: (p: number) => boolean },
): { world: WorldState; result: CallUpResult } {
  const noCall: CallUpResult = { called: false, firstTime: false, reasons: [] };
  if (!isNationalWindow(world.week)) return { world, result: noCall };

  const team = homeTeamOf(world, state.nationality);
  const conf = world.confederations.find((c) => c.id === state.confederationId);
  if (!team || !conf) return { world, result: noCall };

  const chance = callUpChance(state.fame, conf.sporting);
  if (chance <= 0) return { world, result: noCall };
  if (!rng.chance(chance)) return { world, result: { called: false, firstTime: false, reasons: [] } };

  const firstTime = !state.honors.some((h) => h.includes('国家队'));
  const teams = world.nationalTeams.map<NationalTeam>((t) => {
    if (t.id !== team.id) return t;
    return {
      ...t,
      attack: clamp(round2(t.attack + BALANCE.callUpStrengthGain), 15, 97),
      midfield: clamp(round2(t.midfield + BALANCE.callUpStrengthGain), 15, 97),
      defense: clamp(round2(t.defense + BALANCE.callUpStrengthGain * 0.6), 15, 97),
      reputation: clamp(round2(t.reputation + 0.4), BALANCE.reputationMin, BALANCE.reputationMax),
    };
  });

  return {
    world: { ...world, nationalTeams: teams },
    result: {
      called: true,
      teamName: team.nameZh,
      firstTime,
      reasons: [`人气 ${state.fame} 达标，${team.nameZh} 征召入队`],
    },
  };
}

/** 征召后写回玩家态：人气 + 荣誉（首次入选） */
export function applyCallUp(state: CareerState, result: CallUpResult): CareerState {
  if (!result.called) return state;
  const honors = result.firstTime && result.teamName
    ? [...state.honors, `${result.teamName}国家队首秀`]
    : state.honors;
  return { ...state, fame: state.fame + BALANCE.callUpFameGain, honors };
}
