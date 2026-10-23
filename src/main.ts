import './ui/styles.css';
import { delegate, delegateInput, fatalError, mount } from './ui/dom';
import {
  app,
  advanceOneWeek,
  doRehire,
  doRetire,
  go,
  handleHistoryPop,
  importSave,
  loadGame,
  navigate,
  persistNow,
  rollToNextSeason,
  setDraftName,
  startNewGame,
  takePendingScroll,
  wipeSave,
} from './ui/state';
import { homePage, setupPage } from './ui/views/home';
import { careerEndPage, dashboardPage, seasonEndPage } from './ui/views/dashboard';
import { drawPage, matchPreviewPage, matchReportPage } from './ui/views/match';
import {
  boardPage,
  calendarPage,
  financePage,
  importFromBox,
  persistCurrent,
  requestWipe,
  setImportDraft,
  settingsPage,
  squadPage,
} from './ui/views/misc';
import { competitionPage, openCompetition, pylonPage, qualificationPage, setPylonLine } from './ui/views/world';
import { communityPage, livePage, negotiationPage, scenarioPage, scenarioStart, transferPage } from './ui/views/live';
import {
  answerCareerOffer,
  answerChain,
  answerInterview,
  applyHalfTime,
  chooseMoment,
  confirmHalf,
  finishLiveMatch,
  makeBid,
  pickBidTarget,
  startLiveMatch,
  toggleCommunity,
} from './ui/state';
import { saveJson } from './game/game';
import { positionOf } from './game/config/positions';
import type { ScreenId } from './ui/state';

/**
 * 入口：一个 4 行的路由 + 一个事件委托。
 *
 * 所有交互走 data-act（设计 §10.3 DOM 钩子），因此：
 *  - 重绘不需要重新绑定；
 *  - 自动化冒烟可以直接按钩子点；
 *  - 没有任何内联 JS 拼接（避免转义漏洞）。
 */

const ROUTES: Record<ScreenId, () => string> = {
  'home': homePage,
  'setup': setupPage,
  'dashboard': dashboardPage,
  'world-pylon': pylonPage,
  'competition': competitionPage,
  'calendar': calendarPage,
  'match-preview': matchPreviewPage,
  'match-live': livePage,
  'match-report': matchReportPage,
  'transfer': transferPage,
  'negotiation': negotiationPage,
  'community': communityPage,
  'scenario': scenarioPage,
  'draw': drawPage,
  'qualification': qualificationPage,
  'squad': squadPage,
  'finance': financePage,
  'board': boardPage,
  'season-end': seasonEndPage,
  'career-end': careerEndPage,
  'settings': settingsPage,
};

/** 上一次真正渲染出来的屏：用来判断这次是「跨屏」还是「同屏局部重绘」 */
let lastScreen: ScreenId | null = null;

function render(): void {
  try {
    const route = ROUTES[app.screen] ?? homePage;
    // 修复：同屏重绘（心态/战术/线别切换）保留滚动位置，只有跨屏才回到顶部
    mount(route(), { keepScroll: lastScreen === app.screen });
    lastScreen = app.screen;
    // 浏览器返回时还原离开该屏时的滚动位置
    const restore = takePendingScroll();
    if (restore !== null) window.scrollTo(0, restore);
    if (app.toast) {
      showToast(app.toast);
      app.toast = undefined;
    }
  } catch (error) {
    // 修复：渲染异常不再白屏，给玩家一个能点的兜底页
    console.error('[ui] 渲染失败', error);
    fatalError(error instanceof Error ? error.message : String(error));
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showToast(message: string): void {
  document.getElementById('toast')?.remove();
  const node = document.createElement('div');
  node.id = 'toast';
  node.className = 'toast';
  node.textContent = message;
  node.setAttribute('role', 'status');
  document.body.appendChild(node);
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 2400);
}

/** 推进一周后按结果跳屏 */
function handleAdvance(): void {
  const outcome = advanceOneWeek();
  if (outcome.seasonEnded) {
    if (app.session?.state.mode === 'career' && app.session.state.retired) {
      go('career-end');
    } else {
      go('season-end');
    }
  } else if (app.lastReport) {
    go('match-report');
  } else {
    go('dashboard');
  }
  render();
}

function handleAction(act: string, node: HTMLElement): void {
  switch (act) {
    case 'nav': {
      const screen = node.dataset.screen as ScreenId | undefined;
      if (screen && ROUTES[screen]) {
        // 修复：目标屏在历史栈里就回退（不压新条）；popstate 会负责重绘
        if (navigate(screen) === 'pushed') render();
      }
      return;
    }
    case 'mode-career':
    case 'mode-manager': {
      app.draft = { mode: act === 'mode-career' ? 'career' : 'manager' };
      go('setup');
      render();
      return;
    }
    case 'pick-confederation': {
      const confederationId = node.dataset.confederation;
      // 换联合会要清掉下游的国家/俱乐部/国家队，否则会带着别的洲的选择进局
      app.draft = { ...app.draft, confederationId, countryId: undefined, clubId: undefined, tier: undefined, nationalTeamId: undefined };
      render();
      return;
    }
    case 'pick-country': {
      const countryId = node.dataset.country;
      app.draft = { ...app.draft, countryId, clubId: undefined, tier: undefined, nationalTeamId: undefined };
      render();
      return;
    }
    case 'pick-kind': {
      const kind = node.dataset.kind === 'national' ? 'national' : 'club';
      app.draft = {
        ...app.draft,
        kind,
        clubId: undefined,
        nationalTeamId: undefined,
        tier: kind === 'club' ? (app.draft.tier ?? 1) : undefined,
      };
      render();
      return;
    }
    case 'pick-tier': {
      const tier = Number(node.dataset.tier);
      app.draft = { ...app.draft, tier: Number.isFinite(tier) ? tier : undefined, clubId: undefined };
      render();
      return;
    }
    case 'pick-target': {
      const clubId = node.dataset.club;
      const nationalTeamId = node.dataset.national;
      app.draft = {
        ...app.draft,
        ...(clubId ? { clubId } : {}),
        ...(nationalTeamId ? { nationalTeamId } : {}),
      };
      render();
      return;
    }
    case 'pick-position': {
      const position = positionOf(node.dataset.position ?? '');
      if (position) {
        app.draft = { ...app.draft, position: position.id };
        render();
      }
      return;
    }
    case 'start': {
      try {
        startNewGame();
        render();
      } catch (error) {
        showToast(`开局失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    case 'load': {
      if (loadGame()) render();
      else render();
      return;
    }
    case 'advance-week': {
      // P0-1：赛季已结算时 advanceGame 会原样返回世界，再点推进只会原地打转
      if (app.session?.world.finished) {
        showToast('本赛季结束，点「进入下一季」');
        go('season-end');
        render();
        return;
      }
      handleAdvance();
      return;
    }
    case 'play-match': {
      if (startLiveMatch()) render();
      return;
    }
    case 'half-time': {
      confirmHalf();
      render();
      return;
    }
    case 'mentality': {
      const value = node.dataset.value;
      if (value === 'conservative' || value === 'balanced' || value === 'aggressive') {
        applyHalfTime({ mentality: value });
        render();
      }
      return;
    }
    case 'tactic': {
      const value = node.dataset.value;
      if (value === 'press' || value === 'possess' || value === 'counter') {
        applyHalfTime({ tactic: value });
        render();
      }
      return;
    }
    case 'sub-on': {
      applyHalfTime({ subs: 1 });
      render();
      return;
    }
    case 'sub-off': {
      applyHalfTime({ subs: 0 });
      render();
      return;
    }
    case 'moment-choice': {
      chooseMoment(Number(node.dataset.index ?? '0'));
      render();
      return;
    }
    case 'finish-match': {
      finishLiveMatch();
      render();
      return;
    }
    case 'bid-offer': {
      const player = node.dataset.player;
      if (player) {
        pickBidTarget(player);
        go('negotiation');
        render();
      }
      return;
    }
    case 'bid-submit': {
      const ok = makeBid(1.1);
      showToast(ok ? '谈判通过，球员已加盟' : '没谈成：回执里有原因码');
      render();
      return;
    }
    case 'bid-walkaway': {
      go('transfer');
      render();
      return;
    }
    case 'bid-accept':
    case 'bid-reject': {
      const offer = node.dataset.offer;
      if (offer) {
        answerCareerOffer(offer, act === 'bid-accept');
        render();
        return;
      }
      const ok = makeBid(1);
      showToast(ok ? '成交：已按要价签下' : '要价也不够，看回执');
      render();
      return;
    }
    case 'scenario-start': {
      const id = node.dataset.id;
      if (id && scenarioStart(id)) render();
      else render();
      return;
    }
    case 'scenario-pick': {
      go('scenario');
      render();
      return;
    }
    case 'chain-choice': {
      answerChain(Number(node.dataset.index ?? '0'));
      render();
      return;
    }
    case 'interview-answer': {
      answerInterview(Number(node.dataset.index ?? '0'));
      render();
      return;
    }
    case 'toggle-community': {
      const on = toggleCommunity();
      showToast(on ? '社区已打开：赛后会有热评' : '社区层已关闭：不再生成热评');
      render();
      return;
    }
    case 'next-season': {
      // P0-1：没结算完不许开新季（rollSeason 自身也有守卫，这里给玩家一个提示）
      if (!app.session?.world.finished) {
        showToast('赛季未结束，先推进到赛季末');
        return;
      }
      rollToNextSeason();
      render();
      return;
    }
    case 'rehire': {
      doRehire();
      render();
      return;
    }
    case 'retire': {
      doRetire();
      render();
      return;
    }
    case 'again': {
      app.draft = { mode: 'career' };
      go('setup');
      render();
      return;
    }
    case 'share': {
      const text = app.session ? summarise(app.session) : '绿茵世界';
      void navigator.clipboard?.writeText(text).then(
        () => showToast('战绩已复制到剪贴板'),
        () => showToast('复制失败：浏览器不允许'),
      );
      return;
    }
    case 'view-pylon': {
      go('world-pylon');
      render();
      return;
    }
    case 'pylon-line-club': {
      setPylonLine('club');
      render();
      return;
    }
    case 'pylon-line-career': {
      setPylonLine('national');
      render();
      return;
    }
    case 'competition-node': {
      const compId = node.dataset.competition;
      if (compId) {
        openCompetition(compId, 'competition');
        render();
      }
      return;
    }
    case 'view-standing': {
      const clubId = app.session?.state.clubId;
      const club = app.session?.world.clubs.find((c) => c.id === clubId);
      if (club) {
        openCompetition(club.competitionId, 'competition');
        render();
      }
      return;
    }
    case 'view-draw': {
      const compId = app.focusCompetitionId;
      if (compId) {
        go('draw');
        render();
      }
      return;
    }
    case 'qual-path': {
      const compId = node.dataset.competition ?? app.focusCompetitionId;
      if (compId) {
        app.focusCompetitionId = compId;
        go('qualification');
        render();
      }
      return;
    }
    case 'save-now': {
      persistCurrent();
      showToast('已保存');
      return;
    }
    case 'wipe': {
      // 修复：删档不可撤销，先弹自绘确认框；取消就什么都不做
      void requestWipe().then((removed) => {
        if (!removed) return;
        render();
        showToast('存档已删除');
      });
      return;
    }
    case 'import': {
      if (importFromBox()) {
        render();
        showToast('导入成功');
      } else {
        showToast('导入失败：请检查 JSON');
      }
      return;
    }
    case 'export': {
      if (!app.session) {
        showToast('没有进行中的存档');
        return;
      }
      const json = saveJson(app.session);
      void navigator.clipboard?.writeText(json).then(
        () => showToast(`已复制 ${Math.round(json.length / 1024)} KB`),
        () => showToast('复制失败'),
      );
      return;
    }
    default: {
      // 未实现的钩子不静默失败，明确告知
      showToast(`这个按钮还在施工：${act}`);
    }
  }
}

function summarise(session: NonNullable<typeof app.session>): string {
  const { world, state } = session;
  const club = world.clubs.find((c) => c.id === state.clubId);
  const name = state.mode === 'career' ? state.playerName : state.managerName;
  const honors = state.honors.length;
  return `【绿茵世界】${name} · ${club?.name ?? ''} · 第 ${world.season} 赛季 · ${honors} 项荣誉`;
}

/**
 * 手机 webview / 浏览器返回键：`go()` 每切一屏压一条 history，这里负责退回来。
 *
 * 为什么必须做：App 内嵌 webview 没有地址栏和后退按钮，iOS 只有侧滑手势，
 * Android 的返回键默认直接关掉整个页面 —— 玩家进了「赛报」就再也回不到主控台。
 * 直接赋值 app.screen 而不是调 go()，否则 popstate 会再压一条栈、一路退不出去。
 */
function handlePop(event: PopStateEvent): void {
  // 修复：用 state.screen 还原目标屏，并把 navStack 截到对应深度，
  // 这样「主控台」这类跨层返回是一次 history.go 而不是连按多次返回。
  handleHistoryPop((event.state as { screen?: ScreenId } | null)?.screen);
  render();
}

/** #app 里有没有可读内容：用来区分「首屏没渲染出来」和「已渲染但某个动作报错」 */
function hasVisibleContent(): boolean {
  const node = document.getElementById('app');
  return Boolean(node && node.textContent && node.textContent.trim().length > 0);
}

function boot(): void {
  delegate((act, node) => {
    try {
      handleAction(act, node);
    } catch (error) {
      console.error('[ui] 动作失败', act, error);
      showToast(`出错了：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // 输入框委托：姓名草稿与导入框内容都靠它同步（整页重绘不丢输入）
  delegateInput((value, node) => {
    const field = node.dataset.field;
    if (field === 'playerName' || field === 'managerName') setDraftName(field, value);
    else if (field === 'importBox') setImportDraft(value);
  });

  // 全局兜底：任何未捕获异常/未处理拒绝都不能让玩家停在「正在铺草皮…」
  window.addEventListener('error', (event) => {
    console.error('[ui] 未捕获异常', event.error ?? event.message);
    if (!hasVisibleContent()) fatalError(event.message || '脚本执行出错');
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[ui] 未处理的 Promise 拒绝', event.reason);
    if (!hasVisibleContent()) fatalError(String(event.reason ?? '未知错误'));
  });

  // 首次进入：有存档则提示可继续，但不自动读档（避免玩家想开新档被覆盖）
  if (app.hasSave) {
    app.toast = '检测到存档，可点「继续上次存档」';
  }
  render();

  // 起点用 replaceState，避免「返回」直接跳出站点；file:// 下可能抛，忽略即可
  if (typeof history !== 'undefined' && typeof history.replaceState === 'function') {
    try {
      history.replaceState({ screen: app.screen }, '');
    } catch {
      /* file:// 下个别浏览器会抛 SecurityError，不影响游戏 */
    }
  }
  window.addEventListener('popstate', handlePop);

  // 关页前把待写档落地，避免 400ms 防抖窗口丢进度
  window.addEventListener('pagehide', () => persistNow());
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistNow();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

// 供冒烟脚本与调试用的最小接口（不参与游戏逻辑）
declare global {
  interface Window {
    __GREENWORLD__?: {
      screen: () => string;
      seed: () => number;
      week: () => number;
      season: () => number;
      savedKb: () => number;
    };
  }
}

window.__GREENWORLD__ = {
  screen: () => app.screen,
  seed: () => app.session?.world.seed ?? 0,
  week: () => app.session?.world.week ?? 0,
  season: () => app.session?.world.season ?? 0,
  savedKb: () => (app.session ? Math.round(saveJson(app.session).length / 1024) : 0),
};

export { importSave, wipeSave, persistNow };
