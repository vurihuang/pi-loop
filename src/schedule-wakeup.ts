/**
 * schedule_wakeup — dynamic self-pacing for /loop without an interval.
 * The model picks its own delay each turn; the timer is a one-shot task with a
 * `_wakeup_<ms>` sentinel cron, journaled so it is re-armed on resume.
 * `stop: true` cancels every pending wakeup and ends the dynamic loop.
 *
 * One dynamic loop per session: arming a wakeup supersedes pending ones.
 * Loop chaining: inside an iteration started by a fired wakeup (or by /loop),
 * the scheduler's takePendingLoop() hands over the loop's prompt and root
 * timestamp, so the chain stays one logical loop (7-day expiry and
 * /loop-kill by prompt keep working).
 */
import { Type } from "@sinclair/typebox";
import { parseLoopArgs } from "./parse-args.js";
import { CACHE_WINDOW_MS } from "./jitter.js";
import { generateTaskId, getAllTasks, record, type AppendEntry } from "./store.js";
import {
  AUTONOMOUS_LOOP_SENTINEL, DEFAULT_LOOP_PROMPT, WAKEUP_PREFIX, isWakeupTask,
  type LoopConfig, type LoopTask,
} from "./types.js";
import type { LoopScheduler } from "./scheduler.js";

const MIN_DELAY_SECONDS = 60;
const MAX_DELAY_SECONDS = 3600;

/** Sentinels models trained on Claude Code pass; all mean "the current loop prompt". */
const LOOP_SENTINELS = new Set([
  AUTONOMOUS_LOOP_SENTINEL, "<<autonomous-loop>>", "<<loop.md>>", "<<loop.md-dynamic>>", DEFAULT_LOOP_PROMPT,
]);
const CURRENT_LOOP = Symbol("current-loop");

/**
 * Normalize the model-supplied prompt. A sentinel or a bare `/loop` means the
 * current loop prompt; `/loop <args>` is reduced to its prompt part, because
 * pi's /loop is a code command that a fired prompt cannot re-enter.
 */
export function normalizeWakeupPrompt(raw: unknown): string | typeof CURRENT_LOOP | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  if (LOOP_SENTINELS.has(text)) return CURRENT_LOOP;
  const loop = text.match(/^\/loop(?:\s+([\s\S]*))?$/);
  if (loop) return parseLoopArgs(loop[1] ?? "").prompt ?? CURRENT_LOOP;
  return text;
}

/**
 * Clamp the delay and pick the fire time: round up to a whole minute, and for
 * short delays (≤ 5 min) pull back so the wake-up lands inside the prompt-cache
 * window (mirrors Claude Code).
 */
export function computeWakeupTime(delaySeconds: number, cacheLeadMs: number, now = Date.now()) {
  const requested = Number.isNaN(delaySeconds) ? MIN_DELAY_SECONDS : Math.round(delaySeconds);
  const clamped = Math.max(MIN_DELAY_SECONDS, Math.min(MAX_DELAY_SECONDS, Number.isFinite(requested) ? requested : MAX_DELAY_SECONDS));
  let fireAt = Math.ceil((now + clamped * 1000) / 60000) * 60000;
  if (cacheLeadMs > 0 && clamped * 1000 <= CACHE_WINDOW_MS) {
    const maxGap = CACHE_WINDOW_MS - cacheLeadMs;
    while (fireAt - now > maxGap && fireAt - 60000 >= now + MIN_DELAY_SECONDS * 1000) fireAt -= 60000;
  }
  return { clamped, wasClamped: clamped !== delaySeconds, fireAt };
}

const WakeupSchema = Type.Object({
  delaySeconds: Type.Optional(Type.Number({
    description:
      "Seconds from now to wake up. Clamped to [60, 3600]. " +
      "Recommended: 1200-1800 for idle ticks (avoids burning the 5-min prompt cache). " +
      "Use 60-270 only for active work where cache stays warm. Omit when stop is true.",
  })),
  reason: Type.Optional(Type.String({ description: "One short sentence explaining the chosen delay (or the stop). Shown to the user." })),
  prompt: Type.Optional(Type.String({
    description:
      "Inside a dynamic /loop: omit it — the running loop's prompt is carried over automatically. " +
      "Pass a prompt only to arm a self-paced wake-up outside a loop. A leading `/loop ` or the " +
      "`<<autonomous-loop-dynamic>>` sentinel is accepted and means the current loop prompt.",
  })),
  stop: Type.Optional(Type.Boolean({
    description: "true = end the dynamic loop now: cancels every pending wake-up. Other fields are ignored.",
  })),
});

interface PiLike {
  registerTool(tool: unknown): void;
}

const result = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

export function registerWakeupTool(
  pi: PiLike,
  appendEntry: AppendEntry | undefined,
  scheduler: LoopScheduler,
  config?: Pick<LoopConfig, "cacheLeadMs">,
): void {
  pi.registerTool({
    name: "schedule_wakeup",
    label: "Schedule Wake-up",
    description:
      "Schedule a single-shot timer to fire after a delay, or stop a dynamic /loop. For dynamic " +
      "self-pacing: the model chooses its own delay each turn (60-3600 seconds), calls this tool to " +
      "arm the timer, and on wake-up decides whether to continue (call again), or stop (stop:true). " +
      "Only one wake-up is pending at a time — a new call replaces the previous one. " +
      "Unlike cron_create (fixed schedule), this gives the model full control over pacing.\n\n" +
      "Cache guidance: prompt cache has a ~5-minute TTL. Sleeping past 300s means the next wake-up " +
      "reads full context uncached. For idle ticks prefer 1200-1800s; avoid exactly 300s.",
    parameters: WakeupSchema,
    promptSnippet: "schedule_wakeup — arm a single-shot timer for dynamic self-pacing, or stop a loop",
    async execute(_id: string, params: any) {
      if (params.stop) {
        const cancelled = scheduler.stopDynamicLoop();
        return result(
          (cancelled > 0
            ? `Dynamic loop stopped — cancelled ${cancelled} pending wake-up${cancelled === 1 ? "" : "s"}.`
            : "Dynamic loop stopped — there was no pending wake-up to cancel.") +
            (params.reason ? ` Reason: ${params.reason}` : "") +
            " A fixed-interval /loop is not affected; cancel it with cron_delete or /loop-kill.",
        );
      }

      const delaySeconds = params.delaySeconds;
      if (delaySeconds == null) {
        return result("delaySeconds is required unless stop is true.");
      }

      // Inherit the running loop's identity when called inside a loop iteration.
      const inherited = scheduler.takePendingLoop();
      const pendingWakeups = getAllTasks().filter(isWakeupTask);
      const running = pendingWakeups.find((t) => t.loopPrompt)?.loopPrompt;
      const normalized = normalizeWakeupPrompt(params.prompt);
      const loopPrompt =
        normalized === CURRENT_LOOP
          ? inherited?.prompt ?? running ?? DEFAULT_LOOP_PROMPT
          : normalized ?? inherited?.prompt ?? running;
      if (!loopPrompt) {
        return result("prompt is required when no dynamic /loop is running — pass the prompt to fire on wake-up.");
      }
      // Re-pacing an already-armed loop keeps its root so the 7-day expiry still applies.
      const prior = pendingWakeups.find((t) => t.loopPrompt === loopPrompt);
      const root = inherited?.root ?? prior?.loopRoot ?? Date.now();

      // 7-day expiry on the loop as a whole — a self-paced chain is still one loop.
      if (scheduler.isRootAgedOut(root)) {
        scheduler.stopDynamicLoop();
        return result(`Loop has reached its 7-day expiry — not rescheduling; the loop has ended. Start a new /loop to continue.`);
      }

      const superseded = scheduler.cancelLoopWakeups();
      const { wasClamped, fireAt } = computeWakeupTime(delaySeconds, config?.cacheLeadMs ?? 15_000);
      const task: LoopTask = {
        id: generateTaskId(),
        cron: `${WAKEUP_PREFIX}${fireAt}`,
        prompt: AUTONOMOUS_LOOP_SENTINEL,
        createdAt: Date.now(),
        nextFireTime: fireAt,
        recurring: false,
        durable: false,
        label: `wakeup: ${params.reason ?? "self-paced"}`,
        loopPrompt,
        loopRoot: root,
      };
      record(appendEntry, "created", task);
      scheduler.refreshStatus();
      const inSeconds = Math.max(0, Math.round((fireAt - Date.now()) / 1000));
      return result([
        `Wake-up scheduled.`,
        `  ID: ${task.id}`,
        `  Fires at: ${new Date(fireAt).toLocaleString()} (in ${inSeconds}s)`,
        params.reason ? `  Reason: ${params.reason}` : "",
        wasClamped ? `  (Clamped from ${delaySeconds}s to [${MIN_DELAY_SECONDS}, ${MAX_DELAY_SECONDS}])` : "",
        superseded > 0 ? `  (Replaced ${superseded} previously pending wake-up${superseded === 1 ? "" : "s"})` : "",
        inherited?.isFallback
          ? `  (This was the fallback wakeup — if the next iteration also doesn't reschedule, the loop ends.)`
          : "",
        `Now end the turn. Cancel with: schedule_wakeup { stop: true } or /loop-kill ${task.id}`,
      ].filter(Boolean).join("\n"));
    },
  });
}
