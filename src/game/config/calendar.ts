// 52 周赛季日历。改赛季长度/窗期只改这里。
export interface Phase {
  id: string;
  from: number;
  to: number;
  label: string;
}

export interface TransferWindow {
  from: number;
  to: number;
  label: string;
}

export const CALENDAR = {
  weeks: 52,
  phases: [
    { id: 'preseason', from: 1, to: 4, label: '季前备战' },
    { id: 'first-half', from: 5, to: 24, label: '联赛前半程' },
    { id: 'winter', from: 25, to: 28, label: '冬歇期' },
    { id: 'second-half', from: 29, to: 44, label: '联赛后半程' },
    { id: 'finals', from: 45, to: 48, label: '决赛与赛季结算' },
    { id: 'offseason', from: 49, to: 52, label: '休赛期' },
  ] as Phase[],
  transferWindows: [
    { from: 1, to: 9, label: '夏季转会窗' },
    { from: 26, to: 30, label: '冬季转会窗' },
  ] as TransferWindow[],
  /** 国家队比赛窗口周 */
  nationalWindows: [6, 10, 14, 18, 33, 37] as readonly number[],
  maxMatchesPerWeek: 2,
} as const;

/** 可用于打联赛的周（去掉季前/冬歇/决赛/休赛期） */
export function leagueWeeks(): number[] {
  const weeks: number[] = [];
  for (const p of CALENDAR.phases) {
    if (p.id === 'first-half' || p.id === 'second-half') {
      for (let w = p.from; w <= p.to; w++) weeks.push(w);
    }
  }
  return weeks;
}

export function phaseLabelOf(week: number): string {
  for (const p of CALENDAR.phases) {
    if (week >= p.from && week <= p.to) return p.label;
  }
  return '赛季外';
}

export function isTransferWindow(week: number): boolean {
  return CALENDAR.transferWindows.some((t) => week >= t.from && week <= t.to);
}

export function isNationalWindow(week: number): boolean {
  return CALENDAR.nationalWindows.includes(week);
}
