import { parseLoopArgs } from "../dist/parse-args.js";

const cases = [
  // input → expected interval (null = dynamic), expected prompt (null = default)
  ["5m check deploy",            "5m",  "check deploy"],
  ["check every 15m",            "15m", "check"],
  ["every 5m check deploy",      "5m",  "check deploy"],
  ["every 15 minutes run x",     "15m", "run x"],
  ["every 2h do thing",          "2h",  "do thing"],
  ["Every 30m ping",             "30m", "ping"],
  ["check tests every 15 minutes","15m","check tests"],
  ["check the deploy",           null,  "check the deploy"],
  ["monitor build",              null,  "monitor build"],
  // interval only → default (loop.md / maintenance) prompt
  ["15m",                        "15m", null],
  ["every 5m",                   "5m",  null],
  // nothing → dynamic + default prompt
  ["",                           null,  null],
  // edge cases that should NOT misparse
  ["every day at 9 check",       null,  "every day at 9 check"],
  ["everything is fine",         null,  "everything is fine"],
  ["every",                      null,  "every"],
];

let ok = 0, bad = 0;
for (const [input, expInt, expPrompt] of cases) {
  const p = parseLoopArgs(input);
  const pass = p.interval === expInt && p.prompt === expPrompt;
  pass ? ok++ : bad++;
  console.log(`${pass ? "✓" : "✗"} ${JSON.stringify(input).padEnd(32)} → interval=${p.interval} prompt=${JSON.stringify(p.prompt)}`);
}
console.log(`\n${ok} ok, ${bad} bad`);
process.exit(bad ? 1 : 0);
