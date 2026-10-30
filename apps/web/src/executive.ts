export interface TeamStatusRow {
  teamId: string;
  teamName: string;
  status: string;
  count: number;
  value: number;
}
export interface TrendWeek {
  teamId: string;
  weekStart: string;
  opened: number;
  completed: number;
  medianHours: number | null;
}

/** Hour of day (0-23) in Asia/Kolkata. */
function istHour(date: Date) {
  const hour = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Asia/Kolkata',
  }).format(date);
  return Number(hour);
}

export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? '';
}

/** "Good morning/afternoon/evening, <first name>" by the Asia/Kolkata hour. */
export function greeting(date: Date, name: string) {
  const hour = istHour(date);
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const first = firstName(name);
  return first ? `Good ${part}, ${first}` : `Good ${part}`;
}

export function todayLabel(date: Date) {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(date);
}

export function teamTotals(rows: TeamStatusRow[]) {
  const totals = new Map<string, { teamId: string; label: string; count: number; value: number }>();
  for (const row of rows) {
    const total = totals.get(row.teamId) ?? {
      teamId: row.teamId,
      label: row.teamName,
      count: 0,
      value: 0,
    };
    total.count += row.count;
    total.value += row.value;
    totals.set(row.teamId, total);
  }
  return [...totals.values()];
}

export function statusTotals(rows: TeamStatusRow[]) {
  const totals = new Map<string, { label: string; count: number; value: number }>();
  for (const row of rows) {
    const total = totals.get(row.status) ?? { label: row.status, count: 0, value: 0 };
    total.count += row.count;
    total.value += row.value;
    totals.set(row.status, total);
  }
  return [...totals.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Monday dates (YYYY-MM-DD) for the last `count` weeks ending at the week of `today`, in IST. */
export function weekStarts(today: Date, count = 12) {
  const ist = new Date(today.getTime() + 5.5 * 3600e3);
  const day = (ist.getUTCDay() + 6) % 7;
  const monday = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - day);
  return Array.from({ length: count }, (_, index) =>
    new Date(monday - (count - 1 - index) * 7 * 86400e3).toISOString().slice(0, 10),
  );
}

export function fillWeeks(weeks: TrendWeek[], teamId: string, starts: string[]) {
  const byWeek = new Map(weeks.filter((w) => w.teamId === teamId).map((w) => [w.weekStart, w]));
  return starts.map((weekStart) => ({
    weekStart,
    opened: byWeek.get(weekStart)?.opened ?? 0,
    completed: byWeek.get(weekStart)?.completed ?? 0,
  }));
}

/** Pie slices as SVG paths around (0,0) with the given radius; zero-value entries are dropped. */
export function pieSlices(items: { label: string; value: number }[], radius = 50) {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  if (total <= 0) return [];
  let angle = -Math.PI / 2;
  return items
    .filter((item) => item.value > 0)
    .map((item) => {
      const share = item.value / total;
      const start = angle;
      angle += share * Math.PI * 2;
      const point = (a: number) => `${(radius * Math.cos(a)).toFixed(2)} ${(radius * Math.sin(a)).toFixed(2)}`;
      const path =
        share >= 0.9999
          ? `M0 ${-radius}A${radius} ${radius} 0 1 1 0 ${radius}A${radius} ${radius} 0 1 1 0 ${-radius}Z`
          : `M0 0L${point(start)}A${radius} ${radius} 0 ${share > 0.5 ? 1 : 0} 1 ${point(angle)}Z`;
      return { label: item.label, value: item.value, share, path };
    });
}

export function formatHours(hours: number | null | undefined) {
  if (hours === null || hours === undefined || Number.isNaN(hours)) return '—';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${Math.round(hours * 10) / 10} h`;
  return `${Math.round((hours / 24) * 10) / 10} d`;
}

/** One summary line for the signed-in home. */
export function summaryLine(parts: { label: string; count: number }[]) {
  const active = parts.filter((part) => part.count > 0);
  if (!active.length) return 'Nothing needs your attention right now.';
  return active.map((part) => `${part.count} ${part.label}`).join(' · ');
}
