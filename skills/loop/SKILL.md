---
name: loop
description: Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo, defaults to dynamic self-pacing)
---

## When to use

Use this skill when the user wants to set up a recurring task, poll for status, or run something repeatedly on an interval.

Examples:
- "check the deploy every 5 minutes"
- "keep running tests every 15m"
- "remind me at 2:30pm to review PRs"
- "keep iterating on the refactor"

## Tools

| Tool | Purpose |
|------|---------|
| `cron_create` | Schedule a prompt on a cron schedule (recurring or one-shot) |
| `cron_delete` | Cancel a scheduled task by ID, label/prompt match, or `all` |
| `cron_list` | List all active scheduled tasks |
| `schedule_wakeup` | Arm a single-shot timer for dynamic self-pacing (omit `prompt` inside a loop; `stop:true` ends the loop) |

## Slash commands

- `/loop [interval] [prompt]` — both optional: `/loop 5m check the deploy` (fixed), `/loop check the deploy` (dynamic self-pacing), `/loop 15m` (fixed + default prompt), `/loop` (dynamic + default prompt)
- `/loop-list` — list all active loops
- `/loop-kill <id|label|all>` — cancel by ID, fuzzy label match, or kill all

## Default prompt

When `/loop` has no prompt, the first of these wins (re-read each iteration):
`.pi/loop.md` (project) → `~/.pi/agent/loop.md` (user) → built-in maintenance prompt.

## Durability

- `cron_create` with `durable: true` → task state is stored as `pi-loop-task` entries inside the session file and survives closing/resuming this session.
- Session-only `cron_create` tasks (default) live for the current session.
- `/loop` tasks and `schedule_wakeup` timers are restored when this session is resumed.
- A durable one-shot missed while pi was closed is not run automatically: ask the user before running it.

## Notes

- Loops only fire when the agent is idle (not streaming)
- Recurring tasks and dynamic loops auto-expire 7 days after creation
- One dynamic loop per session: a new `schedule_wakeup` replaces the pending one
- A dynamic loop iteration that ends without rescheduling gets one ~20-minute fallback wakeup; if that one is dropped too, the loop ends. An aborted (Esc) iteration ends the loop
- Cron is 5-field local time: `minute hour day-of-month month day-of-week` (day-of-week 0–6, plus 7 = Sunday)
- Intervals that don't map to an even cron step (7m, 90m…) are rounded to the nearest clean step and reported
