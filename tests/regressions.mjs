// Regressions found by the Claude Code /loop parity review.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopScheduler } from "../dist/scheduler.js";
import * as store from "../dist/store.js";
import { nextCronRunMs } from "../dist/cron.js";
import { AUTONOMOUS_LOOP_SENTINEL, DEFAULT_CONFIG, DEFAULT_LOOP_PROMPT } from "../dist/types.js";
import { registerWakeupTool, normalizeWakeupPrompt, computeWakeupTime } from "../dist/schedule-wakeup.js";

let pass = 0, fail = 0;
const t = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${name}${extra ? `  (${extra})` : ""}`); };

function setup(ctx = {}) {
  store.clearAllTasks();
  const sent = [];
  const appended = [];
  const pi = { sendUserMessage: (m, o) => sent.push({ m, o }), getCommands: () => [] };
  const s = new LoopScheduler(pi, DEFAULT_CONFIG, (ty, d) => appended.push(d));
  s.setContext({ hasUI: false, isIdle: () => true, ...ctx });
  let tool;
  registerWakeupTool({ registerTool: (x) => (tool = x) }, (ty, d) => appended.push(d), s, DEFAULT_CONFIG);
  return { s, sent, appended, tool };
}
const realNow = Date.now;

// 1) */5 fires once per boundary, even when the agent is busy then settles.
{
  const { s, sent } = setup();
  const boundary = Math.ceil(realNow() / 300000) * 300000 + 300000;
  store.record(undefined, "created", { id: "00000000", cron: "*/5 * * * *", prompt: "p", createdAt: boundary - 400000, recurring: true, durable: false });
  for (let ms = boundary - 120000; ms <= boundary + 30000; ms += 1000) {
    Date.now = () => ms;
    s.check();
    if (sent.length) { s.onAgentStart(); s.onAgentSettled(false); } // run starts and settles
  }
  Date.now = realNow;
  t("*/5 fires once in a 150s window around a boundary", sent.length === 1, `fires=${sent.length}`);
}
// 1b) a queued fire is re-checked before draining
{
  const { s, sent } = setup();
  const task = { id: "00000001", cron: "*/1 * * * *", prompt: "p", createdAt: realNow() - 180000, recurring: true, durable: false };
  store.record(undefined, "created", task);
  s.onAgentStart(); s.check();               // busy → queued
  store.record(undefined, "cancelled", task); // cancelled meanwhile
  s.onAgentSettled(false);
  t("queued fire is dropped once the task is cancelled", sent.length === 0);
}
// 1c) only one fire per idle window — the rest wait for the run to start/settle
{
  const { s, sent } = setup();
  for (const id of ["00000002", "00000003"]) store.record(undefined, "created", { id, cron: "*/1 * * * *", prompt: id, createdAt: realNow() - 180000, recurring: true, durable: false });
  s.check();
  t("two due tasks → one fire per check", sent.length === 1);
  s.onAgentStart(); s.onAgentSettled(false);
  t("second fires after the first run settles", sent.length === 2);
}

// 2) dom/dow OR semantics
{
  const from = new Date(2026, 9, 14, 12, 0).getTime(); // Wed Oct 14 2026
  t("'0 9 1 * 1' → next Monday", new Date(nextCronRunMs("0 9 1 * 1", from)).toDateString() === "Mon Oct 19 2026");
  t("'0 9 * * 1' → Monday only", new Date(nextCronRunMs("0 9 * * 1", from)).toDateString() === "Mon Oct 19 2026");
  t("'0 9 15 * *' → 15th only", new Date(nextCronRunMs("0 9 15 * *", from)).toDateString() === "Thu Oct 15 2026");
}

// 3) no prompt outside a loop → error; sentinel → default prompt, never sent literally
{
  const { tool } = setup();
  const r = await tool.execute("x", { delaySeconds: 60, reason: "r" });
  t("no prompt & no loop → rejected", /prompt is required/.test(r.content[0].text) && store.getAllTasks().length === 0);
  await tool.execute("y", { delaySeconds: 60, reason: "r", prompt: "<<autonomous-loop-dynamic>>" });
  t("CC sentinel → default loop prompt marker", store.getAllTasks()[0]?.loopPrompt === DEFAULT_LOOP_PROMPT);
  t("'/loop check deploy' → 'check deploy'", normalizeWakeupPrompt("/loop check deploy") === "check deploy");
  t("'/loop 5m check' → 'check'", normalizeWakeupPrompt("/loop 5m check") === "check");
  t("plain prompt kept", normalizeWakeupPrompt("check deploy") === "check deploy");
}

// 4) stop:true cancels armed wakeups even in a later turn
{
  const { s, tool } = setup();
  s.seedPendingLoop("check deploy", realNow());
  await tool.execute("a", { delaySeconds: 600, reason: "r" });
  s.onAgentStart(); s.onAgentSettled(false);
  const r = await tool.execute("b", { stop: true, reason: "user asked" });
  t("stop:true cancels the pending wakeup", store.getAllTasks().length === 0 && /cancelled 1/.test(r.content[0].text));
}

// 5) a new wakeup supersedes the pending one; /loop dynamic replaces a running loop
{
  const { s, tool } = setup();
  s.seedPendingLoop("check deploy", realNow() - 1000);
  await tool.execute("a", { delaySeconds: 600, reason: "r" });
  await tool.execute("b", { delaySeconds: 900, reason: "r2" });
  const all = store.getAllTasks();
  t("two calls → one pending wakeup", all.length === 1 && all[0].loopPrompt === "check deploy");
  t("re-pacing keeps the loop root", all[0].loopRoot < realNow() - 500);
  t("startDynamicLoop replaces the running loop", s.startDynamicLoop("other", realNow()) === 1 && store.getAllTasks().length === 0);
}

// 6) Esc-abort of a loop iteration ends the loop instead of arming a fallback
{
  const { s } = setup();
  store.addTaskRaw({ id: "aaaaaaaa", cron: "_wakeup_1", prompt: AUTONOMOUS_LOOP_SENTINEL, loopPrompt: "x", loopRoot: realNow(), createdAt: realNow(), nextFireTime: realNow() - 1, recurring: false, durable: false });
  s.check(); s.onAgentStart(); s.onAgentSettled(true);
  t("aborted iteration → no fallback, loop ended", store.getAllTasks().length === 0);
  store.addTaskRaw({ id: "bbbbbbbb", cron: "_wakeup_1", prompt: AUTONOMOUS_LOOP_SENTINEL, loopPrompt: "x", loopRoot: realNow(), createdAt: realNow(), nextFireTime: realNow() - 1, recurring: false, durable: false });
  s.check(); s.onAgentStart(); s.onAgentSettled(false);
  t("normal unrescheduled iteration → fallback armed", store.getAllTasks().some((x) => x.isFallback));
}

// 10) default prompt marker: loop.md re-read each fire; unchanged → short reminder
{
  const cwd = mkdtempSync(join(tmpdir(), "piloop-md-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "loop.md"), "TASK v1");
  const { s } = setup({ cwd });
  const a = s.expandPrompt(DEFAULT_LOOP_PROMPT);
  const b = s.expandPrompt(DEFAULT_LOOP_PROMPT);
  writeFileSync(join(cwd, ".pi", "loop.md"), "TASK v2");
  const c = s.expandPrompt(DEFAULT_LOOP_PROMPT);
  s.resetPromptCache();
  const d = s.expandPrompt(DEFAULT_LOOP_PROMPT);
  t("first fire: full loop.md", a.includes("TASK v1"));
  t("unchanged: short reminder", !b.includes("TASK v1") && b.includes("unchanged"));
  t("edited: full new content", c.includes("TASK v2"));
  t("after compaction reset: full again", d.includes("TASK v2"));
}

// 12) wakeups and /loop tasks are journaled; session-only crons are not
{
  const { s, appended, tool } = setup();
  s.seedPendingLoop("check deploy", realNow());
  await tool.execute("a", { delaySeconds: 600, reason: "r" });
  store.record((ty, d) => appended.push(d), "created", { id: "cccccccc", cron: "*/5 * * * *", prompt: "x", createdAt: realNow(), recurring: true, durable: false, fromLoop: true });
  store.record((ty, d) => appended.push(d), "created", { id: "dddddddd", cron: "*/5 * * * *", prompt: "x", createdAt: realNow(), recurring: true, durable: false });
  t("wakeup + /loop journaled, session cron not", appended.length === 2 && appended.every((d) => d.task.id !== "dddddddd"));
}

// 14) wakeup time rounding / cache window
{
  const now = 1_000_000_000_000 + 7_000; // 7s past a minute
  const w = computeWakeupTime(270, 15000, now);
  t("short delay stays inside the 5-min cache window", w.fireAt - now <= 285000 && w.fireAt % 60000 === 0);
  const w2 = computeWakeupTime(1200, 15000, now);
  t("long delay rounds up to a whole minute", w2.fireAt % 60000 === 0 && w2.fireAt - now >= 1200000);
  t("clamps below 60s", computeWakeupTime(5, 15000, now).wasClamped);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
