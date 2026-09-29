// Trading calendar: past trading days come from stored bars (days the market traded), future ones
// are weekdays minus announced holidays. All inputs are ISO dates (YYYY-MM-DD).

const DAY = 86_400_000;
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const isWeekday = (iso: string) => {
  const w = new Date(iso + "T00:00:00Z").getUTCDay();
  return w !== 0 && w !== 6;
};

export type Calendar = {
  /** Sorted trading days with data (past). */
  traded: string[];
  /** Future full-day closures. */
  holidays: Set<string>;
};

export function nextTradingDay(cal: Calendar, d: string): string {
  // Past: the next stored trading day, if we have one.
  let lo = 0, hi = cal.traded.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cal.traded[mid] <= d) lo = mid + 1; else hi = mid;
  }
  if (lo < cal.traded.length) return cal.traded[lo];
  let x = addDays(d, 1);
  while (!isWeekday(x) || cal.holidays.has(x)) x = addDays(x, 1);
  return x;
}

/** The trading day n sessions after d (n ≥ 0). */
export function addTradingDays(cal: Calendar, d: string, n: number): string {
  let x = d;
  for (let i = 0; i < n; i++) x = nextTradingDay(cal, x);
  return x;
}

/** Trading sessions strictly after a and up to and including b. */
export function tradingDaysBetween(cal: Calendar, a: string, b: string): number {
  let n = 0;
  for (let x = a; x < b; ) {
    x = nextTradingDay(cal, x);
    if (x <= b) n++;
  }
  return n;
}

/** Last trading day of its month. */
export const isMonthEnd = (cal: Calendar, d: string) => nextTradingDay(cal, d).slice(0, 7) !== d.slice(0, 7);

/** Monday of the ISO week containing d. */
const weekStart = (d: string) => {
  const w = (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7;
  return addDays(d, -w);
};

/** Last trading day of its week (usually Friday; Thursday before Good Friday, etc.). */
export const isWeekEnd = (cal: Calendar, d: string) => weekStart(nextTradingDay(cal, d)) !== weekStart(d);

export const calendarDaysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
