import { nextCronRunMs } from "./cron.js";
import { isWakeupTask, type LoopConfig, type LoopTask } from "./types.js";

/**
 * Deterministic jitter and fire-time computation:
 * - Recurring tasks: forward delay, spread fires across a window
 * - One-shot tasks: backward lead, fire slightly early to avoid pile-ups
 * - Every-N-minute crons whose gap is the ~5-minute prompt-cache window fire
 *   `cacheLeadMs` early so the run lands inside the cache window. The lead is
 *   anchored on the previous fire (anchor + gap − lead), not on the next cron
 *   boundary, so a fire never re-qualifies for the same boundary.
 */

export const CACHE_WINDOW_MS = 5 * 60 * 1000;
const EVERY_N_MINUTES_RE = /^\*\/\d+ \* \* \* \*$/;

/** Deterministic fraction [0,1) from task id (8-hex → u32). */
export function jitterFrac(taskId: string): number {
  const frac = parseInt(taskId.slice(0, 8), 16) / 0x100000000;
  return Number.isFinite(frac) ? frac : 0;
}

/** Forward jitter for recurring tasks (ms, added to the next cron run). */
export function recurringJitterMs(task: LoopTask, gapMs: number, config: LoopConfig): number {
  const raw = jitterFrac(task.id) * config.recurringJitterFrac * gapMs;
  return Math.min(raw, config.recurringJitterCapMs);
}

/** Next fire time of a recurring cron task, jitter / cache lead included. */
export function recurringFireTimeMs(task: LoopTask, config: LoopConfig): number | null {
  const anchor = task.lastFiredAt ?? task.createdAt;
  const first = nextCronRunMs(task.cron, anchor);
  if (first === null) return null;
  const second = nextCronRunMs(task.cron, first);
  if (second === null) return first;
  const gap = second - first;
  const lead = config.cacheLeadMs ?? 0;
  if (EVERY_N_MINUTES_RE.test(task.cron) && lead > 0 && lead < gap && gap >= CACHE_WINDOW_MS && gap - lead < CACHE_WINDOW_MS) {
    return anchor + gap - lead;
  }
  return first + recurringJitterMs(task, gap, config);
}

/**
 * Positive lead time to subtract from fireTime. Only applies when the fire
 * minute is on a boundary (:00 or :30, governed by oneShotJitterMinuteMod).
 * Never fires before creation.
 */
export function oneShotJitterMs(task: LoopTask, fireTimeMs: number, config: LoopConfig): number {
  const fireDate = new Date(fireTimeMs);
  const fireMinute = fireDate.getMinutes();
  if (fireMinute % config.oneShotJitterMinuteMod !== 0) return 0;
  const frac = jitterFrac(task.id);
  const lead =
    config.oneShotJitterFloorMs +
    frac * (config.oneShotJitterMaxMs - config.oneShotJitterFloorMs);
  const earliest = task.createdAt;
  const jittered = fireTimeMs - lead;
  if (jittered < earliest) return fireTimeMs - earliest;
  return lead;
}

/** When a task fires next (epoch ms), or null if it never will. */
export function taskFireTimeMs(task: LoopTask, config: LoopConfig): number | null {
  if (isWakeupTask(task)) return task.nextFireTime ?? null;
  if (task.recurring) return recurringFireTimeMs(task, config);
  const base = nextCronRunMs(task.cron, task.createdAt);
  if (base === null) return null;
  return base - oneShotJitterMs(task, base, config);
}
