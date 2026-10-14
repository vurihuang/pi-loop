// End-to-end lifecycle through the extension entry with a fake pi runtime:
// session switch isolation, branch replay, resume restore, missed one-shots,
// agent_settled gating.
import piLoop from "../dist/index.js";
import { getAllTasks } from "../dist/store.js";
import { ENTRY_TYPE, AUTONOMOUS_LOOP_SENTINEL } from "../dist/types.js";

let pass = 0, fail = 0;
const t = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${name}${extra ? `  (${extra})` : ""}`); };

/** One pi runtime (pi re-invokes the cached factory per session). */
function runtime(branch = []) {
  const handlers = {}, commands = {}, tools = {};
  const sent = [], notices = [], appended = [];
  const pi = {
    on: (ev, h) => ((handlers[ev] ??= []).push(h)),
    registerCommand: (name, c) => (commands[name] = c),
    registerTool: (tool) => (tools[tool.name] = tool),
    appendEntry: (customType, data) => {
      const e = { type: "custom", customType, data: JSON.parse(JSON.stringify(data)) };
      appended.push(e); branch.push(e);
    },
    sendUserMessage: (m, o) => sent.push({ m, o }),
    sendMessage: (msg, o) => notices.push({ msg, o }),
    getCommands: () => [],
  };
  const ctx = {
    hasUI: false, cwd: "/nonexistent-piloop", isIdle: () => true,
    sessionManager: { getBranch: () => branch, getEntries: () => { throw new Error("use getBranch"); } },
  };
  piLoop(pi);
  const emit = async (ev, e = {}) => { for (const h of handlers[ev] ?? []) await h(e, ctx); };
  return { pi, ctx, emit, commands, tools, sent, notices, appended, branch };
}
const entry = (op, task) => ({ type: "custom", customType: ENTRY_TYPE, data: { op, task } });
const now = Date.now();

// 7 + 12) /loop and a session-only cron in session A; /new → nothing leaks; resume A → /loop back
{
  const a = runtime();
  await a.emit("session_start", { reason: "startup" });
  await a.commands.loop.handler("10m check deploy", a.ctx);
  await a.tools.cron_create.execute("x", { cron: "*/15 * * * *", prompt: "session only", recurring: true, durable: false });
  t("session A has 2 tasks", getAllTasks().length === 2);
  t("/loop first run queued as followUp", a.sent[0]?.m === "check deploy" && a.sent[0]?.o?.deliverAs === "followUp");
  await a.emit("session_shutdown", { reason: "new" });

  const b = runtime();
  await b.emit("session_start", { reason: "new" });
  t("/new: no tasks leak from session A", getAllTasks().length === 0);
  await b.emit("session_shutdown", { reason: "resume" });

  const a2 = runtime(a.branch);
  await a2.emit("session_start", { reason: "resume" });
  const restored = getAllTasks();
  t("resume A: /loop task restored, session-only cron gone", restored.length === 1 && restored[0].prompt === "check deploy");
  await a2.emit("session_shutdown", { reason: "quit" });
}

// 8) branch replay uses getBranch and session_tree rebuilds from the new branch
{
  const task = { id: "11111111", cron: "*/10 * * * *", prompt: "branch A task", createdAt: now, recurring: true, durable: true };
  const branchA = [entry("created", task)];
  const r = runtime(branchA);
  await r.emit("session_start", { reason: "startup" });
  t("getBranch replay restores durable task", getAllTasks().length === 1);
  branchA.length = 0; // navigate to a branch without the task
  await r.emit("session_tree", {});
  t("session_tree → task from abandoned branch dropped", getAllTasks().length === 0);
  await r.emit("session_shutdown", {});
}

// 11) missed durable one-shot → ask the user, never run; recorded so it isn't asked again
{
  const task = { id: "22222222", cron: "0 9 * * *", prompt: "push the branch", createdAt: now - 86400000, nextFireTime: now - 60000, recurring: false, durable: true };
  const branch = [entry("created", task)];
  const r = runtime(branch);
  await r.emit("session_start", { reason: "resume" });
  const msg = r.sent[0]?.m ?? "";
  t("missed one-shot → message asks the user first", /Do NOT execute/.test(msg) && msg.includes("push the branch") && msg !== "push the branch");
  t("missed one-shot cancellation journaled", r.appended.some((e) => e.data.op === "cancelled" && e.data.task.id === task.id));
  await r.emit("session_shutdown", {});
  const r2 = runtime(branch);
  await r2.emit("session_start", { reason: "resume" });
  t("second resume does not ask again", r2.sent.length === 0);
  await r2.emit("session_shutdown", {});
}

// 12) wakeups: future → re-armed on resume; past due → not fired, model told the loop stopped
{
  const future = { id: "33333333", cron: `_wakeup_${now + 600000}`, prompt: AUTONOMOUS_LOOP_SENTINEL, loopPrompt: "monitor", loopRoot: now, createdAt: now, nextFireTime: now + 600000, recurring: false, durable: false };
  const r = runtime([entry("created", future)]);
  await r.emit("session_start", { reason: "resume" });
  t("future wakeup re-armed on resume", getAllTasks().length === 1 && getAllTasks()[0].id === future.id);
  await r.emit("session_shutdown", {});

  const past = { ...future, id: "44444444", nextFireTime: now - 1000, cron: `_wakeup_${now - 1000}` };
  const r2 = runtime([entry("created", past)]);
  await r2.emit("session_start", { reason: "resume" });
  t("past-due wakeup not fired", getAllTasks().length === 0 && r2.sent.length === 0);
  t("model notified (context only, no turn)", r2.notices.length === 1 && r2.notices[0].o?.triggerTurn === false);
  await r2.emit("session_shutdown", {});
}

// 12b) overdue /loop task restarts its cadence on resume instead of a catch-up burst
{
  const old = { id: "55555555", cron: "*/10 * * * *", prompt: "loop", createdAt: now - 3600000, recurring: true, durable: false, fromLoop: true };
  const r = runtime([entry("created", old)]);
  await r.emit("session_start", { reason: "resume" });
  t("overdue /loop rebased to now", (getAllTasks()[0]?.lastFiredAt ?? 0) >= now);
  await r.emit("session_shutdown", {});
}

// 9 + 13) dynamic /loop through the real tool, settle via agent_settled
{
  const r = runtime();
  await r.emit("session_start", { reason: "startup" });
  await r.commands.loop.handler("monitor the build", r.ctx);
  await r.emit("agent_start");
  const res = await r.tools.schedule_wakeup.execute("w", { delaySeconds: 1200, reason: "idle", prompt: "/loop monitor the build" });
  await r.emit("agent_settled", { aborted: false });
  const w = getAllTasks();
  t("dynamic /loop → one wakeup carrying the loop prompt", w.length === 1 && w[0].loopPrompt === "monitor the build", res.content[0].text.split("\n")[0]);
  await r.commands.loop.handler("other loop", r.ctx);
  t("second dynamic /loop replaces the first", getAllTasks().length === 0);
  await r.emit("session_shutdown", {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
