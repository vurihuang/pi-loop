// Dynamic-loop machinery: seed/take pending, fallback arming, */5 early fire,
// wakeup chaining preserves loopPrompt + loopRoot, expiry on the loop root.
import { LoopScheduler } from "../dist/scheduler.js";
import { record, getAllTasks, getTask, clearAllTasks, generateTaskId } from "../dist/store.js";
import { recurringJitterMs, recurringFireTimeMs } from "../dist/jitter.js";
import { AUTONOMOUS_LOOP_SENTINEL } from "../dist/types.js";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${name}`); };

const config = {
  maxJobs: 50, recurringMaxAgeMs: 7 * 86400000, recurringJitterFrac: 0.5,
  recurringJitterCapMs: 30 * 60000, oneShotJitterMaxMs: 90000,
  oneShotJitterFloorMs: 0, oneShotJitterMinuteMod: 30, checkIntervalMs: 1000,
  dynamicFallbackMs: 20 * 60000, cacheLeadMs: 15000,
};
const appended = [];
const appendEntry = (ty, d) => appended.push({ ty, d });
const sent = [];
const fakePi = { sendUserMessage: (m) => sent.push(m), getCommands: () => [] };

// --- 1. seeded pending loop is claimed by schedule_wakeup ---
clearAllTasks();
const sched = new LoopScheduler(fakePi, config, appendEntry);
sched.setContext({ hasUI: false, isIdle: () => true });
sched.seedPendingLoop("check the deploy", 12345);
const claimed = sched.takePendingLoop();
t("seed → takePendingLoop returns prompt+root", claimed?.prompt === "check the deploy" && claimed?.root === 12345);
t("pending empty after take", sched.peekPendingLoop() === null);

// --- 2. fired wakeup with loopPrompt registers pending; unclaimed → fallback armed ---
clearAllTasks();
const sched2 = new LoopScheduler(fakePi, config, appendEntry);
sched2.setContext({ hasUI: false, isIdle: () => true });
const wakeup = {
  id: generateTaskId(), cron: `_wakeup_${Date.now() - 1000}`,
  prompt: AUTONOMOUS_LOOP_SENTINEL, loopPrompt: "monitor the build",
  loopRoot: Date.now() - 60000, createdAt: Date.now() - 60000,
  nextFireTime: Date.now() - 1000, recurring: false, durable: false,
};
record(appendEntry, "created", wakeup);
sched2.check(); // fires the wakeup
t("wakeup fired → sent loopPrompt", sent.some((m) => m.startsWith("monitor the build")));
t("pending has loop", sched2.peekPendingLoop()?.prompt === "monitor the build");
// turn ends without reschedule → fallback armed
sched2.setBusy(); sched2.setIdle();
const fallback = getAllTasks().find((x) => x.isFallback);
t("fallback wakeup armed", !!fallback && fallback.cron.startsWith("_wakeup_") && fallback.loopPrompt === "monitor the build");
t("pending cleared after fallback arm", sched2.peekPendingLoop() === null);

// --- 3. dropped fallback → loop ends, no second fallback ---
clearAllTasks();
const sched3 = new LoopScheduler(fakePi, config, appendEntry);
sched3.setContext({ hasUI: false, isIdle: () => true });
const fb = {
  id: generateTaskId(), cron: `_wakeup_${Date.now() - 1000}`,
  prompt: AUTONOMOUS_LOOP_SENTINEL, loopPrompt: "x", loopRoot: Date.now() - 60000,
  createdAt: Date.now() - 60000, nextFireTime: Date.now() - 1000,
  recurring: false, durable: false, isFallback: true,
};
record(appendEntry, "created", fb);
sched3.check();
sched3.setBusy(); sched3.setIdle();
t("dropped fallback → no new wakeup", getAllTasks().filter((x) => x.cron.startsWith("_wakeup_")).length === 0);

// --- 4. */5 fires early (cache optimization) ---
const jt = { id: "a1b2c3d4", cron: "*/5 * * * *", prompt: "x", createdAt: 0, lastFiredAt: 1_000_000, recurring: true, durable: false };
t("*/5 fires gap−15s after last fire", recurringFireTimeMs(jt, config) === 1_000_000 + 5 * 60000 - 15000);
const jt10 = { ...jt, cron: "*/10 * * * *" };
t("*/10 jitter is ≥0", recurringJitterMs(jt10, 10 * 60000, config) >= 0);

// --- 5. loop root expiry ---
const sched5 = new LoopScheduler(fakePi, config, appendEntry);
sched5.setContext({ hasUI: false, isIdle: () => true });
t("fresh root not aged", !sched5.isRootAgedOut(Date.now() - 1000));
t("8-day root aged out", sched5.isRootAgedOut(Date.now() - 8 * 86400000));

// --- 6. slash-command dispatch: builtin → text, unknown → text, known → expand ---
clearAllTasks();
const sched6 = new LoopScheduler(fakePi, { ...config }, appendEntry);
sched6.setContext({ hasUI: false, isIdle: () => true });
const sent6 = [];
const pi6 = {
  sendUserMessage: (m, o) => sent6.push({ m, o }),
  getCommands: () => [{ name: "review-pr", source: "skill" }],
};
const sched6b = new LoopScheduler(pi6, config, appendEntry);
sched6b.setContext({ hasUI: false, isIdle: () => true });
const mkTask = (prompt) => ({
  id: generateTaskId(), cron: "*/5 * * * *", prompt,
  createdAt: Date.now() - 600000, lastFiredAt: Date.now() - 600000,
  recurring: true, durable: false,
});
sched6b.fire(mkTask("/model list"));          // builtin → text marker
sched6b.fire(mkTask("/review-pr 123"));        // known skill → expandPromptTemplates
sched6b.fire(mkTask("/nonexistent-cmd foo"));  // unknown → plain text
sched6b.fire(mkTask("check the deploy"));      // plain prompt → plain
t("builtin → text marker", sent6[0].m.includes("arrived as text") && !sent6[0].o?.expandPromptTemplates);
t("known skill → expandPromptTemplates", sent6[1].m === "/review-pr 123" && sent6[1].o?.expandPromptTemplates === true);
t("unknown cmd → plain text", sent6[2].m === "/nonexistent-cmd foo" && !sent6[2].o?.expandPromptTemplates);
t("plain prompt → plain", sent6[3].m === "check the deploy" && !sent6[3].o?.expandPromptTemplates);
t("every send is queued as followUp", sent6.every((x) => x.o?.deliverAs === "followUp"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
