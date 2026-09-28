/** Today's date in New York (market time), YYYY-MM-DD. */
export function nyToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isWeekday(iso: string): boolean {
  const day = new Date(iso + "T00:00:00Z").getUTCDay();
  return day !== 0 && day !== 6;
}

/** Weekdays strictly before `endIso`, going back `calendarDays`. Newest first. */
export function weekdaysBack(endIso: string, calendarDays: number): string[] {
  const out: string[] = [];
  for (let i = 1; i <= calendarDays; i++) {
    const d = addDays(endIso, -i);
    if (isWeekday(d)) out.push(d);
  }
  return out;
}
