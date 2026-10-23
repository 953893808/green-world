import { streamRng } from '../../core/rng';
import { BALANCE, clamp, round2, seasonWagesOfWeekly, weeklyWageOfAbility } from '../balance';
import { generateSquad } from '../world/generate';
import { isTransferWindow } from '../config/calendar';
import { financeOf } from './finance';
import type { Club, Player, WorldState } from '../types';

/**
 * 转会（设计 §7.1 / §15.7）。MVP 只做直接转会 + 租借。
 *
 * 每笔转会走 3 轮谈判（transferRounds）：
 *   第 1 轮 俱乐部对俱乐部（fee）→ 第 2 轮 球员同意（player）→ 第 3 轮 经纪人佣金（agent）
 * 任一拒绝即失败，失败原因写进 reasons 供 UI 解释。
 *
 * AI 逻辑：每周 transferPerWeek 笔，买方按「位置需求 × 声望差 × 财政余量」评分挑人。
 */

export type TransferStage = 'fee' | 'player' | 'agent' | 'registration' | 'done' | 'failed';

export interface TransferOffer {
  id: string;
  fromClubId: string;
  toClubId: string;
  /** 被交易的球员（LOD A 才会生成个体，AI 之间用合成 id） */
  playerId: string;
  playerName: string;
  position: Player['position'];
  ability: number;
  age: number;
  /** 转会费（万） */
  fee: number;
  /** 周薪（万） */
  wage: number;
  /** 经纪人佣金（万）：买方额外支付，不进入卖方收入；negotiate 成功后写入 */
  agentFee?: number;
  /** 合同年限 */
  contractYears: number;
  stage: TransferStage;
  reasons: string[];
  /** 是否为租借 */
  loan: boolean;
}

export interface TransferWindowResult {
  world: WorldState;
  offers: TransferOffer[];
  /** 玩家俱乐部收到的报价（可接受/拒绝） */
  playerOffers: TransferOffer[];
  news: string[];
}

/** 一支球队的位置需求：按当前三线强度与平均水平的差估算 */
function needsOf(club: Club): { need: number; position: Player['position'] } {
  const weakest =
    club.attack <= club.defense && club.attack <= club.midfield
      ? 'FW'
      : club.defense <= club.midfield
        ? 'DF'
        : 'MF';
  const avg = (club.attack + club.midfield + club.defense) / 3;
  const gap = avg - (weakest === 'FW' ? club.attack : weakest === 'DF' ? club.defense : club.midfield);
  return { need: clamp(round2(gap / 10), 0, 1), position: weakest as Player['position'] };
}

/**
 * 转会费基准（万）：能力 × 单价 × 年龄系数。
 * P1-2：报价（feeFor）与评估底线（evaluateOffer）共用这一条曲线，保证单调、
 * 恒 > 0，且能力 30 的边缘球员也有可成交的价格（旧公式两套曲线在 ability<53 时互相矛盾）。
 */
export function transferValueOf(ability: number, age: number): number {
  const ageCurve = age <= 24 ? 1.2 : age <= 28 ? 1 : 0.75;
  return Math.round(Math.max(1, ability) * BALANCE.transferFeePerPoint * ageCurve);
}

/** 年龄 → 合同年限：越年轻合同越长（长合同也意味着更高的摊销风险） */
export function contractYearsOf(age: number): number {
  if (age <= 23) return 5;
  if (age <= 26) return 4;
  if (age <= 29) return 3;
  if (age <= 31) return 2;
  return 1;
}

/** 转会费报价：基准价 × 买家财力系数（0.9~1.2，避免「现金越多报价越离谱」） */
export function feeFor(player: Player, to: Club): number {
  const budget = to.cash > 0 ? clamp(to.cash / 800, 0.9, 1.2) : 0.9;
  return Math.round(transferValueOf(player.ability, player.age) * budget);
}

/**
 * P2：AI 引援的工资帽约束——只拦「会把买方推过红线」的签约。
 * 已经在红线上的买方不冻结（它仍要靠卖人/降薪自救，长期存档才不会变死水）。
 */
export function wageCapAllows(world: WorldState, clubId: string, weeklyWage: number): boolean {
  const club = world.clubs.find((c) => c.id === clubId);
  if (!club) return false;
  const line = financeOf(world, club);
  const cap = line.income * BALANCE.wageRatioCap;
  if (line.wages > cap) return true;
  return line.wages + seasonWagesOfWeekly(weeklyWage) <= cap;
}

/** 报价是否会被拒绝：声望差太小 / 价格太低 / 买家财政不够 */
export function evaluateOffer(
  offer: TransferOffer,
  from: Club,
  to: Club,
): { ok: boolean; reason?: string } {
  if (to.cash < offer.fee) return { ok: false, reason: '买家现金不足' };
  // P1-2：底线与 feeFor 同源（同一 transferValueOf），不再用「ability × 4.8」另一条曲线
  const fair = Math.round(transferValueOf(offer.ability, offer.age) * 0.8);
  if (offer.fee < fair) return { ok: false, reason: `报价低于身价底线（${fair} 万）` };
  if (to.reputation < from.reputation - 10 && offer.fee < fair * 1.5) {
    return { ok: false, reason: '卖方不愿卖给低声望球队' };
  }
  return { ok: true };
}

/** 生成一支球队的待售名单（用 seed 确定性生成 3~5 人） */
function listedPlayers(world: WorldState, club: Club): Player[] {
  const squad = generateSquad(streamRng(world.seed, 'transfer-squad', club.id, world.season), club);
  const rng = streamRng(world.seed, 'transfer-list', club.id, world.season);
  const count = 3 + rng.int(0, 2);
  const pool = squad.slice().sort((a, b) => a.ability - b.ability);
  const out: Player[] = [];
  for (let i = 0; i < count && i < pool.length; i++) {
    const pick = pool[pool.length - 1 - i];
    if (pick) out.push(pick);
  }
  return out;
}

/** 执行一笔转会（纯函数）：从 from 扣人、给 to 加人、现金互换 */
function applyTransfer(world: WorldState, offer: TransferOffer): WorldState {
  const clubs = world.clubs.map<Club>((club) => {
    if (club.id === offer.fromClubId) {
      // P1-1：offer.wage 是周薪，写入工资账单前必须换算成赛季总额
      const wageOut = seasonWagesOfWeekly(offer.wage);
      return { ...club, cash: round2(club.cash + offer.fee), wages: round2(Math.max(0, club.wages - wageOut)) };
    }
    if (club.id === offer.toClubId) {
      const weekly = offer.loan ? offer.wage * BALANCE.loanWageShareDefault : offer.wage;
      return {
        ...club,
        // P2：佣金由买方支付给经纪人（资金离开球市），不能再塞进卖方的转会费
        cash: round2(club.cash - offer.fee - (offer.agentFee ?? 0)),
        wages: round2(club.wages + seasonWagesOfWeekly(weekly)),
        // 能力加成折算到三线强度上，反映引援效果
        attack: clamp(round2(club.attack + offer.ability * 0.004), 15, 97),
        midfield: clamp(round2(club.midfield + offer.ability * 0.003), 15, 97),
        defense: clamp(round2(club.defense + offer.ability * 0.002), 15, 97),
      };
    }
    return club;
  });
  return { ...world, clubs };
}

/** 单笔谈判：3 轮全过才算成功 */
export function negotiate(
  world: WorldState,
  offer: TransferOffer,
  rng: { chance: (p: number) => boolean },
): TransferOffer {
  const from = world.clubs.find((c) => c.id === offer.fromClubId);
  const to = world.clubs.find((c) => c.id === offer.toClubId);
  if (!from || !to) return { ...offer, stage: 'failed', reasons: ['俱乐部不存在'] };

  const evaluation = evaluateOffer(offer, from, to);
  if (!evaluation.ok) {
    return { ...offer, stage: 'failed', reasons: [evaluation.reason ?? '俱乐部拒绝'] };
  }
  // P2：旧实现直接 push 调用方传入的 offer.reasons（副作用），改为局部副本，入参只读
  const reasons = [...offer.reasons, '俱乐部接受报价'];

  // 球员本人意愿：声望差 + 出场机会 + 合同年限
  const repGap = to.reputation - from.reputation;
  const playerP = clamp(0.5 + repGap / 60 + BALANCE.needFactor * needsOf(to).need, 0.1, 0.95);
  if (!rng.chance(playerP)) {
    return { ...offer, stage: 'failed', reasons: [...reasons, '球员不愿加盟'] };
  }
  reasons.push('球员同意个人条款');

  // 经纪人佣金
  const agentFee = round2(offer.fee * BALANCE.agentFeeRatio);
  if (to.cash < offer.fee + agentFee) {
    return { ...offer, stage: 'failed', reasons: [...reasons, `付不起经纪人佣金（${agentFee} 万）`] };
  }
  reasons.push(`支付佣金 ${agentFee} 万`);

  return { ...offer, stage: 'done', agentFee, reasons };
}

/** 一周的 AI 转会活动 */
export function runTransferWeek(
  world: WorldState,
  options: { playerClubId?: string } = {},
): TransferWindowResult {
  if (!isTransferWindow(world.week)) {
    return { world, offers: [], playerOffers: [], news: [] };
  }
  const rng = streamRng(world.seed, 'transfer', world.season, world.week);
  const buyers = world.clubs.filter((c) => c.cash > BALANCE.cashFloor * 2);
  const offers: TransferOffer[] = [];
  const news: string[] = [];
  let nextWorld = world;

  const tries = Math.min(BALANCE.transferPerWeek, buyers.length);
  // P3：transferMaxPerClub 之前是死配置，这里真正限制每队每窗引进人数
  const signedByBuyer = new Map<string, number>();
  for (let i = 0; i < tries; i++) {
    const buyer = rng.pick(buyers);
    if (!buyer) continue;
    if (buyer.id === options.playerClubId && options.playerClubId !== undefined) {
      // 玩家俱乐部不自动买卖，只收报价
      continue;
    }
    if ((signedByBuyer.get(buyer.id) ?? 0) >= BALANCE.transferMaxPerClub) continue;
    const demand = needsOf(buyer);
    const pool = world.clubs.filter(
      (c) =>
        c.id !== buyer.id &&
        c.confederationId === buyer.confederationId &&
        c.reputation <= buyer.reputation + 2,
    );
    if (pool.length === 0) continue;
    const seller = rng.pick(pool);
    if (!seller) continue;
    const listed = listedPlayers(world, seller);
    const candidates = listed.filter((p) => p.position === demand.position);
    const target = candidates.length > 0 ? rng.pick(candidates) : rng.pick(listed);
    if (!target) continue;

    const offer: TransferOffer = {
      id: `tr-${world.season}-${world.week}-${i}`,
      fromClubId: seller.id,
      toClubId: buyer.id,
      playerId: target.id,
      playerName: target.name,
      position: target.position,
      ability: target.ability,
      age: target.age,
      fee: feeFor(target, buyer),
      // P1-1：wage 是「周薪」，由能力曲线生成（能力 80 ≈ 0.91 万/周）
      wage: weeklyWageOfAbility(target.ability),
      // P2：合同年限按年龄给，不再写死 3 年
      contractYears: contractYearsOf(target.age),
      stage: 'fee',
      reasons: [],
      loan: buyer.cash < BALANCE.cashFloor * 4,
    };
    // P2：工资帽约束只拦「会上穿红线」的引援；已在线上/租借按分摊后周薪判断
    const weeklyCost = offer.loan ? offer.wage * BALANCE.loanWageShareDefault : offer.wage;
    if (!wageCapAllows(nextWorld, buyer.id, weeklyCost)) continue;
    const result = negotiate(nextWorld, offer, rng);
    offers.push(result);
    if (result.stage === 'done') {
      nextWorld = applyTransfer(nextWorld, result);
      signedByBuyer.set(buyer.id, (signedByBuyer.get(buyer.id) ?? 0) + 1);
      news.push(`${buyer.name} 从 ${seller.name} 签下 ${target.name}（${result.fee} 万）`);
    }
  }

  return { world: nextWorld, offers, playerOffers: [], news };
}

/** 玩家俱乐部收到的报价（挖人） */
export function offersForPlayerClub(
  world: WorldState,
  playerClubId: string,
): TransferOffer[] {
  if (!isTransferWindow(world.week)) return [];
  const me = world.clubs.find((c) => c.id === playerClubId);
  if (!me) return [];
  const rng = streamRng(world.seed, 'offer', world.season, world.week, playerClubId);
  const interested = world.clubs.filter(
    (c) =>
      c.id !== me.id && c.reputation >= me.reputation + BALANCE.offerReputationGap,
  );
  const out: TransferOffer[] = [];
  const price = Math.round(me.reputation * BALANCE.transferFeePerPoint * 1.2);
  // P2：旧实现 rng.pick 有放回 → 同一周会出两条同一买家的报价，接受一条后另一条仍可卖同一名球员。
  // 改为无放回抽样，并且只让「当下真付得起」的买家进入列表。
  const pool = interested.filter((c) => c.cash >= price).slice();
  const count = Math.min(BALANCE.playerOffersPerWindow, pool.length);
  for (let i = 0; i < count; i++) {
    const bidder = pool.splice(rng.int(0, pool.length - 1), 1)[0];
    if (!bidder) continue;
    out.push({
      id: `offer-${world.season}-${world.week}-${i}`,
      fromClubId: me.id,
      toClubId: bidder.id,
      playerId: `${me.id}-star`,
      playerName: '队内核心',
      position: 'MF',
      ability: Math.round(me.midfield),
      age: 25,
      fee: price,
      // P1-1：挖人报价里的工资同样是「周薪」，按能力曲线给，不再拿赛季总额 ×0.1 冒充周薪
      wage: weeklyWageOfAbility(Math.round(me.midfield)),
      contractYears: contractYearsOf(25),
      stage: 'fee',
      reasons: [`${bidder.name} 想挖你的人`],
      loan: false,
    });
  }
  return out;
}

/** 接受报价：钱进账、能力小幅流失 */
export function acceptOffer(world: WorldState, offer: TransferOffer): WorldState {
  const buyer = world.clubs.find((c) => c.id === offer.toClubId);
  // P2：买方现金不足时整笔交易拒绝（返回原世界；调用方可用引用相等判断未成交）
  if (!buyer || buyer.cash < offer.fee + (offer.agentFee ?? 0)) return world;
  const clubs = world.clubs.map<Club>((club) => {
    if (club.id === offer.fromClubId) {
      return {
        ...club,
        cash: round2(club.cash + offer.fee),
        // 人走了，工资账单同步减掉（offer.wage 是周薪）
        wages: round2(Math.max(0, club.wages - seasonWagesOfWeekly(offer.wage))),
        attack: clamp(round2(club.attack - 1.5), 15, 97),
        midfield: clamp(round2(club.midfield - 1.5), 15, 97),
        defense: clamp(round2(club.defense - 1.2), 15, 97),
      };
    }
    if (club.id === offer.toClubId) {
      return { ...club, cash: round2(club.cash - offer.fee - (offer.agentFee ?? 0)) };
    }
    return club;
  });
  return { ...world, clubs };
}

/** 拒绝报价：无副作用，只用于 UI 反馈 */
export function rejectOffer(_world: WorldState, offer: TransferOffer): string {
  return `已拒绝 ${offer.toClubId} 的报价`;
}
