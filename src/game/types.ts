// 全局类型。规则层不碰 DOM / localStorage，所有类型都是纯数据。

export type ConfederationId = 'UEFA' | 'CONMEBOL' | 'AFC' | 'CAF' | 'CONCACAF' | 'OFC';

export type CompetitionType =
  | 'league'
  | 'domestic-cup'
  | 'continental-club'
  | 'continental-club-2'
  | 'continental-club-3'
  | 'club-world'
  | 'national-league'
  | 'national-cup'
  | 'national-qualifier'
  | 'world-cup'
  | 'friendly';

export type CompetitionScope = 'global' | 'confederation' | 'country';

export type Mode = 'career' | 'manager';

export type TacticId = 'press' | 'possess' | 'counter';
export type Mentality = 'conservative' | 'balanced' | 'aggressive';

export interface Confederation {
  id: ConfederationId;
  name: string;
  nameZh: string;
  /** 商业发达度 0~100，影响转播/赞助收入 */
  commercial: number;
  /** 竞技水平 0~100，影响球队基准实力与国家队长召难度 */
  sporting: number;
  /** 下辖国家 */
  countries: string[];
  /** 洲际俱乐部赛事，从高到低 */
  clubCompetitions: string[];
  /** 世俱杯名额 */
  clubWorldSlots: number;
  /** 世界杯直接名额 */
  worldCupSlots: number;
  /** 洲际国家队杯赛参赛队数 */
  continentalCupSlots: number;
  /** 是否有分级国家队联赛（欧国联式） */
  hasNationsLeague: boolean;
  /** 国家队征召难度 0~1，越高越难把你召进国家队 */
  callUpDifficulty: number;
}

export interface Country {
  id: string;
  name: string;
  nameZh: string;
  confederationId: ConfederationId;
  /** 国内联赛层级数 */
  tiers: number;
  /** 每层球队数 */
  teamsPerTier: number[];
  /** 国家基准实力 0~100 */
  strength: number;
}

export interface Club {
  id: string;
  name: string;
  countryId: string;
  confederationId: ConfederationId;
  tier: number;
  competitionId: string;
  reputation: number;
  /** 攻击 / 中场 / 防守，0~100 */
  attack: number;
  midfield: number;
  defense: number;
  /** 现金，万 */
  cash: number;
  /** 工资/赛季，万 */
  wages: number;
  stadium: number;
  /** 状态（全队平均 0~100），每周向 50 回归 */
  form: number;
  /** 士气 0~100 */
  morale: number;
  /** 体能（全队平均 0~100），打比赛消耗、每周恢复 */
  stamina: number;
  /** 默认战术 */
  tactic: TacticId;
}

export interface Player {
  id: string;
  name: string;
  clubId: string;
  /** GK / DF / MF / FW */
  position: 'GK' | 'DF' | 'MF' | 'FW';
  age: number;
  /** 综合能力 0~100 */
  ability: number;
  potential: number;
  stamina: number;
  form: number;
  injuryWeeks: number;
  /** 身价，万 */
  value: number;
  /** 赛季累计：出场/进球/助攻/平均评分 */
  apps: number;
  goals: number;
  assists: number;
  ratingSum: number;
}

/**
 * 国家队（男子成年）。
 * 字段刻意与 Club 的重叠子集对齐，便于直接喂给 teamPower / simulateMatch：
 * 只需 attack / midfield / defense / confederationId / form / morale / stamina / tactic。
 */
export interface NationalTeam {
  /** `${countryId}-nt` */
  id: string;
  countryId: string;
  confederationId: ConfederationId;
  name: string;
  nameZh: string;
  /** 国家队声望 0~100，影响抽签分档、征召难度 */
  reputation: number;
  /** 世界排名，1 起，由 strength 降序生成 */
  rank: number;
  /** 国家联赛级别，MVP 由 strength 分组推出 */
  nationsLeagueTier: 'A' | 'B' | 'C' | 'D';
  /** 综合实力 40~95 */
  strength: number;
  attack: number;
  midfield: number;
  defense: number;
  form: number;
  morale: number;
  stamina: number;
  tactic: TacticId;
  /** 主帅名（虚构） */
  coachName: string;
}

/** 国家队淘汰赛进行态。与 KnockoutState 同构，但显式用它表达「实体是国家队」 */
export interface NationalKnockoutState {
  competitionId: string;
  season: number;
  round: number;
  weeks: number[];
  alive: { teamId: string; seed: number }[];
  eliminated: string[];
  championId?: string;
}

/** 国家队参赛权（世界杯 / 洲际杯），与俱乐部线的 QualificationEntry 同思路但实体是国家队 */
export interface NationalQualificationEntry {
  competitionId: string;
  teamId: string;
  /** 通过哪条路径拿到：洲名额 / 上届成绩 / 主办国 */
  via: 'confederation-slots' | 'ranking' | 'host' | 'fill';
  reasons: Reason[];
}

export interface Fixture {
  id: string;
  competitionId: string;
  season: number;
  week: number;
  round: number;
  homeId: string;
  awayId: string;
  /** 淘汰赛阶段名，联赛为空 */
  stage?: string;
  result?: MatchResult;
  played: boolean;
}

export interface MatchResult {
  homeGoals: number;
  awayGoals: number;
  homeXg: number;
  awayXg: number;
  /** 点球大战独立字段，绝不写入常规比分 */
  penalty: 'none' | 'home' | 'away';
  penaltyScore?: string;
  /** 本场是否由玩家操控（影响是否产生交互） */
  playerSide?: 'home' | 'away';
  playerRating?: number;
  playerGoals?: number;
  playerAssists?: number;
  scorers: { minute: number; clubId: string; playerName: string }[];
  /** 关键事件文本，用于比赛报告 */
  keyEvents: string[];
  /** 上半场比分（两段式模拟需要），无交互时也记录 */
  halfTime?: { homeGoals: number; awayGoals: number };
}

/** 比赛上下文：谁在踢、什么战术、体能士气、主客场 */
export interface MatchContext {
  homeId: string;
  awayId: string;
  /** 中立场（决赛/杯赛） */
  neutral: boolean;
  /** 淘汰赛必须分胜负 */
  needWinner: boolean;
  homeTactic?: TacticId;
  awayTactic?: TacticId;
}

export interface StandingRow {
  clubId: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

export interface Standing {
  competitionId: string;
  season: number;
  rows: StandingRow[];
}

export interface Reason {
  /** 机器可读原因码 */
  code: string;
  /** 面向玩家的一句中文解释 */
  text: string;
  /** 涉及的数据，用于「为什么」面板展开 */
  detail?: Record<string, string | number>;
}

export interface QualificationEntry {
  competitionId: string;
  clubId: string;
  viaCompetitionId: string;
  ruleId: string;
  reasons: Reason[];
}

/**
 * 资格规则：所有参赛权的唯一来源（3.3 节）。
 * 代码只负责解释这条规则，不写任何具体赛事 id 的判断逻辑。
 */
export type QualificationSource =
  | 'league'
  | 'cup-winner'
  | 'cup-runnerup'
  | 'continental-champion'
  | 'continental-rank'
  | 'host';

/** 名次区间 [起, 止]，含端点，1 起 */
export type RankRange = [number, number];

export interface QualificationRule {
  id: string;
  /** 目标赛事 id */
  toCompetitionId: string;
  source: QualificationSource;
  /** 来源赛事 id 模板：`{country}` / `{confederation}` 会被替换 */
  fromTemplate: string;
  /**
   * 按国家取名次区间：国家 id -> [起, 止]。
   * 用于「国家 T1 第 1~8 名进欧冠」这类规则，区间长度即名额数。
   */
  rankRange?: Record<string, RankRange>;
  /** 按国家给固定名额（杯赛冠军/亚军、主办国这类不看名次区间的） */
  slotsByCountry?: Record<string, number>;
  /** 按联合会给名额（世俱杯这类跨联赛名额） */
  slotsByConfederation?: Record<string, number>;
  /** 数值越小越优先；高优先级先占名额，避免同一队被两条规则重复征用 */
  priority: number;
  /** 该规则只负责「把目标赛事剩余名额补齐」：按其优先级顺序递补 */
  fillRemaining?: boolean;
  /** UI「为什么」面板里的一句话说明 */
  note: string;
}

/** 升降级规则（3.5 节），按层级对配置，代码只执行 */
export interface PromotionRule {
  /** 低一级的 level */
  fromTier: number;
  /** 高一级的 level */
  toTier: number;
  /** 升级名额 */
  up: number;
  /** 降级名额 */
  down: number;
  note: string;
}

/** 抽签分档与约束（3.4 节） */
export interface DrawRules {
  pots: number;
  potBy: 'reputation' | 'rank';
  avoidSameCountry: boolean;
  avoidSameConfederation: boolean;
  maxPerConfederation?: Record<string, number>;
}

export interface DrawPot {
  pot: number;
  clubIds: string[];
}

export interface DrawResult {
  competitionId: string;
  season: number;
  pots: DrawPot[];
  /** 首轮对阵，按种子顺序（1v32、2v31 …） */
  pairs: [string, string][];
  /** 奇数队时的轮空者 */
  byeClubId?: string;
  /** 约束无法满足、放宽后得到的结果 */
  degraded: boolean;
  reasons: Reason[];
}

export interface SeasonSummary {
  season: number;
  champions: Record<string, string>;
  promoted: { clubId: string; fromTier: number; toTier: number; reason: Reason }[];
  relegated: { clubId: string; fromTier: number; toTier: number; reason: Reason }[];
  qualifications: QualificationEntry[];
  playerHonors: string[];
  playerSeasonLine?: { apps: number; goals: number; assists: number; avgRating: number };
}

export interface WorldState {
  seed: number;
  season: number;
  week: number;
  confederations: Confederation[];
  countries: Country[];
  clubs: Club[];
  competitions: CompetitionDef[];
  /** 当前赛季所有赛程，按 week 排序 */
  fixtures: Fixture[];
  standings: Record<string, Standing>;
  /** 淘汰赛进行态（杯赛 / 洲际 / 世俱杯），键为 competitionId */
  knockouts: Record<string, KnockoutState>;
  /** 上赛季各联赛排名快照，用于资格链 */
  lastSeasonRanks: Record<string, string[]>;
  /** 上赛季各赛事冠军快照（联赛/杯赛/洲际/世俱杯），键为 competitionId */
  lastSeasonChampions: Record<string, string>;
  /**
   * 上赛季结算时算出的本赛季参赛权（洲际 + 世俱杯 + 国内杯赛）。
   * 赛季 1 为空数组，此时按声望兜底选队。
   */
  qualifications: QualificationEntry[];
  /** 本赛季抽签结果，键为 competitionId，供 UI「为什么这样分」面板 */
  draws: Record<string, DrawResult>;
  // ───────── 国家队线（与俱乐部线并行，互不污染） ─────────
  /** 国家队实体，一国有且仅有一支男子成年国家队 */
  nationalTeams: NationalTeam[];
  /**
   * 国家队赛程。刻意与 `fixtures` 分开存：
   * 俱乐部赛程的所有校验（每队 N-1 场、无自赛、无同周重复）可以完全不受国家队影响。
   */
  nationalFixtures: Fixture[];
  /** 国家队赛事积分榜，键为 competitionId（小组赛阶段一个小组一个赛事 id） */
  nationalStandings: Record<string, Standing>;
  /** 国家队淘汰赛进行态，键为 competitionId */
  nationalKnockouts: Record<string, NationalKnockoutState>;
  /** 本赛季国家队赛事抽签结果 */
  nationalDraws: Record<string, DrawResult>;
  /** 上赛季国家队各赛事排名快照，键为 competitionId */
  lastNationalRanks: Record<string, string[]>;
  /** 上赛季国家队各赛事冠军快照 */
  lastNationalChampions: Record<string, string>;
  /** 上赛季结算出的国家队参赛权（世界杯/洲际杯），本赛季用于组赛；赛季 1 为空 */
  nationalQualifications: NationalQualificationEntry[];
  /** 世界杯 / 洲际杯的举办国 countryId（每赛季轮换，供 UI 与主场优势用） */
  nationalHostCountryId?: string;
  news: string[];
  seasonSummary?: SeasonSummary;
  finished: boolean;
}

/** 淘汰赛单败进行态：每轮从 alive 里种子配对生成，胜者进入下一轮 */
export interface KnockoutState {
  competitionId: string;
  season: number;
  /** 0 起的轮次序号 */
  round: number;
  /** 每轮固定占用哪一周，长度 = 总轮数 */
  weeks: number[];
  /** 存活球队，按种子升序（0 = 头号种子） */
  alive: { clubId: string; seed: number }[];
  eliminated: string[];
  championId?: string;
}


export interface CompetitionDef {
  id: string;
  name: string;
  nameZh: string;
  type: CompetitionType;
  scope: CompetitionScope;
  confederationId?: ConfederationId;
  countryId?: string;
  level: number;
  /** 参赛队数 */
  participants: number;
  /** 必须男性成年 */
  gender: 'men';
  category: 'senior';
}

export interface CareerState extends PlayExtras {
  mode: 'career';
  playerName: string;
  player: Player;
  clubId: string;
  season: number;
  week: number;
  fame: number;
  honors: string[];
  nationality: string;
  confederationId: ConfederationId;
  /** 本赛季累计 */
  seasonApps: number;
  seasonGoals: number;
  seasonAssists: number;
  seasonRatingSum: number;
  /** 已经打完的赛季数（不含进行中的这个） */
  seasonsDone?: number;
  /** 生涯是否已结束（退役或赛季数用尽） */
  retired?: boolean;
  /** 职业生涯价值分，退役时结算 */
  careerValue?: number;
  /** 退役评级 S/A/B/C/D */
  grade?: string;
  /** 效力过的俱乐部（按时间顺序，含当前） */
  clubHistory?: string[];
  /** 开局选的细位置（前锋/边锋/前腰/后腰/中卫/门将，设计 §4.1）；老档没有就用 player.position */
  detailPosition?: string;
}

export interface ManagerState extends PlayExtras {
  mode: 'manager';
  managerName: string;
  /** 执教的俱乐部 id；国家队主帅时为空串 */
  clubId: string;
  /**
   * 执教对象：俱乐部经理 or 国家队主帅（设计 §4.2 二选一）。
   * 旧存档没有这个字段，按 club 处理。
   */
  kind?: 'club' | 'national';
  /** 国家队主帅执教的国家队 id（`${countryId}-nt`） */
  nationalTeamId?: string;
  season: number;
  week: number;
  boardConfidence: number;
  fanMood: number;
  honors: string[];
  confederationId: ConfederationId;
  /** 已经打完的赛季数 */
  seasonsDone?: number;
  /** 连续多少个赛季没拿到欧战（洲际）资格 */
  seasonsWithoutContinental?: number;
  /** 是否已被解雇 */
  fired?: boolean;
  /** 被解雇后可重新应聘的最低级别（tier 数字越大越低） */
  rehireTierFloor?: number;
}

export type PlayState = CareerState | ManagerState;

/** 存档里的一场额外赛程（比赛中动态生成、`createSeason` 重建不出来） */
export interface SavedFixture {
  id: string;
  competitionId: string;
  season: number;
  week: number;
  round: number;
  homeId: string;
  awayId: string;
  stage?: string;
  result?: MatchResult;
}

/**
 * 并行的紧凑结果列：每个字符对应一场比赛，`.` 表示未踢。
 * 分数用 base36 单字符（35 封顶），xG 用 base36 两位。
 */
export interface SavedResultColumns {
  home: string;
  away: string;
  homeXg: string;
  awayXg: string;
  penalty: string;
  /** 上半场比分（两段式报告用），`.` 表示无 */
  halfHome: string;
  halfAway: string;
  /** 点球大战比分，键为列下标 */
  scores: Record<number, string>;
}

/**
 * 存档的「世界动态增量」。
 * 静态世界（俱乐部属性/国家/赛事定义/赛程骨架）全部不存，由 seed 重新生成；
 * 这里只放重放不出来的东西：赛果、体能/状态/士气、升降级位移、淘汰赛进行态、上季快照。
 */
export interface WorldDelta {
  season: number;
  week: number;
  finished: boolean;
  news: string[];
  clubs: {
    stamina: number[];
    form: number[];
    morale: number[];
    /** [俱乐部下标, tier, competitionId]，只记与 seed 生成值不同的项 */
    moves: [number, number, string][];
    /**
     * 财政/声望/实力变动（P5）：[俱乐部下标, 现金, 声望, 攻击, 中场, 防守]，
     * 只记与 seed 生成值不同的项。转会与赛季财政结算会改这些字段。
     */
    attrs?: [number, number, number, number, number, number][];
  };
  nationalTeams: {
    form: number[];
    morale: number[];
    stamina: number[];
    tiers: string[];
  };
  /** 骨架赛程结果（顺序 = `createSeason` 生成顺序） */
  clubResults: SavedResultColumns;
  extraFixtures: SavedFixture[];
  knockouts: Record<string, KnockoutState>;
  nationalResults: SavedResultColumns;
  extraNationalFixtures: SavedFixture[];
  nationalKnockouts: Record<string, NationalKnockoutState>;
  lastSeasonRanks: Record<string, string[]>;
  lastSeasonChampions: Record<string, string>;
  qualifications: QualificationEntry[];
  nationalQualifications: NationalQualificationEntry[];
  seasonSummary?: SeasonSummary;
  nationalHostCountryId?: string;
}

/**
 * 存档（v1）。
 * 设计 §11.2：只存 seed + 模式 + 玩家态 + 必要的世界动态数据；
 * 读档用 seed 重新生成静态世界，动态数据只留当前赛季（+ 上一赛季快照）。
 */
export interface SaveGame {
  version: number;
  createdAt: number;
  seed: number;
  mode: Mode;
  state: PlayState;
  delta: WorldDelta;
}

export interface HalfResult {
  homeGoals: number;
  awayGoals: number;
  homeXg: number;
  awayXg: number;
}

export interface MatchFlow {
  fixtureId: string;
  homeId: string;
  awayId: string;
  /** 上半场结果，写入后不许回改 */
  firstHalf: HalfResult;
  /** 半场动作，最多 2 条 */
  halfTimeActions: HalfAction[];
  subsUsed: number;
  mentality: Mentality;
  /** 已结算的关键时刻 */
  moments: { key: string; success: boolean; text: string }[];
  pendingMomentId?: string;
  /** 关键时刻结算出的下半场边差（设计 §15.2：只改剩余比赛） */
  momentEdge?: number;
  /** 半场换的战术（下半场生效） */
  planTactic?: TacticId;
  result?: MatchResult;
}

export interface HalfAction {
  type: 'sub' | 'tactic' | 'mentality';
  value: string;
}

/** P7 事件链：一条活跃链的当前进度（设计 §15.4） */
export interface ActiveChain {
  id: string;
  /** 当前等待玩家抉择的步骤 id */
  stepId: string;
  /** 该步骤出现的周次 */
  dueWeek: number;
}

/** P7 挑战剧本进度（设计 §15.6） */
export interface ScenarioState {
  id: string;
  /** 已达成目标：bronze / silver / gold */
  reached: string[];
  /** 最近一次评级（铜/银/金/未达标） */
  grade?: string;
}

/**
 * P7 可玩性层的玩家侧公共字段（设计 §15）。
 * 两个模式的 PlayState 都 extends 它，存档时随 state 整体落盘，无需扩 delta。
 */
export interface PlayExtras {
  /** 活跃事件链（≤ chainMaxActive，多余进 queue） */
  chains?: ActiveChain[];
  /** 排队等待的链 id */
  chainQueue?: string[];
  /** 已经结束的链 id（同一链不重复触发） */
  chainDone?: string[];
  /** 社区层开关（关掉后热评返回空数组） */
  communityOn?: boolean;
  /** 最近一场的赛后热评（仅展示） */
  hotComments?: string[];
  /** 挑战剧本进度 */
  scenario?: ScenarioState;
  /** 本周世界大事（叙事，不影响积分与资格） */
  worldNews?: string[];
  /**
   * 已结算（玩家侧：荣誉/成长/董事会）的赛季号。
   * P0-1：赛季末结算必须幂等，UI 连点「推进一周」不能把年龄从 17 推到 20。
   */
  lastSettledSeason?: number;
}
