import type { ConfederationId } from '../types';

/**
 * 挑战剧本（设计 §15.8）。
 *
 * 每条剧本 = 固定种子 + 固定起始国家/级别 + 一个「开场不利」的设定，
 * 目标是**名次**（可选再叠一条现金目标）。进度写在 `PlayState.scenario`。
 */
export interface ScenarioGoals {
  /** 联赛名次 ≤ 该值即达成 */
  bronze: number;
  silver: number;
  gold: number;
  /** 现金（万）阈值，给了才校验 */
  cashSilver?: number;
  cashGold?: number;
}

export interface ScenarioDef {
  id: string;
  name: string;
  blurb: string;
  /** 起始周（直接跳到赛季中段，制造「时间不多了」） */
  startWeek: number;
  seed: number;
  countryId: string;
  confederationId: ConfederationId;
  tier: number;
  /** 开局冻结转会预算（现金清零） */
  cashFreeze: boolean;
  /** 开局折损的主力人数（写进球队强度） */
  injuries: number;
  goals: ScenarioGoals;
}

export const SCENARIOS: readonly ScenarioDef[] = [
  {
    id: 'great-escape',
    name: '绝境保级',
    blurb: '赛季已过半，你在降级区。钱被冻结，两名主力带伤。剩下 27 周，只求活下去。',
    startWeek: 25,
    seed: 770101,
    countryId: 'ITA',
    confederationId: 'UEFA',
    tier: 2,
    cashFreeze: true,
    injuries: 2,
    goals: { bronze: 14, silver: 9, gold: 5, cashSilver: 300, cashGold: 1200 },
  },
  {
    id: 'newly-promoted',
    name: '升班马首季',
    blurb: '刚升上来，账面干净，队里没有一个是顶级联赛证明过自己的人。目标是活过第一年。',
    startWeek: 1,
    seed: 770202,
    countryId: 'ESP',
    confederationId: 'UEFA',
    tier: 2,
    cashFreeze: false,
    injuries: 0,
    goals: { bronze: 16, silver: 10, gold: 6 },
  },
  {
    id: 'cash-crisis',
    name: '财政危机',
    blurb: '工资占比爆表，现金见底。你得一边还债一边拿分，董事会只给你两个赛季。',
    startWeek: 1,
    seed: 770303,
    countryId: 'BRA',
    confederationId: 'CONMEBOL',
    tier: 1,
    cashFreeze: true,
    injuries: 1,
    goals: { bronze: 12, silver: 7, gold: 3, cashSilver: 800, cashGold: 2500 },
  },
];

export function scenarioById(id: string): ScenarioDef | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export type ScenarioGrade = 'none' | 'bronze' | 'silver' | 'gold';

/** 名次 + 现金双条件判定；bronze 是底线，达到更高档同时算 bronze 达成 */
export function gradeScenario(def: ScenarioDef, rank: number, cash: number): ScenarioGrade {
  if (rank <= 0) return 'none';
  const cashOk = (need?: number): boolean => need === undefined || cash >= need;
  if (rank <= def.goals.gold && cashOk(def.goals.cashGold)) return 'gold';
  if (rank <= def.goals.silver && cashOk(def.goals.cashSilver)) return 'silver';
  if (rank <= def.goals.bronze) return 'bronze';
  return 'none';
}

/** 进度文案（结算页与剧本页共用） */
export function scenarioProgress(def: ScenarioDef, rank: number, cash: number): string[] {
  const grade = gradeScenario(def, rank, cash);
  const lines = [
    `当前名次：${rank > 0 ? `第 ${rank} 位` : '未知'}`,
    `现金：${cash} 万`,
    `铜：名次 ≤ ${def.goals.bronze}${def.goals.cashSilver !== undefined ? ` 且现金 ≥ ${def.goals.cashSilver} 万` : ''}`,
    `银：名次 ≤ ${def.goals.silver}${def.goals.cashSilver !== undefined ? ` 且现金 ≥ ${def.goals.cashSilver} 万` : ''}`,
    `金：名次 ≤ ${def.goals.gold}${def.goals.cashGold !== undefined ? ` 且现金 ≥ ${def.goals.cashGold} 万` : ''}`,
  ];
  if (grade !== 'none') lines.push(`已达成：${{ bronze: '铜', silver: '银', gold: '金' }[grade]}`);
  return lines;
}
