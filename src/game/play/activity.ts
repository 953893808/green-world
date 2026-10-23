import { streamRng } from '../../core/rng';
import { BALANCE, clamp } from '../balance';
import { CALENDAR } from '../config/calendar';
import type { PlayState, WorldState } from '../types';

/**
 * 世界活性 + 董事会简报 + 媒体采访（设计 §15.6 之外的世界层）。
 *
 * 铁律：**只影响叙事与软数值（form/morale/董事会/球迷），不改变积分与资格**。
 * 所有随机都走 `streamRng(seed,'activity',week)` 分流，保证同种子同结果。
 */

const CLUB_NEWS: readonly string[] = [
  '{club} 官方宣布新球场扩建方案通过审批',
  '{club} 主帅在赛前发布会迟到二十分钟，记者集体抗议',
  '{club} 队长因家事返回国内，缺席本周训练',
  '{club} 宣布与本地啤酒厂签下三年赞助',
  '{club} 青训营两名 17 岁小将被提拔进一线队训练',
  '{club} 球迷会在基地外挂横幅要求改变引援策略',
  '{club} 主场草皮返修，球队临时借用邻近球场训练',
  '{club} 公布上财年财报，工资占比再度上升',
  '{club} 副主席在采访中表示「今年目标不变」',
  '{club} 门将与替补门将发生训练冲突，俱乐部内部处理',
];

const FORM_NEWS: readonly string[] = [
  '{club} 近五轮只拿两分，更衣室开始有人质疑战术',
  '{club} 连续三场零封，后防线状态回升',
  '{club} 主力前腰伤愈复出，预计本周首发',
  '{club} 董事会内部传闻已开始接触替代主帅人选',
];

function fill(template: string, club: string): string {
  return template.replace(/\{club\}/g, club);
}

export interface ActivityResult {
  world: WorldState;
  news: string[];
}

/**
 * 每周一次：随机挑 2 支俱乐部，改一点 form/morale 并出一条新闻。
 * 调用点固定在 `advanceWeek` 末尾，所以存档只需存 clubs 的 form/morale/morale 列。
 */
export function runWorldActivity(world: WorldState): ActivityResult {
  const rng = streamRng(world.seed, 'activity', world.season, world.week);
  const news: string[] = [];
  if (world.clubs.length === 0) return { world, news };

  const touched = new Map<string, { form?: number; morale?: number }>();
  for (let i = 0; i < 2; i++) {
    const club = world.clubs[rng.int(0, world.clubs.length - 1)];
    if (!club) continue;
    const bad = rng.chance(0.45);
    const form = clamp(club.form + (bad ? -rng.int(2, 5) : rng.int(2, 5)), 0, 100);
    const morale = clamp(club.morale + (bad ? -rng.int(1, 3) : rng.int(1, 3)), 0, 100);
    touched.set(club.id, { form, morale });
    news.push(fill(bad ? FORM_NEWS[rng.int(0, FORM_NEWS.length - 1)] ?? '' : CLUB_NEWS[rng.int(0, CLUB_NEWS.length - 1)] ?? '', club.name));
  }

  const clubs = world.clubs.map((c) => {
    const t = touched.get(c.id);
    return t ? { ...c, form: t.form ?? c.form, morale: t.morale ?? c.morale } : c;
  });
  return { world: { ...world, clubs }, news: news.filter(Boolean) };
}

/** 董事会简报：每 `boardBriefIntervalWeeks` 周给一次，纯信息 + 一句判断 */
export interface BriefResult {
  headline: string;
  lines: string[];
}

export function boardBrief(world: WorldState, state: PlayState, rank: number): BriefResult | undefined {
  if (world.week % BALANCE.boardBriefIntervalWeeks !== 0) return undefined;
  if (state.mode === 'career') {
    return {
      headline: '董事会简报',
      lines: ['你是球员，董事会不直接管你；这份简报只说明俱乐部当前立场。', `本周联赛排名：第 ${rank} 位。`],
    };
  }
  const board = Math.round(state.boardConfidence);
  const mood = Math.round(state.fanMood);
  return {
    headline: '董事会简报',
    lines: [
      `球队排第 ${rank} 位，董事会满意度 ${board}，球迷情绪 ${mood}。`,
      board < BALANCE.fireBoardThreshold ? '董事会已在讨论换帅，请尽快给出结果。' : '董事会认为方向正确，但要求看到稳定。',
    ],
  };
}

/** 媒体采访：每 `interviewIntervalWeeks` 周一次，三选一 */
export interface InterviewPrompt {
  question: string;
  options: { label: string; fame: number; fanMood: number; board: number }[];
}

const INTERVIEWS: readonly { question: string; options: InterviewPrompt['options'] }[] = [
  {
    question: '近期成绩起伏，你怎么看外界对球队的质疑？',
    options: [
      { label: '承认问题，承诺调整', fame: 1, fanMood: 2, board: 1 },
      { label: '强硬回击，认为是噪音', fame: 3, fanMood: -2, board: -1 },
      { label: '拒绝评论，专注下一场', fame: 0, fanMood: 0, board: 0 },
    ],
  },
  {
    question: '有传闻说更衣室对战术安排有分歧，是真的吗？',
    options: [
      { label: '内部的事内部解决', fame: 1, fanMood: 1, board: 1 },
      { label: '否认，称球队非常团结', fame: 0, fanMood: 2, board: 2 },
      { label: '承认有分歧，但这是正常的', fame: 2, fanMood: -1, board: -2 },
    ],
  },
  {
    question: '本赛季的目标，你敢给出一个明确说法吗？',
    options: [
      { label: '按董事会定的目标走', fame: 0, fanMood: 0, board: 2 },
      { label: '我要带队拿冠军', fame: 3, fanMood: 3, board: -1 },
      { label: '一场一场踢，不谈目标', fame: 1, fanMood: 1, board: 0 },
    ],
  },
];

export function interviewPrompt(world: WorldState): InterviewPrompt | undefined {
  if (world.week % BALANCE.interviewIntervalWeeks !== 0) return undefined;
  const rng = streamRng(world.seed, 'interview', world.season, world.week);
  const pick = INTERVIEWS[rng.int(0, INTERVIEWS.length - 1)];
  return pick ? { question: pick.question, options: pick.options } : undefined;
}

/** 采访落地：只动软数值。选项来自当周 `interviewPrompt(world)`。 */
export function applyInterviewChoice(world: WorldState, state: PlayState, optionIndex: number): PlayState {
  const opt = interviewPrompt(world)?.options[optionIndex];
  if (!opt) return state;
  if (state.mode === 'career') {
    return {
      ...state,
      fame: clamp(state.fame + opt.fame, 0, BALANCE.reputationMax),
    };
  }
  return {
    ...state,
    fanMood: clamp(state.fanMood + opt.fanMood, 0, 100),
    boardConfidence: clamp(state.boardConfidence + opt.board, 0, 100),
  };
}

/** 赛季末那三条「世界发生了什么」（只叙事） */
export function seasonWorldNews(world: WorldState): string[] {
  const rng = streamRng(world.seed, 'season-news', world.season);
  const champs = Object.entries(world.lastSeasonChampions ?? {});
  const picks: string[] = [];
  for (let i = 0; i < Math.min(BALANCE.newsPerSeason, champs.length); i++) {
    const entry = champs[rng.int(0, champs.length - 1)];
    if (!entry) continue;
    const [compId, clubId] = entry;
    const club = world.clubs.find((c) => c.id === clubId);
    const comp = world.competitions.find((c) => c.id === compId);
    if (!club || !comp) continue;
    const line = `${club.name} 拿下 ${comp.nameZh} 冠军；${comp.nameZh} 参赛队数维持在 ${comp.participants} 支。`;
    if (!picks.includes(line)) picks.push(line);
  }
  while (picks.length < BALANCE.newsPerSeason) {
    picks.push(`第 ${world.season} 赛季共 ${CALENDAR.weeks} 周赛程走完，各联赛升降级与洲际资格已结算。`);
    break;
  }
  return picks.slice(0, BALANCE.newsPerSeason);
}
