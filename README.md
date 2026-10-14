# pi-loop

Recurring prompt execution and cron scheduling for [pi](https://github.com/earendil-works/pi) ≥ 1.2.0 — built on pi's **durable session-entry** architecture (`pi.appendEntry`). Task state lives in the session's JSONL tree as an append-only `pi-loop-task` event log.

## Design

pi-loop offers two scheduling primitives that share one persistence model:

| Mode | Driver | Use case |
|------|--------|----------|
| **Fixed loop** | `/loop 5m <prompt>` — interval becomes a cron expression, fires on the tick | Poll CI, watch a deploy, re-run a check |
| **Dynamic loop** | `/loop <prompt>` (no interval) — model calls `schedule_wakeup` each turn with a self-chosen 60–3600s delay | "Watch the build until green", exploratory monitoring where the next check time depends on what was just seen |

### State: append-only event log in the session file

Every lifecycle event (`created` / `fired` / `cancelled`) of a journaled task —
`durable` cron tasks, `/loop` tasks and `schedule_wakeup` timers — is appended
as a `CustomEntry` (`customType: "pi-loop-task"`) into the session's
append-only tree via `pi.appendEntry`. On `session_start` (and `session_tree`
navigation) the extension reads `ctx.sessionManager.getBranch()`, filters its
`customType`, and replays the active branch to rebuild live tasks — the pattern
pi documents for extension state. Session-only `cron_create` tasks
(`durable: false`) stay in memory and die with the session.

```
create   →  pi-loop-task entry { op: "created",   task }
fire     →  pi-loop-task entry { op: "fired",     task }
cancel   →  pi-loop-task entry { op: "cancelled", task }
              ↓
       session JSONL (append-only tree)
              ↓ session_start / session_tree
       replay active branch → in-memory task Map
```

| Property | How it falls out |
|---|---|
| Durability | The session file persists across restarts; replay rebuilds tasks on resume |
| Compaction-survival | Custom entries are not LLM context, so compaction never touches them |
| Branch-awareness | Replay reads the active branch; `/tree` navigation rebuilds from the new branch |
| Session isolation | Task state is cleared on every `session_start`, so `/new`, `/resume`, `/fork` never inherit another session's tasks |
| Concurrency | The session tree is the single source of truth for task state |

> **Scope note:** `durable` means "persists inside this session's file". A task
> does not fire while *no* pi session is running — there is no daemon. True
> cross-session/system cron needs an external store plus a live process.

## Key mechanisms

| Mechanism | Behavior |
|-----------|----------|
| Idle gating | `ctx.isIdle()` + `agent_start`/`agent_settled` mirror; one fire per idle window |
| Dynamic-loop chaining | `takePendingLoop()` hands `loopPrompt`/`loopRoot` to the next wakeup, so the chain stays one logical loop (7-day expiry and `/loop-kill` by prompt keep working) |
| Dropped-iteration fallback | Turn ends without rescheduling → arm a ~20min fallback wakeup; if that one is dropped too the loop ends; Esc-abort ends it immediately |
| Deterministic jitter | Recurring tasks spread over a window; every-5-min cron fires ~15s early (anchored on previous fire) to stay inside the prompt-cache window |
| Auto-expiry | Recurring tasks and dynamic loops expire 7 days after creation |
| Missed one-shot | A durable one-shot missed while pi was closed is not run unattended — the model asks the user first |
| Slash-command dispatch | A fired prompt that is a slash command runs when pi can invoke it autonomously; pi's built-ins (`/model`, `/compact`, …) and unknown commands arrive as plain text |

## Features

- `/loop` — fixed interval (`/loop 5m check the deploy`) or dynamic self-pacing (`/loop monitor the build`)
- Bare `/loop` (or interval only) — runs a default prompt: `.pi/loop.md` → `~/.pi/agent/loop.md` → built-in maintenance prompt
- `cron_create` / `cron_delete` / `cron_list` — LLM-callable tools (`cron_delete` also fuzzy-matches label/prompt)
- `schedule_wakeup` — model-driven dynamic pacing (60–3600s); one dynamic loop per session (a new wake-up replaces the pending one), `stop:true` cancels it
- Resume — `/loop` tasks and pending wake-ups come back when the session is resumed; an overdue `/loop` restarts its cadence instead of firing a catch-up run, a wake-up that came due while pi was closed is dropped and the model is told the loop stopped
- Cron day matching follows vixie-cron: with both day-of-month and day-of-week restricted, either one matches
- Per-project `.pi-loop.config.json` overrides
- `PI_LOOP_DISABLE=1` turns the whole extension off; `PI_LOOP_DEBUG=1` for verbose logging

## Install

```bash
pi install github:vurihuang/pi-loop
```

## Usage

```
/loop 5m check the deploy          # recurring every 5m
/loop check tests every 15m        # trailing "every" clause
/loop monitor the build            # dynamic pacing via schedule_wakeup
/loop 15m                          # fixed interval + default prompt (loop.md/maintenance)
/loop                              # dynamic pacing + default prompt
/loop-list
/loop-kill abc123 | deploy | all
```

Both the interval and the prompt are optional. A fired prompt that is a slash
command is dispatched when pi can invoke it autonomously; pi's built-in
commands (`/model`, `/compact`, …) and unknown commands arrive as plain text.

### Default prompt (`loop.md`)

With no prompt, `/loop` uses the first file it finds, re-read each iteration so
edits go live (files >25KB are truncated). The full contents are sent on the
first iteration, after an edit, and after compaction; unchanged later iterations
get a short reminder pointing back at them:

| Path | Scope |
|---|---|
| `.pi/loop.md` | project — wins when both exist |
| `~/.pi/agent/loop.md` | user — applies in any project without its own |

If neither exists, a built-in maintenance prompt runs: continue unfinished work,
tend the current branch's PR (review comments, failed CI, conflicts), then a
small cleanup pass.

### LLM tools

| Tool | Description |
|---|---|
| `cron_create` | `cron`, `prompt`, `recurring` (default true), `durable` (default false), `label` |
| `cron_delete` | `id`, a label/prompt substring, or `"all"` |
| `cron_list` | — |
| `schedule_wakeup` | `delaySeconds` (60–3600), `reason`, `prompt` (omit inside a loop), `stop` |

Cron is standard 5-field local time: `*/5 * * * *`, `0 */2 * * *`, `30 14 * * *`, `0 9 * * 1-5`.
Day-of-week accepts `0`–`6` plus `7` for Sunday.

## Configuration

`.pi-loop.config.json` in the project root:

```json
{
  "maxJobs": 50,
  "recurringMaxAgeMs": 604800000,
  "recurringJitterFrac": 0.5,
  "recurringJitterCapMs": 1800000,
  "checkIntervalMs": 1000,
  "dynamicFallbackMs": 1200000,
  "cacheLeadMs": 15000
}
```

## Development

```bash
npm install
npm run build       # tsc → dist/
npm test            # build + all test scripts (smoke, args, dynamic loop, regressions, lifecycle)
npm run dev         # pi -e ./src/index.ts -s ./skills
```

## Architecture

```
src/
  index.ts           entry: commands, tools, lifecycle (session_start/session_tree replay the branch)
  store.ts           in-memory view + appendEntry journal + restoreFromEntries()
  scheduler.ts       1s tick; shouldFire (jitter) → fire → sendUserMessage; dynamic-loop bookkeeping; loop.md expansion
  cron.ts            5-field parser + next-run + humanizer + interval→cron (dow 7=Sun, odd-step rounding)
  jitter.ts          deterministic jitter; */5 fires −15s for prompt-cache reuse
  parse-args.ts      /loop arg parsing (interval & prompt each optional)
  loop-prompt.ts     default /loop prompt: .pi/loop.md → ~/.pi/agent/loop.md → built-in maintenance
  schedule-wakeup.ts schedule_wakeup tool (_wakeup_<ms> sentinel, stop, loop chaining)
  tools/cron-tools.ts cron_create/delete/list
  types.ts           LoopTask, LoopEntryData, LoopConfig
```

## License

MIT — © vuri.
