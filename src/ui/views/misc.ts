import { escapeHtml, num } from '../dom';
import { askConfirm } from '../confirm';
import { app, persistNow, saveSizeText, wipeSave, importSave } from '../state';
import { CALENDAR, phaseLabelOf } from '../../game/config/calendar';
import { BALANCE } from '../../game/balance';
import { averageRating } from '../../game/match/simulate';
import { financeOf } from '../../game/play/finance';
import { positionOf } from '../../game/config/positions';
import { meterRow, page, noCareer } from './common';
import type { CareerState } from '../../game/types';

/**
 * 赛历（#6）+ 阵容（#12）+ 财政（#15）+ 董事会（#16）+ 设置（#20）。
 * 这一批是「信息屏」：不推进状态，只读会话数据。
 */

export function calendarPage(): string {
  const session = app.session;
  if (!session) return page({ title: '赛历', back: 'dashboard', body: noCareer });
  const { world, state } = session;
  const clubId = state.clubId;
  const mine = world.fixtures.filter((f) => f.homeId === clubId || f.awayId === clubId);
  const byWeek = new Map<number, typeof mine>();
  for (const fixture of mine) {
    const list = byWeek.get(fixture.week) ?? [];
    list.push(fixture);
    byWeek.set(fixture.week, list);
  }

  const phases = new Set([5, 25, 45, 49]);

  return page({
    title: '赛历',
    back: 'dashboard',
    meta: `共 ${CALENDAR.weeks} 周`,
    body: `
      <div class="stack">
        <div class="card stack">
          <b>阶段</b>
          <div class="row--wrap small">
            <span class="chip">第 ${world.week} 周 · ${escapeHtml(phaseLabelOf(world.week))}</span>
            <span class="chip">国家队窗口 ${CALENDAR.nationalWindows.join('/')}</span>
            <span class="chip">转会窗 ${CALENDAR.transferWindows.map((w) => `${w.from}-${w.to}`).join('、')}</span>
          </div>
        </div>

        <div class="card">
          <table class="table table--compact">
            <thead><tr><th>周</th><th>赛事</th><th>对手</th><th>主客</th></tr></thead>
            <tbody>
              ${Array.from(byWeek.entries())
                .sort((a, b) => a[0] - b[0])
                .slice(0, 40)
                .map(([week, fixtures]) => {
                  const phaseBreak = phases.has(week) ? `<tr><td colspan="4" class="dim small">— ${escapeHtml(phaseLabelOf(week))} —</td></tr>` : '';
                  const rows = fixtures.map((f) => {
                    const isHome = f.homeId === clubId;
                    const foeId = isHome ? f.awayId : f.homeId;
                    const foe = world.clubs.find((c) => c.id === foeId);
                    const comp = world.competitions.find((c) => c.id === f.competitionId);
                    const mark = f.played && f.result ? `${f.result.homeGoals}-${f.result.awayGoals}` : '';
                    return `<tr${week === world.week ? ' class="is-me"' : ''}>
                      <td class="mono">${week}</td>
                      <td class="small">${escapeHtml(comp?.nameZh ?? '')}</td>
                      <td class="nowrap">${escapeHtml(foe?.name ?? foeId)}</td>
                      <td>${isHome ? '主' : '客'} ${mark}</td>
                    </tr>`;
                  }).join('');
                  return phaseBreak + rows;
                }).join('')}
            </tbody>
          </table>
          ${byWeek.size > 40 ? `<div class="dim small" style="margin-top:6px">仅显示前 40 周。</div>` : ''}
        </div>
      </div>
    `,
  });
}

export function squadPage(): string {
  const session = app.session;
  if (!session) return page({ title: '阵容', back: 'dashboard', body: noCareer });
  const { world, state } = session;
  if (state.mode !== 'career') {
    const club = world.clubs.find((c) => c.id === state.clubId);
    return page({
      title: '阵容',
      back: 'dashboard',
      body: `
        <div class="stack">
          <div class="card stack">
            <b>${escapeHtml(club?.name ?? '')}</b>
            ${meterRow('体能', club?.stamina ?? 0)}
            ${meterRow('状态', club?.form ?? 50)}
            ${meterRow('士气', club?.morale ?? 50)}
            <div class="row--between small dim"><span>战术 ${club?.tactic ?? '—'}</span><span>声望 ${club?.reputation ?? 0}</span></div>
          </div>
          <div class="notice">LOD A 才生成 25 名个体球员。当前版本经理模式只看全队指标，个体阵容在 P6 后续屏接入。</div>
        </div>
      `,
    });
  }

  const career = state as CareerState;
  const player = career.player;
  return page({
    title: '个人档案',
    back: 'dashboard',
    meta: positionOf(career.detailPosition ?? player.position)?.label ?? player.position,
    body: `
      <div class="stack">
        <div class="card stack">
          <div class="row--between">
            <div>
              <div class="dim small">${escapeHtml(player.name)}</div>
              <h2 style="margin:2px 0 0">${escapeHtml(career.playerName)}</h2>
            </div>
            <div class="center">
              <div class="mono" style="font-size:24px;font-weight:700">${player.ability}</div>
              <div class="dim" style="font-size:11px">能力</div>
            </div>
          </div>
          ${meterRow('体能', player.stamina)}
          ${meterRow('状态', player.form)}
          <div class="row--between small dim">
            <span>年龄 ${player.age} / ${BALANCE.careerEndAge}</span>
            <span>潜力 ${player.potential}</span>
          </div>
        </div>

        <div class="card">
          <table class="table table--compact">
            <tbody>
              <tr><td>出场</td><td class="mono">${player.apps}</td><td>进球</td><td class="mono">${player.goals}</td></tr>
              <tr><td>助攻</td><td class="mono">${player.assists}</td><td>场均</td><td class="mono">${averageRating(player).toFixed(2)}</td></tr>
              <tr><td>身价</td><td class="mono">${num(player.value)} 万</td><td>人气</td><td class="mono">${career.fame}</td></tr>
            </tbody>
          </table>
        </div>

        <div class="card stack">
          <b>荣誉</b>
          ${career.honors.length === 0
            ? '<div class="dim small">还没有。</div>'
            : `<div class="row--wrap">${career.honors.map((h) => `<span class="chip chip--gold">${escapeHtml(h)}</span>`).join('')}</div>`}
        </div>
      </div>
    `,
  });
}

export function financePage(): string {
  const session = app.session;
  if (!session) return page({ title: '财政', back: 'dashboard', body: noCareer });
  const { world, state } = session;
  const club = world.clubs.find((c) => c.id === state.clubId);
  if (!club) {
    return page({
      title: '财政',
      back: 'dashboard',
      body: '<div class="dim">国家队主帅不承担俱乐部财政，这里没有可显示的账目。</div>',
    });
  }
  // 统一走 P5 的 financeOf（与赛季结算、董事会红线用的是同一套公式）
  const line = financeOf(world, club);

  return page({
    title: '财政',
    back: 'dashboard',
    meta: money(line.cash),
    body: `
      <div class="stack">
        <div class="card stack">
          <div class="row--between"><b>本赛季收入</b><span class="dim small">T${club.tier} · 声望 ${Math.round(club.reputation)}</span></div>
          <table class="table table--compact">
            <tbody>
              <tr><td>门票</td><td class="mono">${money(line.gate)}</td></tr>
              <tr><td>转播</td><td class="mono">${money(line.tv)}</td></tr>
              <tr><td>赞助</td><td class="mono">${money(line.sponsor)}</td></tr>
              <tr><td>奖金</td><td class="mono">${money(line.prize)}</td></tr>
              <tr class="is-me"><td>合计</td><td class="mono"><b>${money(line.income)}</b></td></tr>
            </tbody>
          </table>
        </div>
        <div class="card stack">
          <div class="row--between"><b>支出</b><span class="dim small">工资占比 ${Math.round(line.wageRatio * 100)}%</span></div>
          <table class="table table--compact">
            <tbody>
              <tr><td>工资总额</td><td class="mono">${money(line.wages)}</td></tr>
              <tr><td>差旅</td><td class="mono">${money(line.travel)}</td></tr>
              <tr><td>青训</td><td class="mono">${money(line.academy)}</td></tr>
              <tr><td>债务利息</td><td class="mono">${money(line.interest)}</td></tr>
              <tr class="is-me"><td>合计</td><td class="mono"><b>${money(line.expense)}</b></td></tr>
            </tbody>
          </table>
        </div>
        <div class="card stack">
          <div class="row--between"><b>期末</b><span class="mono ${line.net >= 0 ? '' : 'neg'}">${line.net >= 0 ? '+' : ''}${money(line.net)}</span></div>
          <table class="table table--compact">
            <tbody>
              <tr><td>现金</td><td class="mono">${money(line.cash)}</td></tr>
              <tr><td>净资产</td><td class="mono">${money(line.netAssets)}</td></tr>
              <tr><td>转会预算</td><td class="mono">${money(line.transferBudget)}</td></tr>
            </tbody>
          </table>
          ${line.notes.map((n) => `<div class="notice">${escapeHtml(n)}</div>`).join('')}
        </div>
        <div class="card dim small">
          财政公式：门票 = ticketBase×球场×(0.35+声望/200)；转播 = tvBaseByTier×(1+声望/100)；
          赞助 = sponsorBase×(声望/50)^1.2×商业系数；奖金按联赛名次与杯赛/洲际胜场。
          净资产连续 2 赛季为负会进入财政托管。
        </div>
      </div>
    `,
  });
}

export function boardPage(): string {
  const session = app.session;
  if (!session) return page({ title: '董事会', back: 'dashboard', body: noCareer });
  const { world, state } = session;
  const club = world.clubs.find((c) => c.id === state.clubId);
  const confidence = state.mode === 'manager' ? state.boardConfidence : 0;
  const mood = state.mode === 'manager' ? state.fanMood : 50;
  const streak = state.mode === 'manager' ? (state.seasonsWithoutContinental ?? 0) : 0;

  return page({
    title: '董事会与球迷',
    back: 'dashboard',
    body: `
      <div class="stack">
        <div class="card stack">
          <b>${escapeHtml(club?.name ?? '')}</b>
          ${state.mode === 'manager'
            ? `${meterRow('董事会满意度', confidence, confidence < BALANCE.fireBoardThreshold ? 'red' : 'green')}
               ${meterRow('球迷情绪', mood, mood < 40 ? 'gold' : 'green')}`
            : `<div class="dim small">球员模式没有董事会指标；你的评价来自生涯价值与荣誉。</div>`}
        </div>
        ${state.mode === 'manager'
          ? `<div class="card stack">
              <b>下课条件</b>
              <div class="small">董事会满意度低于 <span class="mono">${BALANCE.fireBoardThreshold}</span>，
                且连续 <span class="mono">${BALANCE.fireStreakSeasons}</span> 个赛季没有洲际资格。</div>
              <div class="row--between small"><span>当前连续无欧战</span><span class="mono">${streak} 季</span></div>
            </div>`
          : ''}
        <div class="card dim small">
          董事会简报与媒体采访（每 4 周一次）在 P7 社区层接入。
        </div>
      </div>
    `,
  });
}

export function settingsPage(): string {
  const session = app.session;
  return page({
    title: '设置',
    back: 'home',
    body: `
      <div class="stack">
        <div class="card stack">
          <b>存档</b>
          <div class="row--between small"><span>当前体积</span><span class="mono">${session ? saveSizeText() : '—'}</span></div>
          <div class="row--between small"><span>存档键</span><span class="mono">greenworld_save_v1</span></div>
          <div class="row--between small"><span>世界种子</span><span class="mono">${session?.world.seed ?? BALANCE.worldSeedDefault}</span></div>
          <div class="row--wrap" style="margin-top:6px">
            <button class="btn btn--sm" data-act="save-now" ${session ? '' : 'disabled'}>立即保存</button>
            <button class="btn btn--sm" data-act="load" ${app.hasSave ? '' : 'disabled'}>读档</button>
            <button class="btn btn--sm btn--danger" data-act="wipe" ${app.hasSave || session ? '' : 'disabled'}>删除存档</button>
          </div>
        </div>
        <div class="card stack">
          <div class="row--between">
            <b>社区层（球迷热评）</b>
            <span class="chip">${session && session.state.communityOn === false ? '已关闭' : '已开启'}</span>
          </div>
          <div class="small dim">热评只是叙事，不影响积分与资格。关掉后赛报与结算页不再出现。</div>
          <button class="btn btn--sm" data-act="toggle-community" ${session ? '' : 'disabled'}>切换社区层</button>
        </div>
        <div class="card stack">
          <b>导入 / 导出</b>
          <textarea id="import-box" data-field="importBox" placeholder="把存档 JSON 粘到这里再点导入" class="paste-box">${escapeHtml(importDraft)}</textarea>
          <div class="row--wrap">
            <button class="btn btn--sm" data-act="import">导入</button>
            <button class="btn btn--sm" data-act="export">导出到剪贴板</button>
          </div>
        </div>
        <div class="card stack">
          <b>版本</b>
          <div class="row--between small"><span>存档格式</span><span class="mono">v${BALANCE.saveVersion}</span></div>
          <div class="row--between small"><span>体积上限</span><span class="mono">${BALANCE.saveMaxKB} KB</span></div>
          <div class="dim small">本作零外网请求，图片全部走本地 assets；社区层（P7）可整体关闭。</div>
        </div>
      </div>
    `,
  });
}

/** 供事件处理器调用：把 textarea 里的内容导入 */
export function importFromBox(): boolean {
  const box = document.getElementById('import-box') as HTMLTextAreaElement | null;
  const text = (box?.value ?? importDraft).trim();
  if (!text) return false;
  const ok = importSave(text);
  if (ok) importDraft = '';
  return ok;
}

/**
 * 输入框内容跟重绘解耦：settings 页任何一次整页重绘都会重建 textarea，
 * 以前粘一半的 JSON 会被清空。这里把内容寄存在模块里。
 */
let importDraft = '';

export function setImportDraft(value: string): void {
  importDraft = value;
}

/**
 * 删档：先过自绘确认框，确认后才真正清档。
 * 以前点一下「删除存档」直接毁档，误触无法挽回。
 */
export function requestWipe(): Promise<boolean> {
  return askConfirm({
    title: '删除存档？',
    message: '本地存档会被清空，且无法恢复。当前进度会立刻丢失。',
    okText: '删除',
    cancelText: '先不删',
    danger: true,
  }).then((ok) => {
    if (!ok) return false;
    clearSave();
    return true;
  });
}

export function persistCurrent(): void {
  persistNow();
}

export function clearSave(): void {
  wipeSave();
}

function money(value: number): string {
  if (Math.abs(value) >= 10000) return `${num(value / 10000, 2)} 亿`;
  return `${num(value)} 万`;
}
