/**
 * 5-field cron parser and next-run calculator.
 * All evaluation is in the user's local timezone.
 *
 * Format: minute hour day-of-month month day-of-week
 * Day-of-week accepts 0-6 plus 7 as an alias for Sunday (vixie-cron semantics).
 */

const FIELD_RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 or 7 = Sunday)
];

/** Divisors of 60/24 that produce evenly-spaced steps — used to round odd intervals. */
const MINUTE_STEPS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12];

interface CronField {
  values: Set<number>;
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseField(field: string, min: number, max: number): CronField | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    const range = stepMatch ? stepMatch[1] : part;
    if (step < 1) return null;

    if (range === "*") {
      for (let i = min; i <= max; i += step) values.add(i);
    } else {
      const dashMatch = range.match(/^(\d+)-(\d+)$/);
      if (dashMatch) {
        const lo = parseInt(dashMatch[1], 10);
        const hi = parseInt(dashMatch[2], 10);
        if (lo < min || hi > max || lo > hi) return null;
        for (let i = lo; i <= hi; i += step) values.add(i);
      } else {
        const val = parseInt(range, 10);
        if (isNaN(val) || val < min || val > max) return null;
        values.add(val);
      }
    }
  }
  return values.size > 0 ? { values } : null;
}

export function parseCronExpression(cron: string): ParsedCron | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields: CronField[] = [];
  for (let i = 0; i < 5; i++) {
    const field = parseField(parts[i], FIELD_RANGES[i][0], FIELD_RANGES[i][1]);
    if (!field) return null;
    fields.push(field);
  }
  // vixie-cron: 7 is an alias for Sunday (0)
  const sunday = fields[4].values.has(7);
  if (sunday) {
    fields[4].values.delete(7);
    fields[4].values.add(0);
  }
  return {
    minute: fields[0],
    hour: fields[1],
    dayOfMonth: fields[2],
    month: fields[3],
    dayOfWeek: fields[4],
  };
}

/**
 * vixie-cron day semantics: when both day-of-month and day-of-week are
 * restricted, a day matches if EITHER matches ("0 9 1 * 1" = the 1st or any
 * Monday). When one of them is unrestricted, only the other one counts.
 */
function dayMatches(parsed: ParsedCron, d: Date): boolean {
  const domAll = parsed.dayOfMonth.values.size === 31;
  const dowAll = parsed.dayOfWeek.values.size === 7;
  const dom = parsed.dayOfMonth.values.has(d.getDate());
  const dow = parsed.dayOfWeek.values.has(d.getDay());
  if (domAll && dowAll) return true;
  if (domAll) return dow;
  if (dowAll) return dom;
  return dom || dow;
}

/** Compute next cron run after `from`. Returns null if no match within 1 year. */
export function computeNextCronRun(parsed: ParsedCron, from: Date): Date | null {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = new Date(from.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (d < limit) {
    if (!parsed.month.values.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(parsed, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!parsed.hour.values.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!parsed.minute.values.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  return null;
}

/** Parse cron string and compute next run in epoch ms. */
export function nextCronRunMs(cron: string, fromMs: number): number | null {
  const parsed = parseCronExpression(cron);
  if (!parsed) return null;
  const next = computeNextCronRun(parsed, new Date(fromMs));
  return next ? next.getTime() : null;
}

/** Convert cron expression to human-readable string. */
export function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;

  const everyMinMatch = min.match(/^\*\/(\d+)$/);
  if (everyMinMatch && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const n = parseInt(everyMinMatch[1], 10);
    return n === 1 ? "every minute" : `every ${n} minutes`;
  }
  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (min === "0" && everyHourMatch && dom === "*" && mon === "*" && dow === "*") {
    const n = parseInt(everyHourMatch[1], 10);
    return n === 1 ? "every hour" : `every ${n} hours`;
  }
  if (min === "0" && hour === "0" && mon === "*" && dow === "*") {
    if (dom === "*") return "every day at midnight";
    const everyDayMatch = dom.match(/^\*\/(\d+)$/);
    if (everyDayMatch) {
      const n = parseInt(everyDayMatch[1], 10);
      return n === 1 ? "every day at midnight" : `every ${n} days at midnight`;
    }
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && dow === "*") {
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    const period = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `daily at ${h12}:${m.toString().padStart(2, "0")} ${period}`;
  }
  return cron;
}

export interface IntervalCron {
  cron: string;
  /** Human note when the requested interval was rounded to a clean cron step. */
  rounded?: string;
}

function nearestDivisor(n: number, divisors: number[]): number {
  let best = divisors[0];
  for (const d of divisors) if (Math.abs(d - n) < Math.abs(best - n)) best = d;
  return best;
}

/**
 * Convert a human interval ("5m", "2h", "1d") to a cron expression.
 * Intervals that don't map to an evenly-spaced cron step (7m, 90m…) are rounded
 * to the nearest clean step and reported via `rounded` — a star-slash-7 minute
 * field would fire at uneven gaps (7,7,…,1 minutes), which is almost never
 * what the user wants.
 */
export function intervalToCron(interval: string): IntervalCron | null {
  const match = interval.match(/^(\d+)([smhd])$/);
  if (!match) return null;
  let n = parseInt(match[1], 10);
  const unit = match[2];
  if (n <= 0) return null;
  switch (unit) {
    case "s": {
      n = Math.max(1, Math.ceil(n / 60));
      return { cron: `*/${n} * * * *`, rounded: `${n}m (seconds round up to minutes)` };
    }
    case "m": {
      if (n <= 59) {
        if (MINUTE_STEPS.includes(n)) return { cron: `*/${n} * * * *` };
        const r = nearestDivisor(n, MINUTE_STEPS);
        return { cron: `*/${r} * * * *`, rounded: `${r}m (${n}m isn't an even cron step)` };
      }
      const hours = nearestDivisor(Math.max(1, Math.round(n / 60)), HOUR_STEPS);
      return { cron: `0 */${hours} * * *`, rounded: `${hours}h (${n}m isn't an even cron step)` };
    }
    case "h": {
      if (n <= 23) {
        if (HOUR_STEPS.includes(n)) return { cron: `0 */${n} * * *` };
        const r = nearestDivisor(n, HOUR_STEPS);
        return { cron: `0 */${r} * * *`, rounded: `${r}h (${n}h isn't an even cron step)` };
      }
      return { cron: `0 0 */${Math.ceil(n / 24)} * *` };
    }
    case "d":
      return { cron: `0 0 */${n} * *` };
    default:
      return null;
  }
}

/** Gap between consecutive fires (ms) — used for jitter. */
export function cronGapMs(cron: string, fromMs: number): number | null {
  const first = nextCronRunMs(cron, fromMs);
  if (first === null) return null;
  const second = nextCronRunMs(cron, first);
  if (second === null) return null;
  return second - first;
}
