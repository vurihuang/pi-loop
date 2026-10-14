/**
 * LLM-callable tools: cron_create, cron_delete, cron_list.
 * State changes go through store.record() → appendEntry (durable) or memory (session).
 */
import { Type } from "@sinclair/typebox";
import { parseCronExpression, nextCronRunMs, cronToHuman } from "../cron.js";
import {
  getAllTasks,
  getTask,
  getTaskCount,
  generateTaskId,
  isJournaled,
  record,
  type AppendEntry,
} from "../store.js";
import { WAKEUP_PREFIX, displayPrompt, isWakeupTask, type LoopConfig, type LoopTask } from "../types.js";
import type { LoopScheduler } from "../scheduler.js";

interface PiLike {
  registerTool(tool: unknown): void;
}

/** Persistence flag shown in listings. */
export function persistenceLabel(t: LoopTask): string {
  return t.durable ? "durable" : isJournaled(t) ? "restored on resume" : "session-only";
}

const result = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

export function registerCronTools(
  pi: PiLike,
  scheduler: LoopScheduler,
  config: LoopConfig,
  appendEntry: AppendEntry | undefined,
): void {
  // --- cron_create ---
  pi.registerTool({
    name: "cron_create",
    label: "Create Scheduled Task",
    description:
      "Schedule a prompt to run at a future time, either recurring on a cron schedule or once at a specific time. " +
      "The cron field uses standard 5-field format (minute hour day-of-month month day-of-week) in local time. " +
      "Examples: '*/5 * * * *' = every 5 minutes, '0 */2 * * *' = every 2 hours, '30 14 * * *' = daily at 2:30 PM. " +
      "durable=true persists the task inside this session's file so it survives closing and resuming this session.",
    parameters: Type.Object({
      cron: Type.String({ description: "5-field cron expression in local time (minute hour dom month dow)" }),
      prompt: Type.String({ description: "Prompt to enqueue at fire time" }),
      recurring: Type.Boolean({ default: true, description: "true = fire on every match; false = one-shot then delete" }),
      durable: Type.Boolean({ default: false, description: "true = persist in the session file across restarts; false = session-only" }),
      label: Type.Optional(Type.String({ description: "Optional human-readable label" })),
    }),
    promptSnippet: "cron_create — schedule a prompt to run on a cron schedule (recurring or one-shot)",
    async execute(_id: string, params: any) {
      const parsed = parseCronExpression(params.cron);
      if (!parsed) {
        return result(`Invalid cron expression: "${params.cron}". Use 5-field format: minute hour day-of-month month day-of-week`);
      }
      if (nextCronRunMs(params.cron, Date.now()) === null) {
        return result(`Cron expression "${params.cron}" does not match any date in the next year.`);
      }
      if (getTaskCount() >= config.maxJobs) {
        return result(`Maximum of ${config.maxJobs} scheduled tasks reached. Delete some first.`);
      }
      const recurring = params.recurring ?? true;
      const durable = params.durable ?? false;
      const label = params.label ?? (params.prompt.startsWith("/") ? params.prompt.split(/\s+/)[0].slice(1) : undefined);
      const task: LoopTask = {
        id: generateTaskId(),
        cron: params.cron,
        prompt: params.prompt,
        createdAt: Date.now(),
        recurring,
        durable,
        label,
      };
      const nextRun = scheduler.nextFireTime(task) ?? Date.now();
      if (!recurring) task.nextFireTime = nextRun;
      record(appendEntry, "created", task);
      scheduler.refreshStatus();
      const human = cronToHuman(params.cron);
      const nextDate = new Date(nextRun).toLocaleString();
      const expiryNote = recurring
        ? ` Auto-expires after ${Math.round(config.recurringMaxAgeMs / 86400000)} days.`
        : " One-shot: removed after firing.";
      return result([
        `Scheduled task created.`,
        `  ID: ${task.id}`,
        ...(task.label ? [`  Label: ${task.label}`] : []),
        `  Schedule: ${human} (${params.cron})`,
        `  Next fire: ${nextDate}`,
        `  Prompt: ${task.prompt}`,
        `  Recurring: ${recurring} | Durable (in session file): ${durable}`,
        expiryNote,
        `Cancel with: cron_delete { id: "${task.id}" } or /loop-kill ${task.id}`,
      ].join("\n"));
    },
  });

  // --- cron_delete ---
  pi.registerTool({
    name: "cron_delete",
    label: "Cancel Scheduled Task",
    description:
      "Cancel a scheduled cron task by ID, by fuzzy label/prompt match, or 'all' to cancel every " +
      "active task. Use cron_list to see active tasks.",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID, label/prompt substring to match, or 'all'" }),
    }),
    promptSnippet: "cron_delete — cancel a scheduled task by ID, label match, or all",
    async execute(_id: string, params: any) {
      if (params.id === "all") {
        const all = getAllTasks();
        if (all.length === 0) return result("No active tasks to cancel.");
        const count = all.length;
        for (const t of all) record(appendEntry, "cancelled", t);
        scheduler.clearPendingLoop();
        scheduler.refreshStatus();
        return result(`Cancelled ${count} task${count === 1 ? "" : "s"}.`);
      }
      const exact = getTask(params.id);
      if (exact) {
        record(appendEntry, "cancelled", exact);
        if (isWakeupTask(exact)) scheduler.clearPendingLoop();
        scheduler.refreshStatus();
        return result(`Task ${params.id} cancelled.`);
      }
      // Fuzzy match against label, prompt, and humanized schedule — saves a cron_list round-trip.
      const q = params.id.toLowerCase();
      const matches = getAllTasks().filter((t) => {
        const label = (t.label ?? "").toLowerCase();
        const prompt = displayPrompt(t).toLowerCase();
        const human = (t.cron.startsWith(WAKEUP_PREFIX) ? "wake-up" : cronToHuman(t.cron)).toLowerCase();
        return label.includes(q) || prompt.includes(q) || human.includes(q);
      });
      if (matches.length === 0) {
        return result(`No task matching "${params.id}". Use cron_list to see active tasks.`);
      }
      if (matches.length > 1) {
        const lines = matches.map((t) => `  [${t.id}] ${t.cron.startsWith(WAKEUP_PREFIX) ? "wake-up" : cronToHuman(t.cron)} — ${displayPrompt(t).slice(0, 50)}`);
        return result(`"${params.id}" matches ${matches.length} tasks — be more specific or cancel by ID:\n${lines.join("\n")}`);
      }
      record(appendEntry, "cancelled", matches[0]);
      if (isWakeupTask(matches[0])) scheduler.clearPendingLoop();
      scheduler.refreshStatus();
      return result(`Task ${matches[0].id} cancelled (matched "${params.id}").`);
    },
  });

  // --- cron_list ---
  pi.registerTool({
    name: "cron_list",
    label: "List Scheduled Tasks",
    description: "List all active scheduled cron tasks with their IDs, schedules, and next fire times.",
    parameters: Type.Object({}),
    promptSnippet: "cron_list — list all active scheduled tasks",
    async execute() {
      const all = getAllTasks();
      if (all.length === 0) return result("No scheduled tasks.");
      const now = Date.now();
      const lines = all.map((t) => {
        const human = t.cron.startsWith(WAKEUP_PREFIX)
          ? `wake-up at ${new Date(t.nextFireTime ?? 0).toLocaleString()}`
          : cronToHuman(t.cron);
        const next = scheduler.nextFireTime(t);
        const nextStr = next ? new Date(next).toLocaleString() : "unknown";
        const age = Math.round((now - t.createdAt) / 60000);
        const flags = [t.recurring ? "recurring" : "one-shot", persistenceLabel(t)].join(", ");
        const shown = displayPrompt(t);
        return [
          `[${t.id}] ${human}${t.cron.startsWith(WAKEUP_PREFIX) ? "" : ` (${t.cron})`}`,
          `  Prompt: ${shown}`,
          `  Next: ${nextStr} | Created: ${age}m ago | ${flags}`,
        ].join("\n");
      });
      return result(`${all.length} scheduled task${all.length === 1 ? "" : "s"}:\n\n${lines.join("\n\n")}`);
    },
  });
}
