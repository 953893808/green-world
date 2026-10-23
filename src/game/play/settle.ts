import { finishSeason } from '../rules/qualify';
import { settleFinances } from './finance';
import { settleReputations } from './reputation';
import type { WorldState } from '../types';

/**
 * 赛季结算管线（P0-1 / P0-3 修复）。
 *
 * 修复前的三个问题：
 *  1. `finishSeason` 直到玩家点「进入下一季」才执行，而 `settleCareerSeason`
 *     在赛季最后一周就读 `world.seasonSummary` → 荣誉恒为空；
 *  2. `settleCareerWorld` 全仓没有人调用（`settleFinances` 没有生产调用）→ 财政从不结算；
 *  3. 两段结算都没有幂等守卫 → 连点「推进一周」会重复结算（年龄 17→20、身价翻三倍）。
 *
 * 现在的顺序（生涯 / 经理两种模式共用）：
 *  1. `finishSeason`：名次快照 → 升降级 → 下赛季参赛权 → seasonSummary（已 finished 则跳过）；
 *  2. 财政结算：一年一次，覆盖全部俱乐部（含刚升降级、换了新级别收入模型的队）；
 *  3. 声望结算：读取第 1 步产出的本赛季冠军 / 升降级 / 下赛季洲际资格；
 *  4. 玩家侧结算（荣誉、成长、董事会）由调用方负责，并用 `state.lastSettledSeason` 保证只做一次。
 *
 * 注意：第 3 步必须在第 1 步之后执行 —— `world.qualifications` 在 finish 前还是「本赛季」
 * 的参赛权，finish 后才是「下赛季」的资格，经理线考核拿的是后者（P1-3 语义修正）。
 */
export function finishSeasonIfNeeded(world: WorldState): WorldState {
  return world.finished ? world : finishSeason(world);
}

/** 对**已经 finish**（seasonSummary 已写）的世界做财政 + 声望结算，不重复 finish */
export function settleSeasonWorld(world: WorldState): WorldState {
  const summary = world.seasonSummary;
  const champions = summary ? Object.values(summary.champions) : [];
  const promoted = (summary?.promoted ?? []).map((p) => p.clubId);
  const relegated = (summary?.relegated ?? []).map((p) => p.clubId);

  // 财政：一年一次，覆盖全部俱乐部。修复前只结算 tier<=2 且没有任何调用点。
  const withFinance = settleFinances(world, world.clubs.map((c) => c.id));
  return settleReputations(withFinance, { champions, promoted, relegated }).world;
}

/** finish + 财政 + 声望；幂等：已 finished 的世界直接返回，避免重复扣钱/改声望 */
export function settleWorldAtSeasonEnd(world: WorldState): WorldState {
  if (world.finished) return world;
  return settleSeasonWorld(finishSeason(world));
}

/**
 * 「赛季结束但玩家侧还没结算」时的一次性收尾：
 *  - 世界没 finish → 走完整管线；
 *  - 世界已 finish 但玩家侧没结算（旧档 / 上次中断）→ 只补玩家侧，不再碰世界财政。
 */
export function isSeasonSettled(state: { lastSettledSeason?: number }, season: number): boolean {
  return state.lastSettledSeason === season;
}
