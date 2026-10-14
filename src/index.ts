/**
 * pi-loop — recurring prompt execution and cron scheduling for pi 1.2.0+.
 *
 * Rebuilt on pi's durable session-entry architecture (pi.appendEntry):
 *   state is an append-only `pi-loop-task` event log inside the session file,
 *   replayed from the active branch on session_start and session_tree.
 *
 * Registers:
 *   /loop, /loop-list, /loop-kill   — slash commands
 *   cron_create / cron_delete / cron_list, schedule_wakeup — LLM tools
 *   LoopScheduler                    — 1s tick, idle-gated fires
 *
 * PI_LOOP_DISABLE=1 disables the extension entirely.
 */
import { intervalToCron, cronToHuman } from "./cron.js";
import { parseLoopArgs } from "./parse-args.js";
import { LoopScheduler } from "./scheduler.js";
import {
  getAllTasks, getTask, getTaskCount, generateTaskId, record, clearAllTasks,
  restoreFromEntries, type AppendEntry, type RestoreResult,
} from "./store.js";
import { registerCronTools, persistenceLabel } from "./tools/cron-tools.js";
import { registerWakeupTool } from "./schedule-wakeup.js";
import {
  DEFAULT_CONFIG, DEFAULT_LOOP_PROMPT, displayPrompt, isWakeupTask,
  type LoopTask, type LoopConfig,
} from "./types.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DEBUG = !!process.env.PI_LOOP_DEBUG;
const debug = (...a: unknown[]) => DEBUG && console.debug("[pi-loop]", ...a);

const DISABLED = process.env.PI_LOOP_DISABLE === "1" || process.env.PI_LOOP_DISABLE === "true";

const DYNAMIC_LOOP_SUFFIX =
  "\n\n[pi-loop: This is a dynamic /loop. After completing this iteration, call " +
  "schedule_wakeup to arm the next wake-up (omit `prompt` — the loop prompt is carried " +
  "over automatically). Choose your delay based on the task: 60-270s for active work, " +
  "1200-1800s for idle monitoring. Call schedule_wakeup with stop:true to end the loop.]";

async function loadProjectConfig(cwd: string): Promise<LoopConfig> {
  try {
    const raw = await readFile(join(cwd, ".pi-loop.config.json"), "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Entries of the active branch — abandoned branches are alternative histories. */
function branchEntries(ctx: any): unknown[] {
  const sm = ctx.sessionManager;
  return sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
}

const scheduleLabel = (t: LoopTask) => (isWakeupTask(t) ? "wake-up" : cronToHuman(t.cron));

// `pi` here is the ExtensionAPI; types come from @earendil-works/pi-coding-agent.
// Declared loosely to keep the extension self-contained.
export default function piLoop(pi: any) {
  if (DISABLED) {
    console.debug("[pi-loop] PI_LOOP_DISABLE set — extension inactive");
    return;
  }

  let config: LoopConfig = { ...DEFAULT_CONFIG };
  let scheduler: LoopScheduler | null = null;

  // Append a durable lifecycle entry into the session tree.
  const appendEntry: AppendEntry = (customType, data) => {
    try {
      pi.appendEntry(customType, data);
    } catch (e) {
      debug("appendEntry unavailable:", e);
    }
  };

  /** Record cancellation of tasks the replay dropped, and surface them. */
  const handleRestored = (ctx: any, { missed, expiredWakeups }: RestoreResult) => {
    for (const t of [...missed, ...expiredWakeups]) record(appendEntry, "cancelled", t);

    if (expiredWakeups.length > 0) {
      const due = new Date(Math.max(...expiredWakeups.map((t) => t.nextFireTime ?? 0))).toLocaleString();
      ctx.hasUI && ctx.ui.notify(`pi-loop: the dynamic loop's wake-up was due at ${due} while pi was closed — loop stopped`, "warning");
      scheduler?.notifyModel(
        `[pi-loop] This session resumed after its next dynamic /loop wake-up was due (${due}), so that ` +
          `wake-up will not fire and the dynamic loop is stopped. Call schedule_wakeup again only if the ` +
          `loop is still wanted; when the conversation does not make that clear, ask the user first.`,
      );
    }

    if (missed.length > 0) {
      ctx.hasUI && ctx.ui.notify(`pi-loop: ${missed.length} one-shot task(s) were missed while pi was closed`, "warning");
      const lines = missed.map(
        (t) => `- [${t.id}] scheduled for ${new Date(t.nextFireTime ?? t.createdAt).toLocaleString()}: ${displayPrompt(t)}`,
      );
      // Like Claude Code: never run a stale prompt unattended — ask first.
      pi.sendUserMessage(
        `[pi-loop] The following one-shot scheduled task${missed.length === 1 ? " was" : "s were"} missed while ` +
          `this session was not running. ${missed.length === 1 ? "It has" : "They have"} already been removed from the schedule.\n\n` +
          `${lines.join("\n")}\n\n` +
          `Do NOT execute ${missed.length === 1 ? "this prompt" : "these prompts"} yet. First ask the user ` +
          `(use the ask_user tool if it is available) whether to run ${missed.length === 1 ? "it" : "each one"} now. ` +
          `Only execute if the user confirms.`,
        { deliverAs: "followUp" },
      );
    }
  };

  const replayBranch = (ctx: any): number => {
    const result = restoreFromEntries(branchEntries(ctx));
    handleRestored(ctx, result);
    scheduler?.rebaseRestoredTasks();
    scheduler?.refreshStatus();
    debug("replayed branch →", result.restored, "tasks,", result.missed.length, "missed,", result.expiredWakeups.length, "expired wakeups");
    return getAllTasks().length;
  };

  // ---------- /loop ----------
  pi.registerCommand("loop", {
    description:
      "Run a prompt on a recurring interval (e.g. /loop 5m check the deploy). " +
      "No interval = dynamic self-pacing. No prompt = loop.md or the built-in maintenance prompt.",
    getArgumentCompletions(prefix: string) {
      const suggestions = ["5m ", "10m ", "15m ", "30m ", "1h ", "2h "];
      return suggestions
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s.trim() }));
    },
    async handler(args: string, ctx: any) {
      if (!scheduler) return;
      const parsed = parseLoopArgs(args);

      // Explicit prompt, or the default marker — resolved (loop.md / built-in) at every fire.
      const prompt = parsed.prompt ?? DEFAULT_LOOP_PROMPT;
      const promptSource = parsed.prompt ? "your prompt" : "default prompt (loop.md / built-in)";

      if (parsed.interval === null) {
        // Dynamic self-pacing — the model drives cadence via schedule_wakeup.
        // One dynamic loop per session: a running one is replaced.
        const replaced = scheduler.startDynamicLoop(prompt, Date.now());
        ctx.hasUI && ctx.ui.notify(
          `Loop started (dynamic pacing, ${promptSource}): ${displayPrompt({ prompt } as LoopTask).slice(0, 80)}\n` +
            (replaced > 0 ? "Replaced the previously running dynamic loop.\n" : "") +
            `The agent will self-pace via schedule_wakeup. Cancel: /loop-kill`,
          "info",
        );
        scheduler.send(scheduler.expandPrompt(prompt) + DYNAMIC_LOOP_SUFFIX);
        return;
      }

      const conv = intervalToCron(parsed.interval);
      if (!conv) {
        ctx.hasUI && ctx.ui.notify(`Invalid interval: "${parsed.interval}". Use 5s, 10m, 2h, 1d`, "error");
        return;
      }
      if (getTaskCount() >= config.maxJobs) {
        ctx.hasUI && ctx.ui.notify(`Maximum of ${config.maxJobs} loops reached. /loop-kill to remove some.`, "error");
        return;
      }

      // /loop tasks are session work, journaled so a resumed session gets them back.
      const task: LoopTask = {
        id: generateTaskId(),
        cron: conv.cron,
        prompt,
        createdAt: Date.now(),
        recurring: true,
        durable: false,
        fromLoop: true,
      };
      record(appendEntry, "created", task);
      scheduler.refreshStatus();

      const human = cronToHuman(conv.cron);
      const nextRun = scheduler.nextFireTime(task);
      const nextStr = nextRun ? new Date(nextRun).toLocaleString() : "soon";
      ctx.hasUI && ctx.ui.notify(
        `Loop ${task.id} created: ${human}` +
          (conv.rounded ? ` — interval rounded to ${conv.rounded}` : "") +
          `\nNext fire: ${nextStr}\nCancel: /loop-kill ${task.id}`,
        "info",
      );
      scheduler.send(scheduler.expandPrompt(prompt));
    },
  });

  // ---------- /loop-list ----------
  pi.registerCommand("loop-list", {
    description: "List all active loop tasks",
    async handler(_args: string, ctx: any) {
      const tasks = getAllTasks();
      if (tasks.length === 0) {
        ctx.hasUI && ctx.ui.notify("No active loops. /loop <interval> <prompt> to start one.", "info");
        return;
      }
      const lines = tasks.map((t) => {
        const human = isWakeupTask(t) ? "wake-up timer" : cronToHuman(t.cron);
        const next = scheduler?.nextFireTime(t);
        const nextStr = next ? new Date(next).toLocaleString() : "unknown";
        const flags = [t.recurring ? "recurring" : "one-shot", persistenceLabel(t)].join(", ");
        return `  [${t.id}] ${human} — ${displayPrompt(t).slice(0, 50)} (next: ${nextStr}, ${flags})`;
      });
      ctx.hasUI && ctx.ui.notify(`${tasks.length} active loop${tasks.length === 1 ? "" : "s"}:\n${lines.join("\n")}`, "info");
    },
  });

  // ---------- /loop-kill ----------
  pi.registerCommand("loop-kill", {
    description: "Cancel loop(s): /loop-kill <id|label|all>. Use /loop-list to see active loops.",
    getArgumentCompletions(prefix: string) {
      const out: { value: string; label: string }[] = [];
      if ("all".startsWith(prefix)) out.push({ value: "all", label: "all — cancel every active loop" });
      for (const t of getAllTasks()) {
        if (t.id.startsWith(prefix)) out.push({ value: t.id, label: `${t.id} — ${scheduleLabel(t)}: ${displayPrompt(t).slice(0, 30)}` });
      }
      return out;
    },
    async handler(args: string, ctx: any) {
      const input = args.trim();
      const notify = (m: string, l: "info" | "warning" | "error") => ctx.hasUI && ctx.ui.notify(m, l);
      const cancel = (t: LoopTask) => {
        record(appendEntry, "cancelled", t);
        if (isWakeupTask(t)) scheduler?.clearPendingLoop(t.id);
        scheduler?.refreshStatus();
      };
      if (!input) {
        notify("Usage: /loop-kill <id|label|all>\n\n  /loop-kill all     — cancel all loops\n  /loop-kill abc123  — by ID\n  /loop-kill deploy  — by label/prompt match\n\nUse /loop-list to see active loops.", "warning");
        return;
      }
      if (input === "all") {
        const all = getAllTasks();
        if (all.length === 0) return notify("No active loops to cancel.", "info");
        const count = all.length;
        for (const t of all) record(appendEntry, "cancelled", t);
        scheduler?.clearPendingLoop();
        scheduler?.refreshStatus();
        notify(`Cancelled ${count} loop${count === 1 ? "" : "s"}.`, "info");
        return;
      }
      const exact = getTask(input);
      if (exact) {
        cancel(exact);
        const label = exact.label ? ` (${exact.label})` : "";
        notify(`Cancelled [${input}]${label} — ${displayPrompt(exact).slice(0, 40)}`, "info");
        return;
      }
      const q = input.toLowerCase();
      const matches = getAllTasks().filter((t) => {
        const label = (t.label ?? "").toLowerCase();
        const prompt = displayPrompt(t).toLowerCase();
        const human = scheduleLabel(t).toLowerCase();
        return label.includes(q) || prompt.includes(q) || human.includes(q);
      });
      if (matches.length === 0) {
        notify(`No loops matching "${input}". /loop-list to see active loops.`, "error");
        return;
      }
      if (matches.length === 1) {
        cancel(matches[0]);
        notify(`Cancelled [${matches[0].id}] — ${displayPrompt(matches[0]).slice(0, 40)}`, "info");
        return;
      }
      const lines = matches.map((t) => `  [${t.id}] ${scheduleLabel(t)} — ${displayPrompt(t).slice(0, 40)}`);
      notify(`${matches.length} loops match "${input}":\n${lines.join("\n")}\n\n/loop-kill <id> to cancel one, /loop-kill all to cancel everything.`, "warning");
    },
  });

  // ---------- lifecycle ----------
  pi.on("session_start", async (_event: unknown, ctx: any) => {
    // pi caches this module across /new, /resume and /fork — start from a clean slate.
    scheduler?.stop();
    clearAllTasks();
    config = await loadProjectConfig(ctx.cwd);
    scheduler = new LoopScheduler(pi, config, appendEntry);
    scheduler.setContext(ctx);

    registerCronTools(pi, scheduler, config, appendEntry);
    registerWakeupTool(pi, appendEntry, scheduler, config);

    const restored = replayBranch(ctx);
    scheduler.start();
    if (ctx.hasUI && restored > 0) {
      ctx.ui.notify(`pi-loop: ${restored} task${restored === 1 ? "" : "s"} restored from session`, "info");
    }
  });

  // Navigating the session tree switches to another history: rebuild from that branch.
  pi.on("session_tree", async (_event: unknown, ctx: any) => {
    if (!scheduler) return;
    scheduler.resetRuntimeState();
    replayBranch(ctx);
  });

  // Compaction drops the full loop.md text from context — deliver it in full again.
  pi.on("session_compact", () => scheduler?.resetPromptCache());

  pi.on("session_shutdown", async () => {
    scheduler?.stop();
    scheduler = null;
    // Session-only tasks die here; journaled ones are replayed from the session file.
    clearAllTasks();
  });

  // Idle gate. agent_settled (not agent_end) is the point where pi will not
  // continue on its own, and it reports whether the run was aborted (Esc).
  pi.on("agent_start", () => scheduler?.onAgentStart());
  pi.on("agent_settled", (event: { aborted?: boolean }) => scheduler?.onAgentSettled(!!event?.aborted));
}
