import { streamRng } from '../../core/rng';
import { BALANCE, clamp, round2, seasonWagesOfWeekly, weeklyWageOfAbility } from '../balance';
import { financeOf } from './finance';
import { transferValueOf } from './transfer';
import { clubById } from '../world/generate';
import type { Club, WorldState } from '../types';

/**
 * 转会谈判（设计 §15.7）—— 四关：估价 → 球员意愿 → 经纪人 → 注册与工资帽。
 * 每关失败都给**可解释的原因码**，玩家改条件再来（最多 `transferRounds` 轮）。
 */
export interface BidTarget {
  id: string;
  name: string;
  position: 'GK' | 'DF' | 'MF' | 'FW';
  age: number;
  ability: number;
  /** 参考身价（万，转会费量纲，与 transfer.transferValueOf 同源） */
  value: number;
  clubId: string;
  clubName: string;
  /** 挂牌价：value 叠加需求/合同/竞争三个系数 */
  askingPrice: number;
  /** 期望周薪（万） */
  wage: number;
}

export interface BidReason {
  code: string;
  text: string;
}

export interface BidResult {
  stage: 'fee' | 'player' | 'agent' | 'registration' | 'done' | 'failed';
  ok: boolean;
  reasons: BidReason[];
  fee: number;
  askingPrice: number;
  agentFee: number;
  /** 还价后的建议费用（stage==='fee' 且未通过时给） */
  counter?: number;
}

const SURNAMES = ['Ferreira', 'Kovac', 'Nakamura', 'Sørensen', 'Almeida', 'Mbeki', 'Novak', 'Duarte', 'Halland', 'Kovalenko', 'Bianchi', 'Okafor'];

/** 一份可谈的目标名单：来自其它俱乐部，确定性生成，不写入世界 */
export function marketFor(world: WorldState, clubId: string, count = 6): BidTarget[] {
  const rng = streamRng(world.seed, 'market', world.season, clubId, world.week <= 9 ? 1 : 2);
  const me = clubById(world, clubId);
  if (!me) return [];
  const pool = world.clubs.filter((c) => c.id !== clubId && c.countryId === me.countryId);
  const source = pool.length >= 8 ? pool : world.clubs.filter((c) => c.id !== clubId);
  const out: BidTarget[] = [];
  for (let i = 0; i < count; i++) {
    const seller = source[rng.int(0, source.length - 1)];
    if (!seller) continue;
    const ability = clamp(Math.round(seller.reputation * 0.85 + rng.int(-6, 10)), 30, 95);
    const age = rng.int(18, 32);
    // P1-2：挂牌价改用转会费曲线（与 feeFor / evaluateOffer 同源）。
    // 旧实现以 ability²×0.9 身价为底 → 挂牌 2000~5700 万，而 T1 俱乐部现金只有 ~1300 万，玩家市场实际不可买。
    const value = transferValueOf(ability, age);
    const need = clamp((me.reputation - seller.reputation) / 40, -0.2, 1);
    const asking = Math.round(value * (1 + BALANCE.needFactor * Math.max(0, need)) * (1 + BALANCE.rivalInterestFactor * rng.next()));
    const positions: BidTarget['position'][] = ['GK', 'DF', 'MF', 'FW'];
    out.push({
      id: `${seller.id}-p${i + 1}`,
      name: `${SURNAMES[rng.int(0, SURNAMES.length - 1)] ?? 'Silva'}`,
      position: positions[rng.int(0, 3)] ?? 'MF',
      age,
      ability,
      value,
      clubId: seller.id,
      clubName: seller.name,
      askingPrice: asking,
      // P1-1：wage 统一为周薪（万/周），与 TransferOffer.wage、balance.weeklyWageOfAbility 同源
      wage: weeklyWageOfAbility(ability),
    });
  }
  return out;
}

function incomeOf(world: WorldState, club: Club): number {
  try {
    return financeOf(world, club).income;
  } catch {
    return 0;
  }
}

/** 四关判定。`fee`/`wage`/`agentFee` 是玩家开出的条件。 */
export function evaluateBid(
  world: WorldState,
  clubId: string,
  target: BidTarget,
  fee: number,
  wage: number,
  agentFee: number,
): BidResult {
  const me = clubById(world, clubId);
  const seller = clubById(world, target.clubId);
  const reasons: BidReason[] = [];
  if (!me || !seller) {
    return { stage: 'failed', ok: false, reasons: [{ code: 'NO_CLUB', text: '找不到俱乐部。' }], fee, askingPrice: target.askingPrice, agentFee };
  }

  // ① 估价
  const floor = Math.round(target.askingPrice * 0.8);
  if (fee < floor) {
    reasons.push({ code: 'CLUB_REJECT_LOW_BID', text: `${target.clubName} 认为报价离估值太远，直接拒绝（挂牌价约 ${target.askingPrice} 万）。` });
    return { stage: 'fee', ok: false, reasons, fee, askingPrice: target.askingPrice, agentFee, counter: target.askingPrice };
  }
  if (fee < target.askingPrice) {
    reasons.push({ code: 'CLUB_WANTS_MORE', text: `${target.clubName} 还价：至少要 ${target.askingPrice} 万。` });
    return { stage: 'fee', ok: false, reasons, fee, askingPrice: target.askingPrice, agentFee, counter: target.askingPrice };
  }

  // ② 球员意愿
  const repGap = me.reputation - seller.reputation;
  const wageGap = wage - target.wage;
  // P1-1：wage 是周薪，分母用周薪量纲（旧实现 max(4, wage) 对周薪来说过大，工资差几乎不起作用）
  let will = 0.5 + repGap / 60 + wageGap / Math.max(0.2, target.wage) / 4;
  if (target.age > 30) will += 0.1;
  will = clamp(will, 0, 1);
  if (will < 0.45) {
    if (repGap < -BALANCE.offerReputationGap) {
      reasons.push({ code: 'PLAYER_WANTS_BIGGER', text: `${target.name} 想去更大的俱乐部，拒绝了你的条件。` });
    } else if (wageGap <= 0) {
      reasons.push({ code: 'PLAYER_WANTS_MONEY', text: `${target.name} 要求更高的周薪（当前开出 ${wage} 万/周，他要 ${target.wage} 万/周）。` });
    } else {
      reasons.push({ code: 'PLAYER_PREFERS_STAY', text: `${target.name} 更愿意留在 ${target.clubName}。` });
    }
    return { stage: 'player', ok: false, reasons, fee, askingPrice: target.askingPrice, agentFee };
  }

  // ③ 经纪人佣金
  const minAgent = Math.round(fee * BALANCE.agentFeeRatio);
  if (agentFee < minAgent) {
    reasons.push({ code: 'AGENT_FEE_TOO_LOW', text: `经纪人要 ${minAgent} 万佣金，你只给了 ${agentFee} 万。` });
    return { stage: 'agent', ok: false, reasons, fee, askingPrice: target.askingPrice, agentFee };
  }

  // ④ 注册与工资帽
  if (me.cash < fee) {
    reasons.push({ code: 'NO_BUDGET', text: `现金不足：需要 ${fee} 万，账上只有 ${me.cash} 万。` });
    return { stage: 'registration', ok: false, reasons, fee, askingPrice: target.askingPrice, agentFee };
  }
  const income = incomeOf(world, me);
  // P1-1：club.wages 是赛季工资总额，签约工资是周薪 → 先换算再和收入比（旧实现 0.9 万/周 vs 866 万收入，永远过不了线）
  const nextWage = round2(me.wages + seasonWagesOfWeekly(wage));
  if (income > 0 && nextWage > income * BALANCE.wageRatioCap) {
    reasons.push({ code: 'WAGE_CAP', text: `工资帽：签下后赛季工资 ${nextWage} 万会超过收入的 ${Math.round(BALANCE.wageRatioCap * 100)}%（上限 ${round2(income * BALANCE.wageRatioCap)} 万）。` });
    return { stage: 'registration', ok: false, reasons, fee, askingPrice: target.askingPrice, agentFee };
  }

  reasons.push({ code: 'DONE', text: `${target.name} 同意加盟，交易可签。` });
  return { stage: 'done', ok: true, reasons, fee, askingPrice: target.askingPrice, agentFee };
}

/** 签下：扣现金（含经纪人佣金）、加工资（周薪 → 赛季）、按位置补一点球队强度 */
export function signBid(
  world: WorldState,
  clubId: string,
  target: BidTarget,
  fee: number,
  wage: number,
  agentFee: number = round2(fee * BALANCE.agentFeeRatio),
): WorldState {
  const gain = target.ability * 0.004;
  return {
    ...world,
    clubs: world.clubs.map((c) => {
      if (c.id !== clubId) return c;
      return {
        ...c,
        // P2：旧实现从不扣佣金（evaluateBid 要求了佣金、signBid 却只扣 fee），这里买方补扣
        cash: round2(c.cash - fee - agentFee),
        // P1-1：wage 是周薪，写进账单前换算成赛季总额
        wages: round2(c.wages + seasonWagesOfWeekly(wage)),
        attack: clamp(c.attack + (target.position === 'FW' ? gain * 1.4 : gain * 0.4), 10, 99),
        midfield: clamp(c.midfield + (target.position === 'MF' ? gain * 1.4 : gain * 0.5), 10, 99),
        defense: clamp(c.defense + (target.position === 'DF' || target.position === 'GK' ? gain * 1.3 : gain * 0.3), 10, 99),
      };
    }),
  };
}
