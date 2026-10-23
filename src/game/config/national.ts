import type { ConfederationId } from '../types';

/**
 * 国家队线的缩放参数（MVP）。
 *
 * 设计文档描述的是一个「六大洲 64+ 支国家队」的世界，但 2.3 节把世界人口压到 12 国
 * 以保住 776 家俱乐部与生成性能，于是国家队世界也只有 12 支。
 * 因此这里的名额是**按比例缩放后的真实值**，而不是照抄文档的 32/24/16。
 * 缩放规则：所有名额之和必须严格等于该赛事的参赛队数（单测锁死，见 3.3 的硬校验）。
 */

/**
 * 世界杯决赛圈名额。
 * UEFA 3 + CONMEBOL 2 + AFC 1 + CAF 1 + CONCACAF 1 = 8 队。
 * OFC 0 席（可经跨洲附加赛递补，MVP 暂不实现附加赛，直接以外卡形式记入新闻）。
 */
export const WORLD_CUP_SLOTS: Record<ConfederationId, number> = {
  UEFA: 3,
  CONMEBOL: 2,
  AFC: 1,
  CAF: 1,
  CONCACAF: 1,
  OFC: 0,
};

/** 世界杯决赛圈参赛队数 = 名额之和，必须相等 */
export const WORLD_CUP_SIZE = 8;

/**
 * 洲际国家队杯赛名额。成员数 < 2 的洲没有杯赛（1 支队的「杯赛」没有意义）。
 * UEFA 4（欧洲杯）/ CONMEBOL 2（美洲杯）/ AFC 2（亚洲杯）/ 其余 0。
 */
export const CONTINENTAL_CUP_SLOTS: Record<ConfederationId, number> = {
  UEFA: 4,
  CONMEBOL: 2,
  AFC: 2,
  CAF: 0,
  CONCACAF: 0,
  OFC: 0,
};

/**
 * 国家联赛窗口。
 * 取 CALENDAR.nationalWindows 的前 4 个（6/10/14/18），单循环轮次铺在这里。
 * 后两个窗口（33/37）与 43 留给洲际杯 / 世界杯淘汰赛。
 */
export const NATIONAL_LEAGUE_WEEKS: readonly number[] = [6, 10, 14, 18];

/** 国家队淘汰赛窗口：8 队世界杯正好 QF(33) → SF(37) → F(43) 三轮 */
export const NATIONAL_KNOCKOUT_WEEKS: readonly number[] = [33, 37, 43];

/** 国家联赛级别，从小到大；MVP 只用得上前 4 级 */
export const NATIONS_LEAGUE_TIERS = ['A', 'B', 'C', 'D'] as const;
export type NationsLeagueTier = (typeof NATIONS_LEAGUE_TIERS)[number];

/** 一个级别内的最大队数（文档要求 4 队一组） */
export const NATIONS_LEAGUE_MAX_GROUP = 4;

/**
 * 国家联赛级别数：
 * - 0~1 支队：不办（返回 0）
 * - 2~4 支队：1 级
 * - 5~8 支队：2 级
 * - 依此类推，最多 4 级
 *
 * 现状：UEFA 5 支 → 2 级（A 3 队 / B 2 队），CONMEBOL 2 支 → 1 级，AFC 2 支 → 1 级，
 * CAF / CONCACAF / OFC 各 1 支 → 不办。
 */
export function nationsLeagueLevelCount(teamCount: number): number {
  if (teamCount < 2) return 0;
  return Math.min(NATIONS_LEAGUE_TIERS.length, Math.ceil(teamCount / NATIONS_LEAGUE_MAX_GROUP));
}

/**
 * 把已按实力降序排好的球队切成尽量均等的 n 份。
 * 例：5 支队 2 级 → [3, 2]；7 支队 2 级 → [4, 3]；6 支队 2 级 → [3, 3]。
 */
export function splitIntoLevels<T>(rankedTeams: T[], levels: number): T[][] {
  if (levels <= 0 || rankedTeams.length === 0) return [];
  const base = Math.floor(rankedTeams.length / levels);
  const remainder = rankedTeams.length % levels;
  const out: T[][] = [];
  let cursor = 0;
  for (let i = 0; i < levels; i += 1) {
    const size = base + (i < remainder ? 1 : 0);
    out.push(rankedTeams.slice(cursor, cursor + size));
    cursor += size;
  }
  return out;
}

/** 大赛周期类型：每 4 赛季一个循环，见 `majorTournamentOf` */
export type MajorTournament = 'continental-cup' | 'world-cup' | null;

/**
 * 每 4 赛季一个大赛周期：`%4===2` 洲际杯年、`%4===3` 世界杯年，其余年份只有国家联赛。
 *
 * 为什么不是文档里的「错开 2 年」：MVP 只验收前 3 个赛季，而**资格链必须在前一赛季末产出**
 * （finishSeason 算的是 nextSeason 的名额）。用 2/3 相邻排列时：
 * `finish(第1季)` → 第 2 季洲际杯名额；`finish(第2季)` → 第 3 季世界杯名额，
 * 两条大赛的资格链在验收期内都能被真实走通，4 年周期本身不变。
 */
export function majorTournamentOf(season: number): MajorTournament {
  const r = ((season % 4) + 4) % 4;
  if (r === 2) return 'continental-cup';
  if (r === 3) return 'world-cup';
  return null;
}

/** 国家联赛赛事 id：`{conf}-nl-{tier}`，小写 */
export function nationsLeagueId(confederationId: ConfederationId, tier: NationsLeagueTier): string {
  return `${confederationId.toLowerCase()}-nl-${tier.toLowerCase()}`;
}

/** 洲际国家队杯赛 id：`{conf}-national-cup`（与 generate.ts 的赛事定义对齐） */
export function continentalCupId(confederationId: ConfederationId): string {
  return `${confederationId.toLowerCase()}-national-cup`;
}

export const WORLD_CUP_ID = 'fifa-world-cup';

/** 级别加成：把「在更高级别」换算成世界杯资格系数的一部分，让升降级有意义 */
export const NATIONS_LEAGUE_TIER_BONUS: Record<NationsLeagueTier, number> = {
  A: 4,
  B: 2,
  C: 0,
  D: -2,
};
