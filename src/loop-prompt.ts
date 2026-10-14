/**
 * Default prompt for bare `/loop` — loop.md override + built-in maintenance prompt.
 *
 * Resolution order (first hit wins, re-read every iteration so edits go live):
 *   1. .pi/loop.md              (project)
 *   2. ~/.pi/agent/loop.md      (user)
 *   3. BUILTIN_MAINTENANCE_PROMPT
 * Files over 25KB are truncated.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOOP_MD_MAX_BYTES = 25_000;

export const BUILTIN_MAINTENANCE_PROMPT = `You are running a maintenance /loop iteration. Work through the following, in order:

1. Continue any unfinished work from the conversation.
2. Tend to the current branch's pull request, if any: address review comments, investigate failed CI runs, resolve merge conflicts.
3. If nothing is pending, run one small cleanup pass — a bug hunt, dead-code removal, or simplification — and report what you found in a line or two.

Do not start new initiatives outside this scope. Irreversible actions (push, delete, force operations) only proceed when they continue something the transcript already authorized. If everything is quiet, say so in one line.`;

export interface DefaultLoopPrompt {
  prompt: string;
  source: string;
  /** Absolute path of the loop.md file, absent for the built-in prompt. */
  path?: string;
}

function readLoopMd(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const truncated = raw.length > LOOP_MD_MAX_BYTES;
    const trimmed = (truncated ? raw.slice(0, LOOP_MD_MAX_BYTES) : raw).trim();
    if (trimmed.length === 0) return null;
    return truncated
      ? `${trimmed}\n\n> WARNING: loop.md was truncated to ${LOOP_MD_MAX_BYTES} bytes. Keep the task list concise.`
      : trimmed;
  } catch {
    return null;
  }
}

/** Resolve the default /loop prompt; re-reads on every call so loop.md edits go live. */
export function resolveDefaultLoopPromptSync(cwd: string): DefaultLoopPrompt {
  const projectPath = join(cwd, ".pi", "loop.md");
  const project = readLoopMd(projectPath);
  if (project) return { prompt: project, source: ".pi/loop.md", path: projectPath };
  const userPath = join(homedir(), ".pi", "agent", "loop.md");
  const user = readLoopMd(userPath);
  if (user) return { prompt: user, source: "~/.pi/agent/loop.md", path: userPath };
  return { prompt: BUILTIN_MAINTENANCE_PROMPT, source: "built-in maintenance prompt" };
}

export async function resolveDefaultLoopPrompt(cwd: string): Promise<DefaultLoopPrompt> {
  return resolveDefaultLoopPromptSync(cwd);
}
