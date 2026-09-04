import { formatBytes } from "../core/output.js";
import { truncateToWidth } from "./layout.js";

/**
 * `executePlan` (core/executor.ts, owned elsewhere) has no progress callback,
 * so this drives a live status line entirely from the outside: a single
 * `\r`-rewritten line on stdout, throttled to ~10Hz, showing the item
 * currently being processed and the running freed total. Silent on a
 * non-TTY (piped output, CI, `--json`) — there is nothing useful to overwrite
 * there, and a bare `\r` in a log file is worse than nothing.
 */

export interface ProgressStream extends NodeJS.WritableStream {
  isTTY?: boolean;
  columns?: number;
}

export interface ProgressReporter {
  /** Redraw the line for `itemLabel` (plain words) and `freedBytes` so far.
   * No-ops on a non-TTY stream, and drops calls faster than the throttle
   * window so a burst of fast items does not flood the terminal. */
  update(itemLabel: string, freedBytes: number): void;
  /** Erase the line before writing anything else (e.g. the final summary).
   * Safe to call repeatedly, and a no-op if nothing was ever drawn. */
  clear(): void;
}

const THROTTLE_MS = 100; // ~10Hz

/** Pure so it is easy to reason about / spot-check independent of timing or a real TTY. */
export function formatProgressLine(itemLabel: string, freedBytes: number, width: number): string {
  const text = `cleaning: ${itemLabel} · ${formatBytes(freedBytes)} freed so far`;
  return truncateToWidth(text, Math.max(10, width));
}

export function createProgress(output: ProgressStream, now: () => number = Date.now): ProgressReporter {
  const isTTY = Boolean(output.isTTY);
  let lastRenderAt = -Infinity;
  let hasDrawn = false;

  return {
    update(itemLabel, freedBytes) {
      if (!isTTY) return;
      const currentTime = now();
      if (currentTime - lastRenderAt < THROTTLE_MS) return;
      lastRenderAt = currentTime;
      hasDrawn = true;
      const width = (output.columns ?? 80) - 1;
      output.write(`\r${formatProgressLine(itemLabel, freedBytes, width)}`);
    },
    clear() {
      if (!isTTY || !hasDrawn) return;
      output.write("\r\x1b[2K");
      hasDrawn = false;
    },
  };
}
