/**
 * Core scheduler — 1-second tick loop, gates on agent idle state, fires via
 * pi.sendUserMessage(). Uses ctx.isIdle() directly, with an
 * agent_start/agent_settled mirror, and persists lifecycle events via appendEntry.
 *
 * Dynamic-loop bookkeeping: a fired _wakeup_ task that reschedules stays one
 * logical loop — the new wakeup task inherits loopPrompt/loopRoot via
 * takePendingLoop(). At most one dynamic loop runs per session: a new wakeup
 * supersedes pending ones, stop:true cancels them. If an iteration ends
 * without rescheduling, onTurnEnd() drops in a ~20-minute fallback wakeup; a
 * second dropped iteration ends the loop. An aborted (Esc) iteration ends it.
 */
import { cronToHuman } from "./cron.js";
import { taskFireTimeMs } from "./jitter.js";
import { resolveDefaultLoopPromptSync } from "./loop-prompt.js";
import { getAllTasks, getTask, record, generateTaskId, type AppendEntry } from "./store.js";
import {
  AUTONOMOUS_LOOP_SENTINEL, DEFAULT_LOOP_PROMPT, isWakeupTask,
  type LoopConfig, type LoopTask,
} from "./types.js";

const DEBUG = !!process.env.PI_LOOP_DEBUG;
const debug = (...a: unknown[]) => DEBUG && console.debug("[pi-loop:scheduler]", ...a);

/** A fire whose run hasn't started yet blocks further fires for at most this long. */
const RUN_START_GRACE_MS = 15_000;

export const DYNAMIC_ITERATION_SUFFIX =
  "\n\n[pi-loop: dynamic /loop iteration. After completing this iteration, call " +
  "schedule_wakeup to arm the next wake-up (omit `prompt` — the loop prompt is carried " +
  "over automatically), or schedule_wakeup with stop:true to end the loop.]";

interface PiLike {
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void;
  sendMessage?(
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  getCommands?: () => { name: string; source: "extension" | "prompt" | "skill" }[];
}
interface CtxLike {
  hasUI: boolean;
  cwd?: string;
  isIdle?: () => boolean;
  ui?: {
    notify(msg: string, level: "info" | "warning" | "error"): void;
    setStatus(key: string, text?: string): void;
  };
}

/** Slash-command names built into pi itself — fired loops receive these as plain text. */
const BUILTIN_COMMANDS = new Set([
  "settings", "model", "tree", "thinking", "scoped-models", "export", "import",
  "share", "bug", "copy", "name", "session", "changelog", "hotkeys", "fork",
  "clone", "trust", "login", "logout", "new", "compact", "resume", "reload", "quit",
]);

interface PendingLoop {
  prompt: string;
  root: number;
  isFallback: boolean;
}

export class LoopScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private pendingFires: string[] = [];
  private busy = false; // mirror of agent_start/agent_settled; ctx.isIdle() is checked first
  /** Set when we sent a prompt whose run hasn't started yet — prevents back-to-back fires. */
  private awaitingRunSince: number | null = null;
  /** loopPrompt of the wakeup(s) that fired this turn — claimed by the next schedule_wakeup call. */
  private pendingLoop: PendingLoop[] = [];
  private lastTurnFiredWakeup = false;
  /** loop.md content last delivered in full — later unchanged fires get a short reminder. */
  private deliveredDefault: string | null = null;

  constructor(
    private pi: PiLike,
    private config: LoopConfig,
    private appendEntry: AppendEntry | undefined,
  ) {}

  private ctx: CtxLike | null = null;
  setContext(ctx: CtxLike) {
    this.ctx = ctx;
  }
  start() {
    if (this.interval) return;
    this.interval = setInterval(() => this.check(), this.config.checkIntervalMs);
  }
  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  onAgentStart() {
    this.busy = true;
    this.awaitingRunSince = null;
  }
  /** pi fully settled (no retry/compaction/queued continuation will run). */
  onAgentSettled(aborted = false) {
    this.busy = false;
    this.awaitingRunSince = null;
    this.onTurnEnd(aborted);
    this.drainPendingFires();
  }
  /** Back-compat aliases used by tests. */
  setBusy() {
    this.onAgentStart();
  }
  setIdle() {
    this.onAgentSettled(false);
  }

  private isIdle(): boolean {
    if (this.awaitingRunSince != null) {
      if (Date.now() - this.awaitingRunSince < RUN_START_GRACE_MS) return false;
      this.awaitingRunSince = null; // the run never started (command handled, send failed)
    }
    if (this.ctx?.isIdle) return this.ctx.isIdle() && !this.busy;
    return !this.busy;
  }

  check() {
    const now = Date.now();
    for (const task of getAllTasks()) {
      if (!this.shouldFire(task, now)) continue;
      if (!this.isIdle()) {
        if (!this.pendingFires.includes(task.id)) this.pendingFires.push(task.id);
      } else {
        this.fire(task);
      }
    }
  }

  shouldFire(task: LoopTask, now: number): boolean {
    if (task.cancelled) return false;
    const fireTime = taskFireTimeMs(task, this.config);
    return fireTime !== null && now >= fireTime;
  }

  /** Next fire time for display (jitter included). */
  nextFireTime(task: LoopTask): number | null {
    return taskFireTimeMs(task, this.config);
  }

  // ---------- prompt expansion & dispatch ----------

  /** Forget delivered loop.md content (after compaction or branch navigation). */
  resetPromptCache() {
    this.deliveredDefault = null;
  }

  /**
   * Expand the default-prompt marker: the loop.md contents in full on first
   * delivery or after an edit, a short reminder on unchanged later fires
   * (the full text is already in context). The built-in prompt is short and
   * always sent in full.
   */
  expandPrompt(prompt: string): string {
    if (prompt !== DEFAULT_LOOP_PROMPT) return prompt;
    const resolved = resolveDefaultLoopPromptSync(this.ctx?.cwd ?? process.cwd());
    if (!resolved.path) return resolved.prompt;
    if (this.deliveredDefault === resolved.prompt) {
      return (
        `# /loop tick — loop tasks from ${resolved.source} (unchanged)\n` +
        `Work the loop tasks from ${resolved.source} established earlier in this conversation. ` +
        `If you cannot find them, read ${resolved.path} first.`
      );
    }
    this.deliveredDefault = resolved.prompt;
    return `## Loop tasks (from ${resolved.source})\n\n${resolved.prompt}`;
  }

  /**
   * Send a prompt. Slash commands that pi can't invoke autonomously (built-ins
   * like /model, unknown commands) degrade to plain text; registered
   * extension/skill/prompt commands get expandPromptTemplates. Always queued
   * as followUp so a run that started meanwhile never makes the send throw.
   */
  send(prompt: string): void {
    const m = prompt.match(/^\/([A-Za-z0-9_:-]+)/);
    if (!m) {
      this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      return;
    }
    const name = m[1];
    if (BUILTIN_COMMANDS.has(name) || name === "loop" || name === "loop-list" || name === "loop-kill") {
      debug("send:", `/${name} is not invocable autonomously → plain text`);
      this.pi.sendUserMessage(`[pi-loop: scheduled slash command arrived as text] ${prompt}`, { deliverAs: "followUp" });
      return;
    }
    const known = this.pi.getCommands?.().some((c) => c.name === name) ?? false;
    if (known) {
      this.pi.sendUserMessage(prompt, { deliverAs: "followUp", expandPromptTemplates: true });
    } else {
      debug("send:", `/${name} not a registered command → plain text`);
      this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    }
  }

  /** Context-only notice for the model's next turn (no turn is triggered). */
  notifyModel(content: string): void {
    if (this.pi.sendMessage) {
      this.pi.sendMessage({ customType: "pi-loop-notice", content, display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
    } else {
      this.ctx?.ui?.notify(content, "warning");
    }
  }

  fire(task: LoopTask) {
    debug("fire:", task.id, task.prompt.slice(0, 40));
    if (this.ctx?.hasUI) {
      const label = task.label || task.prompt.slice(0, 40);
      this.ctx.ui?.notify(`Loop firing: ${label}`, "info");
    }

    const isWakeup = isWakeupTask(task);
    if (isWakeup && task.prompt === AUTONOMOUS_LOOP_SENTINEL) {
      if (!task.loopPrompt) {
        // A chained wakeup without a loop prompt has nothing to say — drop it.
        record(this.appendEntry, "cancelled", task);
        this.updateStatus();
        return;
      }
      this.send(this.expandPrompt(task.loopPrompt) + DYNAMIC_ITERATION_SUFFIX);
      this.pendingLoop.push({ prompt: task.loopPrompt, root: task.loopRoot ?? task.createdAt, isFallback: !!task.isFallback });
      this.lastTurnFiredWakeup = true;
    } else {
      this.send(this.expandPrompt(task.prompt));
      if (isWakeup) this.lastTurnFiredWakeup = true;
    }
    task.lastFiredAt = Date.now();
    this.awaitingRunSince = task.lastFiredAt;

    // Recurring tasks expire at recurringMaxAgeMs (fires one final time then deletes).
    // Wakeup chains carry loopRoot so the same expiry applies to a dynamic loop.
    if ((task.recurring || (isWakeup && task.loopRoot != null)) && this.isAgedOut(task)) {
      debug("fire:", task.id, "aged out, removing after final fire");
      record(this.appendEntry, "cancelled", task);
      this.ctx?.ui?.notify(`Loop ${task.id} expired`, "warning");
    } else {
      record(this.appendEntry, "fired", task);
    }
    this.updateStatus();
  }

  // ---------- dynamic-loop bookkeeping ----------

  /** Claim the loop identity for a wakeup fired this turn (called by schedule_wakeup). */
  takePendingLoop(): PendingLoop | null {
    return this.pendingLoop.shift() ?? null;
  }

  /**
   * Seed a pending loop without a fired task — used by /loop (dynamic) so the
   * first schedule_wakeup call of the turn inherits prompt + root directly.
   */
  seedPendingLoop(prompt: string, root: number): void {
    this.pendingLoop.push({ prompt, root, isFallback: false });
    this.lastTurnFiredWakeup = true; // treat like a fired iteration for onTurnEnd bookkeeping
  }

  /** Start a dynamic loop — one per session, so any running one is replaced. */
  startDynamicLoop(prompt: string, root: number): number {
    const replaced = this.stopDynamicLoop();
    this.seedPendingLoop(prompt, root);
    return replaced;
  }

  /** Peek without consuming — lets schedule_wakeup distinguish "continue" vs "new". */
  peekPendingLoop(): PendingLoop | null {
    return this.pendingLoop[0] ?? null;
  }

  /** Drop pending-loop state when a loop is killed. */
  clearPendingLoop(_id?: string): void {
    this.pendingLoop.splice(0);
    this.lastTurnFiredWakeup = false;
  }

  /** Cancel every armed wakeup (the dynamic loop's timers). Returns how many. */
  cancelLoopWakeups(): number {
    const wakeups = getAllTasks().filter(isWakeupTask);
    for (const t of wakeups) record(this.appendEntry, "cancelled", t);
    if (wakeups.length) this.updateStatus();
    return wakeups.length;
  }

  /** End the dynamic loop: cancel pending wakeups and forget the in-flight iteration. */
  stopDynamicLoop(): number {
    const n = this.cancelLoopWakeups();
    this.clearPendingLoop();
    return n;
  }

  /** Forget per-branch runtime state (branch navigation / session switch). */
  resetRuntimeState(): void {
    this.pendingFires.splice(0);
    this.clearPendingLoop();
    this.resetPromptCache();
  }

  /** 7-day check on a loop root timestamp — schedule_wakeup consults this before arming. */
  isRootAgedOut(root: number): boolean {
    if (this.config.recurringMaxAgeMs <= 0) return false;
    return Date.now() - root >= this.config.recurringMaxAgeMs;
  }

  /**
   * After a resume, an overdue /loop task restarts its cadence from now
   * instead of firing a catch-up run (Claude Code resurrects session crons the
   * same way). Recurring tasks past their max age are dropped.
   */
  rebaseRestoredTasks(now = Date.now()): void {
    for (const t of getAllTasks()) {
      if (!t.recurring) continue;
      if (this.isAgedOut(t, now)) {
        record(this.appendEntry, "cancelled", t);
        continue;
      }
      if (!t.fromLoop) continue;
      const next = taskFireTimeMs(t, this.config);
      if (next !== null && next < now) t.lastFiredAt = now;
    }
  }

  /**
   * Turn ended. If a wakeup fired this turn but the model never rescheduled,
   * arm one ~20-minute fallback wakeup carrying the same loop prompt. If the
   * dropped iteration was itself the fallback, let the loop end. If the user
   * aborted the iteration, end the loop.
   */
  private onTurnEnd(aborted: boolean) {
    if (!this.lastTurnFiredWakeup) return;
    this.lastTurnFiredWakeup = false;
    const pending = this.pendingLoop.splice(0);

    if (aborted) {
      const n = this.cancelLoopWakeups();
      debug("iteration aborted — dynamic loop ended,", n, "wakeup(s) cancelled");
      this.ctx?.ui?.notify("pi-loop: dynamic loop ended (iteration aborted). Restart it with /loop.", "info");
      this.updateStatus();
      return;
    }
    // A wakeup armed this turn (e.g. for a superseding loop) already carries the loop on.
    if (pending.length === 0 || getAllTasks().some(isWakeupTask)) return;

    const p = pending[pending.length - 1];
    if (p.isFallback) {
      debug("fallback iteration ended without rescheduling — loop ends");
      this.ctx?.ui?.notify("pi-loop: dynamic loop ended (no reschedule after fallback)", "info");
      return;
    }
    const fireAt = Date.now() + this.config.dynamicFallbackMs;
    const task: LoopTask = {
      id: generateTaskId(),
      cron: `_wakeup_${fireAt}`,
      prompt: AUTONOMOUS_LOOP_SENTINEL,
      createdAt: Date.now(),
      nextFireTime: fireAt,
      recurring: false,
      durable: false,
      label: "wakeup: fallback",
      loopPrompt: p.prompt,
      loopRoot: p.root,
      isFallback: true,
    };
    record(this.appendEntry, "created", task);
    this.ctx?.ui?.notify(
      `pi-loop: no reschedule this turn — fallback wakeup armed for ${new Date(fireAt).toLocaleTimeString()}`,
      "info",
    );
    debug("armed fallback wakeup", task.id, "for loop:", p.prompt.slice(0, 40));
    this.updateStatus();
  }

  // ------------------------------------------------

  private drainPendingFires() {
    const ids = this.pendingFires.splice(0);
    const now = Date.now();
    for (const id of ids) {
      const task = getTask(id);
      // Re-check: the task may have been cancelled or already fired meanwhile.
      if (!task || !this.shouldFire(task, now)) continue;
      if (!this.isIdle()) {
        this.pendingFires.push(id); // the next settle (or tick) picks it up
        continue;
      }
      this.fire(task);
    }
  }

  private isAgedOut(task: LoopTask, now = Date.now()): boolean {
    if (this.config.recurringMaxAgeMs <= 0) return false;
    const root = task.loopRoot ?? task.createdAt;
    return now - root >= this.config.recurringMaxAgeMs;
  }

  /** Age check for non-recurring tasks (wakeup chains) — consulted at schedule time. */
  isLoopAgedOut(task: LoopTask): boolean {
    return this.isAgedOut(task);
  }

  updateStatus() {
    if (!this.ctx?.hasUI) return;
    const count = getAllTasks().length;
    this.ctx.ui?.setStatus(
      "pi-loop",
      count > 0 ? `${count} loop${count === 1 ? "" : "s"} active` : undefined,
    );
  }
  refreshStatus() {
    this.updateStatus();
  }
}

export { cronToHuman };
