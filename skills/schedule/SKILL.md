---
name: schedule
description: Create, list, and manage scheduled cron tasks that fire prompts at specific times or intervals
---

## When to use

Use this skill when:
- The user wants to schedule something for a specific future time
- The user wants a one-shot reminder
- You need to programmatically schedule your own follow-up work
- The user asks about existing scheduled tasks

## Tools

| Tool | Purpose |
|------|---------|
| `cron_create` | Schedule a prompt (recurring or one-shot) |
| `cron_list` | List active scheduled tasks |
| `cron_delete` | Cancel a task by ID, label/prompt match, or `all` |

## Examples

```
"Remind me at 3pm to push the branch"
→ cron_create { cron: "0 15 * * *", prompt: "Reminder: push the branch", recurring: false }

"Check the CI pipeline every 10 minutes, keep it if I resume tomorrow"
→ cron_create { cron: "*/10 * * * *", prompt: "Check CI status", recurring: true, durable: true }

"What's scheduled right now?" → cron_list {}
"Stop the deploy monitor"     → cron_delete { id: "deploy" }  # fuzzy match, or exact ID
```

`durable: true` stores the task inside this session file so it survives closing and resuming the session.
