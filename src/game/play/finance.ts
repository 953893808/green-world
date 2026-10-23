import { BALANCE, clamp, round2 } from '../balance';
import { rankOf } from '../rules/standings';
import type { Club, WorldState } from '../types';

/**
 * 俱乐部财政（设计 §7.2）。
 *
 * 收入 = 门票 + 转播 + 赞助 + 奖金
 *   门票 = ticketBase × 球场容量 × fillRate
 *   fillRate = 0.35 + 声望/200 + 近期战绩修正
 *   转播 = tvBaseByTier[tier] × (1 + 声望/100)
 *   赞助 = sponsorBase × (声望/50)^1.2 × 商业系数
 * 支出 = 工资总额 + 差旅 + 青训 + 债务利息
 * 净资产 = 现金 + 球员身价 × 0.4 - 债务
 * 转会预算 = max(0, (现金 - cashFloor) × budgetShare)
 *
 * 单位：全部为「万」。声望 0~100。
 */

export interface FinanceLine {
  gate: number;
  tv: number;
  sponsor: number;
  prize: number;
  income: number;
  wages: number;
  travel: number;
  academy: number;
  interest: number;
  expense: number;
  net: number;
  cash: number;
  netAssets: number;
  debt: number;
  transferBudget: number;
  /** 工资占收入比（0~n） */
  wageRatio: number;
  /** 超过 wageRatioCap 时为 true → 董事会扣满意度 */
  wageOverCap: boolean;
  /** 净资产为负 → 财政托管 */
  inReceivership: boolean;
  notes: string[];
}

/** 近期战绩修正：联赛排名越靠前上座率越高（-0.08 ~ +0.12） */
function formFillBonus(world: WorldState, club: Club): number {
  const rows = world.standings[club.competitionId]?.rows ?? [];
  if (rows.length < 4) return 0;
  const rank = rankOf(world, club.competitionId, club.id);
  if (rank <= 0) return 0;
  const ratio = (rows.length - rank) / Math.max(1, rows.length - 1);
  return round2((ratio - 0.5) * 0.24);
}

/** 本赛季奖金：联赛名次 + 杯赛/洲际轮次 */
function prizeOf(world: WorldState, club: Club): number {
  const tierBase = BALANCE.tvBaseByTier[club.tier] ?? 2;
  let prize = 0;
  const rows = world.standings[club.competitionId]?.rows ?? [];
  const rank = rankOf(world, club.competitionId, club.id);
  if (rank > 0 && rows.length > 1) {
    const share = (rows.length - rank) / (rows.length - 1);
    prize += tierBase * (0.35 + share * 0.65);
  }
  let wins = 0;
  for (const fixture of world.fixtures) {
    if (!fixture.played || !fixture.result) continue;
    if (fixture.homeId !== club.id && fixture.awayId !== club.id) continue;
    const comp = world.competitions.find((c) => c.id === fixture.competitionId);
    if (!comp || comp.type === 'league') continue;
    const won =
      (fixture.homeId === club.id && fixture.result.homeGoals > fixture.result.awayGoals) ||
      (fixture.awayId === club.id && fixture.result.awayGoals > fixture.result.homeGoals);
    if (!won) continue;
    wins += comp.type === 'club-world' ? 3 : comp.type === 'domestic-cup' ? 1 : 2;
  }
  prize += wins * Math.max(1, tierBase * 0.25);
  return round2(prize);
}

export function financeOf(world: WorldState, club: Club): FinanceLine {
  const tier = club.tier;
  const tvBase = BALANCE.tvBaseByTier[tier] ?? 2;
  const conf = world.confederations.find((c) => c.id === club.confederationId);
  const commercial = conf ? conf.commercial / 50 : 1;

  const fill = clamp(
    BALANCE.ticketFillBase + club.reputation / 200 + formFillBonus(world, club),
    0.15,
    1,
  );
  const gate = round2(BALANCE.ticketBase * (club.stadium / 1000) * fill);
  const tv = round2(tvBase * (1 + club.reputation / 100));
  const sponsor = round2(BALANCE.sponsorBase * Math.pow(club.reputation / 50, 1.2) * commercial);
  const prize = prizeOf(world, club);
  const income = round2(gate + tv + sponsor + prize);

  // P1-1：Club.wages 就是「赛季工资总额（万）」，与 types.ts 注释一致；
  // 周薪 → 赛季的换算只在 balance.seasonWagesOfWeekly 做一次（写入端），这里不再乘 52 或除 100。
  const wages = round2(club.wages);
  const matches = world.fixtures.filter(
    (f) => f.played && (f.homeId === club.id || f.awayId === club.id),
  ).length;
  const travel = round2(
    matches * BALANCE.travelFatiguePerUnit * BALANCE.travelCostPerUnit * (1 + (tier - 1) * 0.15),
  );
  const academy = round2(income * BALANCE.academyCostRatio);
  const debt = club.cash < 0 ? -club.cash : 0;
  const interest = round2(debt * BALANCE.debtInterestRate);
  const expense = round2(wages + travel + academy + interest);
  const net = round2(income - expense);
  const cash = round2(club.cash + net);
  const netAssets = round2(cash - debt);
  const transferBudget = round2(Math.max(0, (cash - BALANCE.cashFloor) * BALANCE.budgetShare));
  const wageRatio = income > 0 ? round2(wages / income) : 9.99;
  const wageOverCap = wageRatio > BALANCE.wageRatioCap;
  const inReceivership = cash < 0;

  const notes: string[] = [];
  if (wageOverCap) {
    notes.push(`工资占收入 ${Math.round(wageRatio * 100)}%，超过 ${Math.round(BALANCE.wageRatioCap * 100)}% 红线`);
  }
  if (inReceivership) notes.push('净资产为负，进入财政托管：本窗禁止引援');
  if (debt > 0) notes.push(`负债 ${debt} 万，年息 ${Math.round(BALANCE.debtInterestRate * 100)}%`);

  return {
    gate,
    tv,
    sponsor,
    prize,
    income,
    wages,
    travel,
    academy,
    interest,
    expense,
    net,
    cash,
    netAssets,
    debt,
    transferBudget,
    wageRatio,
    wageOverCap,
    inReceivership,
    notes,
  };
}

/** 结算一家俱乐部的财政：返回更新后的 Club（cash 变化；工资/收入已按赛季口径计入） */
export function settleClubFinance(world: WorldState, club: Club): Club {
  const line = financeOf(world, club);
  return { ...club, cash: line.cash };
}

/** 只结算指定俱乐部（结算管线每季传入全部俱乐部；单测可只传一家） */
export function settleFinances(world: WorldState, clubIds: readonly string[]): WorldState {
  if (clubIds.length === 0) return world;
  const wanted = new Set(clubIds);
  return {
    ...world,
    clubs: world.clubs.map((club) => (wanted.has(club.id) ? settleClubFinance(world, club) : club)),
  };
}
