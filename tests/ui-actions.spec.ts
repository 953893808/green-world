import { afterEach, describe, expect, it } from 'vitest';
import { newGame } from '../src/game/game';
import { SCENARIOS } from '../src/game/config/scenarios';
import { setConfirmImpl } from '../src/ui/confirm';
import { app, go, navDecision, navSnapshot, needsRollover, replace, sessionOver, setDraftName } from '../src/ui/state';
import { dashboardPage } from '../src/ui/views/dashboard';
import { setupPage } from '../src/ui/views/home';
import { scenarioPage, transferPage } from '../src/ui/views/live';
import { clubAbility } from '../src/ui/views/match';
import { requestWipe, setImportDraft, settingsPage } from '../src/ui/views/misc';

/**
 * UI 交互层的结构回归（P1-8 / P1-9 / P1-10 + 姓名输入、能力值）。
 *
 * 项目零运行时依赖、没有 jsdom，所以这里只断言「渲染出来的 HTML 结构 + 状态机」；
 * 真实点击命中仍由 scripts/mobile-check.mjs（CDP）在浏览器里覆盖。
 */

function countOf(html: string, pattern: RegExp): number {
  return (html.match(pattern) ?? []).length;
}

function managerSession() {
  return newGame({ mode: 'manager', seed: 20261019, manager: { confederationId: 'UEFA', tier: 2 } });
}

afterEach(() => {
  setConfirmImpl(null);
});

describe('P1-8 页面级底栏不再压住卡片内的动作', () => {
  it('挑战剧本：每张卡片的按钮在 card-actions 里，整页只有一条 actionbar', () => {
    const html = scenarioPage();
    expect(countOf(html, /class="actionbar"/g)).toBe(1);
    expect(countOf(html, /class="card-actions"/g)).toBe(SCENARIOS.length);
    expect(countOf(html, /data-act="scenario-start"/g)).toBe(SCENARIOS.length);
  });

  it('转会市场：开价按钮在卡片里，页面底栏只剩返回主控台', () => {
    app.session = managerSession();
    const html = transferPage();
    expect(countOf(html, /class="actionbar"/g)).toBe(1);
    const bar = html.slice(html.indexOf('class="actionbar"'));
    expect(bar).toContain('data-act="nav"');
    expect(bar).not.toContain('data-act="bid-offer"');
    app.session = null;
  });
});

describe('P1-9 删档必须二次确认', () => {
  it('点取消时存档原样保留', async () => {
    app.session = managerSession();
    let calls = 0;
    setConfirmImpl((options) => {
      calls += 1;
      expect(options.danger).toBe(true);
      return Promise.resolve(false);
    });
    await expect(requestWipe()).resolves.toBe(false);
    expect(calls).toBe(1);
    expect(app.session).not.toBeNull();
    app.session = null;
  });

  it('确认后清空会话并回到首页', async () => {
    app.session = managerSession();
    setConfirmImpl(() => Promise.resolve(true));
    await expect(requestWipe()).resolves.toBe(true);
    expect(app.session).toBeNull();
    expect(app.screen).toBe('home');
  });
});

describe('P1-10 返回栈按历史回退，不再只压不弹', () => {
  it('已经在栈里的屏返回 pop 并给出回退步数', () => {
    replace('home');
    go('dashboard');
    go('settings');
    expect(navSnapshot().slice(-3)).toEqual(['home', 'dashboard', 'settings']);
    expect(navDecision('dashboard')).toEqual({ kind: 'pop', delta: -1 });
    expect(navDecision('home')).toEqual({ kind: 'pop', delta: -2 });
    expect(navDecision('transfer')).toEqual({ kind: 'push' });
  });

  it('replace 只替换栈顶，不新增历史条目', () => {
    replace('home');
    go('dashboard');
    const depth = navSnapshot().length;
    replace('career-end');
    expect(navSnapshot().length).toBe(depth);
    expect(navSnapshot()[depth - 1]).toBe('career-end');
  });
});

describe('开局姓名输入（以前只有文案没有控件）', () => {
  it('折叠空白、截断 12 字、留空回退系统名', () => {
    setDraftName('playerName', '  张   三  ');
    expect(app.draft.playerName).toBe('张 三');
    setDraftName('playerName', '一二三四五六七八九十十一十二');
    expect(app.draft.playerName).toBe('一二三四五六七八九十十一');
    setDraftName('playerName', '   ');
    expect(app.draft.playerName).toBeUndefined();
  });

  it('开局页提供姓名输入框', () => {
    app.draft = { mode: 'career' };
    const html = setupPage();
    expect(html).toContain('id="player-name"');
    expect(html).toContain('data-field="playerName"');
    expect(html).not.toContain('名字可选，留空则用系统生成的姓名');
  });
});

describe('赛前能力值（运算符优先级回归）', () => {
  it('取攻/中/防均值，而不是 attack 单值', () => {
    expect(clubAbility({ attack: 70, midfield: 60, defense: 50 })).toBe(60);
    expect(clubAbility({ midfield: 60, defense: 50 })).toBe(37);
    expect(clubAbility(undefined)).toBe(0);
  });
});

describe('设置页导入框', () => {
  it('重绘后保留已输入的草稿', () => {
    setImportDraft('PASTE_MARKER');
    expect(settingsPage()).toContain('PASTE_MARKER');
    setImportDraft('');
  });
});

describe('P0-1 赛季结束后主控台的按钮', () => {
  it('赛季进行中显示「推进一周」', () => {
    app.session = managerSession();
    expect(needsRollover()).toBe(false);
    const html = dashboardPage();
    expect(html).toContain('data-act="advance-week"');
    expect(html).not.toContain('data-act="next-season"');
    app.session = null;
  });

  it('世界已结算时显示「进入下一季」而不是「推进一周」', () => {
    const session = managerSession();
    app.session = { world: { ...session.world, finished: true }, state: session.state };
    expect(needsRollover()).toBe(true);
    const html = dashboardPage();
    expect(html).toContain('data-act="next-season"');
    expect(html).not.toContain('data-act="advance-week"');
    app.session = null;
  });

  it('经理被解雇时显示「重新应聘」，不给开新季', () => {
    const session = managerSession();
    app.session = {
      world: { ...session.world, finished: true },
      state: { ...session.state, fired: true } as unknown as typeof session.state,
    };
    expect(sessionOver()).toBe(true);
    expect(needsRollover()).toBe(false);
    const html = dashboardPage();
    expect(html).toContain('data-act="rehire"');
    expect(html).not.toContain('data-act="next-season"');
    app.session = null;
  });

  it('生涯退役后显示「再开一生」', () => {
    const session = newGame({
      mode: 'career',
      seed: 20261019,
      career: { position: 'FW', detailPosition: 'FW', nationality: 'ENG' },
    });
    app.session = {
      world: { ...session.world, finished: true },
      state: { ...session.state, retired: true } as unknown as typeof session.state,
    };
    expect(sessionOver()).toBe(true);
    const html = dashboardPage();
    expect(html).toContain('data-act="again"');
    expect(html).not.toContain('data-act="advance-week"');
    app.session = null;
  });
});
