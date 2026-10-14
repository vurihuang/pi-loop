// Smoke test: replay the entry log → restore tasks, fire, cancel.
import { parseCronExpression, intervalToCron, cronToHuman, nextCronRunMs } from "../dist/cron.js";
import { parseLoopArgs } from "../dist/parse-args.js";
import { jitterFrac } from "../dist/jitter.js";
import {
  record, restoreFromEntries, getAllTasks, clearAllTasks, generateTaskId,
} from "../dist/store.js";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${name}`); };

// cron
t("parse */5 * * * *", parseCronExpression("*/5 * * * *") !== null);
t("parse 0 9 * * 1-5", parseCronExpression("0 9 * * 1-5") !== null);
t("dow 7 = Sunday", parseCronExpression("0 9 * * 7") !== null);
t("reject bad", parseCronExpression("99 * * * *") === null);
t("intervalToCron 5m", intervalToCron("5m")?.cron === "*/5 * * * *");
t("intervalToCron 2h", intervalToCron("2h")?.cron === "0 */2 * * *");
t("intervalToCron 90m→2h rounded", intervalToCron("90m")?.cron === "0 */2 * * *" && !!intervalToCron("90m")?.rounded);
t("intervalToCron 7m→even step rounded", intervalToCron("7m")?.cron !== "*/7 * * * *" && !!intervalToCron("7m")?.rounded);
t("intervalToCron 10m exact", intervalToCron("10m")?.cron === "*/10 * * * *" && !intervalToCron("10m")?.rounded);
t("cronToHuman */5", cronToHuman("*/5 * * * *") === "every 5 minutes");
t("nextCronRun in future", nextCronRunMs("*/5 * * * *", Date.now()) > Date.now());

// parse-args: interval null = dynamic, prompt null = default (loop.md/maintenance)
t("leading interval", parseLoopArgs("5m check deploy")?.interval === "5m");
t("trailing every", parseLoopArgs("check tests every 15m")?.interval === "15m");
t("dynamic (no interval)", parseLoopArgs("monitor build")?.interval === null);
t("interval-only → default prompt", parseLoopArgs("15m")?.interval === "15m" && parseLoopArgs("15m")?.prompt === null);
t("empty → dynamic + default", parseLoopArgs("   ")?.interval === null && parseLoopArgs("   ")?.prompt === null);

// jitter deterministic
t("jitterFrac in [0,1)", jitterFrac("a1b2c3d4") >= 0 && jitterFrac("a1b2c3d4") < 1);
t("jitterFrac deterministic", jitterFrac("a1b2c3d4") === jitterFrac("a1b2c3d4"));

// store replay — the core of the new architecture
clearAllTasks();
const appended = [];
const appendEntry = (type, data) => appended.push({ type, customType: type, data });

const durableTask = {
  id: generateTaskId(), cron: "*/10 * * * *", prompt: "check status",
  createdAt: Date.now() - 10000, recurring: true, durable: true,
};
const sessionTask = {
  id: generateTaskId(), cron: "0 9 * * *", prompt: "temp",
  createdAt: Date.now(), recurring: true, durable: false,
};

record(appendEntry, "created", durableTask);
record(appendEntry, "created", sessionTask);
t("2 tasks in memory", getAllTasks().length === 2);
t("only durable appended", appended.length === 1 && appended[0].data.task.id === durableTask.id);

// Simulate restart: wipe memory, replay appended entries
clearAllTasks();
t("cleared", getAllTasks().length === 0);
const fakeEntries = appended.map((a) => ({ type: "custom", customType: a.customType, data: a.data }));
const { restored, missed } = restoreFromEntries(fakeEntries);
t("durable restored from entries", restored === 1 && getAllTasks()[0].id === durableTask.id);
t("session task gone", getAllTasks().every((x) => x.id !== sessionTask.id));

// cancel via replay
record(appendEntry, "cancelled", getAllTasks()[0]);
const { restored: r2 } = restoreFromEntries(appended.map((a) => ({ type: "custom", customType: a.customType, data: a.data })));
t("cancelled after replay", r2 === 0 && getAllTasks().length === 0);

// missed one-shot recovery
clearAllTasks();
const missedTask = {
  id: generateTaskId(), cron: "0 9 * * *", prompt: "remind me",
  createdAt: Date.now() - 86400000, nextFireTime: Date.now() - 1000,
  recurring: false, durable: true,
};
record(appendEntry, "created", missedTask);
clearAllTasks();
const fake2 = [{ type: "custom", customType: "pi-loop-task", data: { op: "created", task: missedTask } }];
const res = restoreFromEntries(fake2);
t("missed one-shot detected", res.missed.length === 1 && res.missed[0].id === missedTask.id);
t("missed not kept", getAllTasks().length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
