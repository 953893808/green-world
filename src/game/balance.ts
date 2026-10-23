// 所有可调数值的唯一落点。改玩法只改这里 + config/*.json。
// 初始值均为经验值，需要 tests/calibration.spec.ts 标定后微调。

export const BALANCE = {
  // === 世界 ===
  worldSeedDefault: 20261019,
  seasons: 3,
  clubsPerTier: [18, 20, 20, 20] as readonly number[],
  /** 世界基准强度参照点 */
  attrRef: 70,
  attrMin: 20,
  attrMax: 99,

  // === 比赛：xG 与泊松 ===
  baseXG: 1.35,
  strengthK: 0.03,
  homeAdvantage: 2.2,
  awayXGMultiplier: 0.88,
  xGMin: 0.15,
  xGMax: 4.2,

  // === 球队强度权重 ===
  wAttack: 0.38,
  wMidfield: 0.34,
  wDefense: 0.28,

  // === 战术对抗 ===
  tacticEdgeK: 0.45,
  tacticMatrix: {
    press: { press: 0, possess: 0.6, counter: -0.35 },
    possess: { press: -0.45, possess: 0, counter: 0.3 },
    counter: { press: 0.5, possess: -0.25, counter: 0 },
  } as Record<string, Record<string, number>>,

  // === 体能 / 疲劳 ===
  staminaMax: 100,
  staminaLowFactor: 0.72,
  lowStaminaWarning: 35,
  staminaPerMatch: 12,
  betweenMatchRecovery: 9,
  travelFatiguePerUnit: 2.5,
  crossConfederationExtra: 1.5,

  // === 半场交互（P7） ===
  subsAllowed: 3,
  cupSubsAllowed: 5,
  halfTimeMaxActions: 2,
  matchMaxInteractions: 3,
  subsK: 0.06,
  mentalityEdge: { conservative: -0.15, balanced: 0, aggressive: 0.2 } as Record<string, number>,
  momentWindowStartMinute: 70,
  momentAbilityK: 0.004,
  momentSuccessMin: 0.1,
  momentSuccessMax: 0.9,

  // === 点球 ===
  penaltyK: 0.006,
  penaltyBase: 0.5,
  penaltyMin: 0.35,
  penaltyMax: 0.65,
  penaltyRounds: 5,
  penaltyMaxSudden: 15,

  // === 球员评分 ===
  ratingBase: 6.0,
  ratingGoalWeight: 0.55,
  ratingAssistWeight: 0.35,
  ratingMarginK: 0.35,
  ratingWinBonus: 0.4,
  ratingLossPenalty: -0.3,
  ratingLuckRange: 0.25,
  ratingMin: 4.0,
  ratingMax: 10.0,

  // === 财政 ===
  tvBaseByTier: { 1: 90, 2: 32, 3: 9, 4: 2 } as Record<number, number>,
  sponsorBase: 20,
  ticketBase: 18,
  /**
   * 工资占收入的红线。P1-1：工资改回「赛季总额」口径后，T3/T4 的收入基数小，
   * generate 的工资单（rep*4+10..90）天然接近 0.75 → 0.75 会让小球队结构性挨罚，
   * 故放宽到 0.85（T1 中位 0.47 / T4 中位 0.72，仍有真实超支空间）。
   */
  wageRatioCap: 0.85,
  cashFloor: 50,
  budgetShare: 0.6,
  /** 上座率基数：fillRate = 0.35 + 声望/200 + 战绩修正（设计 §7.2） */
  ticketFillBase: 0.35,
  /** 差旅：每场 travelFatiguePerUnit × travelCostPerUnit × 联赛级别系数 */
  travelCostPerUnit: 0.08,
  /** 青训支出占收入比例 */
  academyCostRatio: 0.08,
  /** 债务年息（净资产为负时计息） */
  debtInterestRate: 0.04,

  // === 声望 ===
  reputationMax: 100,
  /** 俱乐部声望下限 */
  reputationMin: 5,
  famePointValue: 5,
  /** 夺冠 / 升级 / 洲际资格 / 降级的声望增减（设计 §7.3） */
  repChampionGain: 6,
  repPromotionGain: 5,
  repRelegationLoss: 6,
  repContinentalGain: 3,
  repRankGainK: 0.35,

  // === 成长与身价（设计 §7.4） ===
  /** 年龄系数：16-21 / 22-26 / 27-29 / 30+ */
  ageFactorYoung: 1.15,
  ageFactorPrime: 1.0,
  ageFactorLate: 0.6,
  ageFactorVeteran: 0.25,
  /** 出场时间系数：每场 1/38 的赛季出场率映射到 0.6~1.2 */
  minutesFactorMin: 0.6,
  minutesFactorMax: 1.2,
  /** 训练系数范围 */
  trainingMin: 0.85,
  trainingMax: 1.25,
  /** 身价年龄曲线（设计 §7.1 valueAgeCurve）：26 岁见顶，之后按 decline 衰减 */
  valuePeakAge: 26,
  valueDeclineK: 0.12,
  /** 身价基准：ability² × 系数 × 年龄/声望修正 */
  valueAbilityK: 0.9,
  valueReputationK: 0.6,

  // === 转会（设计 §7.1 / §15.7） ===
  transferRounds: 3,
  needFactor: 0.15,
  contractYearsFactorStep: 0.05,
  rivalInterestFactor: 0.2,
  agentFeeRatio: 0.08,
  loanWageShareDefault: 0.5,
  /** 每周 AI 转会笔数上限 */
  transferPerWeek: 3,
  /** 每队每窗最多引进人数 */
  transferMaxPerClub: 2,
  /** 每点球队属性折合转会费（万） */
  transferFeePerPoint: 6,
  /** 期望周薪 = 能力² / 该除数（万/周）：能力 80 ≈ 0.91 万/周 ≈ 47 万/赛季 */
  wageAbilityDivisor: 7000,
  /** 转会窗内玩家每周最多收到的报价数 */
  playerOffersPerWindow: 2,
  /** 报价方声望至少要比原俱乐部高这么多才来挖人 */
  offerReputationGap: 4,

  // === 国家队征召（设计 §7.1 / §3.7） ===
  callUpDifficultyBySporting: 0.85,
  /** 每次征召给的人气与国家队强度加成 */
  callUpFameGain: 4,
  callUpStrengthGain: 0.6,

  // === 生涯 ===
  careerStartAge: 16,
  careerMaxAge: 34,
  careerMaxSeasons: 18,
  honorValue: 60,
  scorePerRatingPoint: 120,
  /** 一季 52 周（设计 §5.1） */
  weeksPerSeason: 52,
  /** 能力上限（设计 §7.1 potentialMax） */
  potentialMax: 99,
  /** 成长率：成长 = rate × (potential - ability) × 年龄系数（设计 §7.4） */
  abilityGrowthRate: 0.19,
  /** 衰退起点：30 岁起每年按系数掉能力（补上设计 §7.4 的「30+ 回落」） */
  ageDeclineStart: 30,
  /** 衰退系数：每年 (age - ageDeclineStart + 1) × 该值，34 岁约 1.25 点/季 */
  ageDeclinePerYear: 0.25,

  // === 评级线 ===
  gradeLines: { S: 1550, A: 1230, B: 850, C: 560, D: 0 } as Record<string, number>,

  // === 双模式：生涯 / 经理 ===
  /** 生涯起始年龄（设计 §7.1） */
  careerEndAge: 34,
  /** 人气达到该值才可能被国家队征召（设计 §7.1） */
  nationalCallFame: 30,
  /** 解雇判定：董事会满意度低于该值 */
  fireBoardThreshold: 30,
  /** 解雇判定：连续多少个赛季没拿到洲际资格 */
  fireStreakSeasons: 2,
  /** 经理初始董事会满意度 */
  boardConfidenceStart: 60,
  /** 球迷情绪初值，0~100（唯一权威定义在设计 §9 PlayLayerState，这里只给初值） */
  fanMoodStart: 55,
  /** 球迷情绪平滑系数（设计 §7.1） */
  fanMoodSmoothing: 0.25,
  /** 自然衰减：每赛季声望按该比例回落（设计 §7.1） */
  reputationDecay: 0.04,
  /** 存档版本号（设计 §11.2） */
  saveVersion: 1,
  /** 存档写入防抖（毫秒，设计 §11.2） */
  saveDebounceMs: 400,

  // === 仿真分级 LOD ===
  lodAPlayers: true,
  lodBPlayers: false,
  lodCPlayers: false,
  perfBudgetMs: 800,
  saveMaxKB: 256,

  // === P7 可玩性（设计 §7.1 / §15） ===
  /** 同时活跃事件链上限 */
  chainMaxActive: 3,
  /** 赛后热评：单条最大长度与条数区间 */
  hotCommentMaxLen: 60,
  hotCommentCountMin: 3,
  hotCommentCountMax: 5,
  /** 董事会简报 / 媒体采访间隔周数 */
  boardBriefIntervalWeeks: 4,
  interviewIntervalWeeks: 5,
  /** AI 换帅：连续不胜周数、下课概率 */
  fireStreakWeeks: 5,
  fireChance: 0.35,
  /** 每赛季世界大事 / 转会传闻条数 */
  newsPerSeason: 3,
  transferRumorPerWeek: 1,
  /** 大赛年商业系数（世界杯 / 洲际杯年） */
  majorTournamentSponsorBonus: 1.1,
} as const;

export type Balance = typeof BALANCE;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 周薪（万/周）→ 赛季工资总额（万）：Σ周薪 × 52（设计 §7.2）。
 * P1-1：全项目只有这一处做「周 → 赛季」换算，财务、转会、谈判共用。
 */
export function seasonWagesOfWeekly(weekly: number): number {
  return round2(Math.max(0, weekly) * BALANCE.weeksPerSeason);
}

/** 赛季工资总额（万）→ 周薪（万/周） */
export function weeklyWageOfSeason(season: number): number {
  return round2(Math.max(0, season) / BALANCE.weeksPerSeason);
}

/** 球员期望周薪（万/周）：能力平方曲线，能力 80 ≈ 0.91 万/周 ≈ 47 万/赛季 */
export function weeklyWageOfAbility(ability: number): number {
  const a = Math.max(0, ability);
  return Math.max(0.05, round2((a * a) / BALANCE.wageAbilityDivisor));
}
