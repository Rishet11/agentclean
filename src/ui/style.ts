/**
 * ~40 lines of raw SGR escape codes. No dependency (no chalk): this is the
 * entire color layer for the CLI. Every wrapped string still carries its
 * plain-text meaning on its own (e.g. "[x]" / "[~]" / "[ ]" / "[-]") so
 * color is always additive, never load-bearing, per the "never color-only"
 * rule in the brief.
 */

export interface ColorStream {
  isTTY?: boolean;
}

/** Gate: only colorize a real TTY, and only when the environment has not
 * opted out. `CI` is the de facto standard env var most CI systems set. */
export function colorEnabled(stream: ColorStream, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!stream.isTTY) return false;
  if (env.NO_COLOR) return false;
  if (env.CI) return false;
  return true;
}

const CODES = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

function paint(code: string): (text: string, enabled: boolean) => string {
  return (text, enabled) => (enabled ? `${code}${text}${CODES.reset}` : text);
}

export const bold = paint(CODES.bold);
export const dim = paint(CODES.dim);
export const red = paint(CODES.red);
export const green = paint(CODES.green);
export const yellow = paint(CODES.yellow);
export const blue = paint(CODES.blue);
export const cyan = paint(CODES.cyan);
export const gray = paint(CODES.gray);

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Strips SGR sequences back out, so width math never has to know about
 * color: `Array.from(stripAnsi(s)).length` is the visible width. */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}
