import type { ConfederationId, Country } from '../types';

// 12 个国家 / 776 家俱乐部的生成规则。
// 层数：UEFA 4 层，其余 3 层，OFC 2 层；每层队数 T1 18 / T2 20 / T3 20 / T4 20。
// 合计 = 5×78 + 2×58 + 2×58 + 58 + 58 + 38 = 390+116+116+58+58+38 = 776
export const COUNTRIES: Country[] = [
  { id: 'ENG', name: 'England', nameZh: '英格兰', confederationId: 'UEFA', tiers: 4, teamsPerTier: [18, 20, 20, 20], strength: 92 },
  { id: 'ESP', name: 'Spain', nameZh: '西班牙', confederationId: 'UEFA', tiers: 4, teamsPerTier: [18, 20, 20, 20], strength: 90 },
  { id: 'GER', name: 'Germany', nameZh: '德国', confederationId: 'UEFA', tiers: 4, teamsPerTier: [18, 20, 20, 20], strength: 88 },
  { id: 'ITA', name: 'Italy', nameZh: '意大利', confederationId: 'UEFA', tiers: 4, teamsPerTier: [18, 20, 20, 20], strength: 87 },
  { id: 'FRA', name: 'France', nameZh: '法国', confederationId: 'UEFA', tiers: 4, teamsPerTier: [18, 20, 20, 20], strength: 86 },

  { id: 'BRA', name: 'Brazil', nameZh: '巴西', confederationId: 'CONMEBOL', tiers: 3, teamsPerTier: [18, 20, 20], strength: 88 },
  { id: 'ARG', name: 'Argentina', nameZh: '阿根廷', confederationId: 'CONMEBOL', tiers: 3, teamsPerTier: [18, 20, 20], strength: 85 },

  { id: 'JPN', name: 'Japan', nameZh: '日本', confederationId: 'AFC', tiers: 3, teamsPerTier: [18, 20, 20], strength: 68 },
  { id: 'KSA', name: 'Saudi Arabia', nameZh: '沙特阿拉伯', confederationId: 'AFC', tiers: 3, teamsPerTier: [18, 20, 20], strength: 62 },

  { id: 'EGY', name: 'Egypt', nameZh: '埃及', confederationId: 'CAF', tiers: 3, teamsPerTier: [18, 20, 20], strength: 63 },

  { id: 'USA', name: 'United States', nameZh: '美国', confederationId: 'CONCACAF', tiers: 3, teamsPerTier: [18, 20, 20], strength: 66 },

  { id: 'NZL', name: 'New Zealand', nameZh: '新西兰', confederationId: 'OFC', tiers: 2, teamsPerTier: [18, 20], strength: 44 },
];

/** 城市名池：俱乐部名 = 城市 + 后缀，全程序化，禁止真实俱乐部名 */
export const CITY_POOL: Record<string, string[]> = {
  ENG: ['Northport', 'Ashford', 'Brookvale', 'Camden', 'Dunmore', 'Eastleigh', 'Fairhaven', 'Granby', 'Harrowgate', 'Iverton', 'Kelbrook', 'Langmere', 'Mossley', 'Netherby', 'Oakridge', 'Pemberton', 'Quarryford', 'Redcliff', 'Stonebury', 'Thornby', 'Uxbridge', 'Valebrook', 'Westmoor', 'Yarmouth'],
  ESP: ['Almenar', 'Bellara', 'Costabrava', 'Dorada', 'Estrella', 'Fuensal', 'Granvia', 'Huelmo', 'Islana', 'Jarales', 'Lumbrera', 'Montoya', 'Navilla', 'Olmeda', 'Peralta', 'Quintana', 'Ribera', 'Saldana', 'Toledo', 'Urbina', 'Valverde', 'Zamora'],
  GER: ['Altenberg', 'Bruckheim', 'Dornstadt', 'Eichwald', 'Feldkirch', 'Grunsfeld', 'Hagenau', 'Irlbach', 'Kronberg', 'Lindhof', 'Marbach', 'Neuhafen', 'Ostwald', 'Pfullingen', 'Rothsee', 'Steinbach', 'Tannberg', 'Ulmstedt', 'Waldau', 'Zellhof'],
  ITA: ['Altamura', 'Bellagio', 'Castelvecchio', 'Dorsoduro', 'Ercolano', 'Fiorentino', 'Gallipoli', 'Ischia', 'Lucania', 'Montenero', 'Norcina', 'Ostuni', 'Palombara', 'Quercia', 'Ravello', 'Sorrento', 'Trevignano', 'Urbino', 'Verona', 'Zibello'],
  FRA: ['Aubagne', 'Bellegarde', 'Clermont', 'Dijonval', 'Embrun', 'Fontaine', 'Grenoble', 'Hyerois', 'Issoudun', 'Jouy', 'Laval', 'Montreuil', 'Narbonne', 'Orleans', 'Perpignan', 'Quimper', 'Roubaix', 'Strasbourg', 'Toulon', 'Valence'],
  BRA: ['Alegrete', 'Boa Vista', 'Carioca', 'Dourados', 'Encanto', 'Fortaleza', 'Guarani', 'Ipiranga', 'Jequié', 'Londrina', 'Maringá', 'Niterói', 'Ourinhos', 'Piracicaba', 'Quixadá', 'Recife', 'Santana', 'Tubarão', 'Uberaba', 'Varginha'],
  ARG: ['Almagro', 'Banfield', 'Casilda', 'Dolores', 'Ensenada', 'Formosa', 'Gualeguay', 'Hurlingham', 'Ituzaingó', 'Junín', 'Laboulaye', 'Mercedes', 'Neuquén', 'Olavarría', 'Paraná', 'Quilmes', 'Rafaela', 'Sunchales', 'Tandil', 'Venado'],
  JPN: ['Aobadai', 'Chikusa', 'Daisen', 'Ebetsu', 'Fukui', 'Gifu', 'Hikone', 'Inagi', 'Joetsu', 'Kurume', 'Minami', 'Nagato', 'Otsu', 'Sakai', 'Tottori', 'Ube', 'Wakayama', 'Yonezawa', 'Zushi', 'Kofu'],
  KSA: ['Abha', 'Buraidah', 'Dammam', 'Hail', 'Jubail', 'Khobar', 'Medina', 'Najran', 'Riyadh', 'Tabuk', 'Yanbu', 'Alhasa', 'Alqassim', 'Sakaka', 'Wajh', 'Arar', 'Dhahran', 'Qatif', 'Unaizah', 'Zulfi'],
  EGY: ['Aswan', 'Bani Suef', 'Damanhur', 'Edfu', 'Faiyum', 'Giza', 'Hurghada', 'Ismailia', 'Kom Ombo', 'Luxor', 'Mansoura', 'Nag Hamadi', 'Port Said', 'Qena', 'Rosetta', 'Sohag', 'Tanta', 'Zagazig', 'Suez', 'Minya'],
  USA: ['Ashland', 'Brookline', 'Cedar Falls', 'Dover', 'Elmwood', 'Fairview', 'Glenmont', 'Hartley', 'Ironton', 'Junction', 'Kingston', 'Lakemont', 'Milford', 'Northgate', 'Oak Park', 'Pinehurst', 'Redwood', 'Stonewall', 'Trenton', 'Westbrook'],
  NZL: ['Arrowtown', 'Blenheim', 'Coromandel', 'Dunedin', 'Feilding', 'Gisborne', 'Hamilton', 'Invercargill', 'Kaikoura', 'Levin', 'Masterton', 'Nelson', 'Oamaru', 'Picton', 'Rotorua', 'Timaru', 'Upper Hutt', 'Wanaka', 'Whangarei', 'Ashburton'],
};

/** 俱乐部名后缀池：扁平、虚构、无真实品牌 */
export const CLUB_SUFFIXES: string[] = [
  'FC', 'United', 'Athletic', 'Rovers', 'City', 'Town', 'Sporting', 'Wanderers',
  'Rangers', 'Albion', 'County', 'Union', 'Olympic', 'Dynamo', 'Corinthians', 'Locomotive',
];

export function countClubs(countries: readonly Country[]): number {
  return countries.reduce((sum, c) => sum + c.teamsPerTier.reduce((a, b) => a + b, 0), 0);
}

export function confederationTierCount(confederationId: ConfederationId): number {
  return COUNTRIES.filter((c) => c.confederationId === confederationId).length;
}
