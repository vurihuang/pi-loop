/**
 * /loop argument parser.
 * Both the interval and the prompt are optional (2×2):
 *   "5m check deploy"        → interval + prompt
 *   "check deploy"           → dynamic self-pacing, prompt
 *   "15m"                    → interval + default (loop.md or built-in maintenance) prompt
 *   "" / "every 5m"          → interval + default prompt  /  dynamic + default prompt
 * Priority: 1) leading "5m"  2) leading "every 5m"  3) trailing "every 20m"
 */

const INTERVAL_RE = /^\d+[smhd]$/;
const LEADING_EVERY_RE = /^every\s+(\d+)\s*([smhd]|seconds?|minutes?|hours?|days?)\b\s*/i;
const TRAILING_EVERY_RE = /\s+every\s+(\d+)\s*([smhd]|seconds?|minutes?|hours?|days?)\s*$/i;
const UNIT_MAP: Record<string, string> = {
  s: "s", second: "s", seconds: "s",
  m: "m", minute: "m", minutes: "m",
  h: "h", hour: "h", hours: "h",
  d: "d", day: "d", days: "d",
};

export interface ParsedLoopArgs {
  /** null → dynamic self-pacing (no explicit interval) */
  interval: string | null;
  /** null → use loop.md / built-in maintenance prompt */
  prompt: string | null;
}

export function parseLoopArgs(args: string): ParsedLoopArgs {
  const trimmed = args.trim();
  const tokens = trimmed.split(/\s+/).filter(Boolean);

  if (tokens.length >= 1 && INTERVAL_RE.test(tokens[0])) {
    const rest = tokens.slice(1).join(" ").trim();
    return { interval: tokens[0], prompt: rest || null };
  }

  // Leading "every 5m <prompt>" / "every 15 minutes <prompt>" / bare "every 5m"
  const leadingEvery = trimmed.match(LEADING_EVERY_RE);
  if (leadingEvery) {
    const n = leadingEvery[1];
    const unit = UNIT_MAP[leadingEvery[2].toLowerCase()];
    if (unit) {
      const prompt = trimmed.slice(leadingEvery[0].length).trim();
      return { interval: `${n}${unit}`, prompt: prompt || null };
    }
  }

  const everyMatch = trimmed.match(TRAILING_EVERY_RE);
  if (everyMatch) {
    const n = everyMatch[1];
    const unit = UNIT_MAP[everyMatch[2].toLowerCase()];
    if (unit) {
      const prompt = trimmed.slice(0, everyMatch.index).trim();
      // Trailing-every with no prompt → still a fixed interval + default prompt
      return { interval: `${n}${unit}`, prompt: prompt || null };
    }
  }

  // No interval anywhere → dynamic self-pacing
  return { interval: null, prompt: trimmed || null };
}
