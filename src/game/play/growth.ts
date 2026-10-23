import { BALANCE, clamp, round2 } from '../balance';
import type { Club, Player } from '../types';

/**
 * 球员成长与身价（设计 §7.4）。
 *
 * 成长 = abilityGrowthRate × (potential - ability) × 年龄系数 × 出场时间系数 × 训练系数
 * 身价 = f(ability, potential, 年龄, 状态, 声望, 合同剩余年数)
 */

/** 年龄系数：16-21 猛涨，22-26 稳定，27-29 放缓，30+ 转衰退（见 growthOf） */
export function ageFactorOf(age: number): number {
  if (age <= 21) return BALANCE.ageFactorYoung;
  if (age <= 26) return BALANCE.ageFactorPrime;
  if (age <= 29) return BALANCE.ageFactorLate;
  return BALANCE.ageFactorVeteran;
}

/** 出场时间系数：把「本季出场 / 预计总场次」映射到 minutesFactorMin~Max */
export function minutesFactorOf(apps: number, expected: number): number {
  if (expected <= 0) return BALANCE.minutesFactorMin;
  const rate = clamp(apps / expected, 0, 1.2);
  const span = BALANCE.minutesFactorMax - BALANCE.minutesFactorMin;
  return round2(BALANCE.minutesFactorMin + span * Math.min(1, rate));
}

/** 训练系数：设施（球场容量近似）与士气共同决定，落在 trainingMin~Max */
export function trainingFactorOf(club: Club | undefined, morale: number): number {
  const facility = club ? clamp(club.stadium / 60000, 0, 1) : 0.5;
  const mood = clamp(morale / 100, 0, 1);
  const span = BALANCE.trainingMax - BALANCE.trainingMin;
  return round2(BALANCE.trainingMin + span * (facility * 0.6 + mood * 0.4));
}

export interface GrowthInput {
  player: Player;
  /** 本季出场次数 */
  apps: number;
  /** 本季预计总场次 */
  expected: number;
  club?: Club | undefined;
  morale?: number;
}

export interface GrowthResult {
  /** 涨了多少能力点（可为 0） */
  delta: number;
  /** 拆解，用于 UI 展示「为什么涨/不涨」 */
  ageFactor: number;
  minutesFactor: number;
  trainingFactor: number;
  /** 是否到达潜力上限 */
  capped: boolean;
}

export function growthOf(input: GrowthInput): GrowthResult {
  const { player } = input;
  const ageFactor = ageFactorOf(player.age);
  const minutesFactor = minutesFactorOf(input.apps, input.expected);
  const trainingFactor = trainingFactorOf(input.club, input.morale ?? 55);
  // P2：30 岁起转为衰退。成长公式本身恒 ≥ 0（raw ≥ 0），若不在这里给负值，
  // 老将「只会涨或不动」→ 年龄曲线不可逆。delta 是负数时 applyGrowth 仍会 clamp 到 attrMin。
  const declineYears = player.age - BALANCE.ageDeclineStart + 1;
  if (declineYears > 0) {
    const delta = -round2(BALANCE.ageDeclinePerYear * declineYears);
    return { delta, ageFactor, minutesFactor, trainingFactor, capped: false };
  }
  const room = player.potential - player.ability;
  if (room <= 0) {
    return { delta: 0, ageFactor, minutesFactor, trainingFactor, capped: true };
  }
  const raw = BALANCE.abilityGrowthRate * room * ageFactor * minutesFactor * trainingFactor;
  const delta = round2(Math.min(room, raw));
  return { delta, ageFactor, minutesFactor, trainingFactor, capped: false };
}

/** 身价：能力平方为底，叠加潜力溢价、年龄曲线、状态与声望 */
export function marketValueOf(
  player: Player,
  options: { club?: Club | undefined; form?: number; contractYears?: number } = {},
): number {
  const base = Math.pow(player.ability, 2) * BALANCE.valueAbilityK;
  const potentialBonus = 1 + Math.max(0, player.potential - player.ability) / 100;
  const ageGap = player.age - BALANCE.valuePeakAge;
  const ageCurve = ageGap <= 0 ? 1 : Math.max(0.2, 1 - ageGap * BALANCE.valueDeclineK);
  const reputation = options.club ? options.club.reputation / 100 : 0.4;
  const repCurve = 0.7 + reputation * BALANCE.valueReputationK;
  const formCurve = 0.9 + clamp(options.form ?? 0.5, 0, 1) * 0.2;
  const contract = options.contractYears ?? 3;
  // P2：合同越长身价越高（旧实现方向反了：5 年合同反而打 8 折）；封顶 +20%
  const contractCurve = 1 + Math.max(0, Math.min(5, contract) - 1) * BALANCE.contractYearsFactorStep;
  return Math.round(base * potentialBonus * ageCurve * repCurve * formCurve * contractCurve);
}

/** 能力变动后重算身价并返回新 Player（能力/年龄/身价一起更新） */
export function applyGrowth(
  player: Player,
  result: GrowthResult,
  options: { club?: Club | undefined; form?: number } = {},
): Player {
  const ability = clamp(round2(player.ability + result.delta), BALANCE.attrMin, BALANCE.potentialMax);
  const next: Player = { ...player, ability };
  next.value = marketValueOf(next, options);
  return next;
}
