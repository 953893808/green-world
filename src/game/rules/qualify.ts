import type {
  Club,
  DrawRules,
  QualificationEntry,
  QualificationRule,
  Reason,
  SeasonSummary,
  WorldState,
} from '../types';
import { CONFEDERATIONS } from '../config/confederations';
import {
  CONTINENTAL_PARTICIPANTS,
  PROMOTION_RULES,
  drawRulesOf,
  rulesForCompetition,
} from '../config/qualification';
import { computeStandings, sortRows } from './standings';
import { finishNationalSeason } from '../national/advance';
import { createSeason } from '../world/schedule';

const CLUB_WORLD_ID = 'fifa-club-world';

/** 俱乐部声望查询（排序用的确定性兜底键） */
function reputationOf(world: WorldState, clubId: string): number {
  return world.clubs.find((c) => c.id === clubId)?.reputation ?? 0;
}

/** 把规则模板里的占位符换成真实赛事 id（唯一允许的模板解析处） */
export function competitionIdOf(
  template: string,
  ctx: { countryId?: string; confederationId?: string } = {},
): string {
  return template
    .replace('{country}', (ctx.countryId ?? '').toLowerCase())
    .replace('{confederation}', (ctx.confederationId ?? '').toLowerCase());
}

/** 目标赛事的参赛队数；不在表里的按 32 处理 */
function participantsOf(competitionId: string): number {
  if (competitionId === CLUB_WORLD_ID) return 32;
  return CONTINENTAL_PARTICIPANTS[competitionId] ?? 32;
}

/** 某洲顶级俱乐部赛 id（从联合会配置里读，不写死） */
function confederationTopCompetition(confederationId: string): string | undefined {
  const conf = CONFEDERATIONS.find((c) => c.id === confederationId);
  return conf?.clubCompetitions[0];
}

/** 上赛季某赛事的完整名次表（联赛取积分榜，淘汰赛取淘汰轮次） */
export function seasonRanking(world: WorldState, competitionId: string): string[] {
  const snapshot = world.lastSeasonRanks[competitionId];
  if (snapshot) return snapshot;
  const ko = world.knockouts[competitionId];
  if (ko && ko.championId) {
    const ranking = [ko.championId, ...ko.eliminated.slice().reverse()];
    return [...new Set(ranking)];
  }
  return [];
}

function hostCountryOf(world: WorldState): string | undefined {
  const sorted = world.countries.slice().sort((a, b) => a.id.localeCompare(b.id));
  if (sorted.length === 0) return undefined;
  return sorted[world.season % sorted.length]?.id;
}

/** 某赛事的候选池（补名额时用）：按上季名次优先、声望其次 */
function candidatePool(world: WorldState, competitionId: string): string[] {
  const comp = world.competitions.find((c) => c.id === competitionId);
  const scoped = comp?.confederationId
    ? world.clubs.filter((c) => c.confederationId === comp.confederationId)
    : world.clubs;
  const rankIndex = new Map<string, number>();
  const topComp = comp?.confederationId
    ? confederationTopCompetition(comp.confederationId)
    : undefined;
  const ranking = topComp ? seasonRanking(world, topComp) : [];
  ranking.forEach((id, i) => rankIndex.set(id, i));
  return scoped
    .slice()
    .sort((a, b) => {
      const ra = rankIndex.get(a.id) ?? 999;
      const rb = rankIndex.get(b.id) ?? 999;
      if (ra !== rb) return ra - rb;
      if (b.reputation !== a.reputation) return b.reputation - a.reputation;
      return a.id.localeCompare(b.id);
    })
    .map((c) => c.id);
}

/**
 * 由上赛季快照解析本赛季所有参赛权（3.3 节）。
 * 纯函数：入参 world 必须已带 lastSeasonRanks / lastSeasonChampions。
 * 每条参赛权都带 Reason，UI「为什么」面板直接读。
 */
export function resolveQualifications(world: WorldState): {
  entries: QualificationEntry[];
  reasons: Reason[];
} {
  const entries: QualificationEntry[] = [];
  const reasons: Reason[] = [];
  // 洲际赛事之间互斥：同一队不能同时拿两项洲际资格（世俱杯可以复用洲际参赛队）
  const continentalClaimed = new Set<string>();
  const targetIds = new Set<string>();
  for (const comp of world.competitions) {
    if (rulesForCompetition(comp.id).length > 0) targetIds.add(comp.id);
  }
  if (targetIds.size === 0) {
    for (const id of Object.keys(CONTINENTAL_PARTICIPANTS)) targetIds.add(id);
    targetIds.add(CLUB_WORLD_ID);
  }

  for (const competitionId of [...targetIds].sort()) {
    const rules = rulesForCompetition(competitionId);
    if (rules.length === 0) continue;
    const used = new Set<string>();
    const local: QualificationEntry[] = [];

    const push = (
      clubId: string | undefined,
      via: string,
      rule: QualificationRule,
      reason: Reason,
    ): void => {
      if (!clubId || used.has(clubId)) return;
      const continental = competitionId !== CLUB_WORLD_ID;
      if (continental && continentalClaimed.has(clubId)) return;
      used.add(clubId);
      if (continental) continentalClaimed.add(clubId);
      local.push({
        competitionId,
        clubId,
        viaCompetitionId: via,
        ruleId: rule.id,
        reasons: [reason],
      });
    };

    const fillRule = rules.find((r) => r.fillRemaining);

    for (const rule of rules) {
      if (rule.fillRemaining) continue;

      if (rule.rankRange) {
        for (const [countryId, range] of Object.entries(rule.rankRange)) {
          const fromId = competitionIdOf(rule.fromTemplate, { countryId });
          const ranking = seasonRanking(world, fromId);
          const picked = ranking.slice(range[0] - 1, range[1]);
          picked.forEach((clubId, i) => {
            push(clubId, fromId, rule, {
              code: 'LEAGUE_RANK',
              text: `${countryId} 联赛第 ${range[0] + i} 名获得参赛权`,
              detail: { competitionId: fromId, rank: range[0] + i },
            });
          });
        }
      }

      if (rule.slotsByCountry) {
        for (const [countryId, slots] of Object.entries(rule.slotsByCountry)) {
          const fromId = competitionIdOf(rule.fromTemplate, { countryId });
          for (let i = 0; i < slots; i++) {
            if (rule.source === 'cup-winner') {
              push(world.lastSeasonChampions[fromId], fromId, rule, {
                code: 'CUP_WINNER',
                text: `${countryId} 杯赛冠军获得参赛权`,
                detail: { competitionId: fromId },
              });
            } else if (rule.source === 'cup-runnerup') {
              const ranking = seasonRanking(world, fromId);
              push(ranking[1], fromId, rule, {
                code: 'CUP_RUNNER_UP',
                text: `${countryId} 杯赛亚军获得参赛权`,
                detail: { competitionId: fromId },
              });
            }
          }
        }
      }

      if (rule.slotsByConfederation) {
        for (const [confederationId, slots] of Object.entries(rule.slotsByConfederation)) {
          const fromId = competitionIdOf(rule.fromTemplate, { confederationId });
          const topId = confederationTopCompetition(confederationId) ?? fromId;
          if (rule.source === 'continental-champion') {
            for (let i = 0; i < slots; i++) {
              push(world.lastSeasonChampions[topId], topId, rule, {
                code: 'CONTINENTAL_CHAMPION',
                text: `${confederationId} 顶级俱乐部赛事冠军获得参赛权`,
                detail: { competitionId: topId },
              });
            }
          } else if (rule.source === 'continental-rank') {
            const ranking = seasonRanking(world, topId);
            const champion = world.lastSeasonChampions[topId];
            const rest = champion ? ranking.filter((id) => id !== champion) : ranking;
            for (let i = 0; i < slots; i++) {
              push(rest[i], topId, rule, {
                code: 'CONTINENTAL_RANK',
                text: `${confederationId} 近季洲际综合排名第 ${i + 1} 位获得参赛权`,
                detail: { competitionId: topId, rankInConfederation: i + 1 },
              });
            }
          }
        }
      }

      if (rule.source === 'host') {
        const hostCountry = hostCountryOf(world);
        const fromId = hostCountry
          ? competitionIdOf(rule.fromTemplate, { countryId: hostCountry })
          : '';
        const champion = fromId ? world.lastSeasonChampions[fromId] : undefined;
        push(champion, fromId, rule, {
          code: 'HOST_SLOT',
          text: `主办国 ${hostCountry ?? '—'} 联赛冠军获得主办名额`,
          detail: { country: hostCountry ?? '' },
        });
      }
    }

    // 补名额：名额规则去重后不足目标队数时按近季综合排名递补
    const target = participantsOf(competitionId);
    if (local.length < target) {
      const pool = candidatePool(world, competitionId);
      for (const clubId of pool) {
        if (local.length >= target) break;
        if (used.has(clubId)) continue;
        if (competitionId !== CLUB_WORLD_ID && continentalClaimed.has(clubId)) continue;
        used.add(clubId);
        if (competitionId !== CLUB_WORLD_ID) continentalClaimed.add(clubId);
        local.push({
          competitionId,
          clubId,
          viaCompetitionId: competitionId,
          ruleId: fillRule?.id ?? 'fill',
          reasons: [
            {
              code: 'FILL',
              text: '按近季综合排名递补',
              detail: { competitionId },
            },
          ],
        });
      }
      if (local.length < target) {
        reasons.push({
          code: 'FILL_SHORT',
          text: `${competitionId} 候选池不足：需要 ${target} 队，实际 ${local.length} 队`,
          detail: { competitionId, required: target, actual: local.length },
        });
      }
    }

    entries.push(...local);
  }

  return { entries, reasons };
}

/** 按目标赛事取本赛季参赛权（赛程构建读这里） */
export function qualifiedClubs(world: WorldState, competitionId: string): Club[] {
  const ids = world.qualifications
    .filter((e) => e.competitionId === competitionId)
    .map((e) => e.clubId);
  const byId = new Map(world.clubs.map((c) => [c.id, c]));
  const out: Club[] = [];
  for (const id of ids) {
    const club = byId.get(id);
    if (club) out.push(club);
  }
  return out;
}

/** 赛季末名次快照：联赛按积分榜，淘汰赛按淘汰轮次 */
export function snapshotSeason(world: WorldState): {
  ranks: Record<string, string[]>;
  champions: Record<string, string>;
} {
  const ranks: Record<string, string[]> = {};
  const champions: Record<string, string> = {};
  const standings = computeStandings(world);
  const repOf = (clubId: string): number => reputationOf(world, clubId);
  for (const comp of world.competitions) {
    if (comp.type === 'league') {
      const st = standings[comp.id];
      if (!st) continue;
      const sorted = sortRows(st.rows, repOf).map((r) => r.clubId);
      if (sorted.length === 0) continue;
      ranks[comp.id] = sorted;
      const champ = sorted[0];
      if (champ) champions[comp.id] = champ;
      continue;
    }
    const ko = world.knockouts[comp.id];
    if (ko?.championId) {
      // 直接按本赛季淘汰轮次生成名次，不能读 lastSeasonRanks（那是上一季，会把杯赛名次永久冻结）
      ranks[comp.id] = [...new Set([ko.championId, ...ko.eliminated.slice().reverse()])];
      champions[comp.id] = ko.championId;
    }
  }
  return { ranks, champions };
}

/**
 * 升降级（3.5 节）：按 PROMOTION_RULES 一次性结算。
 * 只改 club.tier / club.competitionId，不碰赛程与积分。
 */
export function applyPromotionRelegation(
  world: WorldState,
  ranks: Record<string, string[]>,
): {
  world: WorldState;
  promoted: SeasonSummary['promoted'];
  relegated: SeasonSummary['relegated'];
} {
  const promoted: SeasonSummary['promoted'] = [];
  const relegated: SeasonSummary['relegated'] = [];
  const moved = new Map<string, { tier: number; competitionId: string }>();

  for (const rule of PROMOTION_RULES) {
    for (const country of world.countries) {
      const lowerId = `${country.id.toLowerCase()}-l${rule.fromTier}`;
      const upperId = `${country.id.toLowerCase()}-l${rule.toTier}`;
      const lowerExists = world.competitions.some((c) => c.id === lowerId);
      const upperExists = world.competitions.some((c) => c.id === upperId);
      if (!lowerExists || !upperExists) continue;
      const lowerRanks = ranks[lowerId];
      const upperRanks = ranks[upperId];
      if (!lowerRanks || !upperRanks) continue;

      for (const clubId of lowerRanks.slice(0, rule.up)) {
        if (moved.has(clubId)) continue;
        moved.set(clubId, { tier: rule.toTier, competitionId: upperId });
        promoted.push({
          clubId,
          fromTier: rule.fromTier,
          toTier: rule.toTier,
          reason: {
            code: 'PROMOTED',
            text: `${country.name} 第 ${rule.fromTier} 级联赛前 ${rule.up} 名升入第 ${rule.toTier} 级`,
            detail: { countryId: country.id, rule: rule.note },
          },
        });
      }
      for (const clubId of upperRanks.slice(-rule.down)) {
        if (moved.has(clubId)) continue;
        moved.set(clubId, { tier: rule.fromTier, competitionId: lowerId });
        relegated.push({
          clubId,
          fromTier: rule.toTier,
          toTier: rule.fromTier,
          reason: {
            code: 'RELEGATED',
            text: `${country.name} 第 ${rule.toTier} 级联赛末 ${rule.down} 名降入第 ${rule.fromTier} 级`,
            detail: { countryId: country.id, rule: rule.note },
          },
        });
      }
    }
  }

  const clubs = world.clubs.map((club) => {
    const target = moved.get(club.id);
    return target ? { ...club, tier: target.tier, competitionId: target.competitionId } : club;
  });
  return { world: { ...world, clubs }, promoted, relegated };
}

/**
 * 赛季结算：名次快照 → 升降级 → 下赛季参赛权 → SeasonSummary。
 * 不创建新赛程（startNextSeason 负责）。
 */
export function finishSeason(world: WorldState): WorldState {
  const { ranks, champions } = snapshotSeason(world);
  const withSnapshots: WorldState = {
    ...world,
    lastSeasonRanks: ranks,
    lastSeasonChampions: champions,
  };
  const { world: afterMovement, promoted, relegated } = applyPromotionRelegation(
    withSnapshots,
    ranks,
  );
  const { entries, reasons } = resolveQualifications(afterMovement);

  const clubSummary: SeasonSummary = {
    season: world.season,
    champions,
    promoted,
    relegated,
    qualifications: entries,
    playerHonors: [],
  };
  const clubFinished: WorldState = {
    ...afterMovement,
    qualifications: entries,
    seasonSummary: clubSummary,
    finished: true,
    news: [...world.news, ...reasons.map((r) => r.text)].slice(-8),
  };
  // 国家队线结算（国家联赛升降级 + 世界杯/洲际杯名额），与俱乐部结算互不覆盖
  return finishNationalSeason(clubFinished).world;
}

/** 结算后开新赛季：换赛程、重置周次，参赛权来自上个赛季的资格链 */
export function startNextSeason(world: WorldState): WorldState {
  return createSeason(world, world.season + 1);
}

/**
 * 单条规则的「为什么」（资格路径面板用）。
 * 返回该规则在本赛季实际产生的参赛权说明，找不到规则时给配置缺失原因。
 */
export function explainQualification(ruleId: string, world: WorldState): Reason {
  const entry = world.qualifications.find((e) => e.ruleId === ruleId);
  if (entry) {
    const first = entry.reasons[0];
    if (first) return first;
    return {
      code: 'QUALIFIED',
      text: `${entry.clubId} 通过规则 ${ruleId} 获得 ${entry.competitionId} 参赛权`,
      detail: { ruleId },
    };
  }
  for (const comp of world.competitions) {
    const rule = rulesForCompetition(comp.id).find((r) => r.id === ruleId);
    if (rule) {
      return {
        code: 'NO_ENTRY',
        text: `规则 ${ruleId} 存在但本赛季没有产出参赛权（${rule.note}）`,
        detail: { ruleId, competitionId: comp.id },
      };
    }
  }
  return { code: 'RULE_MISSING', text: `规则 ${ruleId} 不存在`, detail: { ruleId } };
}

/** 某赛事的抽签规则（供创建赛季时调用） */
export function drawRuleFor(competitionId: string): DrawRules {
  return drawRulesOf(competitionId);
}
