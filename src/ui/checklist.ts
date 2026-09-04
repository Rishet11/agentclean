import { emitKeypressEvents } from "node:readline";
import { formatBytes, humanReason, plainRestore, shortLabel } from "../core/output.js";
import type { ReportRow, ReportModel } from "../core/report.js";
import type { RestoreTier } from "../core/types.js";
import { tierLabel } from "../core/tiers.js";
import { bold, colorEnabled, dim, gray, yellow } from "./style.js";
import { formatDuration, padRight, truncateToWidth, viewportRows } from "./layout.js";

/**
 * Interactive checklist over an already-built `ReportModel`. Four mechanics
 * verified against Node's real readline keypress decoder (see report to the
 * caller / brief) rather than assumed:
 *
 *  1. A lone ESC emits no keypress event at all (readline holds `\x1b`
 *     waiting for a possible escape sequence), so ESC cannot be the abort
 *     key. `q` and ctrl+c are.
 *  2. Raw mode suppresses SIGINT: ctrl+c arrives as a normal keypress event
 *     (`{ name: "c", ctrl: true }`), not a process signal, and must be
 *     handled explicitly.
 *  3. `?` (and other bare punctuation) has `key.name === undefined`; every
 *     binding below matches on `key.sequence` (falling back to the raw
 *     decoded string) instead of `key.name`, except the small set of named
 *     control keys (arrows, enter) that have no printable sequence of their
 *     own.
 *  4. `emitKeypressEvents` + a fake `isTTY: true` works on a plain
 *     `PassThrough`, which is what makes this whole module unit-testable
 *     with no real terminal. `setRawMode` does not exist on a `PassThrough`,
 *     so every call to it is guarded with `typeof`.
 */

export type ChecklistStdin = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
};

export type ChecklistStdout = NodeJS.WritableStream & {
  isTTY?: boolean;
  rows?: number;
};

export interface ChecklistIO {
  stdin: ChecklistStdin;
  stdout: ChecklistStdout;
}

export interface ChecklistResult {
  selectedIds: Set<string>;
  aborted: boolean;
}

interface KeyEvent {
  sequence?: string;
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

type FocusItem = { kind: "header"; tier: RestoreTier; rows: ReportRow[] } | { kind: "row"; row: ReportRow };

const TIER_ORDER: RestoreTier[] = ["free", "cheap", "irreplaceable"];

function isRowEligible(row: ReportRow): boolean {
  return row.eligible;
}

function buildFocusItems(model: ReportModel): FocusItem[] {
  const items: FocusItem[] = [];
  for (const tier of TIER_ORDER) {
    const rows = model.rows.filter((row) => row.tier === tier);
    if (rows.length === 0) continue;
    items.push({ kind: "header", tier, rows });
    for (const row of rows) items.push({ kind: "row", row });
  }
  return items;
}

/** Everything with a documented way back (free + cheap) starts ticked;
 * irreplaceable never does, and a blocked row is never selectable at all. */
function defaultSelection(model: ReportModel): Set<string> {
  const ids = new Set<string>();
  for (const row of model.rows) {
    if (!isRowEligible(row)) continue;
    if (row.tier === "free" || row.tier === "cheap") for (const id of row.candidateIds) ids.add(id);
  }
  return ids;
}

function rowFullySelected(row: ReportRow, selected: Set<string>): boolean {
  return row.candidateIds.length > 0 && row.candidateIds.every((id) => selected.has(id));
}

function rowNoneSelected(row: ReportRow, selected: Set<string>): boolean {
  return row.candidateIds.every((id) => !selected.has(id));
}

function rowSymbol(row: ReportRow, selected: Set<string>): string {
  if (!isRowEligible(row)) return "[-]";
  return rowFullySelected(row, selected) ? "[x]" : "[ ]";
}

function tierSymbol(rows: ReportRow[], selected: Set<string>): string {
  const eligibleRows = rows.filter(isRowEligible);
  if (eligibleRows.length === 0) return "[ ]";
  if (eligibleRows.every((row) => rowFullySelected(row, selected))) return "[x]";
  if (eligibleRows.every((row) => rowNoneSelected(row, selected))) return "[ ]";
  return "[~]";
}

export async function runChecklist(model: ReportModel, io: ChecklistIO): Promise<ChecklistResult> {
  if (!io.stdin.isTTY || !io.stdout.isTTY) return { selectedIds: new Set(), aborted: true };

  const items = buildFocusItems(model);
  const selected = defaultSelection(model);
  const colorOn = colorEnabled(io.stdout);
  const canRawMode = typeof io.stdin.setRawMode === "function";

  let cursor = items.findIndex((item) => item.kind === "row");
  if (cursor < 0) cursor = 0;
  let scrollTop = 0;
  let message = "";
  let previousLineHeight = 0;

  function clampCursor(value: number): number {
    if (items.length === 0) return 0;
    return Math.max(0, Math.min(items.length - 1, value));
  }

  function tierAt(index: number): RestoreTier | undefined {
    const item = items[index];
    if (!item) return undefined;
    return item.kind === "header" ? item.tier : item.row.tier;
  }

  function toggleTier(tier: RestoreTier): void {
    const rows = model.rows.filter((row) => row.tier === tier);
    const eligibleRows = rows.filter(isRowEligible);
    if (eligibleRows.length === 0) return;
    const allSelected = eligibleRows.every((row) => rowFullySelected(row, selected));
    for (const row of eligibleRows) {
      for (const id of row.candidateIds) {
        if (allSelected) selected.delete(id);
        else selected.add(id);
      }
    }
  }

  function toggleFocused(): void {
    const item = items[cursor];
    if (!item) return;
    if (item.kind === "header") {
      toggleTier(item.tier);
      return;
    }
    const row = item.row;
    if (!isRowEligible(row)) {
      message = `kept: ${row.blockers.map(humanReason).join(", ") || "not eligible"}`;
      return;
    }
    const nowSelected = !rowFullySelected(row, selected);
    for (const id of row.candidateIds) {
      if (nowSelected) selected.add(id);
      else selected.delete(id);
    }
  }

  function selectFreeOnly(): void {
    selected.clear();
    for (const row of model.rows) {
      if (row.tier === "free" && isRowEligible(row)) for (const id of row.candidateIds) selected.add(id);
    }
  }

  function selectedBytes(): number {
    return model.rows.filter((row) => rowFullySelected(row, selected)).reduce((sum, row) => sum + row.bytes, 0);
  }

  function buildHeaderLine(tier: RestoreTier, rows: ReportRow[], focused: boolean): string {
    const subtotal = model.tierSubtotals.find((entry) => entry.tier === tier);
    const marker = focused ? "> " : "  ";
    const symbol = tierSymbol(rows, selected);
    const text = `${marker}${symbol} ${tierLabel[tier]} - ${subtotal?.count ?? 0} item(s), ${formatBytes(subtotal?.bytes ?? 0)}`;
    return bold(text, colorOn);
  }

  function buildRowLine(row: ReportRow, focused: boolean): string {
    const marker = focused ? ">   " : "    ";
    const symbol = rowSymbol(row, selected);
    const size = padRight(formatBytes(row.bytes), 10);
    const method = padRight(truncateToWidth(plainRestore(row) || "cannot be undone", 28), 28);
    const time = padRight(`~${formatDuration(row.restoreSeconds)}`, 6);
    const suffix = row.count > 1 ? ` (x${row.count})` : "";
    const label = `${truncateToWidth(shortLabel(row), 40)}${suffix}`;
    const line = `${marker}${symbol} ${size} ${method} ${time} ${label}`;
    if (!isRowEligible(row)) return dim(`${line}  [kept: ${row.blockers.map(humanReason).join(", ")}]`, colorOn);
    return line;
  }

  function buildFrame(): string[] {
    const total = viewportRows(io.stdout);
    const reserved = 5; // title, totals, blank separator, message, help
    const bodyHeight = Math.max(1, total - reserved);
    if (cursor < scrollTop) scrollTop = cursor;
    if (cursor >= scrollTop + bodyHeight) scrollTop = cursor - bodyHeight + 1;
    scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, items.length - bodyHeight)));

    const lines: string[] = [];
    lines.push(bold("agentclean - select what to remove", colorOn));
    lines.push(`Selected: ${selected.size} item(s), ${formatBytes(selectedBytes())} of ${formatBytes(model.eligibleBytes)} eligible`);
    lines.push("");
    for (let offset = 0; offset < bodyHeight; offset += 1) {
      const index = scrollTop + offset;
      const item = items[index];
      if (!item) {
        lines.push("");
        continue;
      }
      const focused = index === cursor;
      lines.push(item.kind === "header" ? buildHeaderLine(item.tier, item.rows, focused) : buildRowLine(item.row, focused));
    }
    lines.push(message ? yellow(message, colorOn) : "");
    lines.push(gray("up/down (k/j) move  space toggle  a group  f free-only  n none  enter accept  q/ctrl+c abort", colorOn));
    return lines;
  }

  function render(): void {
    const frame = buildFrame();
    const text = `${frame.join("\n")}\n`;
    const cursorUp = previousLineHeight > 0 ? `\x1b[${previousLineHeight}A` : "";
    io.stdout.write(cursorUp + text);
    previousLineHeight = frame.length;
  }

  if (canRawMode) io.stdin.setRawMode?.(true);
  emitKeypressEvents(io.stdin);
  io.stdin.resume();
  io.stdout.write("\x1b[?25l"); // hide cursor for the duration of the checklist

  let removeKeypressListener: (() => void) | undefined;

  try {
    return await new Promise<ChecklistResult>((resolve) => {
      let settled = false;
      const finish = (result: ChecklistResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const onKeypress = (str: string | undefined, key: KeyEvent = {}) => {
        if (settled) return;
        message = "";
        if (key.ctrl && key.name === "c") {
          finish({ selectedIds: new Set(), aborted: true });
          return;
        }
        const seq = key.sequence ?? str ?? "";
        if (seq === "q") {
          finish({ selectedIds: new Set(), aborted: true });
          return;
        }
        if (key.name === "return" || seq === "\r" || seq === "\n") {
          finish({ selectedIds: new Set(selected), aborted: false });
          return;
        }
        if (key.name === "up" || seq === "k") cursor = clampCursor(cursor - 1);
        else if (key.name === "down" || seq === "j") cursor = clampCursor(cursor + 1);
        else if (seq === " ") toggleFocused();
        else if (seq === "a") { const tier = tierAt(cursor); if (tier) toggleTier(tier); }
        else if (seq === "f") selectFreeOnly();
        else if (seq === "n") selected.clear();
        render();
      };
      io.stdin.on("keypress", onKeypress);
      removeKeypressListener = () => io.stdin.removeListener("keypress", onKeypress);
      render();
    });
  } finally {
    removeKeypressListener?.();
    if (canRawMode) io.stdin.setRawMode?.(false);
    io.stdout.write("\x1b[?25h\n");
  }
}
