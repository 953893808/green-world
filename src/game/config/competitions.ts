import type { ConfederationId, DrawRules } from '../types';

/**
 * 赛事元数据（名称 / 参赛队数来源 / 抽签规则）。
 * 3.x 节要求：赛事结构、名额、抽签约束全部走配置，rules.ts 只解释不硬编赛事 id。
 */
export interface ContinentalMeta {
  id: string;
  name: string;
  nameZh: string;
  /** 1 = 顶级，2 = 第二级，3 = 第三级 */
  tier: 1 | 2 | 3;
  confederationId: ConfederationId;
  draw: DrawRules;
}

const CLUB_DRAW: DrawRules = {
  pots: 4,
  potBy: 'reputation',
  avoidSameCountry: true,
  avoidSameConfederation: false,
};

function meta(
  confederationId: ConfederationId,
  id: string,
  name: string,
  nameZh: string,
  tier: 1 | 2 | 3,
): ContinentalMeta {
  return { id, name, nameZh, tier, confederationId, draw: CLUB_DRAW };
}

export const CONTINENTAL_COMPETITIONS: ContinentalMeta[] = [
  meta('UEFA', 'uefa-cl', 'Champions Cup', '欧洲冠军杯', 1),
  meta('UEFA', 'uefa-el', 'Europa Cup', '欧洲联盟杯', 2),
  meta('UEFA', 'uefa-uecl', 'Conference Cup', '欧洲协会杯', 3),
  meta('CONMEBOL', 'conmebol-libertadores', 'Libertadores Cup', '南美解放者杯', 1),
  meta('CONMEBOL', 'conmebol-sudamericana', 'Sudamericana Cup', '南美杯', 2),
  meta('AFC', 'afc-cl', 'AFC Champions Cup', '亚足联冠军联赛', 1),
  meta('AFC', 'afc-cup', 'AFC Cup', '亚足联杯', 2),
  meta('CAF', 'caf-cl', 'CAF Champions Cup', '非洲冠军联赛', 1),
  meta('CAF', 'caf-confed', 'CAF Confederation Cup', '非洲联盟杯', 2),
  meta('CONCACAF', 'concacaf-cl', 'CONCACAF Champions Cup', '中北美冠军联赛', 1),
  meta('CONCACAF', 'concacaf-central', 'CONCACAF Central Cup', '中北美中央杯', 2),
  meta('OFC', 'ofc-cl', 'OFC Champions Cup', '大洋洲冠军联赛', 1),
];

export const CLUB_WORLD = {
  id: 'fifa-club-world',
  name: 'FIFA Club World Cup',
  nameZh: '国际足联俱乐部世界杯',
  /** 名额守恒：3 + 2 + 2 + 2 + 2 + 1 = 12（冠军） + 19（排名） + 1（主办） = 32 */
  participants: 32,
  draw: {
    pots: 4,
    potBy: 'reputation',
    avoidSameCountry: true,
    avoidSameConfederation: true,
  } as DrawRules,
} as const;

/** 国内杯赛参赛队数（每国顶级联赛取前 N） */
export const DOMESTIC_CUP_ENTRANTS = 16;

/** 按联合会取该洲全部洲际赛事，按级别升序 */
export function continentalOf(confederationId: ConfederationId): ContinentalMeta[] {
  return CONTINENTAL_COMPETITIONS.filter((c) => c.confederationId === confederationId).sort(
    (a, b) => a.tier - b.tier,
  );
}

/** 按 id 取洲际赛事元数据 */
export function continentalById(id: string): ContinentalMeta | undefined {
  return CONTINENTAL_COMPETITIONS.find((c) => c.id === id);
}
