import { BALANCE } from '../game/balance';
import {
  advanceGame,
  buildSave,
  canContinue,
  loadFrom,
  loadFromStorage,
  needsSeasonRollover,
  newGame,
  rehire,
  retire,
  rollSeason,
  saveInfo,
  SaveController,
} from '../game/game';
import { careerStats } from '../game/play/career';
import { managerStats } from '../game/play/manager';
import { applyHalfTimePlan, beginFlow, decisionsCount, finishFlow, resolveMoment } from '../game/match/flow';
import type { HalfPlan } from '../game/match/flow';
import { defaultStorage } from '../game/save/persist';
import { generateWorld } from '../game/world/generate';
import { scenarioById } from '../game/config/scenarios';
import { applyScenario, fastForward, scenarioClub } from '../game/play/scenario';
import { evaluateBid, marketFor, signBid } from '../game/play/negotiation';
import type { BidResult } from '../game/play/negotiation';
import { resolveChainStep } from '../game/play/chains';
import { applyInterviewChoice } from '../game/play/activity';
import { acceptOffer, offersForPlayerClub, rejectOffer } from '../game/play/transfer';
import { basePositionOf } from '../game/config/positions';
import type { DetailPosition } from '../game/config/positions';
import type { GameSession } from '../game/game';
import type { ManagerSeasonOutcome } from '../game/play/manager';
import type { CareerState, ManagerState, MatchFlow, MatchResult, Mode } from '../game/types';

/**
 * 应用状态与路由（P6）。
 *
 * 只做三件事：持有 session、切换当前屏、把「玩家动作」翻译成 game.ts 的调用。
 * 规则一律不进这里 —— 这里允许出现的是文案与页面跳转。
 */

export type ScreenId =
  | 'home'
  | 'setup'
  | 'dashboard'
  | 'world-pylon'
  | 'competition'
  | 'calendar'
  | 'match-preview'
  | 'match-live'
  | 'match-report'
  | 'transfer'
  | 'negotiation'
  | 'community'
  | 'scenario'
  | 'draw'
  | 'qualification'
  | 'squad'
  | 'finance'
  | 'board'
  | 'season-end'
  | 'career-end'
  | 'settings';

/** 开局链的四个步骤（设计 §4.1 / §4.2 / §10.3） */
export type SetupStep = 'kind' | 'country' | 'target' | 'detail';

export interface SetupDraft {
  mode: Mode;
  /** 俱乐部经理 / 国家队主帅（仅 manager 模式有意义） */
  kind?: 'club' | 'national';
  /** 当前走到开局链第几步 */
  step?: SetupStep;
  confederationId?: string;
  countryId?: string;
  tier?: number;
  clubId?: string;
  /** 国家队主帅选的队 id（`${countryId}-nt`） */
  nationalTeamId?: string;
  position?: DetailPosition;
  playerName?: string;
  managerName?: string;
}

export interface LastReport {
  fixtureId: string;
  competitionId: string;
  competitionName: string;
  homeId: string;
  awayId: string;
  homeName: string;
  awayName: string;
  homeGoals: number;
  awayGoals: number;
  /** 玩家视角：win / draw / loss */
  outcome: 'win' | 'draw' | 'loss';
  line?: { goals: number; assists: number; rating: number };
  penalties?: string;
  rankBefore?: number;
  rankAfter?: number;
  minute?: number;
  /** 赛后热评（P7 社区层，关闭时为空） */
  hotComments?: string[];
  /** 本场玩家做了几个决策（设计 §15.1 口径） */
  decisions?: number;
}

export interface SeasonReport {
  season: number;
  leagueRank: number;
  leagueName: string;
  honors: string[];
  promoted: string[];
  relegated: string[];
  boardDelta: number;
  fanDelta: number;
  fired: boolean;
  retired: boolean;
  reasons: string[];
  grade?: string;
  careerValue?: number;
}

export interface AppState {
  screen: ScreenId;
  session: GameSession | null;
  draft: SetupDraft;
  /** 当前查看的赛事/俱乐部/联赛（页面间传递） */
  focusCompetitionId?: string;
  focusClubId?: string;
  lastReport?: LastReport;
  seasonReport?: SeasonReport;
  /** 本周新闻（转会、征召、国家队），主控台显示 */
  news?: string[];
  /** 交互比赛进行中的流程（P7 两段式） */
  flow?: MatchFlow;
  /** 半场面板是否已经确认过 */
  halfDone?: boolean;
  /** 转会页当前选中的目标 */
  bidTarget?: string;
  /** 最近一次谈判回执（谈判页逐关展示原因码） */
  bidResult?: BidResult;
  /** 最近一次谈判结果文案 */
  bidText?: string;
  toast?: string;
  repaired: string[];
  /** 是否曾经读过档（首页显示「继续」） */
  hasSave: boolean;
  busy: boolean;
}

/**
 * 控制器必须先于 app 初始化：app.hasSave 在对象字面量里就要读它。
 * 反过来写会撞 TDZ（`controller` 尚未初始化）→ hasStoredSave 的 try/catch
 * 把 ReferenceError 吞掉 → 刷新后永远认为「没有存档」。
 */
export const controller = new SaveController({ storage: defaultStorage() });

export function hasStoredSave(): boolean {
  try {
    return controller.has();
  } catch {
    return false;
  }
}

export const app: AppState = {
  screen: 'home',
  session: null,
  draft: { mode: 'career' },
  repaired: [],
  hasSave: hasStoredSave(),
  busy: false,
};

/**
 * 切屏。顺带写一条 history，让手机 webview 与浏览器的返回键能退回上一屏。
 *
 * 为什么放在这里而不是 main.ts：`go()` 是唯一换屏入口（views 也调它），
 * 放在入口才不会漏。测试环境（node）没有 history，`typeof` 一挡即可；
 * 同屏不重复压栈，避免「点了返回还停在原地」。
 */

/** history 条目的内存镜像：返回键要一次退到目标屏，而不是一路退到首页 */
const navStack: ScreenId[] = [app.screen];
/** 每屏离开时的滚动位置，popstate 回来时还原 */
const scrollMemo: Partial<Record<ScreenId, number>> = {};
let pendingScroll: number | null = null;
/** pushState 是否真的成功；file:// 下可能抛，此时不能用 history.go 回退 */
let historyOk = true;
/** 正在等 popstate：期间再点返回不再发一次 history.go，避免连退两屏 */
let popping = false;

function rememberScroll(screen: ScreenId): void {
  if (typeof window !== 'undefined' && typeof window.scrollY === 'number') scrollMemo[screen] = window.scrollY;
}

export function go(screen: ScreenId): void {
  if (app.screen === screen) return;
  rememberScroll(app.screen);
  pendingScroll = null;
  navStack.push(screen);
  if (typeof history !== 'undefined' && typeof history.pushState === 'function') {
    try {
      history.pushState({ screen, depth: navStack.length - 1 }, '');
    } catch {
      // file:// 或受限 webview 可能抛，但不影响切屏本身
      historyOk = false;
    }
  } else {
    historyOk = false;
  }
  app.screen = screen;
}

/** 换屏并替换当前 history 条目（开局/读档/删档后使用，避免「返回」退回已失效的表单） */
export function replace(screen: ScreenId): void {
  if (app.screen !== screen) rememberScroll(app.screen);
  app.screen = screen;
  pendingScroll = null;
  if (navStack.length === 0) navStack.push(screen);
  else navStack[navStack.length - 1] = screen;
  if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
    try {
      history.replaceState({ screen, depth: navStack.length - 1 }, '');
    } catch {
      historyOk = false;
    }
  }
}

/**
 * 导航决策：目标屏已经在历史栈里就回退（一次 history.go，只触发一个 popstate），
 * 否则正常压栈。修复：以前只压不弹，返回键要按很多次才能退出页面。
 */
export function navDecision(screen: ScreenId): { kind: 'push' } | { kind: 'pop'; delta: number } {
  if (app.screen === screen) return { kind: 'push' };
  const index = navStack.lastIndexOf(screen);
  if (index >= 0 && index < navStack.length - 1) return { kind: 'pop', delta: index - (navStack.length - 1) };
  return { kind: 'push' };
}

export function navigate(screen: ScreenId): 'pushed' | 'popped' {
  if (popping) return 'popped';
  const decision = navDecision(screen);
  if (decision.kind === 'pop' && historyOk && typeof history !== 'undefined' && typeof history.go === 'function') {
    rememberScroll(app.screen);
    try {
      popping = true;
      history.go(decision.delta);
      return 'popped';
    } catch {
      popping = false;
      // 回退失败就退化成普通压栈
    }
  }
  go(screen);
  return 'pushed';
}

/** popstate：把目标屏同步进 navStack，并记下要还原的滚动位置 */
export function handleHistoryPop(screen: ScreenId | undefined): void {
  const next = screen ?? 'home';
  const index = navStack.lastIndexOf(next);
  if (index >= 0) navStack.length = index + 1;
  else navStack.push(next);
  popping = false;
  app.screen = next;
  pendingScroll = scrollMemo[next] ?? 0;
}

/** 取一次「待还原滚动位置」，取完清空 */
export function takePendingScroll(): number | null {
  const value = pendingScroll;
  pendingScroll = null;
  return value;
}

/** 只读快照：给测试与调试看历史栈 */
export function navSnapshot(): readonly ScreenId[] {
  return navStack;
}

/** 开局草稿的姓名：折叠空白、截 12 字，空串代表「用系统默认」 */
export function setDraftName(field: 'playerName' | 'managerName', raw: string): void {
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, 12);
  app.draft = { ...app.draft, [field]: name.length > 0 ? name : undefined };
}

export function toast(message: string): void {
  app.toast = message;
}

export function requireSession(): GameSession | null {
  return app.session;
}

export function playerClubId(): string | undefined {
  const state = app.session?.state;
  if (!state) return undefined;
  return state.clubId;
}

/* ---------------- 推进 ---------------- */

/** 新开档/读档/删档后清掉上一局残留的临时状态（赛事焦点、报价、比赛流程） */
function resetTransientState(): void {
  app.lastReport = undefined;
  app.seasonReport = undefined;
  app.news = undefined;
  app.focusCompetitionId = undefined;
  app.focusClubId = undefined;
  app.bidTarget = undefined;
  app.bidResult = undefined;
  app.bidText = undefined;
  app.flow = undefined;
  app.halfDone = undefined;
}

export function startNewGame(): void {
  const draft = app.draft;
  const session =
    draft.mode === 'career'
      ? newGame({
          mode: 'career',
          career: {
            // 细位置（前锋/边锋/前腰/后腰/中卫/门将）落库时归到底层四类
            position: basePositionOf(draft.position),
            detailPosition: draft.position,
            nationality: draft.countryId ?? 'ENG',
            ...(draft.clubId ? { clubId: draft.clubId } : {}),
            ...(draft.playerName ? { playerName: draft.playerName } : {}),
          },
        })
      : newGame({
          mode: 'manager',
          manager: {
            ...(draft.kind === 'national' && draft.nationalTeamId
              ? { nationalTeamId: draft.nationalTeamId }
              : { confederationId: draft.confederationId ?? 'UEFA', tier: draft.tier ?? 2 }),
            ...(draft.clubId ? { clubId: draft.clubId } : {}),
            ...(draft.managerName ? { managerName: draft.managerName } : {}),
          },
        });
  app.session = session;
  // 修复：开局是「替换当前历史条目」，否则返回键会退回到已经失效的开局表单
  resetTransientState();
  replace('dashboard');
  persistNow();
}

/** 存档：400ms 防抖 + 内容去重由 SaveController 负责。 */
export function persistNow(): void {
  if (!app.session) return;
  try {
    controller.writeNow(app.session.world, app.session.state);
    app.hasSave = true;
  } catch (error) {
    console.warn('[save] 写档失败', error);
  }
}

export function loadGame(): boolean {
  const loaded = loadFromStorage(controller);
  if (!loaded.ok) {
    toast(`读档失败：${loaded.reason}`);
    return false;
  }
  app.session = { world: loaded.session.world, state: loaded.session.state };
  app.repaired = loaded.session.repaired;
  resetTransientState();
  replace('dashboard');
  return true;
}

export function importSave(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    toast('存档解析失败：不是合法 JSON');
    return false;
  }
  const loaded = loadFrom(parsed);
  if (!loaded.ok) {
    toast(`读档失败：${loaded.reason}`);
    return false;
  }
  app.session = { world: loaded.session.world, state: loaded.session.state };
  app.repaired = loaded.session.repaired;
  // 修复：导入存档以前不清上一局的赛报/新闻，会串档到新存档里
  resetTransientState();
  replace('dashboard');
  persistNow();
  return true;
}

export function wipeSave(): void {
  controller.clear();
  app.hasSave = false;
  app.session = null;
  app.repaired = [];
  resetTransientState();
  replace('home');
}

/* ---------------- 推进 ---------------- */

export interface AdvanceOutcome {
  played: boolean;
  seasonEnded: boolean;
  needsRollover: boolean;
}

export function advanceOneWeek(playerResult?: MatchResult): AdvanceOutcome {
  const session = app.session;
  if (!session) return { played: false, seasonEnded: false, needsRollover: false };
  if (!canContinue(session.state)) {
    return { played: false, seasonEnded: false, needsRollover: false };
  }
  const before = captureReportContext(session);
  const result = advanceGame(session, playerResult ? { playerResult } : {});
  app.session = { world: result.world, state: result.state };
  app.flow = undefined;
  if (result.played) {
    app.lastReport = buildReport(before, result.world, result.state, result.seasonEnded);
  }
  const state = result.state;
  if (app.lastReport && state.hotComments && app.lastReport.hotComments === undefined) {
    app.lastReport.hotComments = state.hotComments;
  }
  const news = [...result.news];
  if (result.calledUp) news.unshift('你入选了本期国家队名单。');
  app.news = news.length > 0 ? news : undefined;
  if (result.seasonEnded) {
    app.seasonReport = buildSeasonReport(result.world, result.state, result.outcome);
  }
  persistNow();
  return { played: result.played, seasonEnded: result.seasonEnded, needsRollover: result.needsRollover };
}

/* ---------------- P7 交互比赛（两段式） ---------------- */

/** 本周是否有你的比赛（「亲自踢这场」按钮的出现条件，必须与 startLiveMatch 的筛选一致） */
export function thisWeekMatch(): boolean {
  const session = app.session;
  if (!session) return false;
  const clubId = session.state.clubId;
  return session.world.fixtures.some(
    (f) => !f.played && f.week === session.world.week && (f.homeId === clubId || f.awayId === clubId),
  );
}

export function startLiveMatch(): boolean {
  const session = app.session;
  if (!session) return false;
  const clubId = session.state.clubId;
  const fixture = session.world.fixtures
    .filter((f) => !f.played && f.week === session.world.week && (f.homeId === clubId || f.awayId === clubId))
    .sort((a, b) => a.competitionId.localeCompare(b.competitionId))[0];
  if (!fixture) {
    toast('本周没有你的比赛。');
    return false;
  }
  const cup = !fixture.competitionId.endsWith('-l1') && Boolean(fixture.stage);
  app.flow = beginFlow(session.world, fixture.id, {
    careerPlayer: session.state.mode === 'career',
    cup,
  });
  app.halfDone = false;
  go('match-live');
  return true;
}

/** 半场调整（换人/心态/战术），超限给原因 */
export function applyHalfTime(plan: HalfPlan): void {
  const session = app.session;
  if (!session || !app.flow) return;
  const cup = Boolean(app.flow.fixtureId.includes('-k'));
  const { flow, rejected } = applyHalfTimePlan(app.flow, plan, {
    careerPlayer: session.state.mode === 'career',
    cup,
  });
  app.flow = flow;
  if (rejected) toast(rejected.text);
}

/** 确认半场面板，进入关键时刻 */
export function confirmHalf(): void {
  app.halfDone = true;
}

/** 关键时刻抉择 */
export function chooseMoment(index: number): void {
  const session = app.session;
  if (!session || !app.flow) return;
  app.flow = resolveMoment(session.world, app.flow, index);
}

/** 踢完下半场并推进这一周 */
export function finishLiveMatch(): void {
  const session = app.session;
  if (!session || !app.flow) return;
  const { flow, result } = finishFlow(session.world, app.flow);
  app.flow = flow;
  const decisionCount = decisionsCount(flow);
  const outcome = advanceOneWeek(result);
  if (app.lastReport) {
    app.lastReport.decisions = decisionCount;
    const penalties = flow.result?.penaltyScore;
    if (penalties) app.lastReport.penalties = penalties;
  }
  go(outcome.seasonEnded ? 'season-end' : 'match-report');
}

/** 社区层开关（关掉后不再生成热评，游戏其余部分不变） */
export function toggleCommunity(): boolean {
  const session = app.session;
  if (!session) return false;
  const on = session.state.communityOn !== false;
  app.session = {
    world: session.world,
    state: { ...session.state, communityOn: !on },
  };
  persistNow();
  return !on;
}

/* ---------------- P7 事件链与采访 ---------------- */

export function answerChain(index: number): void {
  const session = app.session;
  if (!session) return;
  const result = resolveChainStep(session.world, session.state, index);
  app.session = { world: result.world, state: result.state };
  toast(result.text);
  persistNow();
}

export function answerInterview(index: number): void {
  const session = app.session;
  if (!session) return;
  app.session = {
    world: session.world,
    state: applyInterviewChoice(session.world, session.state, index),
  };
  persistNow();
}

/* ---------------- P7 转会谈判 ---------------- */

export function pickBidTarget(id: string): void {
  app.bidTarget = id;
  app.bidText = undefined;
  app.bidResult = undefined;
}

/**
 * 按挂牌价 × scale 开价（玩家不输入数字：一键按估值，或加价 10% 再谈）。
 * 失败时保留 bidTarget 与 bidResult，谈判页据此逐关展示原因码。
 */
export function makeBid(scale = 1): boolean {
  const session = app.session;
  if (!session || !app.bidTarget) return false;
  const clubId = session.state.clubId;
  const target = marketFor(session.world, clubId, 8).find((t) => t.id === app.bidTarget);
  if (!target) {
    app.bidText = '该目标已不在名单里（转会窗已刷新）';
    app.bidResult = undefined;
    return false;
  }
  const fee = Math.round(target.askingPrice * scale);
  const agentFee = Math.round(fee * BALANCE.agentFeeRatio);
  const result = evaluateBid(session.world, clubId, target, fee, target.wage, agentFee);
  app.bidResult = result;
  app.bidText = result.reasons.map((r) => r.text).join(' ');
  if (result.ok) {
    app.session = {
      // 佣金要和 evaluateBid 里展示的那笔一致（signBid 默认 8%，这里显式透传）
      world: signBid(session.world, clubId, target, fee, target.wage, agentFee),
      state: session.state,
    };
    app.bidTarget = undefined;
    app.bidResult = undefined;
    persistNow();
    return true;
  }
  return false;
}

/** 生涯模式：接受/拒绝一家俱乐部的报价 */
export function answerCareerOffer(offerId: string, accept: boolean): void {
  const session = app.session;
  if (!session) return;
  const offers = offersForPlayerClub(session.world, session.state.clubId);
  const offer = offers.find((o) => o.id === offerId);
  if (!offer) return;
  if (!accept) {
    app.bidText = rejectOffer(session.world, offer);
  } else {
    const prev = session.world;
    const world = acceptOffer(prev, offer);
    // 买方现金不足时 acceptOffer 原样返回 world（引用不变），必须提示而不是静默
    if (world === prev) {
      app.bidText = '对方现金不足，无法接受。';
      persistNow();
      return;
    }
    app.session = {
      world,
      state: { ...session.state, clubId: offer.toClubId } as typeof session.state,
    };
    const club = world.clubs.find((c) => c.id === offer.toClubId);
    app.bidText = `你转会到了 ${club?.name ?? offer.toClubId}。`;
  }
  persistNow();
}

/* ---------------- P7 挑战剧本 ---------------- */

export function startScenarioGame(id: string): boolean {
  const def = scenarioById(id);
  if (!def) return false;
  const probe = generateWorld(def.seed);
  const club = scenarioClub(probe, def);
  if (!club) {
    toast('剧本找不到目标俱乐部（国家/级别不匹配）');
    return false;
  }
  const session = newGame({ mode: 'manager', seed: def.seed, manager: { clubId: club.id } });
  if (session.state.mode !== 'manager') return false;
  const forward = fastForward(session.world, def.startWeek);
  const applied = applyScenario(forward, session.state, def);
  app.session = { world: applied.world, state: applied.state };
  app.lastReport = undefined;
  app.seasonReport = undefined;
  app.news = [`剧本「${def.name}」开始：${def.blurb}`];
  app.flow = undefined;
  go('dashboard');
  persistNow();
  return true;
}

export function rollToNextSeason(): void {
  if (!app.session) return;
  app.session = rollSeason(app.session);
  app.seasonReport = undefined;
  go('dashboard');
  persistNow();
}

/**
 * P0-1（玩家可见的一半）：赛季已结算、只差「进入下一季」时，主控台必须显示
 * 「进入下一季」，不能再显示「推进一周」——advanceGame 对已 finished 的世界原样返回，
 * 玩家会以为按钮坏了。
 */
export function needsRollover(): boolean {
  const session = app.session;
  return session ? needsSeasonRollover(session.world, session.state) : false;
}

/** 生涯已退役 / 经理已被解雇：既不能推进，也不能开新赛季，只能换一条路 */
export function sessionOver(): boolean {
  const session = app.session;
  if (!session) return false;
  return session.state.mode === 'career' ? session.state.retired === true : session.state.fired === true;
}

export function doRetire(): void {
  if (!app.session) return;
  app.session = retire(app.session);
  const state = app.session.state as CareerState;
  app.seasonReport = {
    season: app.session.world.season,
    leagueRank: 0,
    leagueName: '',
    honors: state.honors.slice(-6),
    promoted: [],
    relegated: [],
    boardDelta: 0,
    fanDelta: 0,
    fired: false,
    retired: true,
    reasons: ['你决定在这里挂靴。'],
    ...(state.grade ? { grade: state.grade } : {}),
    ...(state.careerValue !== undefined ? { careerValue: state.careerValue } : {}),
  };
  go('career-end');
  persistNow();
}

export function doRehire(): void {
  if (!app.session) return;
  app.session = rehire(app.session);
  go('dashboard');
  persistNow();
}

/* ---------------- 报告 ---------------- */

interface ReportContext {
  fixtureId: string;
  competitionId: string;
  homeId: string;
  awayId: string;
  rankBefore: number;
}

function captureReportContext(session: GameSession): ReportContext | null {
  const clubId = session.state.clubId;
  const club = session.world.clubs.find((c) => c.id === clubId);
  if (!club) return null;
  const next = session.world.fixtures
    .filter((f) => !f.played && f.week === session.world.week && (f.homeId === clubId || f.awayId === clubId))
    .sort((a, b) => a.competitionId.localeCompare(b.competitionId))[0];
  if (!next) return null;
  const rows = session.world.standings[club.competitionId]?.rows ?? [];
  const rankBefore = rows.findIndex((r) => r.clubId === clubId) + 1;
  return {
    fixtureId: next.id,
    competitionId: next.competitionId,
    homeId: next.homeId,
    awayId: next.awayId,
    rankBefore,
  };
}

function buildReport(
  context: ReportContext | null,
  world: GameSession['world'],
  state: CareerState | ManagerState,
  _seasonEnded: boolean,
): LastReport | undefined {
  if (!context) return undefined;
  const fixture = world.fixtures.find((f) => f.id === context.fixtureId);
  const clubId = state.clubId;
  const comp = world.competitions.find((c) => c.id === context.competitionId);
  const home = world.clubs.find((c) => c.id === context.homeId);
  const away = world.clubs.find((c) => c.id === context.awayId);
  if (!fixture || !fixture.result || !home || !away) return undefined;

  const isHome = fixture.homeId === clubId;
  const mine = isHome ? fixture.result.homeGoals : fixture.result.awayGoals;
  const theirs = isHome ? fixture.result.awayGoals : fixture.result.homeGoals;
  const penalty = fixture.result.penalty;
  const outcome: LastReport['outcome'] =
    mine > theirs ? 'win' : mine < theirs
      ? 'loss'
      : (isHome && penalty === 'home') || (!isHome && penalty === 'away')
        ? 'win'
        : (isHome && penalty === 'away') || (!isHome && penalty === 'home')
          ? 'loss'
          : 'draw';

  const club = world.clubs.find((c) => c.id === clubId);
  const rows = club ? (world.standings[club.competitionId]?.rows ?? []) : [];
  const rankAfter = rows.findIndex((r) => r.clubId === clubId) + 1;

  const report: LastReport = {
    fixtureId: fixture.id,
    competitionId: context.competitionId,
    competitionName: comp?.nameZh ?? context.competitionId,
    homeId: context.homeId,
    awayId: context.awayId,
    homeName: home.name,
    awayName: away.name,
    homeGoals: fixture.result.homeGoals,
    awayGoals: fixture.result.awayGoals,
    outcome,
    ...(context.rankBefore > 0 ? { rankBefore: context.rankBefore } : {}),
    ...(rankAfter > 0 ? { rankAfter } : {}),
    minute: 90,
  };
  if (fixture.result.penaltyScore) report.penalties = fixture.result.penaltyScore;
  return report;
}

function buildSeasonReport(
  world: GameSession['world'],
  state: CareerState | ManagerState,
  outcome?: ManagerSeasonOutcome,
): SeasonReport {
  const club = world.clubs.find((c) => c.id === state.clubId);
  const summary = world.seasonSummary;
  const rows = club ? (world.standings[club.competitionId]?.rows ?? []) : [];
  const leagueRank = rows.findIndex((r) => r.clubId === state.clubId) + 1;
  const leagueName = club
    ? (world.competitions.find((c) => c.id === club.competitionId)?.nameZh ?? '')
    : '';
  const promoted = (summary?.promoted ?? []).filter((p) => p.clubId === state.clubId).map((p) => `升入 T${p.toTier}`);
  const relegated = (summary?.relegated ?? []).filter((p) => p.clubId === state.clubId).map((p) => `降至 T${p.toTier}`);

  if (state.mode === 'career') {
    const stats = careerStats(world, state);
    return {
      season: world.season,
      leagueRank,
      leagueName,
      honors: state.honors.slice(-4),
      promoted,
      relegated,
      boardDelta: 0,
      fanDelta: 0,
      fired: false,
      retired: state.retired === true,
      reasons: [],
      grade: gradeLabel(stats.grade),
      careerValue: stats.careerValue,
    };
  }

  const info = managerStats(world, state);
  return {
    season: world.season,
    leagueRank: info.leagueRank,
    leagueName,
    honors: state.honors.slice(-4),
    promoted,
    relegated,
    boardDelta: outcome?.boardDelta ?? 0,
    fanDelta: outcome?.fanDelta ?? 0,
    fired: info.fired,
    retired: false,
    reasons: outcome?.reasons ?? [],
    grade: gradeLabel(gradeFor(state.boardConfidence)),
  };
}

export function gradeFor(boardConfidence: number): string {
  if (boardConfidence >= 80) return 'S';
  if (boardConfidence >= 66) return 'A';
  if (boardConfidence >= 50) return 'B';
  if (boardConfidence >= 34) return 'C';
  return 'D';
}

export function gradeLabel(grade: string): string {
  const map: Record<string, string> = {
    S: '历史级',
    A: '名人堂',
    B: '联盟门面',
    C: '合格首发',
    D: '边缘人',
  };
  return map[grade] ?? grade;
}

/** 玩家俱乐部当前联赛排名（1 起，0 = 未知）。 */
export function currentRank(): number {
  const session = app.session;
  if (!session) return 0;
  const club = session.world.clubs.find((c) => c.id === session.state.clubId);
  if (!club) return 0;
  const rows = session.world.standings[club.competitionId]?.rows ?? [];
  return rows.findIndex((r) => r.clubId === club.id) + 1;
}

/** 下一场（玩家俱乐部） */
export function nextFixture(): { week: number; homeName: string; awayName: string; competitionName: string } | null {
  const session = app.session;
  if (!session) return null;
  const clubId = session.state.clubId;
  const next = session.world.fixtures
    .filter((f) => !f.played && (f.homeId === clubId || f.awayId === clubId))
    .sort((a, b) => a.week - b.week)[0];
  if (!next) return null;
  const home = session.world.clubs.find((c) => c.id === next.homeId);
  const away = session.world.clubs.find((c) => c.id === next.awayId);
  const comp = session.world.competitions.find((c) => c.id === next.competitionId);
  return {
    week: next.week,
    homeName: home?.name ?? '?',
    awayName: away?.name ?? '?',
    competitionName: comp?.nameZh ?? '',
  };
}

export function saveSizeText(): string {
  if (!app.session) return '—';
  const info = saveInfo(buildSave(app.session));
  return `${info.kb} KB / ${BALANCE.saveMaxKB} KB`;
}

