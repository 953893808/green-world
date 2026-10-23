/**
 * 关键时刻模板（设计 §8.6 / §15.2）。
 *
 * 三条铁律：
 * 1. 每个模板恰好 3 个选项，且必须是**不同取舍**（资源/风险/收益），不许出现纯优解。
 * 2. `difficulty` 是成功率基准，实际成功率还叠能力差（见 match/flow.ts）。
 * 3. 效果只改「剩余比赛的 attackEdge/defenseEdge」与体能/换人名额，**绝不回改已发生的比分**。
 */
export interface MomentChoice {
  label: string;
  /** 成功率基准，0.1~0.9 */
  difficulty: number;
  /** 成功/失败各自的效果 */
  success: MomentEffect;
  fail: MomentEffect;
}

export interface MomentEffect {
  attackEdge?: number;
  defenseEdge?: number;
  stamina?: number;
  subs?: number;
  text: string;
}

export interface MomentTemplate {
  id: string;
  /** 只有生涯模式才触发（个人抉择，不能操控换人） */
  careerOnly?: boolean;
  /** 需要比分领先才触发 */
  whenLeading?: boolean;
  prompt: string;
  choices: MomentChoice[];
}

export const MOMENTS: readonly MomentTemplate[] = [
  {
    id: 'late-corner',
    prompt: '第 82 分钟，你在禁区右侧拿到一个角球。替补席都站起来了。',
    choices: [
      {
        label: '门将也上来，全员压上抢这一分',
        difficulty: 0.45,
        success: { attackEdge: 0.3, stamina: -6, text: '混战中中卫捅进去了。' },
        fail: { attackEdge: -0.25, stamina: -8, text: '球被顶出，对手直接打空门。' },
      },
      {
        label: '留三个人在中圈，防他们的反击',
        difficulty: 0.7,
        success: { defenseEdge: 0.2, text: '没进球，但也没丢球。' },
        fail: { defenseEdge: -0.1, text: '回防慢了半拍，被反击打进。' },
      },
      {
        label: '换上一个高中卫，就赌这一下',
        difficulty: 0.55,
        success: { attackEdge: 0.35, subs: 1, text: '他第一脚触球就顶进了。' },
        fail: { subs: 1, text: '他没碰到球，还吃了一张黄牌。' },
      },
    ],
  },
  {
    id: 'penalty-taker',
    prompt: '点球。全场安静下来，草皮上只剩下球和门将。',
    choices: [
      {
        label: '交给头号射手——他能力最高，但今天状态一般',
        difficulty: 0.62,
        success: { attackEdge: 0.25, text: '骗过门将，稳稳罚进。' },
        fail: { attackEdge: -0.2, text: '被门将猜对了方向。' },
      },
      {
        label: '队长来罚，他最稳',
        difficulty: 0.72,
        success: { attackEdge: 0.2, text: '一脚抽射，死角。' },
        fail: { attackEdge: -0.15, text: '打飞了，看台一片叹息。' },
      },
      {
        label: '让队里最有自信的年轻人上',
        difficulty: 0.5,
        success: { attackEdge: 0.3, text: '勺子点球，全场炸了。' },
        fail: { attackEdge: -0.25, text: '他腿软了，被门将抱住。' },
      },
    ],
  },
  {
    id: 'injury-risk',
    prompt: '核心球员一瘸一拐走到边线，说还能踢。',
    choices: [
      {
        label: '立刻换下，保住他',
        difficulty: 0.8,
        success: { defenseEdge: 0.05, subs: 1, text: '换上的人顶住了，他也保住了。' },
        fail: { attackEdge: -0.15, subs: 1, text: '换人后中场断了线。' },
      },
      {
        label: '让他踢完，赌这一场',
        difficulty: 0.45,
        success: { attackEdge: 0.3, stamina: -10, text: '他咬牙打进一球，然后才被换下。' },
        fail: { attackEdge: -0.3, stamina: -14, text: '他撑不住了，队形全乱。' },
      },
      {
        label: '换阵型保护他，让他少跑',
        difficulty: 0.65,
        success: { defenseEdge: 0.15, text: '阵型一收，他反而踢顺了。' },
        fail: { attackEdge: -0.1, text: '收得太深，前场彻底断供。' },
      },
    ],
  },
  {
    id: 'time-wasting',
    whenLeading: true,
    prompt: '领先一球，第 85 分钟。第四官员举牌：补时 4 分钟。',
    choices: [
      {
        label: '换上一个防守球员，把门关上',
        difficulty: 0.7,
        success: { defenseEdge: 0.25, subs: 1, text: '五后卫一摆，对面没脾气。' },
        fail: { defenseEdge: -0.1, subs: 1, text: '退得太深，被远射扳平。' },
      },
      {
        label: '继续压上，再进一个保险',
        difficulty: 0.4,
        success: { attackEdge: 0.35, text: '反击打成，2-0。' },
        fail: { attackEdge: -0.3, text: '后场空了，被追平。' },
      },
      {
        label: '控球消耗，把球留在角旗区',
        difficulty: 0.6,
        success: { defenseEdge: 0.15, stamina: -4, text: '球权全耗在边线，时间走完了。' },
        fail: { attackEdge: -0.15, text: '丢球后被立刻打成反击。' },
      },
    ],
  },
  {
    id: 'red-card',
    prompt: '对手被罚下一人。他们收缩了，把空间全让出来。',
    choices: [
      {
        label: '立刻两翼齐飞，压上去',
        difficulty: 0.55,
        success: { attackEdge: 0.35, text: '人多打人少，边路传中砸进一个。' },
        fail: { attackEdge: -0.1, text: '传中全被解围，还吃了一次反击。' },
      },
      {
        label: '稳住阵型，等他们犯错',
        difficulty: 0.75,
        success: { defenseEdge: 0.15, text: '耐心换来一次定位球，进了。' },
        fail: { text: '谁也没进球，时间耗光。' },
      },
      {
        label: '换上速度型前锋，专打身后',
        difficulty: 0.6,
        success: { attackEdge: 0.3, subs: 1, text: '一次直塞，单刀。' },
        fail: { attackEdge: -0.05, subs: 1, text: '他三次越位，节奏全乱。' },
      },
    ],
  },
  {
    id: 'promotion-decider',
    prompt: '升级附加赛决赛，0-0。第 88 分钟，谁都不敢先失误。',
    choices: [
      {
        label: '保守拖进点球',
        difficulty: 0.78,
        success: { defenseEdge: 0.2, text: '顶住了，进点球大战。' },
        fail: { defenseEdge: -0.2, text: '补时被打穿，直接出局。' },
      },
      {
        label: '压上搏绝杀',
        difficulty: 0.42,
        success: { attackEdge: 0.4, text: '补时绝杀，全队冲上看台。' },
        fail: { attackEdge: -0.3, text: '被反击一刀，赛季结束。' },
      },
      {
        label: '换上点球手，为点球大战做准备',
        difficulty: 0.7,
        success: { defenseEdge: 0.1, subs: 1, text: '他上来先稳住了节奏。' },
        fail: { defenseEdge: -0.1, subs: 1, text: '换人打乱了防守站位。' },
      },
    ],
  },
  {
    id: 'career-sub-self',
    careerOnly: true,
    prompt: '第四官员举起换人牌——上面是你的号码。教练在看你。',
    choices: [
      {
        label: '要求留下，赌这一次评分',
        difficulty: 0.45,
        success: { attackEdge: 0.25, stamina: -8, text: '你留下了，还送出一记关键传球。' },
        fail: { attackEdge: -0.2, stamina: -12, text: '你留在场上，但彻底跑不动了。' },
      },
      {
        label: '接受换下，保住体能',
        difficulty: 0.8,
        success: { stamina: -2, subs: 1, text: '你走下场，教练拍了拍你。' },
        fail: { stamina: -6, subs: 1, text: '你不太高兴，但还是坐回了替补席。' },
      },
      {
        label: '主动提战术建议再下场',
        difficulty: 0.6,
        success: { defenseEdge: 0.2, subs: 1, text: '教练照你说的换了边路，守住了。' },
        fail: { defenseEdge: -0.1, subs: 1, text: '没人听你的，场面越来越乱。' },
      },
    ],
  },
  {
    id: 'last-gasp-free-kick',
    prompt: '第 89 分钟，禁区弧顶外的任意球。人墙排好了。',
    choices: [
      {
        label: '直接射',
        difficulty: 0.38,
        success: { attackEdge: 0.35, text: '越过人墙，挂死角。' },
        fail: { attackEdge: -0.1, text: '射在人墙上，机会没了。' },
      },
      {
        label: '做战术球，短传边路',
        difficulty: 0.68,
        success: { attackEdge: 0.2, text: '短传后传中，头球攻门被挡出但混战进球。' },
        fail: { text: '短传被抢断，比赛结束。' },
      },
      {
        label: '高球吊进禁区，赌第二点',
        difficulty: 0.55,
        success: { attackEdge: 0.25, text: '第二点被补进。' },
        fail: { defenseEdge: -0.12, text: '门将摘下球，一脚长传反击。' },
      },
    ],
  },
] as const;

export function momentById(id: string): MomentTemplate | undefined {
  return MOMENTS.find((m) => m.id === id);
}
