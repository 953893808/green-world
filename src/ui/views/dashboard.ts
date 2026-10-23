import { img } from '../art';
import { escapeHtml, num } from '../dom';
import { app, currentRank, nextFixture, gradeLabel, needsRollover, sessionOver, thisWeekMatch } from '../state';
import { careerStats } from '../../game/play/career';
import { managerStats } from '../../game/play/manager';
import { meterRow, page, repairNotice } from './common';
import { chainPrompt } from '../../game/play/chains';
import { boardBrief, interviewPrompt } from '../../game/play/activity';
import type { CareerState, ManagerState } from '../../game/types';

/**
 * 主控台（#3）：赛季/周次、下一场、目标、关键指标。
 * 这是玩家 90% 时间停留的屏，信息密度优先，图只做头图。
 */
export function dashboardPage(): string {
  const session = app.session;
  if (!session) {
    return page({
      title: '主控台',
      body: `<div class="notice">没有进行中的生涯。<button class="btn btn--sm" data-act="nav" data-screen="home">回首页</button></div>`,
    });
  }
  const { world, state } = session;
  const club = world.clubs.find((c) => c.id === state.clubId);
  const rank = currentRank();
  const next = nextFixture();
  const isCareer = state.mode === 'career';

  const header = `
    <section class="card" style="padding:0;overflow:hidden">
      <div style="position:relative;height:120px">
        ${img('stadiumDay', { className: '', alt: '主场球场的白天全景' })}
      </div>
      <div style="padding:12px 14px">
        <div class="row--between">
          <div class="grow">
            <div class="dim small">${escapeHtml(club?.name ?? '未定')}</div>
            <h2 style="margin:2px 0 0">${escapeHtml(isCareer ? (state as CareerState).playerName : (state as ManagerState).managerName)}</h2>
          </div>
          <div class="center">
            <div class="mono" style="font-size:22px;font-weight:700">${rank > 0 ? `#${rank}` : '—'}</div>
            <div class="dim" style="font-size:11px">联赛排名</div>
          </div>
        </div>
      </div>
    </section>
    ${repairNotice()}
  `;

  const nextCard = next
    ? `<div class="card stack">
        <div class="row--between">
          <b>下一场</b>
          <span class="chip">第 ${next.week} 周</span>
        </div>
        <div class="dim small">${escapeHtml(next.competitionName)}</div>
        <div class="scoreline">
          <div class="scoreline__team"><div class="scoreline__name">${escapeHtml(next.homeName)}</div></div>
          <span class="dim mono">vs</span>
          <div class="scoreline__team scoreline__team--away"><div class="scoreline__name">${escapeHtml(next.awayName)}</div></div>
        </div>
        ${thisWeekMatch() ? '<button class="btn btn--sm btn--block" data-act="nav" data-screen="match-preview">赛前简报</button>' : ''}
      </div>`
    : `<div class="card dim small">本赛季赛程已全部结束。</div>`;

  const metrics = isCareer
    ? careerMetrics(world, state as CareerState)
    : managerMetrics(world, state as ManagerState);

  const news = (app.news ?? []).slice(0, 6);
  const newsCard = news.length === 0
    ? ''
    : `<div class="card stack">
        <div class="row--between"><b>本周消息</b><span class="chip">${news.length}</span></div>
        <div class="stack">
          ${news.map((n) => `<div class="small dim">· ${escapeHtml(n)}</div>`).join('')}
        </div>
      </div>`;

  const chain = chainPrompt(state, world.week);
  const chainCard = chain
    ? `<div class="card stack">
        <div class="row--between"><b>${escapeHtml(chain.title)}</b><span class="chip">抉择</span></div>
        <div class="small">${escapeHtml(chain.desc)}</div>
        ${chain.choices
          .map((c, i) => `<button class="btn btn--sm btn--block" data-act="chain-choice" data-index="${i}">${escapeHtml(c.label)}</button>`)
          .join('')}
      </div>`
    : '';

  const brief = boardBrief(world, state, rank);
  const briefCard = brief
    ? `<div class="card stack board-brief">
        <div class="row--between"><b>${escapeHtml(brief.headline)}</b><span class="chip">第 ${world.week} 周</span></div>
        ${brief.lines.map((l) => `<div class="small dim">${escapeHtml(l)}</div>`).join('')}
      </div>`
    : '';

  const interview = interviewPrompt(world);
  const interviewCard = interview
    ? `<div class="card stack">
        <div class="row--between"><b>媒体采访</b><span class="chip">舆情</span></div>
        <div class="small">${escapeHtml(interview.question)}</div>
        ${interview.options
          .map((o, i) => `<button class="btn btn--sm btn--block" data-act="interview-answer" data-index="${i}">${escapeHtml(o.label)}</button>`)
          .join('')}
      </div>`
    : '';

  // P0-1：赛季结算完只差「进入下一季」；退役/解雇则只能换一条路，不能再推进
  const over = sessionOver();
  const rollover = needsRollover();
  const primaryAction = over
    ? isCareer
      ? '<button class="btn btn--primary grow" data-act="again">再开一生 →</button>'
      : '<button class="btn btn--primary grow" data-act="rehire">重新应聘 →</button>'
    : rollover
      ? '<button class="btn btn--primary grow" data-act="next-season">进入下一季 →</button>'
      : '<button class="btn btn--primary grow" data-act="advance-week">推进一周 →</button>';

  // 「亲自踢这场」只在本周真有比赛时出现：startLiveMatch() 只认当前周未踢的
  // 俱乐部赛程，赛季里大多数周其实没有你的比赛，按钮常驻会让人以为坏了。
  const canPlayLive = !over && !rollover && (state as ManagerState).kind !== 'national' && thisWeekMatch();

  return page({
    title: '主控台',
    meta: `S${world.season} · W${world.week}`,
    body: `
      <div class="stack">
        ${header}
        ${nextCard}
        ${metrics}
        ${chainCard}
        ${briefCard}
        ${interviewCard}
        ${newsCard}
        <div class="row--wrap">
          <button class="btn btn--sm grow" data-act="view-pylon">世界金字塔</button>
          <button class="btn btn--sm grow" data-act="view-standing">积分榜</button>
          <button class="btn btn--sm grow" data-act="nav" data-screen="calendar">赛历</button>
          <button class="btn btn--sm grow" data-act="nav" data-screen="squad">阵容</button>
          <button class="btn btn--sm grow" data-act="nav" data-screen="transfer">转会</button>
        <button class="btn btn--sm grow" data-act="nav" data-screen="community">社区</button>
        </div>
      </div>
    `,
    actions: `
      <button class="btn btn--ghost" data-act="nav" data-screen="settings">存档</button>
      ${canPlayLive ? '<button class="btn" data-act="play-match">亲自踢这场</button>' : ''}
      ${primaryAction}
    `,
  });
}

function careerMetrics(world: Parameters<typeof careerStats>[0], state: CareerState): string {
  const stats = careerStats(world, state);
  const avg = state.seasonApps > 0 ? state.seasonRatingSum / state.seasonApps : 0;
  return `<div class="card stack">
    <div class="row--between"><b>本赛季</b><span class="dim small">${stats.seasonsDone} 季已打</span></div>
    <div class="table">
      <table class="table table--compact">
        <tbody>
          <tr><td>出场</td><td class="mono">${state.seasonApps}</td><td>进球</td><td class="mono">${state.seasonGoals}</td></tr>
          <tr><td>助攻</td><td class="mono">${state.seasonAssists}</td><td>场均评分</td><td class="mono">${avg > 0 ? avg.toFixed(2) : '—'}</td></tr>
        </tbody>
      </table>
    </div>
    ${meterRow('体能', state.player.stamina)}
    ${meterRow('状态', state.player.form)}
    ${meterRow('人气', Math.min(100, state.fame), 'gold')}
    <div class="row--between small dim">
      <span>年龄 ${stats.age} · 能力 ${stats.ability}</span>
      <span>${stats.honors} 项荣誉</span>
    </div>
  </div>`;
}

function managerMetrics(world: Parameters<typeof managerStats>[0], state: ManagerState): string {
  const info = managerStats(world, state);
  return `<div class="card stack">
    <div class="row--between"><b>董事会</b><span class="dim small">${info.leagueRank > 0 ? `联赛 #${info.leagueRank}` : ''}</span></div>
    ${meterRow('满意度', state.boardConfidence, state.boardConfidence < 40 ? 'red' : 'green')}
    ${meterRow('球迷情绪', state.fanMood, state.fanMood < 40 ? 'gold' : 'green')}
    <div class="row--between small dim">
      <span>连续无欧战 ${state.seasonsWithoutContinental ?? 0} 季</span>
      <span>${state.honors.length} 项荣誉</span>
    </div>
    ${info.fired ? `<div class="notice">已下课。赛季结算后可重新应聘。</div>` : ''}
  </div>`;
}

/** 赛季结算（#18） */
export function seasonEndPage(): string {
  const session = app.session;
  const report = app.seasonReport;
  if (!session || !report) {
    return page({ title: '赛季结算', back: 'dashboard', body: `<div class="dim">没有可显示的结算。</div>` });
  }
  const fired = report.fired;
  const honors = report.honors.length > 0
    ? report.honors.map((h) => `<span class="chip chip--gold">${escapeHtml(h)}</span>`).join(' ')
    : '<span class="dim small">本赛季没有奖杯</span>';

  return page({
    title: `第 ${report.season} 赛季结算`,
    meta: fired ? '已下课' : '完成',
    body: `
      <div class="stack">
        <section class="card card--dark">
          <div class="dim small">${escapeHtml(report.leagueName || '本赛季')}</div>
          <div class="row--between" style="margin-top:6px">
            <div>
              <div class="num-xl">${report.leagueRank > 0 ? `#${report.leagueRank}` : '—'}</div>
              <div class="dim small">最终排名</div>
            </div>
            <div class="center">
              ${img('trophyShelf', { className: 'thumb', displayWidth: 64, alt: '奖杯陈列架' })}
            </div>
          </div>
        </section>

        <div class="card stack">
          <b>荣誉</b>
          <div class="row--wrap">${honors}</div>
          ${report.promoted.length > 0 ? `<div class="chip chip--win">${escapeHtml(report.promoted[0]!)}</div>` : ''}
          ${report.relegated.length > 0 ? `<div class="chip chip--loss">${escapeHtml(report.relegated[0]!)}</div>` : ''}
        </div>

        ${report.grade ? `<div class="card row--between"><span>本季评价</span><b class="mono">${escapeHtml(report.grade)} · ${escapeHtml(gradeLabel(report.grade))}</b></div>` : ''}

        ${report.boardDelta !== 0 || report.fanDelta !== 0
          ? `<div class="card stack">
              <b>董事会与球迷</b>
              <div class="row--between small">
                <span>董事会满意度</span>
                <span class="chip ${report.boardDelta >= 0 ? 'chip--win' : 'chip--loss'} mono">${report.boardDelta >= 0 ? '+' : ''}${report.boardDelta}</span>
              </div>
              <div class="row--between small">
                <span>球迷情绪</span>
                <span class="chip ${report.fanDelta >= 0 ? 'chip--win' : 'chip--loss'} mono">${report.fanDelta >= 0 ? '+' : ''}${report.fanDelta.toFixed(1)}</span>
              </div>
            </div>`
          : ''}

        ${report.reasons.length > 0
          ? `<div class="card stack">
              <b>发生了什么</b>
              ${report.reasons.map((r) => `<div class="small dim">· ${escapeHtml(r)}</div>`).join('')}
            </div>`
          : ''}

        ${fired
          ? `<div class="notice">董事会决定换帅。你可以重新应聘低一档联赛的俱乐部。</div>`
          : `<div class="card dim small">下一季的赛程、资格与升降级会在进入新赛季时生成。</div>`}
      </div>
    `,
    actions: fired
      ? `<button class="btn btn--ghost" data-act="nav" data-screen="home">回首页</button>
         <button class="btn btn--primary grow" data-act="rehire">重新应聘</button>`
      : `<button class="btn btn--ghost" data-act="nav" data-screen="home">稍后</button>
         <button class="btn btn--primary grow" data-act="next-season">进入下一季 →</button>`,
  });
}

/** 生涯结算 / 评级（#19） */
export function careerEndPage(): string {
  const session = app.session;
  const report = app.seasonReport;
  if (!session || !report) {
    return page({ title: '生涯结算', back: 'dashboard', body: `<div class="dim">没有可显示的结算。</div>` });
  }
  const state = session.state as CareerState;
  const stats = careerStats(session.world, state);
  const grade = report.grade ?? stats.grade;
  const gradeArt: Record<string, 'gradeS' | 'gradeA' | 'gradeB' | 'gradeC' | 'gradeD'> = {
    S: 'gradeS', A: 'gradeA', B: 'gradeB', C: 'gradeC', D: 'gradeD',
  };
  const artKey = gradeArt[grade] ?? 'gradeB';

  return page({
    title: '生涯结算',
    meta: grade,
    body: `
      <div class="stack">
        <section class="card center stack">
          ${img(artKey, { className: 'thumb', displayWidth: 128, alt: `评级 ${grade}` })}
          <div>
            <div class="num-xxl">${escapeHtml(grade)}</div>
            <div class="dim small">${escapeHtml(gradeLabel(grade))}</div>
          </div>
          <div class="row--between">
            <span class="dim small">生涯价值</span>
            <b class="mono">${num(stats.careerValue)}</b>
          </div>
        </section>

        <div class="card">
          <table class="table table--compact">
            <tbody>
              <tr><td>出场</td><td class="mono">${stats.apps}</td><td>进球</td><td class="mono">${stats.goals}</td></tr>
              <tr><td>助攻</td><td class="mono">${stats.assists}</td><td>场均</td><td class="mono">${stats.avgRating.toFixed(2)}</td></tr>
              <tr><td>赛季</td><td class="mono">${stats.seasonsDone}</td><td>荣誉</td><td class="mono">${stats.honors}</td></tr>
            </tbody>
          </table>
        </div>

        <div class="card stack">
          <b>荣誉墙</b>
          <div class="honor-grid">
            ${state.honors.length === 0
              ? '<div class="dim small">还没有奖杯。下一次。</div>'
              : state.honors.slice(-8).map((h) => `
                <div class="honor">
                  ${img('leagueTitle', { alt: h })}
                  <div>${escapeHtml(h.replace(/冠军$/, ''))}</div>
                </div>`).join('')}
          </div>
        </div>
      </div>
    `,
    actions: `
      <button class="btn btn--ghost" data-act="share">分享</button>
      <button class="btn grow" data-act="nav" data-screen="home">回首页</button>
      <button class="btn btn--primary grow" data-act="again">再开一生</button>
    `,
  });
}
