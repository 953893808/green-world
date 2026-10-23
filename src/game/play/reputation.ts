import { BALANCE, clamp, round2 } from '../balance';
import { rankOf, seasonRankOf } from '../rules/standings';
import type { Club, NationalTeam, WorldState } from '../types';

/**
 * 声望（设计 §7.3）。四类：俱乐部 / 国家队 / 教练 / 赛事。
 *
 * 本实现只把「可被玩法改变」的两类落进 WorldState：
 *  - 俱乐部声望 `club.reputation`（0~100）：影响抽签档位、赞助、转会吸引力、董事会期待；
 *  - 国家队声望 `nationalTeam.reputation`：影响世界杯种子档与征召吸引力。
 * 教练声望与赛事声望是派生值（从荣誉/赛事级别推算），不单独存字段。
 *
 * 规则：夺冠 / 升级 / 拿到洲际资格 → 涨；降级 / 财政事故 → 跌；
 * 每赛季按 reputationDecay 自然回落（越高的声望回落越多）。
 */

export interface ReputationChange {
  clubId?: string;
  teamId?: string;
  delta: number;
  reason: string;
}

/** 赛季末：按名次给出声望增量（正负都有） */
export function rankReputationDelta(world: WorldState, club: Club): number {
  // P0-1：finishSeason 先升降级再结算，club.competitionId 已指向新联赛，
  // 必须优先用上赛季快照算名次，否则升级队/降级队都拿不到名次变化。
  const snap = seasonRankOf(world, club.id);
  const rows = world.standings[club.competitionId]?.rows ?? [];
  const rank = snap.rank > 0 ? snap.rank : rankOf(world, club.competitionId, club.id);
  const total = snap.total > 0 ? snap.total : rows.length;
  if (rank <= 0 || total < 2) return 0;
  const mid = (total + 1) / 2;
  return round2((mid - rank) * BALANCE.repRankGainK);
}

/** 自然衰减：上赛季声望越高，回落越多 */
export function decayReputation(value: number): number {
  return round2(value - value * BALANCE.reputationDecay);
}

function clampRep(value: number): number {
  return clamp(round2(value), BALANCE.reputationMin, BALANCE.reputationMax);
}

/**
 * 结算全部参与赛季的俱乐部声望。
 * 只有真正发生变化的俱乐部才会被写进返回值（UI 与存档都按稀疏处理）。
 */
export function settleReputations(
  world: WorldState,
  options: { promoted?: readonly string[]; relegated?: readonly string[]; champions?: readonly string[] } = {},
): { world: WorldState; changes: ReputationChange[] } {
  const promoted = new Set(options.promoted ?? []);
  const relegated = new Set(options.relegated ?? []);
  const champions = new Set(options.champions ?? []);
  const continental = new Set(world.qualifications.map((q) => q.clubId));

  const changes: ReputationChange[] = [];
  const clubs = world.clubs.map<Club>((club) => {
    let value = decayReputation(club.reputation);
    const notes: string[] = [];

    const rankDelta = rankReputationDelta(world, club);
    if (rankDelta !== 0) {
      value += rankDelta;
      const snap = seasonRankOf(world, club.id);
      notes.push(`联赛第 ${snap.rank > 0 ? snap.rank : rankOf(world, club.competitionId, club.id)}`);
    }
    if (champions.has(club.id)) {
      value += BALANCE.repChampionGain;
      notes.push('夺冠');
    }
    if (promoted.has(club.id)) {
      value += BALANCE.repPromotionGain;
      notes.push('升级');
    }
    if (relegated.has(club.id)) {
      value -= BALANCE.repRelegationLoss;
      notes.push('降级');
    }
    if (continental.has(club.id)) {
      value += BALANCE.repContinentalGain;
      notes.push('洲际资格');
    }
    if (club.cash < 0) {
      value -= 3;
      notes.push('财政事故');
    }

    const next = clampRep(value);
    if (next === club.reputation) return club;
    changes.push({ clubId: club.id, delta: round2(next - club.reputation), reason: notes.join('、') || '赛季结算' });
    return { ...club, reputation: next };
  });

  return { world: { ...world, clubs }, changes };
}

/** 国家队声望：按世界排名与分级联赛结果微调 */
export function settleNationalReputations(
  world: WorldState,
): { world: WorldState; changes: ReputationChange[] } {
  const changes: ReputationChange[] = [];
  const teams = world.nationalTeams.map<NationalTeam>((team) => {
    const tierBonus = { A: 2, B: 1, C: 0, D: -1 }[team.nationsLeagueTier];
    const rankBonus = team.rank > 0 ? round2((13 - Math.min(12, team.rank)) * 0.4) : 0;
    const next = clampRep(decayReputation(team.reputation) + tierBonus + rankBonus);
    if (next === team.reputation) return team;
    changes.push({
      teamId: team.id,
      delta: round2(next - team.reputation),
      reason: `分级 ${team.nationsLeagueTier}`,
    });
    return { ...team, reputation: next };
  });
  return { world: { ...world, nationalTeams: teams }, changes };
}

/** 教练声望：从荣誉数 + 董事会满意度推算（派生值，不存字段） */
export function coachReputation(world: WorldState, state: { honors: string[]; boardConfidence?: number }): number {
  const honorScore = state.honors.length * 8;
  const boardScore = (state.boardConfidence ?? 50) * 0.4;
  const seasons = world.season;
  return Math.round(clamp(20 + honorScore + boardScore + seasons * 1.5, 0, 100));
}

/** 赛事声望：从赛事级别推算，用于奖金/转播/球员意愿的展示 */
export function competitionReputation(type: string, level: number): number {
  if (type === 'club-world') return 98;
  if (type === 'world-cup') return 98;
  if (type === 'continental-club') return 88;
  if (type === 'continental-club-2') return 76;
  if (type === 'continental-club-3') return 64;
  if (type === 'national-league') return 82;
  if (type === 'national-cup') return 80;
  if (type === 'domestic-cup') return 62;
  if (type === 'league') return Math.max(40, 92 - (level - 1) * 12);
  return 50;
}
