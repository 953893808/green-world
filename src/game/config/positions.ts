import type { Player } from '../types';

/**
 * 球员位置（设计 §4.1：开局可选 6 种）。
 *
 * 底层 `Player.position` 只有 GK / DF / MF / FW 四类 —— 比赛模拟、进球分配、
 * 成长公式都只认这四类。所以「细位置」只作为开局选择与展示，落库时归到 base。
 *
 * 归并关系直接决定球员的进球/助攻份额（见 `play/career.ts` 的 SCORING_SHARE），
 * 所以边锋归 FW、前腰/后腰归 MF、中卫归 DF —— 玩家选的球风会真实体现在数据上
 * 的另一半由 `scoringTilt` / `assistTilt` 承担。
 */

export type DetailPosition = 'FW' | 'WF' | 'AM' | 'DM' | 'CB' | 'GK';

export interface PositionDef {
  id: DetailPosition;
  base: Player['position'];
  label: string;
  hint: string;
  /** 进球份额倍率（1 = 按 base 的默认份额） */
  scoringTilt: number;
  /** 助攻份额倍率 */
  assistTilt: number;
}

export const POSITIONS: PositionDef[] = [
  { id: 'FW', base: 'FW', label: '前锋', hint: '进球最多，评分波动最大', scoringTilt: 1, assistTilt: 1 },
  { id: 'WF', base: 'FW', label: '边锋', hint: '进球略少、助攻更多', scoringTilt: 0.85, assistTilt: 1.6 },
  { id: 'AM', base: 'MF', label: '前腰', hint: '助攻与关键传球的核心', scoringTilt: 1.25, assistTilt: 1.5 },
  { id: 'DM', base: 'MF', label: '后腰', hint: '抢断多、评分稳，进球少', scoringTilt: 0.6, assistTilt: 0.8 },
  { id: 'CB', base: 'DF', label: '中卫', hint: '球队失球越少评分越高', scoringTilt: 0.5, assistTilt: 0.8 },
  { id: 'GK', base: 'GK', label: '门将', hint: '几乎不进球，靠零封拉评分', scoringTilt: 1, assistTilt: 1 },
];

export const DEFAULT_POSITION: DetailPosition = 'FW';

export function positionOf(id: string | undefined): PositionDef | undefined {
  return POSITIONS.find((p) => p.id === id);
}

/** 细位置 → 底层四类；未知值退回 MF（与旧存档的默认一致） */
export function basePositionOf(id: string | undefined): Player['position'] {
  return positionOf(id)?.base ?? 'MF';
}
