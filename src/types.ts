import { Type } from "@sinclair/typebox";

/** A live scheduled task (rebuilt from the entry stream). */
export interface LoopTask {
  id: string;
  /** 5-field cron, or the `_wakeup_<epochMs>` sentinel used by schedule_wakeup. */
  cron: string;
  prompt: string;
  createdAt: number;
  lastFiredAt?: number;
  /** Computed at creation for one-shots — enables missed-fire detection. */
  nextFireTime?: number;
  recurring: boolean;
  /**
   * durable=true  → survives the session being closed & resumed (state lives in
   *                 the session file via appendEntry).
   * durable=false → session-only; kept in memory and dropped on shutdown.
   */
  durable: boolean;
  label?: string;
  cancelled?: boolean;
  /** Set for one-shot tasks that have already fired (tombstone). */
  fired?: boolean;
  /**
   * Dynamic-loop chaining: a schedule_wakeup task that should reschedule on
   * fire carries the user-facing prompt here; the task's own `prompt` is the
   * `<<autonomous-loop-dynamic>>` sentinel wrapper. The originating /loop's
   * createdAt — used so a self-paced loop still expires after recurringMaxAgeMs.
   */
  loopPrompt?: string;
  loopRoot?: number;
  /** Set on the armed fallback wakeup — a dropped fallback iteration ends the loop. */
  isFallback?: boolean;
  /** Created by a fixed-interval /loop — journaled so it is restored on resume. */
  fromLoop?: boolean;
}

/** Sentinel prompt a fired _wakeup_ task sends; index.ts expands it to loopPrompt. */
export const AUTONOMOUS_LOOP_SENTINEL = "<<autonomous-loop-dynamic>>";

/** Sentinel cron prefix for schedule_wakeup one-shot timers. */
export const WAKEUP_PREFIX = "_wakeup_";

/**
 * Prompt marker for "/loop with no prompt": resolved at fire time to
 * .pi/loop.md → ~/.pi/agent/loop.md → built-in maintenance prompt, so loop.md
 * edits go live on the next iteration.
 */
export const DEFAULT_LOOP_PROMPT = "<<pi-loop-default>>";

export function isWakeupTask(task: Pick<LoopTask, "cron">): boolean {
  return task.cron.startsWith(WAKEUP_PREFIX);
}

/** The prompt to show in lists — loop prompt for wakeups, a label for the default marker. */
export function displayPrompt(task: LoopTask): string {
  const p = task.loopPrompt ?? task.prompt;
  return p === DEFAULT_LOOP_PROMPT ? "(default loop prompt: loop.md / built-in)" : p;
}

/** The appendEntry payload — a journal of lifecycle events, one entry per event. */
export interface LoopEntryData {
  /** created | fired | cancelled — one entry per event; replay folds into task state */
  op: "created" | "fired" | "cancelled";
  task: LoopTask;
}

export const ENTRY_TYPE = "pi-loop-task";

export const LoopTaskSchema = Type.Object({
  id: Type.String(),
  cron: Type.String(),
  prompt: Type.String(),
  createdAt: Type.Number(),
  lastFiredAt: Type.Optional(Type.Number()),
  nextFireTime: Type.Optional(Type.Number()),
  recurring: Type.Boolean(),
  durable: Type.Boolean(),
  label: Type.Optional(Type.String()),
  cancelled: Type.Optional(Type.Boolean()),
  fired: Type.Optional(Type.Boolean()),
  loopPrompt: Type.Optional(Type.String()),
  loopRoot: Type.Optional(Type.Number()),
  isFallback: Type.Optional(Type.Boolean()),
  fromLoop: Type.Optional(Type.Boolean()),
});

export interface LoopConfig {
  /** Max concurrent tasks */
  maxJobs: number;
  /** Auto-expire recurring tasks after this many ms (0 = never) */
  recurringMaxAgeMs: number;
  /** Forward jitter = jitterFrac * cron-gap, capped at jitterCapMs */
  recurringJitterFrac: number;
  recurringJitterCapMs: number;
  /** One-shot tasks on minute-boundaries get a backward lead of up to this */
  oneShotJitterMaxMs: number;
  oneShotJitterFloorMs: number;
  /** Only apply one-shot jitter when fire-minute % this === 0 */
  oneShotJitterMinuteMod: number;
  /** Scheduler tick interval */
  checkIntervalMs: number;
  /** Fallback wakeup armed when a dynamic /loop turn ends without rescheduling */
  dynamicFallbackMs: number;
  /** Every-N-minute crons whose gap is the 5-min cache window fire this much early */
  cacheLeadMs: number;
}

export const DEFAULT_CONFIG: LoopConfig = {
  maxJobs: 50,
  recurringMaxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  recurringJitterFrac: 0.5,
  recurringJitterCapMs: 30 * 60 * 1000, // 30 min
  oneShotJitterMaxMs: 90 * 1000,
  oneShotJitterFloorMs: 0,
  oneShotJitterMinuteMod: 30,
  checkIntervalMs: 1000,
  dynamicFallbackMs: 20 * 60 * 1000, // 20 min safety net for dropped self-pacing
  cacheLeadMs: 15 * 1000,
};
