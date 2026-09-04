import { stripAnsi } from "./style.js";

/** Visible width, ignoring SGR color codes: no string-width dependency
 * needed because output is ASCII-only, so one code point is one column. */
export function visualWidth(value: string): number {
  return Array.from(stripAnsi(value)).length;
}

/** Pads a plain (uncolored) string to a fixed visible width. Apply color to
 * the whole field afterward, never to a substring, or this measures wrong. */
export function padRight(value: string, width: number): string {
  const gap = width - visualWidth(value);
  return gap > 0 ? value + " ".repeat(gap) : value;
}

export function padLeft(value: string, width: number): string {
  const gap = width - visualWidth(value);
  return gap > 0 ? " ".repeat(gap) + value : value;
}

/** ASCII-only truncation (no unicode ellipsis, no box-drawing): a plain "..."
 * so the whole CLI stays within the ASCII-only, no-emoji, no-box-drawing rule. */
export function truncateToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  const chars = Array.from(value);
  if (chars.length <= width) return value;
  if (width <= 3) return chars.slice(0, width).join("");
  return `${chars.slice(0, width - 3).join("")}...`;
}

/** Fixed viewport height for the interactive checklist: the whole frame
 * (header, scrollable body, footer) is padded/clipped to exactly this many
 * lines, so the "move cursor up N lines" redraw math never has to change
 * between frames. */
export function viewportRows(stdout: { rows?: number }): number {
  return stdout.rows ?? 24;
}

export function formatDuration(seconds: number | "unknown"): string {
  if (seconds === "unknown") return "unknown";
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
