import { record, getAllTasks, getTask, clearAllTasks, generateTaskId } from "../dist/store.js";
import { LoopScheduler } from "../dist/scheduler.js";

const appended = [];
const appendEntry = (t, d) => appended.push({ t, d });
const sent = [];
const fakePi = { sendUserMessage: (m) => sent.push(m) };
const config = {
  maxJobs: 50, recurringMaxAgeMs: 7*86400000, recurringJitterFrac: 0.5,
  recurringJitterCapMs: 30*60000, oneShotJitterMaxMs: 90000,
  oneShotJitterFloorMs: 0, oneShotJitterMinuteMod: 30, checkIntervalMs: 1000,
  dynamicFallbackMs: 20*60000, cacheLeadMs: 15000,
};
const sched = new LoopScheduler(fakePi, config, appendEntry);
sched.setContext({ hasUI: false, isIdle: () => true });

const task = {
  id: generateTaskId(), cron: "*/1 * * * *", prompt: "test fire",
  createdAt: Date.now() - 120000,
  recurring: true, durable: false,
};
record(appendEntry, "created", task);
console.log("1) task in memory:", getTask(task.id) !== undefined);
console.log("2) shouldFire:", sched.shouldFire(task, Date.now()));
sched.check();
console.log("3) fired → sendUserMessage:", sent.length === 1 && sent[0] === "test fire");
console.log("4) session-only → no entries appended:", appended.length === 0);
console.log("5) lastFiredAt updated:", getTask(task.id)?.lastFiredAt !== undefined);
