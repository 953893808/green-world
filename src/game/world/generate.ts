import { Rng, streamRng } from '../../core/rng';
import { BALANCE, clamp } from '../balance';
import { CONFEDERATIONS } from '../config/confederations';
import { CITY_POOL, CLUB_SUFFIXES, COUNTRIES, countClubs } from '../config/countries';
import { CONTINENTAL_PARTICIPANTS } from '../config/qualification';
import { generateNationalTeams } from '../national/generate';
import { nationalCompetitionDefs } from '../national/schedule';
import type {
  Club,
  CompetitionDef,
  Confederation,
  ConfederationId,
  Country,
  Player,
  WorldState,
} from '../types';

const ROMAN = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

/** 生成一个联赛/杯赛的 competition 定义 */
function leagueId(countryId: string, tier: number): string {
  return `${countryId.toLowerCase()}-l${tier}`;
}

function collectCompetitions(): CompetitionDef[] {
  const comps: CompetitionDef[] = [];
  for (const c of COUNTRIES) {
    for (let tier = 1; tier <= c.tiers; tier++) {
      comps.push({
        id: leagueId(c.id, tier),
        name: `${c.name} League ${tier}`,
        nameZh: `${c.nameZh}${tier <= 1 ? '顶级' : tier === 2 ? '次级' : `第${tier}级`}联赛`,
        type: 'league',
        scope: 'country',
        countryId: c.id,
        confederationId: c.confederationId,
        level: tier,
        participants: c.teamsPerTier[tier - 1] ?? 20,
        gender: 'men',
        category: 'senior',
      });
    }
    comps.push({
      id: `${c.id.toLowerCase()}-cup`,
      name: `${c.name} Cup`,
      nameZh: `${c.nameZh}国内杯赛`,
      type: 'domestic-cup',
      scope: 'country',
      countryId: c.id,
      confederationId: c.confederationId,
      level: 1,
      participants: c.teamsPerTier[0] ?? 18,
      gender: 'men',
      category: 'senior',
    });
  }

  const continentalNames: Record<string, { name: string; nameZh: string; type: 'continental-club' | 'continental-club-2' | 'continental-club-3' }[]> = {
    'uefa-cl': [{ name: 'Champions Cup', nameZh: '欧洲冠军杯', type: 'continental-club' }],
    'uefa-el': [{ name: 'Europa Cup', nameZh: '欧洲联盟杯', type: 'continental-club-2' }],
    'uefa-uecl': [{ name: 'Conference Cup', nameZh: '欧洲协会杯', type: 'continental-club-3' }],
    'conmebol-libertadores': [{ name: 'Libertadores Cup', nameZh: '南美解放者杯', type: 'continental-club' }],
    'conmebol-sudamericana': [{ name: 'Sudamericana Cup', nameZh: '南美杯', type: 'continental-club-2' }],
    'afc-cl': [{ name: 'AFC Champions Cup', nameZh: '亚冠联赛', type: 'continental-club' }],
    'afc-cup': [{ name: 'AFC Cup', nameZh: '亚足联杯', type: 'continental-club-2' }],
    'caf-cl': [{ name: 'CAF Champions Cup', nameZh: '非洲冠军联赛', type: 'continental-club' }],
    'caf-confed': [{ name: 'CAF Confederation Cup', nameZh: '非洲联盟杯', type: 'continental-club-2' }],
    'concacaf-cl': [{ name: 'CONCACAF Champions Cup', nameZh: '中北美冠军联赛', type: 'continental-club' }],
    'concacaf-central': [{ name: 'CONCACAF Central Cup', nameZh: '中北美中央杯', type: 'continental-club-2' }],
    'ofc-cl': [{ name: 'OFC Champions Cup', nameZh: '大洋洲冠军联赛', type: 'continental-club' }],
  };

  for (const conf of CONFEDERATIONS) {
    const list = continentalNames[conf.clubCompetitions[0] ?? ''];
    if (!list) continue;
    // 按俱乐部赛事 id 顺序逐个建
    conf.clubCompetitions.forEach((id, idx) => {
      const meta = continentalNames[id]?.[0];
      if (!meta) return;
      comps.push({
        id,
        name: meta.name,
        nameZh: meta.nameZh,
        type: meta.type,
        scope: 'confederation',
        confederationId: conf.id,
        level: idx + 1,
        participants: CONTINENTAL_PARTICIPANTS[id] ?? 32,
        gender: 'men',
        category: 'senior',
      });
    });
  }

  comps.push({
    id: 'fifa-club-world',
    name: 'FIFA Club World Cup',
    nameZh: '国际足联俱乐部世界杯',
    type: 'club-world',
    scope: 'global',
    level: 0,
    participants: 32,
    gender: 'men',
    category: 'senior',
  });

  // 国家队线：赛事定义由 national/schedule.ts 统一产出，避免两处 id/参赛队数漂移
  comps.push(...nationalCompetitionDefs());

  return comps;
}

/** 俱乐部实力：由国家强度 + 层级 + 声望抖动推出 */
function makeClubAttributes(rng: Rng, countryStrength: number, tier: number) {
  const tierPenalty = (tier - 1) * 11;
  const base = clamp(countryStrength * 0.72 + 20 - tierPenalty, 18, 92);
  const attack = clamp(Math.round(base + rng.gauss(0, 5)), 15, 97);
  const midfield = clamp(Math.round(base + rng.gauss(0, 5)), 15, 97);
  const defense = clamp(Math.round(base + rng.gauss(0, 5)), 15, 97);
  const reputation = clamp(Math.round(base + rng.gauss(0, 7)), 10, 98);
  return { attack, midfield, defense, reputation };
}

function generateClubs(rng: Rng, countries: readonly Country[]): Club[] {
  const clubs: Club[] = [];
  for (const country of countries) {
    const conf = CONFEDERATIONS.find((c) => c.id === country.confederationId);
    const confStrength = conf ? conf.sporting : 60;
    const strength = (country.strength * 0.65 + confStrength * 0.35);
    const cities = CITY_POOL[country.id] ?? ['Aston', 'Borough', 'Calderton', 'Dunmore'];
    const used = new Set<string>();

    for (let tier = 1; tier <= country.tiers; tier++) {
      const teams = country.teamsPerTier[tier - 1] ?? 20;
      for (let i = 0; i < teams; i++) {
        const city = cities[i % cities.length] ?? 'Borough';
        let suffix = CLUB_SUFFIXES[i % CLUB_SUFFIXES.length] ?? 'FC';
        let name = `${city} ${suffix}`;
        let bump = 0;
        while (used.has(name)) {
          bump++;
          suffix = CLUB_SUFFIXES[(i + bump) % CLUB_SUFFIXES.length] ?? 'FC';
          name = `${city} ${suffix}`;
          if (bump > CLUB_SUFFIXES.length) {
            name = `${city} ${suffix} ${ROMAN[bump % ROMAN.length] ?? 'II'}`;
          }
        }
        used.add(name);

        const attrs = makeClubAttributes(rng, strength, tier);
        const rep = attrs.reputation;
        clubs.push({
          id: `${country.id.toLowerCase()}-t${tier}-${String(i + 1).padStart(2, '0')}`,
          name,
          countryId: country.id,
          confederationId: country.confederationId,
          tier,
          competitionId: leagueId(country.id, tier),
          ...attrs,
          cash: Math.round(rep * 12 + rng.int(50, 400)),
          wages: Math.round(rep * 4 + rng.int(10, 90)),
          stadium: clamp(Math.round(rep * 320 + rng.int(3000, 20000)), 4000, 82000),
          form: 50,
          morale: 55 + rng.int(-8, 8),
          stamina: BALANCE.staminaMax,
          tactic: rng.pick(['press', 'possess', 'counter'] as const),
        });
      }
    }
  }
  return clubs;
}

const FIRST_NAMES = ['Adrian', 'Bruno', 'Caleb', 'Diego', 'Emil', 'Felipe', 'Gabriel', 'Hugo', 'Ivan', 'Jonas', 'Kai', 'Lucas', 'Marco', 'Nico', 'Oscar', 'Pablo', 'Quentin', 'Rafael', 'Samir', 'Tomas', 'Ugo', 'Victor', 'Walter', 'Yusuf', 'Zane', 'Ethan', 'Lorenzo', 'Mateo'];
const LAST_NAMES = ['Alvarez', 'Bakker', 'Costa', 'Duarte', 'Eriksen', 'Ferrari', 'Gomez', 'Hansen', 'Ibrahim', 'Jensen', 'Kovac', 'Lopez', 'Moreau', 'Novak', 'Okafor', 'Petrov', 'Quintero', 'Rossi', 'Silva', 'Torres', 'Ueda', 'Vargas', 'Weber', 'Yilmaz', 'Zhao', 'Nakamura', 'Diallo', 'Bianchi'];

/** 只为玩家所在俱乐部生成完整球员（LOD A）。其它俱乐部不生成个体。 */
export function generateSquad(rng: Rng, club: Club): Player[] {
  const positions: Player['position'][] = ['GK', 'GK', 'DF', 'DF', 'DF', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'MF', 'MF', 'MF', 'FW', 'FW', 'FW', 'FW', 'FW', 'MF', 'DF', 'FW', 'GK'];
  const players: Player[] = positions.map((pos, i) => {
    const ability = clamp(Math.round(club.reputation * 0.85 + rng.gauss(0, 7)), 30, 92);
    return {
      id: `${club.id}-p${String(i + 1).padStart(2, '0')}`,
      name: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
      clubId: club.id,
      position: pos,
      age: rng.int(17, 34),
      ability,
      potential: clamp(ability + rng.int(0, 14), ability, 99),
      stamina: BALANCE.staminaMax,
      form: 50,
      injuryWeeks: 0,
      value: Math.round(ability * ability * 0.9 + rng.int(20, 200)),
      apps: 0,
      goals: 0,
      assists: 0,
      ratingSum: 0,
    };
  });
  return players;
}

export interface WorldConfig {
  seed: number;
  countries: readonly Country[];
  confederations: readonly Confederation[];
}

export function defaultWorldConfig(seed: number): WorldConfig {
  return { seed, countries: COUNTRIES, confederations: CONFEDERATIONS };
}

/** 生成世界。同种子 = 同结果。生成耗时目标 < 300ms。 */
export function generateWorld(seed: number = BALANCE.worldSeedDefault): WorldState {
  const t0 = Date.now();
  const rng = streamRng(seed, 'world');
  const confederations = CONFEDERATIONS.map((c) => ({ ...c, countries: [...c.countries] }));
  const countries = COUNTRIES.map((c) => ({ ...c, teamsPerTier: [...c.teamsPerTier] }));
  const clubs = generateClubs(rng, countries);
  const competitions = collectCompetitions();
  const nationalTeams = generateNationalTeams(seed);

  if (clubs.length !== countClubs(countries)) {
    throw new Error(`俱乐部数量不符：生成 ${clubs.length}，期望 ${countClubs(countries)}`);
  }

  const world: WorldState = {
    seed,
    season: 1,
    week: 1,
    confederations,
    countries,
    clubs,
    competitions,
    fixtures: [],
    standings: {},
    knockouts: {},
    lastSeasonRanks: {},
    lastSeasonChampions: {},
    qualifications: [],
    draws: {},
    nationalTeams,
    nationalFixtures: [],
    nationalStandings: {},
    nationalKnockouts: {},
    nationalDraws: {},
    lastNationalRanks: {},
    lastNationalChampions: {},
    nationalQualifications: [],
    news: [],
    finished: false,
  };

  // 生成耗时（调试用）：超过预算说明世界数据写死了
  void t0;
  return world;
}

/** 按国家/层级取俱乐部 */
export function clubsOfTier(world: WorldState, countryId: string, tier: number): Club[] {
  return world.clubs.filter((c) => c.countryId === countryId && c.tier === tier);
}

export function clubsOfCompetition(world: WorldState, competitionId: string): Club[] {
  return world.clubs.filter((c) => c.competitionId === competitionId);
}

export function clubById(world: WorldState, id: string): Club | undefined {
  return world.clubs.find((c) => c.id === id);
}

export function confederationOf(world: WorldState, id: ConfederationId): Confederation | undefined {
  return world.confederations.find((c) => c.id === id);
}
