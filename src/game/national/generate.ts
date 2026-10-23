import { streamRng } from '../../core/rng';
import type { Rng } from '../../core/rng';
import { BALANCE, clamp } from '../balance';
import { CONFEDERATIONS } from '../config/confederations';
import { COUNTRIES } from '../config/countries';
import {
  NATIONS_LEAGUE_TIERS,
  nationsLeagueLevelCount,
  splitIntoLevels,
} from '../config/national';
import type {
  Club,
  Confederation,
  Country,
  NationalTeam,
  TacticId,
  WorldState,
} from '../types';

/** 国家队 id 约定：`${countryId}-nt`，与俱乐部 id（`eng-t1-01`）不会冲突 */
export function nationalTeamId(countryId: string): string {
  return `${countryId.toLowerCase()}-nt`;
}

const COACH_FIRST = [
  'Aldo', 'Bernard', 'Carlos', 'Diego', 'Edgar', 'Felix', 'Gustav', 'Hugo',
  'Ivan', 'Jonas', 'Karl', 'Luis', 'Marco', 'Nils', 'Otto', 'Pavel',
];
const COACH_LAST = [
  'Adeyemi', 'Bianchi', 'Costa', 'Duarte', 'Eckert', 'Ferreira', 'Gomez', 'Horvat',
  'Ibarra', 'Janssen', 'Kovac', 'Lindqvist', 'Moreau', 'Novak', 'Olsen', 'Pereira',
];

const TACTICS: TacticId[] = ['press', 'possess', 'counter'];

function coachName(rng: Rng): string {
  return `${rng.pick(COACH_FIRST)} ${rng.pick(COACH_LAST)}`;
}

/**
 * 国家队实力：取该国最强国力（country.strength）与所属洲竞技水平（sporting）的混合，
 * 再加一点种子抖动。目标区间 40~95，与 2.3 节一致。
 */
function nationalStrength(rng: Rng, country: Country, conf: Confederation): number {
  const raw = country.strength * 0.7 + conf.sporting * 0.3 + rng.gauss(0, 3);
  return Math.round(clamp(raw, 40, 95));
}

/** 由综合实力拆三线：国家队比俱乐部更均衡（三线差异小），但有微弱风格偏移 */
function splitStrength(rng: Rng, strength: number): { attack: number; midfield: number; defense: number } {
  const attack = Math.round(clamp(strength + rng.gauss(1, 4), 30, 97));
  const midfield = Math.round(clamp(strength + rng.gauss(0, 3), 30, 97));
  const defense = Math.round(clamp(strength + rng.gauss(-1, 4), 30, 97));
  return { attack, midfield, defense };
}

/** 生成全部国家队（一国有且仅有一支），并按 strength 降序写入世界排名 */
export function generateNationalTeams(seed: number): NationalTeam[] {
  const rng = streamRng(seed, 'national-teams');
  const teams: NationalTeam[] = [];

  for (const country of COUNTRIES) {
    const conf = CONFEDERATIONS.find((c) => c.id === country.confederationId);
    if (!conf) throw new Error(`generateNationalTeams: 未知联合会 ${country.confederationId}`);
    const strength = nationalStrength(rng, country, conf);
    const lines = splitStrength(rng, strength);
    teams.push({
      id: nationalTeamId(country.id),
      countryId: country.id,
      confederationId: country.confederationId,
      name: `${country.name} National Team`,
      nameZh: `${country.nameZh}国家队`,
      reputation: Math.round(clamp(strength + rng.gauss(0, 4), 20, 98)),
      rank: 0, // 下面统一编号
      nationsLeagueTier: 'C', // 下面按洲内实力覆盖
      strength,
      attack: lines.attack,
      midfield: lines.midfield,
      defense: lines.defense,
      form: 50,
      morale: 60,
      stamina: BALANCE.staminaMax,
      tactic: rng.pick(TACTICS),
      coachName: coachName(rng),
    });
  }

  // 世界排名：strength 降序，同分按 reputation，再按 id，保证确定性
  const ranked = [...teams].sort(
    (a, b) => b.strength - a.strength || b.reputation - a.reputation || a.id.localeCompare(b.id),
  );
  ranked.forEach((team, i) => {
    team.rank = i + 1;
  });

  // 国家联赛级别：**在洲内**按 strength 降序切级，级别标签从 A 起
  for (const conf of CONFEDERATIONS) {
    const members = ranked.filter((t) => t.confederationId === conf.id);
    const levels = nationsLeagueLevelCount(members.length);
    const groups = splitIntoLevels(members, levels);
    groups.forEach((group, levelIndex) => {
      const tier = NATIONS_LEAGUE_TIERS[levelIndex];
      if (!tier) return;
      for (const team of group) team.nationsLeagueTier = tier;
    });
  }

  return teams;
}

/** 把国家队适配成 `Club` 形状，复用 teamPower / tacticEdge / simulateMatch 的全部逻辑 */
export function nationalTeamAsClub(team: NationalTeam): Club {
  return {
    id: team.id,
    name: team.name,
    countryId: team.countryId,
    confederationId: team.confederationId,
    tier: 0,
    competitionId: '',
    reputation: team.reputation,
    attack: team.attack,
    midfield: team.midfield,
    defense: team.defense,
    cash: 0,
    wages: 0,
    stadium: 40000,
    form: team.form,
    morale: team.morale,
    stamina: team.stamina,
    tactic: team.tactic,
  };
}

/** 国家队索引，供 simulateMatch 的 `options.index` 使用（避免它去 world.clubs 里找） */
export function buildNationalIndex(world: WorldState): Map<string, Club> {
  return new Map(world.nationalTeams.map((t) => [t.id, nationalTeamAsClub(t)]));
}

export function nationalTeamById(world: WorldState, teamId: string): NationalTeam | undefined {
  return world.nationalTeams.find((t) => t.id === teamId);
}

export function nationalTeamsOfConfederation(world: WorldState, confederationId: string): NationalTeam[] {
  return world.nationalTeams.filter((t) => t.confederationId === confederationId);
}
