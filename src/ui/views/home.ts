import { img } from '../art';
import { escapeHtml } from '../dom';
import { app } from '../state';
import type { SetupDraft } from '../state';
import { page } from './common';
import { ART_COUNT } from '../art-manifest';
import { BALANCE } from '../../game/balance';
import { CONFEDERATIONS } from '../../game/config/confederations';
import { COUNTRIES } from '../../game/config/countries';
import { generateWorld } from '../../game/world/generate';
import type { WorldState } from '../../game/types';
import { POSITIONS } from '../../game/config/positions';

/**
 * 开局页需要真实的俱乐部/国家队清单（要拿到俱乐部 id 才能传给 createCareer）。
 * 世界是种子确定性生成的，这里只生成一次并缓存，避免每次重绘都重跑。
 */
let setupCache: WorldState | null = null;

function setupWorld(): WorldState {
  setupCache ??= generateWorld(BALANCE.worldSeedDefault);
  return setupCache;
}

/** 本国青训候选：T3/T4 里声望最低的几支（出场机会最多） */
function careerStartClubs(countryId: string) {
  return setupWorld()
    .clubs.filter((c) => c.countryId === countryId && c.tier >= 3)
    .sort((a, b) => a.reputation - b.reputation || a.id.localeCompare(b.id))
    .slice(0, 8);
}

function managerTiers(countryId: string): number[] {
  const country = COUNTRIES.find((c) => c.id === countryId);
  const tiers = country?.tiers ?? 3;
  return Array.from({ length: tiers }, (_, i) => i + 1);
}

function managerClubs(countryId: string, tier: number) {
  return setupWorld()
    .clubs.filter((c) => c.countryId === countryId && c.tier === tier)
    .sort((a, b) => b.reputation - a.reputation || a.id.localeCompare(b.id))
    .slice(0, 8);
}

/**
 * 位置（设计 §4.1 的 6 种：前锋 / 边锋 / 前腰 / 后腰 / 中卫 / 门将）。
 * 底层 `Player.position` 只有 GK/DF/MF/FW 四类，细位置只作为展示与球风说明，
 * 落库时归到 base（这样比赛模拟与成长公式都只认四类）。
 */
const POSITION_OPTIONS = POSITIONS;

/**
 * 首页（设计 §10.1 #1）。
 * 三张图：hero keyart（preload，唯一允许预加载）、title plate、两张模式卡。
 * 图没做时 art.img() 会直接给同色系渐变块，所以现在就能看。
 */
export function homePage(): string {
  const save = app.hasSave
    ? `<button class="btn btn--primary btn--block" data-act="load">继续上次存档</button>`
    : '';
  return page({
    title: '绿茵世界',
    meta: `v0.1 · ${ART_COUNT} 图位`,
    body: `
      <section class="hero">
        ${img('heroKeyart', { className: 'hero__img', eager: true, alt: '绿茵世界主视觉：黄昏球场与看台' })}
        <div class="hero__body">
          <h1>绿茵世界</h1>
          <p class="dim small">一个跑在文字里的足球世界 —— 12 国 776 家俱乐部、六大洲际、双金字塔。</p>
        </div>
      </section>

      <div class="stack">
        ${save}
        <div class="row--wrap">
          <button class="pick" data-act="mode-career" data-mode="career" style="flex:1 1 160px">
            <div class="row" style="gap:8px">
              ${img('modeCareer', { className: 'thumb', displayWidth: 56, alt: '球员生涯模式' })}
              <div class="grow">
                <b>球员生涯</b>
                <div class="pick__sub">16 岁入队，一场一场踢到退役</div>
              </div>
            </div>
          </button>
          <button class="pick" data-act="mode-manager" data-mode="manager" style="flex:1 1 160px">
            <div class="row" style="gap:8px">
              ${img('modeManager', { className: 'thumb', displayWidth: 56, alt: '主帅经营模式' })}
              <div class="grow">
                <b>主帅经营</b>
                <div class="pick__sub">坐上教练席，管更衣室也管账本</div>
              </div>
            </div>
          </button>
        </div>

        <div class="card card--flat">
          <div class="row--between">
            <span class="small dim">世界种子</span>
            <span class="mono small">20261019</span>
          </div>
          <div class="row--between" style="margin-top:6px">
            <span class="small dim">上一个进度</span>
            <span class="small">${app.hasSave ? '本地有存档' : '无'}</span>
          </div>
        </div>

        <button class="btn btn--block" data-act="scenario-pick">挑战剧本 · 换个开局试试</button>

        <div class="row">
          <button class="btn btn--ghost btn--sm grow" data-act="nav" data-screen="settings">设置 / 存档</button>
        </div>
      </div>
    `,
  });
}

/**
 * 开局选择链（#2，设计 §4.1 / §4.2 / §10.1 #2 / §10.3）。
 *
 * 生涯：联合会 → 国家 → 起始俱乐部（本国 T3/T4）→ 位置与名字
 * 经理：联合会 → 国家 → 执教对象（俱乐部 / 国家队）→ 联赛级别与俱乐部
 *
 * DOM 钩子固定为 `pick-confederation` / `pick-country` / `pick-target` / `start`，
 * 冒烟与自动化测试都靠这四个名字，不能改。
 */
export function setupPage(): string {
  const draft = app.draft;
  const isCareer = draft.mode === 'career';
  const confederationId = draft.confederationId ?? 'UEFA';

  return page({
    title: isCareer ? '创建球员' : '就任主帅',
    back: 'home',
    meta: stepLabel(draft),
    body: `
      <div class="stack">
        ${confederationStep(draft)}
        ${countryStep(draft)}
        ${isCareer ? careerDetailStep(draft) : managerTargetStep(draft, confederationId)}
        ${nameField(isCareer ? 'playerName' : 'managerName', isCareer ? draft.playerName : draft.managerName)}
      </div>
    `,
    actions: `
      <button class="btn btn--ghost" data-act="nav" data-screen="home">取消</button>
      <button class="btn btn--primary grow" data-act="start">开始</button>
    `,
  });
}

function stepLabel(draft: SetupDraft): string {
  const isCareer = draft.mode === 'career';
  if (!draft.countryId) return '第 2 步 / 共 4 步：选国家';
  if (isCareer) return '第 4 步 / 共 4 步：位置与名字';
  if (!draft.kind) return '第 3 步 / 共 4 步：执教对象';
  return '第 4 步 / 共 4 步：选俱乐部';
}

/** 第 1 步：联合会（六个，必须全在） */
function confederationStep(draft: SetupDraft): string {
  return `
    <div class="card card--flat">
      <b>1 · 选联合会</b>
      <div class="pick__sub" style="margin-bottom:8px">决定联赛强度、旅费与征召难度</div>
      <div class="row--wrap">
        ${CONFEDERATIONS.map(
          (conf) => `<button class="btn btn--sm${draft.confederationId === conf.id ? ' btn--primary' : ''}"
            data-act="pick-confederation" data-confederation="${conf.id}">${escapeHtml(conf.nameZh)}</button>`,
        ).join('')}
      </div>
    </div>
  `;
}

/** 第 2 步：国家（选完联合会才显示） */
function countryStep(draft: SetupDraft): string {
  if (!draft.confederationId) {
    return `<div class="card card--flat dim small">先选一个联合会，下面会列出它的国家。</div>`;
  }
  const countries = COUNTRIES.filter((c) => c.confederationId === draft.confederationId);
  return `
    <div class="card card--flat">
      <b>2 · 选国家</b>
      <div class="pick__sub" style="margin-bottom:8px">国家队征召与青训起点都看这里</div>
      <div class="row--wrap">
        ${countries
          .map(
            (c) => `<button class="btn btn--sm${draft.countryId === c.id ? ' btn--primary' : ''}"
              data-act="pick-country" data-country="${c.id}">${escapeHtml(c.nameZh)}</button>`,
          )
          .join('')}
      </div>
    </div>
  `;
}

/** 姓名可选项：文案承诺过「名字可选」，以前却没有输入框，导致生涯固定叫「无名球员」。 */
function nameField(field: 'playerName' | 'managerName', value: string | undefined): string {
  const id = field === 'playerName' ? 'player-name' : 'manager-name';
  return `
    <div class="card card--flat">
      <b>名字（可选）</b>
      <div class="pick__sub" style="margin-bottom:8px">留空则用系统生成的姓名（生涯里默认「无名球员」，经理默认「无名主帅」）。</div>
      <input id="${id}" class="name-input" data-field="${field}" type="text" maxlength="12"
        autocomplete="off" autocapitalize="off" spellcheck="false"
        placeholder="最多 12 个字，留空用系统生成" value="${escapeHtml(value ?? '')}" />
    </div>`;
}

/** 第 3 步（生涯）：俱乐部 + 第 4 步：位置与名字 */
function careerDetailStep(draft: SetupDraft): string {
  if (!draft.countryId) {
    return `<div class="card card--flat dim small">选完国家后，会列出该国第三、第四级别的青训俱乐部。</div>`;
  }
  const clubs = careerStartClubs(draft.countryId);
  return `
    <div class="card card--flat">
      <b>3 · 选起始俱乐部（本国青训）</b>
      <div class="pick__sub" style="margin-bottom:8px">级别越低，出场机会越多、成长越快</div>
      <div class="row--wrap">
        ${clubs
          .map(
            (club) => `<button class="btn btn--sm${draft.clubId === club.id ? ' btn--primary' : ''}"
              data-act="pick-target" data-club="${club.id}">T${club.tier} ${escapeHtml(club.name)}</button>`,
          )
          .join('')}
      </div>
    </div>
    <div class="card card--flat">
      <b>4 · 位置</b>
      <div class="row--wrap" style="margin-top:8px">
        ${POSITION_OPTIONS.map(
          (p) => `<button class="btn btn--sm${(draft.position ?? 'FW') === p.id ? ' btn--primary' : ''}"
            data-act="pick-position" data-position="${p.id}">${escapeHtml(p.label)}</button>`,
        ).join('')}
      </div>
      <div class="pick__sub" style="margin-top:8px">${
        POSITION_OPTIONS.find((p) => p.id === (draft.position ?? 'FW'))?.hint ?? ''
      }</div>
    </div>
  `;
}

/** 第 3~4 步（经理）：执教对象 + 俱乐部/国家队 */
function managerTargetStep(draft: SetupDraft, confederationId: string): string {
  const kindPick = `
    <div class="card card--flat">
      <b>3 · 执教对象</b>
      <div class="row--wrap" style="margin-top:8px">
        <button class="btn btn--sm${draft.kind !== 'national' ? ' btn--primary' : ''}"
          data-act="pick-kind" data-kind="club">俱乐部经理</button>
        <button class="btn btn--sm${draft.kind === 'national' ? ' btn--primary' : ''}"
          data-act="pick-kind" data-kind="national">国家队主帅</button>
      </div>
      <div class="pick__sub" style="margin-top:8px">国家队主帅只看联合会，不看国家；俱乐部经理要先选国家。</div>
    </div>
  `;
  if (draft.kind === 'national') {
    const teams = setupWorld().nationalTeams.filter((t) => t.confederationId === confederationId);
    return `${kindPick}
      <div class="card card--flat">
        <b>4 · 选国家队</b>
        <div class="pick__sub" style="margin-bottom:8px">世界排名越靠前越难带，也越容易拿大赛荣誉</div>
        <div class="row--wrap">
          ${teams
            .map(
              (t) => `<button class="btn btn--sm${draft.nationalTeamId === t.id ? ' btn--primary' : ''}"
                data-act="pick-target" data-national="${t.id}">${escapeHtml(t.nameZh)} · 第 ${t.rank} 位</button>`,
            )
            .join('')}
        </div>
      </div>`;
  }
  if (!draft.countryId) {
    return `${kindPick}<div class="card card--flat dim small">选完国家后，会列出该国的联赛级别与俱乐部。</div>`;
  }
  const tiers = managerTiers(draft.countryId);
  return `${kindPick}
    <div class="card card--flat">
      <b>4 · 选联赛级别与俱乐部</b>
      <div class="row--wrap" style="margin-top:8px">
        ${tiers
          .map(
            (t) => `<button class="btn btn--sm${draft.tier === t ? ' btn--primary' : ''}"
              data-act="pick-tier" data-tier="${t}">第 ${t} 级</button>`,
          )
          .join('')}
      </div>
      <div class="row--wrap" style="margin-top:8px">
        ${managerClubs(draft.countryId, draft.tier ?? 1)
          .map(
            (club) => `<button class="btn btn--sm${draft.clubId === club.id ? ' btn--primary' : ''}"
              data-act="pick-target" data-club="${club.id}">${escapeHtml(club.name)}</button>`,
          )
          .join('')}
      </div>
      <div class="pick__sub" style="margin-top:8px">不选就按该级别中游球队入职。</div>
    </div>`;
}
