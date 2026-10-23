import type { Fixture, MatchResult, Standing, StandingRow, WorldState } from '../types';

/** 积分：胜 3、平 1、负 0 */
export const POINTS_WIN = 3;
export const POINTS_DRAW = 1;

/** 把一场比赛结果记进积分榜行（纯函数，不改入参） */
export function applyResultToRow(row: StandingRow, gf: number, ga: number): StandingRow {
  const won = gf > ga;
  const drawn = gf === ga;
  return {
    ...row,
    played: row.played + 1,
    won: row.won + (won ? 1 : 0),
    drawn: row.drawn + (drawn ? 1 : 0),
    lost: row.lost + (!won && !drawn ? 1 : 0),
    goalsFor: row.goalsFor + gf,
    goalsAgainst: row.goalsAgainst + ga,
    points: row.points + (won ? POINTS_WIN : drawn ? POINTS_DRAW : 0),
  };
}

/** 排序规则：积分 → 净胜球 → 进球 → 声望/名称（保证确定性） */
export function sortRows(rows: StandingRow[], reputationOf: (clubId: string) => number): StandingRow[] {
  return rows.slice().sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const gdA = a.goalsFor - a.goalsAgainst;
    const gdB = b.goalsFor - b.goalsAgainst;
    if (gdB !== gdA) return gdB - gdA;
    if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
    const repDiff = reputationOf(b.clubId) - reputationOf(a.clubId);
    if (repDiff !== 0) return repDiff;
    return a.clubId.localeCompare(b.clubId);
  });
}

/** 从赛程重算积分榜（唯一记账处，避免累计重复计算） */
export function computeStandings(world: WorldState): Record<string, Standing> {
  const out: Record<string, Standing> = {};
  const repOf = (clubId: string): number => world.clubs.find((c) => c.id === clubId)?.reputation ?? 0;

  for (const comp of world.competitions) {
    if (comp.type !== 'league') continue;
    const base = world.standings[comp.id];
    if (!base) continue;
    const rows = base.rows.map<StandingRow>((r) => ({
      clubId: r.clubId,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      points: 0,
    }));

    for (const f of world.fixtures) {
      if (f.competitionId !== comp.id || !f.result) continue;
      const home = rows.find((r) => r.clubId === f.homeId);
      const away = rows.find((r) => r.clubId === f.awayId);
      if (!home || !away) continue;
      const hi = rows.indexOf(home);
      const ai = rows.indexOf(away);
      const h = applyResultToRow(home, f.result.homeGoals, f.result.awayGoals);
      const a = applyResultToRow(away, f.result.awayGoals, f.result.homeGoals);
      rows[hi] = h;
      rows[ai] = a;
    }

    out[comp.id] = {
      competitionId: comp.id,
      season: world.season,
      rows: sortRows(rows, repOf),
    };
  }
  return out;
}

/** 当前排名（1 起） */
export function rankOf(world: WorldState, competitionId: string, clubId: string): number {
  const standing = world.standings[competitionId];
  if (!standing) return 0;
  const idx = standing.rows.findIndex((r) => r.clubId === clubId);
  return idx < 0 ? 0 : idx + 1;
}

/**
 * 上赛季排名快照里的名次（1 起，0 = 快照里没有）。
 *
 * P0-1：`finishSeason` 会先升降级再结算，此时 `club.competitionId` 已经指向新联赛，
 * 用 `rankOf(world, club.competitionId, club.id)` 会查到空表（名次 0、声望奖励丢失）。
 * 所有「赛季末按名次打分」的地方都必须用这个快照函数。
 */
export function seasonRankOf(
  world: WorldState,
  clubId: string,
): { rank: number; total: number; competitionId: string } {
  for (const comp of world.competitions) {
    if (comp.type !== 'league') continue;
    const ids = world.lastSeasonRanks[comp.id];
    if (!ids) continue;
    const idx = ids.indexOf(clubId);
    if (idx >= 0) return { rank: idx + 1, total: ids.length, competitionId: comp.id };
  }
  return { rank: 0, total: 0, competitionId: '' };
}

/** 从赛程推出某队已踢比赛数（事件页进度必须从这里推导） */
export function playedMatchesOf(world: WorldState, clubId: string): number {
  return world.fixtures.filter(
    (f) => f.played && (f.homeId === clubId || f.awayId === clubId),
  ).length;
}

/** 联赛轮次总数（积分榜轮数 = 已踢比赛场数 / 2） */
export function leagueRoundOf(world: WorldState, competitionId: string): number {
  const played = world.fixtures.filter((f) => f.competitionId === competitionId && f.played).length;
  const standing = world.standings[competitionId];
  const teams = standing?.rows.length ?? 2;
  return Math.floor(played / Math.max(1, teams / 2));
}

/** 联赛是否已赛完（每队都打满 N-1 场） */
export function isLeagueComplete(world: WorldState, competitionId: string): boolean {
  const standing = world.standings[competitionId];
  if (!standing) return true;
  const teams = standing.rows.length;
  return standing.rows.every((r) => r.played >= teams - 1);
}

/** 淘汰赛参赛者的比赛结果（供晋级判断） */
export function resultOfFixture(fixture: Fixture): MatchResult | undefined {
  return fixture.result;
}
