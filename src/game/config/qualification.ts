import type {
  ConfederationId,
  DrawRules,
  PromotionRule,
  QualificationRule,
  RankRange,
} from '../types';
import { CONFEDERATIONS } from './confederations';
import { COUNTRIES } from './countries';

/**
 * 资格链 / 升降级 / 抽签约束的配置表（3.3~3.5 节）。
 * 规则层只解释这里的数据，绝不出现任何具体赛事 id 的判断分支。
 */

function countriesOf(confederationId: ConfederationId): string[] {
  const conf = CONFEDERATIONS.find((c) => c.id === confederationId);
  return conf ? [...conf.countries] : [];
}

/** 给一组国家同一个名次区间 */
function rangeOf(countryIds: readonly string[], from: number, to: number): Record<string, RankRange> {
  const out: Record<string, RankRange> = {};
  for (const id of countryIds) out[id] = [from, to];
  return out;
}

/** 给一组国家同样的固定名额 */
function slotsOf(countryIds: readonly string[], n: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of countryIds) out[id] = n;
  return out;
}

/** 名次区间长度 = 名额数 */
export function rangeSize(range: RankRange): number {
  return range[1] - range[0] + 1;
}

/** 优先级：数字越小越先占名额 */
export const RULE_PRIORITY = {
  leagueTop: 10,
  leagueRest: 20,
  cupWinner: 30,
  cupRunnerUp: 40,
  continentalChampion: 50,
  continentalRank: 60,
  host: 70,
  fill: 90,
} as const;

/** 32 强赛或 16 强赛的参赛队数 */
const TIER1 = 32;
const TIER2 = 32;
const TIER3 = 32;

const UEFA = countriesOf('UEFA');
const CONMEBOL = countriesOf('CONMEBOL');
const AFC = countriesOf('AFC');
const CAF = countriesOf('CAF');
const CONCACAF = countriesOf('CONCACAF');
const OFC = countriesOf('OFC');

/**
 * 各洲际俱乐部赛的名额配方。
 *
 * 守恒等式（单测锁死）：
 * - uefa-cl   8+7+6+6+5                         = 32
 * - uefa-el   8+7+6+6+5                         = 32
 * - uefa-uecl 5 国 × 3（l2）+ 5 杯赛冠军 + 12 递补 = 32
 * - libertadores 8+8（l1）+ 4+4（l2）+ 8 递补    = 32
 * - sudamericana 8+8（l1）+ 2 杯赛冠军 + 14 递补  = 32
 * - afc-cl    10+10 + 2 杯赛冠军 + 10 递补       = 32
 * - afc-cup   6+6（l2）+ 2 杯赛亚军 + 18 递补     = 32
 * - caf-cl    16（l1 1-16）+ 1 杯赛冠军（可能重复，递补） = 16
 * - caf-confed 8（l2）+ 1 + 23 递补              = 32
 * （CAF 只有 1 国 58 队；两赛若都 32 需 64 支不重复球队，故 CAF 冠军联赛定为 16 队）
 * - concacaf-cl 10 + 1 + 5 递补                  = 16
 * - concacaf-central 6（l2）+ 1 + 9 递补         = 16
 * - ofc-cl    10 + 1 + 5 递补                    = 16
 */
export const CONTINENTAL_RULES: QualificationRule[] = [
  // ── UEFA ──
  {
    id: 'uefa-cl-league',
    toCompetitionId: 'uefa-cl',
    source: 'league',
    fromTemplate: '{country}-l1',
    rankRange: { ENG: [1, 8], ESP: [1, 7], GER: [1, 6], ITA: [1, 6], FRA: [1, 5] },
    priority: RULE_PRIORITY.leagueTop,
    note: '国内顶级联赛头部名次直通欧洲冠军杯',
  },
  {
    id: 'uefa-el-league',
    toCompetitionId: 'uefa-el',
    source: 'league',
    fromTemplate: '{country}-l1',
    rankRange: { ENG: [9, 16], ESP: [8, 14], GER: [7, 12], ITA: [7, 12], FRA: [6, 10] },
    priority: RULE_PRIORITY.leagueRest,
    note: '冠军杯之后的名次区间进入欧洲联盟杯',
  },
  {
    id: 'uefa-uecl-l2',
    toCompetitionId: 'uefa-uecl',
    source: 'league',
    fromTemplate: '{country}-l2',
    rankRange: rangeOf(UEFA, 1, 3),
    priority: RULE_PRIORITY.leagueRest,
    note: '各国次级联赛前 3 名进入欧洲协会杯',
  },
  {
    id: 'uefa-uecl-cup',
    toCompetitionId: 'uefa-uecl',
    source: 'cup-winner',
    fromTemplate: '{country}-cup',
    slotsByCountry: slotsOf(UEFA, 1),
    priority: RULE_PRIORITY.cupWinner,
    note: '国内杯赛冠军进入欧洲协会杯',
  },
  {
    id: 'uefa-uecl-fill',
    toCompetitionId: 'uefa-uecl',
    source: 'league',
    fromTemplate: '',
    priority: RULE_PRIORITY.fill,
    fillRemaining: true,
    note: '剩余名额按近季综合排名递补',
  },

  // ── CONMEBOL ──
  {
    id: 'libertadores-league',
    toCompetitionId: 'conmebol-libertadores',
    source: 'league',
    fromTemplate: '{country}-l1',
    rankRange: rangeOf(CONMEBOL, 1, 8),
    priority: RULE_PRIORITY.leagueTop,
    note: '南美各国顶级联赛前 8 名进入解放者杯',
  },
  {
    id: 'libertadores-l2',
    toCompetitionId: 'conmebol-libertadores',
    source: 'league',
    fromTemplate: '{country}-l2',
    rankRange: rangeOf(CONMEBOL, 1, 4),
    priority: RULE_PRIORITY.leagueRest,
    note: '次级联赛前 4 名获得解放者杯资格',
  },
  {
    id: 'libertadores-fill',
    toCompetitionId: 'conmebol-libertadores',
    source: 'league',
    fromTemplate: '',
    priority: RULE_PRIORITY.fill,
    fillRemaining: true,
    note: '剩余名额按近季综合排名递补',
  },
  {
    id: 'sudamericana-league',
    toCompetitionId: 'conmebol-sudamericana',
    source: 'league',
    fromTemplate: '{country}-l1',
    rankRange: rangeOf(CONMEBOL, 9, 16),
    priority: RULE_PRIORITY.leagueRest,
    note: '顶级联赛中段名次进入南美杯',
  },
  {
    id: 'sudamericana-cup',
    toCompetitionId: 'conmebol-sudamericana',
    source: 'cup-winner',
    fromTemplate: '{country}-cup',
    slotsByCountry: slotsOf(CONMEBOL, 1),
    priority: RULE_PRIORITY.cupWinner,
    note: '国内杯赛冠军进入南美杯',
  },
  {
    id: 'sudamericana-fill',
    toCompetitionId: 'conmebol-sudamericana',
    source: 'league',
    fromTemplate: '',
    priority: RULE_PRIORITY.fill,
    fillRemaining: true,
    note: '剩余名额按近季综合排名递补',
  },

  // ── AFC ──
  {
    id: 'afc-cl-league',
    toCompetitionId: 'afc-cl',
    source: 'league',
    fromTemplate: '{country}-l1',
    rankRange: rangeOf(AFC, 1, 10),
    priority: RULE_PRIORITY.leagueTop,
    note: '亚洲顶级联赛前 10 名进入亚足联冠军联赛',
  },
  {
    id: 'afc-cl-cup',
    toCompetitionId: 'afc-cl',
    source: 'cup-winner',
    fromTemplate: '{country}-cup',
    slotsByCountry: slotsOf(AFC, 1),
    priority: RULE_PRIORITY.cupWinner,
    note: '国内杯赛冠军进入亚足联冠军联赛',
  },
  {
    id: 'afc-cl-fill',
    toCompetitionId: 'afc-cl',
    source: 'league',
    fromTemplate: '',
    priority: RULE_PRIORITY.fill,
    fillRemaining: true,
    note: '剩余名额按近季综合排名递补',
  },
  {
    id: 'afc-cup-l2',
    toCompetitionId: 'afc-cup',
    source: 'league',
    fromTemplate: '{country}-l2',
    rankRange: rangeOf(AFC, 1, 6),
    priority: RULE_PRIORITY.leagueRest,
    note: '次级联赛前 6 名进入亚足联杯',
  },
  {
    id: 'afc-cup-cup',
    toCompetitionId: 'afc-cup',
    source: 'cup-runnerup',
    fromTemplate: '{country}-cup',
    slotsByCountry: slotsOf(AFC, 1),
    priority: RULE_PRIORITY.cupRunnerUp,
    note: '国内杯赛亚军进入亚足联杯',
  },
  {
    id: 'afc-cup-fill',
    toCompetitionId: 'afc-cup',
    source: 'league',
    fromTemplate: '',
    priority: RULE_PRIORITY.fill,
    fillRemaining: true,
    note: '剩余名额按近季综合排名递补',
  },

  // ── CAF ──
  {
    id: 'caf-cl-league',
    toCompetitionId: 'caf-cl',
    source: 'league',
    fromTemplate: '{country}-l1',
    rankRange: rangeOf(CAF, 1, 15),
    priority: RULE_PRIORITY.leagueTop,
    note: '非洲顶级联赛前 15 名 + 杯赛冠军构成 16 队',
  },
  {
    id: 'caf-cl-cup',
    toCompetitionId: 'caf-cl',
    source: 'cup-winner',
    fromTemplate: '{country}-cup',
    slotsByCountry: slotsOf(CAF, 1),
    priority: RULE_PRIORITY.cupWinner,
    note: '国内杯赛冠军进入非洲冠军联赛',
  },
  {
    id: 'caf-cl-fill',
    toCompetitionId: 'caf-cl',
    source: 'league',
    fromTemplate: '',
    priority: RULE_PRIORITY.fill,
    fillRemaining: true,
    note: '剩余名额按近季综合排名递补',
  },
  {
    id: 'caf-confed-l2',
    toCompetitionId: 'caf-confed',
    source: 'league',
    fromTemplate: '{country}-l2',
    rankRange: rangeOf(CAF, 1, 8),
    priority: RULE_PRIORITY.leagueRest,
    note: '次级联赛前 8 名进入非洲联盟杯',
  },
  {
    id: 'caf-confed-cup',
    toCompetitionId: 'caf-confed',
    source: 'cup-runnerup',
    fromTemplate: '{country}-cup',
    slotsByCountry: slotsOf(CAF, 1),
    priority: RULE_PRIORITY.cupRunnerUp,
    note: '国内杯赛亚军进入非洲联盟杯',
  },
  {
    id: 'caf-confed-fill',
    toCompetitionId: 'caf-confed',
    source: 'league',
    fromTemplate: '',
    priority: RULE_PRIORITY.fill,
    fillRemaining: true,
    note: '剩余名额按近季综合排名递补',
  },

  // ── CONCACAF ──
  {
    id: 'concacaf-cl-league',
    toCompetitionId: 'concacaf-cl',
    source: 'league',
    fromTemplate: '{country}-l1',
    rankRange: rangeOf(CONCACAF, 1, 10),
    priority: RULE_PRIORITY.leagueTop,
    note: '中北美顶级联赛前 10 名进入冠军杯',
  },
  {
    id: 'concacaf-cl-cup',
    toCompetitionId: 'concacaf-cl',
    source: 'cup-winner',
    fromTemplate: '{country}-cup',
    slotsByCountry: slotsOf(CONCACAF, 1),
    priority: RULE_PRIORITY.cupWinner,
    note: '国内杯赛冠军进入中北美冠军杯',
  },
  {
    id: 'concacaf-cl-fill',
    toCompetitionId: 'concacaf-cl',
    source: 'league',
    fromTemplate: '',
    priority: RULE_PRIORITY.fill,
    fillRemaining: true,
    note: '剩余名额按近季综合排名递补',
  },
  {
    id: 'concacaf-central-l2',
    toCompetitionId: 'concacaf-central',
    source: 'league',
    fromTemplate: '{country}-l2',
    rankRange: rangeOf(CONCACAF, 1, 6),
    priority: RULE_PRIORITY.leagueRest,
    note: '次级联赛前 6 名进入中北美中央杯',
  },
  {
    id: 'concacaf-central-cup',
    toCompetitionId: 'concacaf-central',
    source: 'cup-runnerup',
    fromTemplate: '{country}-cup',
    slotsByCountry: slotsOf(CONCACAF, 1),
    priority: RULE_PRIORITY.cupRunnerUp,
    note: '国内杯赛亚军进入中北美中央杯',
  },
  {
    id: 'concacaf-central-fill',
    toCompetitionId: 'concacaf-central',
    source: 'league',
    fromTemplate: '',
    priority: RULE_PRIORITY.fill,
    fillRemaining: true,
    note: '剩余名额按近季综合排名递补',
  },

  // ── OFC ──
  {
    id: 'ofc-cl-league',
    toCompetitionId: 'ofc-cl',
    source: 'league',
    fromTemplate: '{country}-l1',
    rankRange: rangeOf(OFC, 1, 10),
    priority: RULE_PRIORITY.leagueTop,
    note: '大洋洲顶级联赛前 10 名进入冠军联赛',
  },
  {
    id: 'ofc-cl-cup',
    toCompetitionId: 'ofc-cl',
    source: 'cup-winner',
    fromTemplate: '{country}-cup',
    slotsByCountry: slotsOf(OFC, 1),
    priority: RULE_PRIORITY.cupWinner,
    note: '国内杯赛冠军进入大洋洲冠军联赛',
  },
  {
    id: 'ofc-cl-fill',
    toCompetitionId: 'ofc-cl',
    source: 'league',
    fromTemplate: '',
    priority: RULE_PRIORITY.fill,
    fillRemaining: true,
    note: '剩余名额按近季综合排名递补',
  },
];

/**
 * 世俱杯：32 队。
 * 各洲冠军 1 队（6）+ 各洲剩余名额（UEFA 11 / CONMEBOL 5 / AFC 3 / CAF 3 / CONCACAF 3 / OFC 0 = 25）
 * + 主办国 1 队 = 32。
 */
export const CLUB_WORLD_RULES: QualificationRule[] = [
  {
    id: 'cwc-continental-champion',
    toCompetitionId: 'fifa-club-world',
    source: 'continental-champion',
    fromTemplate: '{confederation}-cl',
    slotsByConfederation: slotsOf(CONFEDERATIONS.map((c) => c.id), 1),
    priority: RULE_PRIORITY.continentalChampion,
    note: '各洲顶级俱乐部赛事冠军直接进入世俱杯',
  },
  {
    id: 'cwc-continental-rank',
    toCompetitionId: 'fifa-club-world',
    source: 'continental-rank',
    fromTemplate: '{confederation}-cl',
    slotsByConfederation: {
      UEFA: 11,
      CONMEBOL: 5,
      AFC: 3,
      CAF: 3,
      CONCACAF: 3,
      OFC: 0,
    },
    priority: RULE_PRIORITY.continentalRank,
    note: '各洲按近季洲际赛事综合排名分配剩余名额',
  },
  {
    id: 'cwc-host',
    toCompetitionId: 'fifa-club-world',
    source: 'host',
    fromTemplate: '{country}-l1',
    priority: RULE_PRIORITY.host,
    note: '主办国联赛冠军自动获得资格',
  },
];

export const CLUB_QUALIFICATION_RULES: QualificationRule[] = [
  ...CONTINENTAL_RULES,
  ...CLUB_WORLD_RULES,
];

/** 按目标赛事取规则，按优先级排序（规则层唯一读取入口） */
export function rulesForCompetition(competitionId: string): QualificationRule[] {
  return CLUB_QUALIFICATION_RULES.filter((r) => r.toCompetitionId === competitionId).sort(
    (a, b) => a.priority - b.priority,
  );
}

/** 国内联赛升降级：T1 末 3 ↔ T2 前 3；T2 末 3 ↔ T3 前 3；T3 末 4 ↔ T4 前 4 */
export const PROMOTION_RULES: PromotionRule[] = [
  { fromTier: 2, toTier: 1, up: 3, down: 3, note: '次级联赛前 3 升入顶级，顶级末 3 降级' },
  { fromTier: 3, toTier: 2, up: 3, down: 3, note: '第三级前 3 升入次级，次级末 3 降级' },
  { fromTier: 4, toTier: 3, up: 4, down: 4, note: '第四级前 4 升入第三级，第三级末 4 降级' },
];

/** 俱乐部的联赛体系是否开放（MVP 只有 open；closed 仅作为配置开关展示） */
export function leagueSystemOf(countryId: string): 'open' | 'closed' {
  const country = COUNTRIES.find((c) => c.id === countryId);
  if (!country) return 'open';
  // 中北美允许封闭体系；MVP 默认全部开放，改这个数组即可切换
  const closedCountries: string[] = [];
  return closedCountries.includes(country.id) ? 'closed' : 'open';
}

/** 抽签约束：俱乐部赛事默认同国回避；世俱杯额外同洲回避 */
const CLUB_DRAW: DrawRules = {
  pots: 4,
  potBy: 'reputation',
  avoidSameCountry: true,
  avoidSameConfederation: false,
};

const WORLD_DRAW: DrawRules = {
  pots: 4,
  potBy: 'reputation',
  avoidSameCountry: true,
  avoidSameConfederation: true,
  maxPerConfederation: { UEFA: 8 },
};

/** 按赛事 id 取抽签规则；未单独配置的赛事用俱乐部默认规则 */
export function drawRulesOf(competitionId: string): DrawRules {
  return competitionId === 'fifa-club-world' ? WORLD_DRAW : CLUB_DRAW;
}

/** 各洲际俱乐部赛的目标参赛队数（16 或 32），供资格守恒单测使用 */
export const CONTINENTAL_PARTICIPANTS: Record<string, number> = {
  'uefa-cl': TIER1,
  'uefa-el': TIER2,
  'uefa-uecl': TIER3,
  'conmebol-libertadores': TIER1,
  'conmebol-sudamericana': TIER2,
  'afc-cl': TIER1,
  'afc-cup': TIER2,
  // CAF 仅 1 国 58 队，两赛合计不能超过 58；与真实 CAF 冠军联赛 16 队对齐
  'caf-cl': 16,
  'caf-confed': TIER2,
  'concacaf-cl': 16,
  'concacaf-central': 16,
  'ofc-cl': 16,
};

/** 规则表合起来的名额总数（fillRemaining 规则不计），用于守恒校验 */
export function declaredSlotsOf(competitionId: string): number {
  let total = 0;
  for (const rule of rulesForCompetition(competitionId)) {
    if (rule.fillRemaining) continue;
    for (const n of Object.values(rule.slotsByCountry ?? {})) total += n;
    for (const n of Object.values(rule.slotsByConfederation ?? {})) total += n;
    for (const range of Object.values(rule.rankRange ?? {})) total += rangeSize(range);
  }
  return total;
}

export const QUALIFICATION_CONFIG = {
  rules: CLUB_QUALIFICATION_RULES,
  promotionRules: PROMOTION_RULES,
  continentalParticipants: CONTINENTAL_PARTICIPANTS,
} as const;
