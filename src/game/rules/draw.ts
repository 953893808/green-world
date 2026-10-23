import type { DrawPot, DrawResult, DrawRules, Reason } from '../types';
import { CONFEDERATIONS } from '../config/confederations';

/** 从俱乐部 id 反推国家/联合会（id 形如 `eng-t1-01`，第一段是国家代码） */
function guessCountryOf(clubId: string): string {
  return clubId.split('-')[0] ?? '';
}

function confederationOfCountry(countryCode: string): string {
  const conf = CONFEDERATIONS.find((c) =>
    c.countries.some((x) => x.toLowerCase() === countryCode.toLowerCase()),
  );
  return conf?.id ?? '';
}

/**
 * 抽签（3.4 节）：按声望/名次分档 → 上下档配对 → 逐条校验回避约束 →
 * 违反则在对位间交换，最多 200 次 → 仍不满足则降级为「最不坏」并记 degraded。
 *
 * 纯函数：不读 world，只吃 entrants + 名次函数，方便单测与重放。
 */
export function runDraw(
  competitionId: string,
  season: number,
  entrants: string[],
  rules: DrawRules,
  reputation?: (clubId: string) => number,
): DrawResult {
  const rep = reputation ?? ((): number => 0);
  const ranked = entrants.slice().sort((a, b) => {
    const d = rep(b) - rep(a);
    return d !== 0 ? d : a.localeCompare(b);
  });
  const count = ranked.length;
  const potsCount = Math.max(1, Math.min(rules.pots, Math.max(1, Math.ceil(count / 2))));
  const perPot = Math.ceil(count / potsCount);
  const pots: DrawPot[] = [];
  for (let p = 0; p < potsCount; p++) {
    pots.push({ pot: p + 1, clubIds: ranked.slice(p * perPot, (p + 1) * perPot) });
  }

  const byeClubId = count % 2 === 1 ? ranked[count - 1] : undefined;
  const field = byeClubId ? ranked.slice(0, count - 1) : ranked;
  const half = field.length / 2;
  const pairs: [string, string][] = [];
  for (let i = 0; i < half; i++) {
    const home = field[i];
    const away = field[field.length - 1 - i];
    if (home && away) pairs.push([home, away]);
  }

  const countryOf = new Map<string, string>();
  const confOf = new Map<string, string>();
  for (const clubId of field) {
    const code = guessCountryOf(clubId);
    countryOf.set(clubId, code);
    confOf.set(clubId, confederationOfCountry(code));
  }
  // 档位（小组）归属：maxPerConfederation 的语义是「每个小组最多 N 队」，不是全局客队计数
  const potOf = new Map<string, number>();
  pots.forEach((pot, index) => {
    for (const clubId of pot.clubIds) potOf.set(clubId, index);
  });

  const exceedsConfederationCap = (pair: [string, string]): boolean => {
    const cap = rules.maxPerConfederation;
    if (!cap) return false;
    const perPot = new Map<string, number>();
    for (const [a, b] of [...pairs, pair]) {
      for (const clubId of [a, b]) {
        const confId = confOf.get(clubId) ?? '';
        const limit = cap[confId];
        if (limit === undefined) continue;
        const pot = potOf.get(clubId);
        if (pot === undefined) continue;
        const key = `${pot}|${confId}`;
        const next = (perPot.get(key) ?? 0) + 1;
        if (next > limit) return true;
        perPot.set(key, next);
      }
    }
    return false;
  };

  const violation = (pair: [string, string]): string | null => {
    if (rules.avoidSameCountry) {
      const c1 = countryOf.get(pair[0]);
      const c2 = countryOf.get(pair[1]);
      if (c1 && c1 === c2) return 'SAME_COUNTRY';
    }
    if (rules.avoidSameConfederation) {
      const k1 = confOf.get(pair[0]);
      const k2 = confOf.get(pair[1]);
      if (k1 && k1 === k2) return 'SAME_CONFEDERATION';
    }
    if (exceedsConfederationCap(pair)) return 'CONFEDERATION_CAP';
    return null;
  };

  let degraded = false;
  const reasons: Reason[] = [];
  const blocked = new Map<string, number>();
  let attempts = 0;
  while (attempts < 200) {
    const bad = pairs.findIndex((p) => violation(p) !== null);
    if (bad === -1) break;
    attempts++;
    const code = violation(pairs[bad] as [string, string]) ?? 'CONSTRAINT';
    blocked.set(code, (blocked.get(code) ?? 0) + 1);
    let repaired = false;
    for (let j = 0; j < pairs.length; j++) {
      if (j === bad) continue;
      const a = pairs[bad];
      const b = pairs[j];
      if (!a || !b) continue;
      const swapped: [string, string] = [a[0], b[1]];
      const mirrored: [string, string] = [b[0], a[1]];
      if (violation(swapped) === null && violation(mirrored) === null) {
        pairs[bad] = swapped;
        pairs[j] = mirrored;
        repaired = true;
        break;
      }
    }
    if (!repaired) {
      degraded = true;
      break;
    }
  }
  if (degraded) {
    reasons.push({
      code: 'DRAW_DEGRADED',
      text: '本次抽签受回避约束限制放宽（同国球队可能提前相遇）',
      detail: {
        competitionId,
        season,
        attempts,
        blocked: [...blocked.entries()].map(([k, v]) => `${k}×${v}`).join(', '),
      },
    });
  }
  return { competitionId, season, pots, pairs, byeClubId, degraded, reasons };
}
