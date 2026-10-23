import { BALANCE } from '../../game/balance';
import { SCENARIOS, scenarioById, scenarioProgress } from '../../game/config/scenarios';
import { interviewPrompt } from '../../game/play/activity';
import { marketFor } from '../../game/play/negotiation';
import { offersForPlayerClub } from '../../game/play/transfer';
import { pendingMoment } from '../../game/match/flow';
import { rankOf } from '../../game/rules/standings';
import type { ManagerState } from '../../game/types';
import { escapeHtml } from '../dom';
import { app, applyHalfTime, chooseMoment, startScenarioGame } from '../state';
import { img } from '../art';
import { emptyState, meterRow, page } from './common';

/**
 * P7 的三个新屏：
 *  - `match-live`：上半场 → 半场面板（心态/战术/换人）→ 关键时刻 → 下半场；
 *  - `transfer`：经理看市场报价单，生涯看收到的报价；
 *  - `scenario`：挑战剧本入口。
 */

function teamName(id: string): string {
  return app.session?.world.clubs.find((c) => c.id === id)?.name ?? id;
}

export function livePage(): string {
  const session = app.session;
  const flow = app.flow;
  if (!session || !flow) {
    return page({
      title: '比赛',
      back: 'dashboard',
      body: emptyState('现在没有正在进行的比赛。点主控台的「亲自踢这场」进入。'),
      actions: '<button class="btn" data-act="nav" data-screen="dashboard">回主控台</button>',
    });
  }
  const half = flow.firstHalf;
  const mineIsHome = session.state.clubId === flow.homeId;
  const mine = mineIsHome ? half.homeGoals : half.awayGoals;
  const theirs = mineIsHome ? half.awayGoals : half.homeGoals;
  const head = `<div class="hero"><div class="hero__body">
    <div class="small dim">上半场结束</div>
    <div class="score-big"><b>${mine}</b> : <b>${theirs}</b></div>
    <div class="small dim">${escapeHtml(teamName(flow.homeId))} vs ${escapeHtml(teamName(flow.awayId))}</div>
    <div class="small dim">xG ${half.homeXg.toFixed(2)} / ${half.awayXg.toFixed(2)}</div>
  </div>${img('tacticsBoard', { className: 'thumb', displayWidth: 64, alt: '战术板' })}</div>`;

  if (!app.halfDone) {
    const career = session.state.mode === 'career';
    const mentalities: { id: 'conservative' | 'balanced' | 'aggressive'; label: string }[] = [
      { id: 'conservative', label: '保守' },
      { id: 'balanced', label: '均衡' },
      { id: 'aggressive', label: '激进' },
    ];
    const tactics: { id: 'press' | 'possess' | 'counter'; label: string }[] = [
      { id: 'press', label: '压迫' },
      { id: 'possess', label: '控球' },
      { id: 'counter', label: '反击' },
    ];
    const subsRow = career
      ? '<div class="small dim">生涯模式下换人由教练决定，你只能决定自己的踢法。</div>'
      : `<div class="bar-row"><span class="bar-row__label">换人</span>
          <button class="btn btn--sm" data-act="sub-on">换 1 人</button>
          <button class="btn btn--sm" data-act="sub-off">不换</button>
          <span class="small dim">已用 ${flow.subsUsed} / ${BALANCE.subsAllowed}</span></div>`;
    const body = `${head}
      <div class="card"><div class="card__title">半场面板（最多 2 个动作）</div>
        <div class="bar-row"><span class="bar-row__label">心态</span>${mentalities
          .map((m) => `<button class="btn btn--sm${flow.mentality === m.id ? ' btn--primary' : ''}" data-act="mentality" data-value="${m.id}">${m.label}</button>`)
          .join('')}</div>
        <div class="bar-row"><span class="bar-row__label">战术</span>${tactics
          .map((t) => `<button class="btn btn--sm${flow.planTactic === t.id ? ' btn--primary' : ''}" data-act="tactic" data-value="${t.id}">${t.label}</button>`)
          .join('')}</div>
        ${subsRow}
        <div class="small dim">已做动作：${flow.halfTimeActions.length} 条</div>
      </div>`;
    return page({
      title: '比赛进行中',
      back: 'dashboard',
      meta: `第 ${session.world.season} 季 第 ${session.world.week} 周`,
      body,
      actions: `<button class="btn btn--primary grow" data-act="half-time">进入下半场 →</button>`,
    });
  }

  const moment = pendingMoment(flow);
  if (moment) {
    const body = `${head}
      <div class="card"><div class="card__title">关键时刻</div>
        <div class="moment-prompt">${escapeHtml(moment.prompt)}</div>
        ${moment.choices
          .map(
            (c, i) =>
              `<button class="btn btn--block" data-act="moment-choice" data-index="${i}">${escapeHtml(c.label)}</button>`,
          )
          .join('')}
      </div>`;
    return page({
      title: '关键时刻',
      back: 'dashboard',
      body,
      actions: '',
    });
  }

  const resolved = flow.moments.length > 0
    ? `<div class="card"><div class="card__title">关键时刻结果</div>${flow.moments
        .map((m) => `<div class="small ${m.success ? 'chip chip--win' : 'chip chip--loss'}">${escapeHtml(m.text)}</div>`)
        .join('')}</div>`
    : '';
  return page({
    title: '准备下半场',
    back: 'dashboard',
    body: `${head}${resolved}`,
    actions: `<button class="btn btn--primary grow" data-act="finish-match">踢完下半场 →</button>`,
  });
}

/** 半场面板的三个动作按钮在 main.ts 里译成 applyHalfTime / chooseMoment */
export { applyHalfTime, chooseMoment };

export function transferPage(): string {
  const session = app.session;
  if (!session) {
    return page({ title: '转会', back: 'home', body: emptyState('还没有开局。') });
  }
  const state = session.state;
  const note = app.bidText ? `<div class="card"><div class="small">${escapeHtml(app.bidText)}</div></div>` : '';

  if (state.mode === 'career') {
    const offers = offersForPlayerClub(session.world, state.clubId);
    const body = offers.length === 0
      ? emptyState('这个转会窗还没有收到报价。窗口在赛季第 1~9 周与第 26~30 周。')
      : offers
          .map(
            (o) => `<div class="card"><div class="card__title">${escapeHtml(teamName(o.fromClubId))} 报价</div>
              <div class="small">位置 ${o.position} · 能力 ${o.ability} · 转会费 ${o.fee} 万 · 周薪 ${o.wage} 万</div>
              <div class="card-actions">
                <button class="btn btn--primary" data-act="bid-accept" data-offer="${escapeHtml(o.id)}">接受</button>
                <button class="btn" data-act="bid-reject" data-offer="${escapeHtml(o.id)}">拒绝</button>
              </div></div>`,
          )
          .join('');
    return page({
      title: '转会报价',
      back: 'dashboard',
      meta: '只显示本窗内收到的报价',
      body: `${note}${body}`,
      actions: '<button class="btn" data-act="nav" data-screen="dashboard">回主控台</button>',
    });
  }

  const manager = state as ManagerState;
  if (manager.kind === 'national') {
    return page({
      title: '转会',
      back: 'dashboard',
      body: emptyState('国家队主帅没有转会市场。'),
      actions: '<button class="btn" data-act="nav" data-screen="dashboard">回主控台</button>',
    });
  }
  const targets = marketFor(session.world, manager.clubId, 8);
  const rows = targets
    .map(
      (t) => `<div class="card"><div class="card__title">${escapeHtml(t.name)} · ${t.position} · ${t.age} 岁</div>
        <div class="small">能力 ${t.ability} · 身价 ${t.value} 万 · 挂牌 ${t.askingPrice} 万 · 期望周薪 ${t.wage} 万 · 来自 ${escapeHtml(t.clubName)}</div>
        <div class="card-actions">
          <button class="btn btn--sm${app.bidTarget === t.id ? ' btn--primary' : ''}" data-act="bid-offer" data-player="${escapeHtml(t.id)}">按挂牌价开价</button>
        </div></div>`,
    )
    .join('');
  return page({
    title: '转会市场',
    back: 'dashboard',
    meta: '四关：估价 → 球员意愿 → 经纪人 → 注册与工资帽',
    body: `${note}${rows || emptyState('没有可谈的目标。')}`,
    actions: '<button class="btn" data-act="nav" data-screen="dashboard">回主控台</button>',
  });
}

export function scenarioPage(): string {
  const session = app.session;
  const cards = SCENARIOS.map((def) => {
    const clubNote = '';
    void clubNote;
    const progress =
      session && session.state.scenario?.id === def.id && session.state.mode === 'manager'
        ? (() => {
            const club = session.world.clubs.find((c) => c.id === session.state.clubId);
            const rank = club ? rankOf(session.world, club.competitionId, club.id) : 0;
            return `<div class="small">${scenarioProgress(def, rank, club?.cash ?? 0)
              .map((l) => escapeHtml(l))
              .join(' · ')}</div>`;
          })()
        : '';
    return `<div class="card scenario-goal"><div class="card__title">${escapeHtml(def.name)}</div>
      <div class="small">${escapeHtml(def.blurb)}</div>
      <div class="small dim">国家 ${def.countryId} · 第 ${def.tier} 级别 · 从第 ${def.startWeek} 周开始</div>
      ${progress}
      <div class="card-actions"><button class="btn btn--primary" data-act="scenario-start" data-id="${def.id}">开始这个剧本</button></div>
    </div>`;
  }).join('');
  return page({
    title: '挑战剧本',
    back: 'home',
    meta: `共 ${SCENARIOS.length} 个`,
    body: `${cards}`,
    actions: '<button class="btn" data-act="nav" data-screen="home">回首页</button>',
  });
}

export function scenarioStart(id: string): boolean {
  if (!scenarioById(id)) return false;
  return startScenarioGame(id);
}

const GATES: readonly { stage: string; label: string }[] = [
  { stage: 'fee', label: '① 俱乐部估价' },
  { stage: 'player', label: '② 球员意愿' },
  { stage: 'agent', label: '③ 经纪人佣金' },
  { stage: 'registration', label: '④ 注册与工资帽' },
];

/** 转会谈判页：报价 → 四关逐条给原因码 */
export function negotiationPage(): string {
  const session = app.session;
  if (!session) {
    return page({ title: '谈判', back: 'home', body: emptyState('还没有开局。') });
  }
  const state = session.state;
  if (state.mode !== 'manager' || state.kind === 'national' || !app.bidTarget) {
    return page({
      title: '谈判',
      back: 'transfer',
      body: emptyState('先在转会市场里挑一个目标。'),
      actions: '<button class="btn" data-act="nav" data-screen="transfer">回转会市场</button>',
    });
  }
  const target = marketFor(session.world, state.clubId, 8).find((t) => t.id === app.bidTarget);
  if (!target) {
    return page({
      title: '谈判',
      back: 'transfer',
      body: emptyState('这个目标已经不在名单里了（转会窗刷新了名单）。'),
      actions: '<button class="btn" data-act="nav" data-screen="transfer">回转会市场</button>',
    });
  }
  const result = app.bidResult;
  const gateRows = GATES.map((g) => {
    let mark = '<span class="dim">未开始</span>';
    if (result) {
      const order = ['fee', 'player', 'agent', 'registration', 'done', 'failed'];
      const reached = order.indexOf(result.stage);
      const idx = order.indexOf(g.stage);
      mark = reached > idx || result.stage === 'done' ? '<span class="chip chip--win">通过</span>' : '<span class="dim">未开始</span>';
      if (reached === idx && result.stage !== 'done') mark = '<span class="chip chip--loss">卡在这里</span>';
    }
    return `<div class="bar-row"><span>${g.label}</span>${mark}</div>`;
  }).join('');
  const reasons = result
    ? `<div class="card"><div class="card__title">谈判回执</div>
        <div class="small">最终阶段 ${result.stage} · 你的报价 ${result.fee} 万 / 要价 ${result.askingPrice} 万 · 佣金 ${result.agentFee} 万${
          result.counter ? ` · 对方还价 ${result.counter} 万` : ''
        }</div>
        ${result.reasons.map((r) => `<div class="negotiation-reason small"><code>${escapeHtml(r.code)}</code> ${escapeHtml(r.text)}</div>`).join('')}
      </div>`
    : '';
  return page({
    title: `谈判 · ${target.name}`,
    back: 'transfer',
    meta: `${target.position} · ${target.age} 岁 · 能力 ${target.ability}`,
    body: `<div class="card"><div class="card__title">${escapeHtml(target.name)}（${escapeHtml(target.clubName)}）</div>
        <div class="small">身价 ${target.value} 万 · 挂牌 ${target.askingPrice} 万 · 期望周薪 ${target.wage} 万</div>
        ${gateRows}
      </div>${reasons}`,
    actions: `<button class="btn" data-act="nav" data-screen="transfer">走开</button>
      <button class="btn" data-act="bid-submit">加价 10% 再谈</button>
      <button class="btn btn--primary" data-act="bid-accept">接受要价</button>`,
  });
}

/** 球迷社区层：热评流 + 球迷情绪 + 媒体采访（可整体关闭） */
export function communityPage(): string {
  const session = app.session;
  if (!session) {
    return page({ title: '社区', back: 'home', body: emptyState('还没有开局。') });
  }
  const state = session.state;
  const on = state.communityOn !== false;
  const isClubManager = state.mode === 'manager' && state.kind !== 'national';
  const mood = isClubManager ? (state as ManagerState).fanMood : state.mode === 'career' ? state.fame : 55;
  const moodLabel = isClubManager ? '球迷情绪' : state.mode === 'career' ? '人气' : '国家队声望';
  const comments = state.hotComments ?? [];
  const stream = !on
    ? emptyState('社区层已在设置里关闭。关闭后不影响推进与结算。')
    : comments.length === 0
      ? emptyState('还没有热评。踢完一场比赛就会有人开喷。')
      : comments.map((c) => `<div class="hot-comment small">· ${escapeHtml(c)}</div>`).join('');
  const prompt = on ? interviewPrompt(session.world) : undefined;
  const interview = prompt
    ? `<div class="card"><div class="card__title">媒体采访</div>
        <div class="small">${escapeHtml(prompt.question)}</div>
        ${prompt.options
          .map(
            (o, i) =>
              `<button class="btn btn--block btn--sm" data-act="interview-answer" data-index="${i}">${escapeHtml(o.label)}</button>`,
          )
          .join('')}
      </div>`
    : '';
  return page({
    title: '社区',
    back: 'dashboard',
    meta: '球迷热评 · 只叙事，不改积分与资格',
    body: `<div class="card"><div class="card__title">${moodLabel}</div>
        <div class="fan-mood small">${moodLabel} ${Math.round(mood)} / 100</div>
        ${meterRow(moodLabel, Math.round(mood), mood >= 60 ? 'green' : mood >= 35 ? 'gold' : 'red')}
      </div>
      <div class="card"><div class="card__title">热评</div>${stream}</div>
      ${interview}`,
    actions: `<button class="btn" data-act="nav" data-screen="dashboard">回主控台</button>
      <button class="btn" data-act="toggle-community">${on ? '关闭社区层' : '打开社区层'}</button>`,
  });
}
