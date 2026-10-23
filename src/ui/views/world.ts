import { img } from '../art';
import { escapeHtml } from '../dom';
import { app, go, type ScreenId } from '../state';
import { explainQualification } from '../../game/rules/qualify';
import { rulesForCompetition } from '../../game/config/qualification';
import { nationalCompetitionSize } from '../../game/national/schedule';
import { page, noCareer } from './common';
import type { CompetitionType, WorldState } from '../../game/types';

/**
 * 世界金字塔（#4）+ 赛事详情（#5）+ 资格路径（#11）。
 *
 * 金字塔分两条线：俱乐部线（国家联赛 → 洲际 → 世俱杯）与国家队线
 * （国家联赛 → 洲际杯 → 世界杯）。两条线共用同一套事件记录，但奖金/名额独立。
 */

/** 当前查看的线：club / national */
let pylonLine: 'club' | 'national' = 'club';

export function pylonPage(): string {
  const session = app.session;
  if (!session) return page({ title: '世界金字塔', back: 'home', body: noCareer });
  const { world } = session;
  const confs = world.confederations;

  const body = pylonLine === 'club' ? clubPyramid(world) : nationalPyramid(world);

  return page({
    title: '世界金字塔',
    back: 'dashboard',
    meta: pylonLine === 'club' ? '俱乐部线' : '国家队线',
    body: `
      <div class="stack">
        <section class="media-frame">
          ${img('headerBg', { alt: '赛事金字塔页头' })}
        </section>
        <div class="row">
          <button class="btn btn--sm grow${pylonLine === 'club' ? ' btn--primary' : ''}"
            data-act="pylon-line-club">俱乐部线</button>
          <button class="btn btn--sm grow${pylonLine === 'national' ? ' btn--primary' : ''}"
            data-act="pylon-line-career">国家队线</button>
        </div>
        ${body}
        <div class="card dim small">
          点任意赛事看「怎么进 / 往哪去」。当前联合会：${confs.length} 个，赛事共 ${world.competitions.length} 项。
        </div>
      </div>
    `,
  });
}

function clubPyramid(world: WorldState): string {
  const confs = world.confederations;
  return `
    <div class="card stack">
      <b>世界俱乐部赛事</b>
      <div>
        <button class="pick" data-act="competition-node" data-competition="fifa-club-world">
          <div class="row--between"><span>世俱杯 · 32 队</span><span class="chip chip--gold">顶层</span></div>
          <div class="pick__sub">各洲顶级赛事冠军与高排名球队</div>
        </button>
      </div>
      ${confs.map((conf) => {
        const comps = world.competitions.filter((c) =>
          c.scope === 'confederation' && c.confederationId === conf.id &&
          (c.type === 'continental-club' || c.type === 'continental-club-2' || c.type === 'continental-club-3'));
        if (comps.length === 0) return '';
        return `
          <div style="margin-top:8px">
            <div class="row" style="gap:8px;margin-bottom:6px">
              ${confIcon(conf.id, 28)}
              <b class="small">${escapeHtml(conf.nameZh)}</b>
            </div>
            ${comps.map((comp) => `
              <button class="pick" data-act="competition-node" data-competition="${comp.id}" style="margin-bottom:6px">
                <div class="row--between">
                  <span>${escapeHtml(comp.nameZh)}</span>
                  <span class="dim small">${comp.participants} 队</span>
                </div>
              </button>`).join('')}
          </div>`;
      }).join('')}
      <div class="divider"></div>
      <b class="small">国家联赛（12 国顶级联赛）</b>
      <div class="dim small" style="margin-bottom:6px">点进去能看积分榜与资格路径；次级联赛在赛事页里可切换。</div>
      <div class="row--wrap">
        ${world.countries.map((country) => {
          const top = world.competitions.filter((c) => c.type === 'league' && c.countryId === country.id);
          const tier1 = top.find((c) => c.level === 1) ?? top[0];
          if (!tier1) return '';
          return `<button class="chip" data-act="competition-node" data-competition="${tier1.id}">${escapeHtml(tier1.nameZh)}</button>`;
        }).join('')}
      </div>
    </div>`;
}

function nationalPyramid(world: WorldState): string {
  const cups = world.competitions.filter((c) => c.type === 'national-cup' || c.type === 'world-cup');
  const leagues = world.competitions.filter((c) => c.type === 'national-league');
  return `
    <div class="card stack">
      <b>世界国家队赛事</b>
      ${cups.map((comp) => `
        <button class="pick" data-act="competition-node" data-competition="${comp.id}">
          <div class="row--between">
            <span>${escapeHtml(comp.nameZh)}</span>
            <span class="dim small">${nationalCompetitionSize(world, comp.id)} 队</span>
          </div>
        </button>`).join('')}
      <div class="divider"></div>
      <b class="small">国家联赛分级（按联合会）</b>
      <div class="dim small">共 ${leagues.length} 个分级小组；A 级最高、D 级最低，赛季末升降。</div>
      <div class="row--wrap">
        ${leagues.slice(0, 12).map((comp) => `<button class="chip" data-act="competition-node" data-competition="${comp.id}">${escapeHtml(comp.nameZh)}</button>`).join('')}
      </div>
    </div>`;
}

function confIcon(confederationId: string, width: number): string {
  const map: Record<string, Parameters<typeof img>[0]> = {
    UEFA: 'europe',
    CONMEBOL: 'southAmerica',
    AFC: 'asia',
    CAF: 'africa',
    CONCACAF: 'northAmerica',
    OFC: 'oceania',
  };
  const key = map[confederationId];
  return key ? img(key, { className: 'thumb', displayWidth: width, alt: confederationId }) : '';
}

/** 赛事详情（#5）：积分榜 / 淘汰树 / 赛程 / 参赛队 */
export function competitionPage(): string {
  const session = app.session;
  const compId = app.focusCompetitionId;
  if (!session || !compId) return page({ title: '赛事', back: 'world-pylon', body: '<div class="dim">没有选中赛事。</div>' });
  const { world } = session;
  const comp = world.competitions.find((c) => c.id === compId);
  if (!comp) return page({ title: '赛事', back: 'world-pylon', body: `<div class="dim">赛事 ${escapeHtml(compId)} 不存在。</div>` });

  const isLeague = comp.type === 'league';
  const body = isLeague ? leagueBody(world, compId) : knockoutBody(world, compId);

  return page({
    title: comp.nameZh,
    back: 'world-pylon',
    meta: `${comp.participants} 队`,
    body: `
      <div class="stack">
        <section style="border-radius:10px;overflow:hidden">${img('stadiumDay', { alt: `${comp.nameZh} 赛事头图` })}</section>
        <div class="row--wrap">
          ${isLeague ? '<span class="chip">联赛 · 单循环</span>' : `<span class="chip">${escapeHtml(typeLabel(comp.type))}</span>`}
          <button class="chip" data-act="qual-path" data-competition="${compId}">资格路径 →</button>
        </div>
        ${body}
      </div>
    `,
  });
}

function typeLabel(type: CompetitionType): string {
  const map: Record<string, string> = {
    'league': '联赛',
    'domestic-cup': '国内杯赛',
    'continental-club': '洲际一级',
    'continental-club-2': '洲际二级',
    'continental-club-3': '洲际三级',
    'club-world': '世俱杯',
    'national-league': '国家联赛',
    'national-continental': '洲际杯',
    'world-cup': '世界杯',
  };
  return map[type] ?? type;
}

function leagueBody(world: WorldState, compId: string): string {
  const standing = world.standings[compId];
  const me = app.session?.state.clubId;
  if (!standing || standing.rows.length === 0) {
    return `<div class="card dim small">积分榜还没有数据（开赛后才有）。</div>`;
  }
  const rows = standing.rows.slice(0, 20);
  return `
    <div class="card">
      <div class="table-wrap">
      <table class="table">
        <thead><tr><th>#</th><th>球队</th><th>赛</th><th>胜</th><th>平</th><th>负</th><th>净</th><th>分</th></tr></thead>
        <tbody>
          ${rows.map((row, index) => {
            const club = world.clubs.find((c) => c.id === row.clubId);
            const cls = row.clubId === me ? ' class="is-me"' : '';
            return `<tr${cls}>
              <td class="table__rank">${index + 1}</td>
              <td class="nowrap">${escapeHtml(club?.name ?? row.clubId)}</td>
              <td class="mono">${row.played}</td><td class="mono">${row.won}</td>
              <td class="mono">${row.drawn}</td><td class="mono">${row.lost}</td>
              <td class="mono">${row.goalsFor - row.goalsAgainst}</td>
              <td class="mono"><b>${row.points}</b></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>
      ${standing.rows.length > 20 ? `<div class="dim small" style="margin-top:6px">仅显示前 20 名，共 ${standing.rows.length} 队。</div>` : ''}
    </div>`;
}

function knockoutBody(world: WorldState, compId: string): string {
  const ko = world.knockouts[compId];
  if (!ko) return `<div class="card dim small">淘汰赛尚未抽签。</div>`;
  const fixtures = world.fixtures
    .filter((f) => f.competitionId === compId)
    .sort((a, b) => a.week - b.week || a.round - b.round);

  return `
    <div class="card stack">
      <div class="row--between">
        <b>进行态</b>
        <span class="dim small">第 ${ko.round + 1} 轮 · 剩 ${ko.alive.length} 队</span>
      </div>
      ${ko.championId ? `<div class="chip chip--gold">冠军：${escapeHtml(clubName(world, ko.championId))}</div>` : ''}
      <table class="table table--compact">
        <thead><tr><th>周</th><th>轮次</th><th>主</th><th></th><th>客</th><th>比分</th></tr></thead>
        <tbody>
          ${fixtures.slice(-24).map((f) => `
            <tr>
              <td class="mono">${f.week}</td>
              <td class="dim small">${escapeHtml(f.stage ?? `R${f.round}`)}</td>
              <td class="nowrap">${escapeHtml(clubName(world, f.homeId))}</td>
              <td class="dim">vs</td>
              <td class="nowrap">${escapeHtml(clubName(world, f.awayId))}</td>
              <td class="mono">${f.result ? `${f.result.homeGoals}-${f.result.awayGoals}` : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function clubName(world: WorldState, clubId: string): string {
  const club = world.clubs.find((c) => c.id === clubId);
  return club?.name ?? clubId;
}

/** 资格路径（#11）：数据完全来自 QualificationRule + resolveQualifications */
export function qualificationPage(): string {
  const session = app.session;
  const compId = app.focusCompetitionId;
  if (!session) return page({ title: '资格路径', back: 'world-pylon', body: noCareer });
  const { world } = session;
  if (!compId) return page({ title: '资格路径', back: 'world-pylon', body: '<div class="dim">没有选中赛事。</div>' });
  const comp = world.competitions.find((c) => c.id === compId);
  const rules = comp ? rulesFor(compId) : [];
  const entries = world.qualifications.filter((q) => q.competitionId === compId);

  const ruleRows = rules.map((rule) => {
    const sample = entries.find((e) => e.ruleId === rule.id);
    const reason = sample?.reasons?.[0]?.text ?? explainQualification(rule.id, world).text;
    return `<tr>
      <td class="mono small">${escapeHtml(rule.id)}</td>
      <td class="small">${escapeHtml(reason)}</td>
    </tr>`;
  }).join('');

  return page({
    title: comp?.nameZh ?? '资格路径',
    back: 'competition',
    meta: `${entries.length} 队已获资格`,
    body: `
      <div class="stack">
        <div class="card stack">
          <b>怎么进</b>
          ${rules.length === 0
            ? '<div class="dim small">该赛事没有配置资格规则（可能是按固定名单）。</div>'
            : `<table class="table table--compact"><tbody>${ruleRows}</tbody></table>`}
        </div>
        <div class="card stack">
          <b>已获资格</b>
          ${entries.length === 0
            ? '<div class="dim small">尚未产生资格。</div>'
            : `<div class="row--wrap">${entries.slice(0, 32).map((e) =>
                `<span class="chip">${escapeHtml(clubName(world, e.clubId))}</span>`).join('')}</div>`}
        </div>
        <div class="card dim small">
          数据来源：QualificationRule 与 StateStore。赛事的「往哪去」由下游赛事的规则反查得出。
        </div>
      </div>
    `,
  });
}

function rulesFor(competitionId: string): Array<{ id: string; source: string; note: string }> {
  return rulesForCompetition(competitionId);
}

export function setPylonLine(line: 'club' | 'national'): void {
  pylonLine = line;
}

export function openCompetition(competitionId: string, screen: ScreenId = 'competition'): void {
  app.focusCompetitionId = competitionId;
  // 修复：以前直接赋值 app.screen，绕过 go() 不写 history，返回键会一次跳过多屏
  go(screen);
}
