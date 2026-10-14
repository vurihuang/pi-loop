/**
 * Task state on pi 1.2.0's durable session architecture.
 *
 * State is an append-only event log of `pi-loop-task` CustomEntries inside
 * the session's own JSONL tree via pi.appendEntry(). On session_start (and on
 * session_tree navigation) we replay the active branch to rebuild live tasks.
 * This gives:
 *   - durability  (session file persists across restarts)
 *   - compaction-survival (custom entries are not LLM context)
 *   - branch-awareness (entries ride the session tree; replay uses getBranch())
 *
 * Journaled tasks: durable cron tasks, /loop tasks and schedule_wakeup timers
 * (the latter two are restored on resume, like Claude Code's session crons).
 * Session-only cron_create tasks (durable=false) live in memory only.
 *
 * The Map is module-level and pi caches extension modules across /new,
 * /resume and /fork — callers must clearAllTasks() on session_start/shutdown.
 */
import { randomUUID } from "node:crypto";
import { ENTRY_TYPE, isWakeupTask, type LoopEntryData, type LoopTask } from "./types.js";

const DEBUG = process.env.PI_LOOP_DEBUG === "1" || process.env.PI_LOOP_DEBUG === "true";
const debug = (...a: unknown[]) => DEBUG && console.debug("[pi-loop]", ...a);

const tasks = new Map<string, LoopTask>();

/** Minimal appendEntry signature we depend on — keeps unit tests free of pi types. */
export type AppendEntry = (customType: string, data?: LoopEntryData) => void;

export function generateTaskId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

/** Whether a task's lifecycle is written into the session file. */
export function isJournaled(task: LoopTask): boolean {
  return task.durable || !!task.fromLoop || isWakeupTask(task);
}

export function getTask(id: string) {
  return tasks.get(id);
}
/** Direct in-memory insert without journaling (tests / ad-hoc use). */
export function addTaskRaw(task: LoopTask): void {
  tasks.set(task.id, task);
}
export function getAllTasks(): LoopTask[] {
  return Array.from(tasks.values());
}
export function getTaskCount() {
  return tasks.size;
}
export function clearAllTasks() {
  tasks.clear();
}
/** Drop journaled tasks (before replaying another branch); memory-only tasks stay. */
export function clearJournaledTasks() {
  for (const t of getAllTasks()) if (isJournaled(t)) tasks.delete(t.id);
}

/** Apply one journal op to the in-memory view. */
function apply(task: LoopTask, op: LoopEntryData["op"]): void {
  // Copy on create so later mutations (lastFiredAt) never touch session-entry objects.
  if (op === "created") tasks.set(task.id, { ...task });
  else if (op === "cancelled") tasks.delete(task.id);
  else if (op === "fired") {
    const existing = tasks.get(task.id);
    if (existing) {
      existing.lastFiredAt = task.lastFiredAt;
      if (!existing.recurring) tasks.delete(task.id); // one-shot consumed
    }
  }
}

/** Record a task lifecycle event (appendEntry for journaled tasks, memory-only otherwise). */
export function record(appendEntry: AppendEntry | undefined, op: LoopEntryData["op"], task: LoopTask): void {
  if (op === "created") tasks.set(task.id, task);
  else apply(task, op);
  if (isJournaled(task) && appendEntry) {
    try {
      appendEntry(ENTRY_TYPE, { op, task: { ...task } });
    } catch (e) {
      debug("record: appendEntry failed", e);
    }
  }
  debug("record:", op, task.id);
}

export interface RestoreResult {
  /** Live tasks after replay (missed / expired ones excluded). */
  restored: number;
  /** Cron one-shots whose fire time passed while no session was running. */
  missed: LoopTask[];
  /** schedule_wakeup timers that came due while no session was running. */
  expiredWakeups: LoopTask[];
}

/**
 * Rebuild journaled tasks by replaying pi-loop-task entries from the active
 * branch (ctx.sessionManager.getBranch()). Missed one-shots and overdue
 * wakeups are removed from memory and returned — the caller records their
 * cancellation and decides how to surface them. Idempotent.
 */
export function restoreFromEntries(entries: unknown[], now = Date.now()): RestoreResult {
  clearJournaledTasks();
  for (const e of entries) {
    const entry = e as { type?: string; customType?: string; data?: LoopEntryData };
    if (entry?.type !== "custom" || entry.customType !== ENTRY_TYPE || !entry.data?.task) continue;
    apply(entry.data.task, entry.data.op);
  }

  const missed: LoopTask[] = [];
  const expiredWakeups: LoopTask[] = [];
  for (const t of getAllTasks()) {
    if (t.recurring || t.nextFireTime == null || now <= t.nextFireTime) continue;
    (isWakeupTask(t) ? expiredWakeups : missed).push(t);
    tasks.delete(t.id);
  }
  const restored = getAllTasks().filter(isJournaled).length;
  debug("restoreFromEntries: restored", restored, "missed", missed.length, "expired wakeups", expiredWakeups.length);
  return { restored, missed, expiredWakeups };
}
