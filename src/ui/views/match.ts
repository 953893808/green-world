import { img } from '../art';
import { escapeHtml } from '../dom';
import { app } from '../state';
import { page, outcomeChip, noCareer } from './common';
import type { ArtKey } from '../art';

/**
 * 赛后报告（#9）+ 抽签（#10）。
 *
 * P7 的半场面板（match-live）会插在 preview 与 report 之间；
 * 这一版先给「赛前简报 + 赛后战报」，把一条完整链路跑通。
 */

/**
 * 球队综合能力 = 攻/中/防均值。
 *
 * 修复：原先写的是 `attack ?? 0 + midfield + defense`，而 `+` 的优先级高于 `??`，
 * 实际解析成 `attack ?? (0 + midfield + defense)` —— 有 attack 时显示的是单值，
 * 缺 attack 时反而显示 0+中+防 之和。
 */
export function clubAbility(club: { attack?: number; midfield?: number; defense?: number } | undefined): number {
  if (!club) return 0;
  const attack = club.attack ?? 0;
  const midfield = club.midfield ?? 0;
  const defense = club.defense ?? 0;
  return Math.round((attack + midfield + defense) / 3);
}

export function matchPreviewPage(): string {
  const session = app.session;
  if (!session) return page({ title: '赛前', back: 'dashboard', body: noCareer });
  const { world, state } = session;
  const clubId = state.clubId;
  const fixture = world.fixtures
    .filter((f) => !f.played && (f.homeId === clubId || f.awayId === clubId))
    .sort((a, b) => a.week - b.week)[0];
  if (!fixture) {
    return page({
      title: '赛前',
      back: 'dashboard',
      body: '<div class="card dim small">本赛季没有剩余比赛。</div>',
    });
  }
  const home = world.clubs.find((c) => c.id === fixture.homeId);
  const away = world.clubs.find((c) => c.id === fixture.awayId);
  const comp = world.competitions.find((c) => c.id === fixture.competitionId);
  const isHome = fixture.homeId === clubId;
  const me = isHome ? home : away;
  const foe = isHome ? away : home;

  return page({
    title: '赛前',
    back: 'dashboard',
    meta: `第 ${fixture.week} 周`,
    body: `
      <div class="stack">
        <section style="border-radius:10px;overflow:hidden">${img('tacticsBoard', { alt: '战术板与对手情报' })}</section>
        <div class="card">
          <div class="dim small">${escapeHtml(comp?.nameZh ?? '')}</div>
          <div class="scoreline" style="margin-top:6px">
            <div class="scoreline__team">
              <div class="scoreline__name">${escapeHtml(home?.name ?? '?')}</div>
              <div class="dim small">${isHome ? '你' : '主'} · 能力 ${clubAbility(home)}</div>
            </div>
            <span class="dim mono">vs</span>
            <div class="scoreline__team scoreline__team--away">
              <div class="scoreline__name">${escapeHtml(away?.name ?? '?')}</div>
              <div class="dim small">${!isHome ? '你' : '客'} · 能力 ${clubAbility(away)}</div>
            </div>
          </div>
        </div>
        <div class="card stack">
          <b>体能预警</b>
          <div class="row--between small"><span>${escapeHtml(me?.name ?? '我方')}</span><span class="mono">${Math.round(me?.stamina ?? 0)}</span></div>
          <div class="row--between small"><span>${escapeHtml(foe?.name ?? '对手')}</span><span class="mono">${Math.round(foe?.stamina ?? 0)}</span></div>
          <div class="notice">旅费与跨洲疲劳已计入模拟；这里不重复扣。</div>
        </div>
      </div>
    `,
    actions: `
      <button class="btn btn--ghost" data-act="nav" data-screen="dashboard">稍后</button>
      <button class="btn btn--primary grow" data-act="advance-week">直接推进这一周</button>
    `,
  });
}

export function matchReportPage(): string {
  const report = app.lastReport;
  if (!report) {
    return page({ title: '赛报', back: 'dashboard', body: '<div class="card dim small">还没有赛报。先推进一周。</div>' });
  }
  const rankText = report.rankBefore && report.rankAfter
    ? report.rankBefore === report.rankAfter
      ? `排名不变（#${report.rankAfter}）`
      : `排名 #${report.rankBefore} → #${report.rankAfter}`
    : '';

  const moodKey: ArtKey = report.outcome === 'win' ? 'moodHigh' : report.outcome === 'loss' ? 'moodAngry' : 'moodCalm';

  return page({
    title: '赛后战报',
    back: 'dashboard',
    meta: escapeHtml(report.competitionName),
    body: `
      <div class="stack">
        <section class="card center stack">
          <div class="row--between">
            <span class="dim small">${escapeHtml(report.homeName)}</span>
            <span class="dim small">${escapeHtml(report.awayName)}</span>
          </div>
          <div class="row" style="justify-content:center;gap:10px">
            <span class="score-big"><b>${report.homeGoals}</b><em>:</em><b>${report.awayGoals}</b></span>
            ${outcomeChip(report.outcome)}
          </div>
          ${report.penalties ? `<div class="dim small">点球 ${escapeHtml(report.penalties)}</div>` : ''}
          ${rankText ? `<div class="chip">${escapeHtml(rankText)}</div>` : ''}
        </section>

        <section style="border-radius:10px;overflow:hidden">${img(moodKey, { alt: '球迷情绪' })}</section>

        ${report.line
          ? `<div class="card">
              <div class="row--between"><b>你的表现</b><span class="chip chip--gold">评分 ${report.line.rating.toFixed(1)}</span></div>
              <div class="row--between small dim" style="margin-top:6px">
                <span>进球 ${report.line.goals}</span>
                <span>助攻 ${report.line.assists}</span>
              </div>
            </div>`
          : ''}

        <div class="card stack">
          <b>关键时间</b>
          <ul class="timeline">
            <li><span class="timeline__min">开球</span><span class="grow">比赛开始，${escapeHtml(report.homeName)} 主场。</span></li>
            ${report.decisions ? `<li><span class="timeline__min">调整</span><span class="grow">你在本场做了 ${report.decisions} 个决策（含半场）。</span></li>` : ''}
            <li><span class="timeline__min">90'</span><span class="grow">终场哨响，比分 ${report.homeGoals}-${report.awayGoals}。</span></li>
          </ul>
        </div>

        ${report.hotComments && report.hotComments.length > 0
          ? `<div class="card stack">
              <div class="row--between"><b>球迷热评</b><span class="chip">${report.hotComments.length}</span></div>
              ${report.hotComments.map((c) => `<div class="small hot-comment">· ${escapeHtml(c)}</div>`).join('')}
              <div class="dim" style="font-size:11px">社区层只是叙事，不影响积分与资格。</div>
            </div>`
          : ''}
      </div>
    `,
    actions: `<button class="btn btn--primary btn--block" data-act="nav" data-screen="dashboard">回到主控台</button>`,
  });
}

/** 抽签（#10） */
export function drawPage(): string {
  const session = app.session;
  const compId = app.focusCompetitionId;
  if (!session || !compId) return page({ title: '抽签', back: 'dashboard', body: '<div class="dim">没有选中赛事。</div>' });
  const draw = session.world.draws[compId];
  if (!draw) {
    return page({ title: '抽签', back: 'competition', body: '<div class="card dim small">该赛事没有抽签记录。</div>' });
  }
  return page({
    title: '抽签结果',
    back: 'competition',
    meta: `${draw.pairs.length} 场`,
    body: `
      <div class="stack">
        ${draw.degraded ? '<div class="notice">本次抽签未完全满足避让约束（同国/同洲），已标记为降级抽签。</div>' : ''}
        ${draw.byeClubId ? `<div class="chip chip--gold">轮空：${escapeHtml(clubName(session.world, draw.byeClubId))}</div>` : ''}
        <div class="card">
          <table class="table table--compact">
            <thead><tr><th>主</th><th></th><th>客</th></tr></thead>
            <tbody>
              ${draw.pairs.map(([homeId, awayId]) => `
                <tr>
                  <td class="nowrap">${escapeHtml(clubName(session.world, homeId))}</td>
                  <td class="dim">vs</td>
                  <td class="nowrap">${escapeHtml(clubName(session.world, awayId))}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="card stack">
          <b>分档</b>
          ${draw.pots.map((pot) => `
            <div class="small"><span class="dim">档 ${pot.pot}</span> · ${pot.clubIds.length} 队</div>
          `).join('')}
        </div>
      </div>
    `,
  });
}

function clubName(world: NonNullable<typeof app.session>['world'], clubId: string): string {
  const club = world.clubs.find((c) => c.id === clubId);
  return club?.name ?? clubId;
}
