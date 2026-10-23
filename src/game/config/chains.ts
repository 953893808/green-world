/**
 * 事件链（设计 §8.7 / §15.4）。
 *
 * 三条链各示范一种结构：
 * - `bench-crisis`（生涯）教「耐心与对话」；
 * - `board-pressure`（经理）教「承诺是要还的」；
 * - `wonderkid`（经理）教「短期与长期」。
 *
 * 硬约束（单测锁死）：每条链必须有终止态，`nextStepId` 全部可达、无环；
 * 同一时刻活跃链 ≤ 3；链的结果只走 `advanceWeek` 这一条路。
 */
export interface ChainEffect {
  fame?: number;
  stamina?: number;
  boardConfidence?: number;
  fanMood?: number;
  /** 万为单位，正数进账、负数支出 */
  budget?: number;
  /** 球队三线强度（直接加，量级 0.5~2） */
  teamPower?: number;
}

export interface ChainChoice {
  label: string;
  effect: ChainEffect;
  risk?: { chance: number; failText: string; failEffect: ChainEffect };
  nextStepId?: string;
  endChain?: 'success' | 'fail' | 'abandon';
}

export interface ChainStep {
  id: string;
  /** 相对上一步的延迟周数 */
  weekOffset: number;
  title: string;
  desc: string;
  choices: ChainChoice[];
}

export interface ChainDef {
  id: string;
  mode: 'career' | 'manager';
  title: string;
  /** 触发条件（数据化，引擎只认这几种） */
  startWhen: 'career-midseason' | 'below-target' | 'youth-window';
  /** 最早可触发的周次 */
  weekFrom: number;
  steps: ChainStep[];
}

export const CHAINS: readonly ChainDef[] = [
  {
    id: 'bench-crisis',
    mode: 'career',
    title: '替补席危机',
    startWhen: 'career-midseason',
    weekFrom: 10,
    steps: [
      {
        id: 'agent',
        weekOffset: 0,
        title: '经纪人打来电话',
        desc: '「你连续三场替补了。再这样下去，夏天没人会记得你。」',
        choices: [
          {
            label: '让他别急，说教练答应过机会',
            effect: { fame: -1, stamina: 4 },
            nextStepId: 'training',
          },
          {
            label: '让他去打听其他俱乐部的意思',
            effect: { fame: 2, stamina: -3 },
            risk: { chance: 0.4, failText: '消息走漏，教练在全队面前点了你的名。', failEffect: { fame: -4, stamina: -2 } },
            nextStepId: 'training',
          },
          {
            label: '挂掉电话，先去加练',
            effect: { stamina: -5, fame: 1 },
            nextStepId: 'training',
          },
        ],
      },
      {
        id: 'training',
        weekOffset: 3,
        title: '训练场上的碰撞',
        desc: '分组对抗，你被主力中卫铲翻。他伸手要拉你，你又爬起来继续带球。',
        choices: [
          {
            label: '当着所有人再冲他一次',
            effect: { fame: 2, stamina: -4 },
            risk: { chance: 0.45, failText: '两人扭打起来，双双被罚跑十圈。', failEffect: { fame: -5, stamina: -8 } },
            nextStepId: 'showdown',
          },
          {
            label: '把球传出去，用配合回应',
            effect: { fame: 1, stamina: -2 },
            nextStepId: 'showdown',
          },
          {
            label: '找队长私下说清楚',
            effect: { fame: 1, stamina: 2 },
            nextStepId: 'showdown',
          },
        ],
      },
      {
        id: 'showdown',
        weekOffset: 4,
        title: '摊牌',
        desc: '教练把你叫到办公室：「这个赛季剩下的时间，你想要什么？」',
        choices: [
          {
            label: '要求首发，否则冬窗走人',
            effect: { fame: 3, stamina: -2 },
            risk: { chance: 0.5, failText: '教练当场把你排除出大名单。', failEffect: { fame: -6, stamina: -6 } },
            endChain: 'success',
          },
          {
            label: '低头，接受轮换，用训练说话',
            effect: { fame: -1, stamina: 6 },
            endChain: 'success',
          },
          {
            label: '把问题摊开，问他到底怎么想',
            effect: { fame: 1, stamina: 2 },
            endChain: 'success',
          },
        ],
      },
    ],
  },
  {
    id: 'board-pressure',
    mode: 'manager',
    title: '董事会施压',
    startWhen: 'below-target',
    weekFrom: 12,
    steps: [
      {
        id: 'summon',
        weekOffset: 0,
        title: '主席叫你去办公室',
        desc: '桌上摊着积分榜，他手指敲了两下目标名次那个位置。',
        choices: [
          {
            label: '承诺这个赛季打进目标名次',
            effect: { boardConfidence: 5 },
            nextStepId: 'promise-follow',
          },
          {
            label: '要人要钱，先把话说清楚',
            effect: { budget: 800, boardConfidence: -6 },
            nextStepId: 'money-received',
          },
          {
            label: '什么都不承诺，只谈球队现状',
            effect: { boardConfidence: -2, fanMood: 2 },
            nextStepId: 'no-promise',
          },
        ],
      },
      {
        id: 'promise-follow',
        weekOffset: 6,
        title: '承诺开始兑现了吗',
        desc: '记者在发布会上把你说过的名次又念了一遍。',
        choices: [
          {
            label: '认下这个目标',
            effect: { boardConfidence: 3, fanMood: 2 },
            endChain: 'success',
          },
          {
            label: '把话题引回伤病',
            effect: { boardConfidence: -1, fanMood: -3 },
            endChain: 'fail',
          },
        ],
      },
      {
        id: 'money-received',
        weekOffset: 4,
        title: '钱到了，附了一张纸条',
        desc: '「这是最后一批。」',
        choices: [
          {
            label: '全花在即战力上',
            effect: { budget: -800, teamPower: 1.5, boardConfidence: 2 },
            endChain: 'success',
          },
          {
            label: '一半花在青训上',
            effect: { budget: -400, teamPower: 0.6, fanMood: 3 },
            endChain: 'success',
          },
        ],
      },
      {
        id: 'no-promise',
        weekOffset: 5,
        title: '股东开始问话了',
        desc: '这次没人给你留面子。',
        choices: [
          {
            label: '继续按自己的路走',
            effect: { boardConfidence: -4 },
            endChain: 'abandon',
          },
          {
            label: '主动申请开一次说明会',
            effect: { boardConfidence: 2, fanMood: 1 },
            endChain: 'fail',
          },
        ],
      },
    ],
  },
  {
    id: 'wonderkid',
    mode: 'manager',
    title: '天才少年',
    startWhen: 'youth-window',
    weekFrom: 6,
    steps: [
      {
        id: 'spotted',
        weekOffset: 0,
        title: '青训教练带来一个人',
        desc: '十七岁，脚下很快，抬头看人。青训教练说：「他能上一线队。」',
        choices: [
          {
            label: '立刻调上一线队',
            effect: { teamPower: 0.8, fanMood: 3 },
            nextStepId: 'hype',
          },
          {
            label: '让他先在杯赛里试一次',
            effect: { teamPower: 0.4, fanMood: 1 },
            nextStepId: 'hype',
          },
          {
            label: '再练半年，先不着急',
            effect: { fanMood: -1 },
            endChain: 'abandon',
          },
        ],
      },
      {
        id: 'hype',
        weekOffset: 3,
        title: '媒体开始捧杀',
        desc: '「下一个巨星」的标题铺满了首页。他今天训练迟到了十分钟。',
        choices: [
          {
            label: '公开护他，压住舆论',
            effect: { fanMood: 2, boardConfidence: -1 },
            nextStepId: 'bid',
          },
          {
            label: '让他自己面对媒体',
            effect: { teamPower: 0.4, fanMood: -2 },
            risk: { chance: 0.45, failText: '他说错话，俱乐部被迫道歉。', failEffect: { fanMood: -6, boardConfidence: -3 } },
            nextStepId: 'bid',
          },
          {
            label: '按队规罚款，一视同仁',
            effect: { teamPower: 0.2, fanMood: 1 },
            nextStepId: 'bid',
          },
        ],
      },
      {
        id: 'bid',
        weekOffset: 5,
        title: '大俱乐部报价了',
        desc: '一份三倍于他身价的报价摆在桌上。董事会的意思很明显。',
        choices: [
          {
            label: '留下他，拒绝报价',
            effect: { teamPower: 1.2, boardConfidence: -5, fanMood: 5 },
            endChain: 'success',
          },
          {
            label: '卖掉，钱进转会预算',
            effect: { budget: 1200, teamPower: -1.5, boardConfidence: 6 },
            endChain: 'success',
          },
          {
            label: '卖掉但加回购条款',
            effect: { budget: 900, teamPower: -0.8, boardConfidence: 3 },
            endChain: 'success',
          },
        ],
      },
    ],
  },
] as const;

export function chainById(id: string): ChainDef | undefined {
  return CHAINS.find((c) => c.id === id);
}

/** 链的步骤：按 `nextStepId` 拓扑校验（单测用） */
export function chainSteps(def: ChainDef): Map<string, ChainStep> {
  return new Map(def.steps.map((s) => [s.id, s]));
}
