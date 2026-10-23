import { clamp } from '../balance';
import { gradeScenario, type ScenarioDef, type ScenarioGrade } from '../config/scenarios';
import { advanceWeek, recoverWeekly } from '../rules/advance';
import { rankOf } from '../rules/standings';
import type { Club, ManagerState, PlayState, WorldState } from '../types';

/**
 * 挑战剧本的启动与结算（设计 §15.6）。
 *
 * 启动方式：先用剧本的固定种子建一档经理档，然后把赛程**真实推进**到 `startWeek`，
 * 最后施加「开场不利」（现金冻结 / 主力折损）。不伪造积分，前 24 周就是真打出来的。
 */

/** 剧本指定的目标俱乐部：该国该级别里声望最低的一支 */
export function scenarioClub(world: WorldState, def: ScenarioDef): Club | undefined {
  const pool = world.clubs
    .filter((c) => c.countryId === def.countryId && c.tier === def.tier)
    .sort((a, b) => a.reputation - b.reputation);
  return pool[0];
}

/** 把世界推进到剧本起始周（真实模拟，不造假积分） */
export function fastForward(world: WorldState, targetWeek: number): WorldState {
  let next = world;
  let guard = 0;
  while (next.week < targetWeek && guard < 60) {
    next = recoverWeekly(advanceWeek(next, {}));
    guard += 1;
  }
  return next;
}

const INJURY_PENALTY = 2;

/** 施加开场不利：现金冻结 + 主力折损，并写 `state.scenario` */
export function applyScenario(world: WorldState, state: ManagerState, def: ScenarioDef): { world: WorldState; state: ManagerState } {
  const clubId = state.clubId;
  const clubs = world.clubs.map((c) => {
    if (c.id !== clubId) return c;
    const hit = def.injuries * INJURY_PENALTY;
    return {
      ...c,
      cash: def.cashFreeze ? 0 : c.cash,
      attack: clamp(c.attack - hit, 10, 99),
      midfield: clamp(c.midfield - hit, 10, 99),
      defense: clamp(c.defense - hit, 10, 99),
      morale: clamp(c.morale - def.injuries * 4, 0, 100),
    };
  });
  return {
    world: { ...world, clubs },
    state: { ...state, scenario: { id: def.id, reached: [] } },
  };
}

/** 剧本结算：按名次与现金评级，写入 `state.scenario` */
export function settleScenario(
  world: WorldState,
  state: PlayState,
  def: ScenarioDef,
): { state: PlayState; grade: ScenarioGrade; lines: string[] } {
  const club = world.clubs.find((c) => c.id === (state.mode === 'manager' ? state.clubId : state.clubId));
  const rank = club ? rankOf(world, club.competitionId, club.id) : 0;
  const cash = club?.cash ?? 0;
  const grade = gradeScenario(def, rank, cash);
  const order: ScenarioGrade[] = ['bronze', 'silver', 'gold'];
  const reached = order.slice(0, order.indexOf(grade) + 1).filter((g) => g !== 'none');
  const lines = [
    `剧本「${def.name}」本季结果：第 ${rank > 0 ? rank : '—'} 位，现金 ${cash} 万。`,
    grade === 'none' ? '未达成任何目标档位。' : `达成：${reached.map((g) => ({ bronze: '铜', silver: '银', gold: '金' })[g]).join(' / ')}`,
  ];
  return {
    state: { ...state, scenario: { id: def.id, reached, grade } } as PlayState,
    grade,
    lines,
  };
}
