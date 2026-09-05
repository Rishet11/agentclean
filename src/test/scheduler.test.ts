import assert from "node:assert/strict";
import test from "node:test";
import { installScheduler, renderLaunchdPlist, renderSystemdService, renderSystemdTimer, uninstallScheduler, type SchedulerRenderOptions } from "../platform/scheduler.js";

// Mirrors the local helper already used in ai-providers.test.ts: process.platform
// is a getter-backed property, so it must be swapped via defineProperty and
// restored, not assigned directly.
async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

// A single path carrying every character that's easy to get wrong: a space
// (breaks naive whitespace-splitting), an '&' (must become &amp; in the
// plist or the XML is invalid), a '%' (systemd specifier prefix - a literal
// one must be doubled or a modern systemd rejects the unit), a '<' and '>'
// (must become &lt;/&gt; in the plist, and must not be escaped in a way that
// double-escapes the '&' beside them), and a '"' and '\' (systemd quoting
// delimiters - escaping them in the wrong order corrupts the argument).
const trickyExecutable = "/usr/local/bin/node & friends/node";
const trickyScript = '/Users/test user/Projects & Co 100% <Ltd> "quoted" \\backslash/agentclean/dist/cli.js';

function baseOptions(interval: "daily" | "weekly"): SchedulerRenderOptions {
  return {
    label: "agentclean-auto",
    executable: trickyExecutable,
    script: trickyScript,
    interval,
    logPath: "/Users/test user/.local/state/agentclean/scheduler.log",
  };
}

function unescapeXml(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function extractPlistStrings(xml: string): string[] {
  return [...xml.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => unescapeXml(match[1]));
}

// Positional slicing across every <string> in the document is fragile - the
// Label key alone is one, ahead of ProgramArguments - so pull the array
// content out by key name first and only then extract its <string> entries.
function extractProgramArguments(xml: string): string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  assert.ok(array, "ProgramArguments array must be present");
  return extractPlistStrings(array![1]);
}

function quoteSystemdArgExpectation(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

// Independent of quoteSystemdArg's own replaceAll formula (a character-scan
// decode, not a mirror of the encoder) so that a real ordering bug - e.g.
// escaping '"' before '\', which would double-escape the backslash that
// introduces - shows up as a failed round trip rather than passing because
// both sides share the same mistake.
function unquoteSystemdExecStart(execValue: string): string[] {
  // Every embedded '"' inside a token is backslash-escaped, so a bare '"'
  // immediately followed by a space and another '"' only ever occurs at a
  // boundary between two adjacent quoted tokens.
  const pieces = execValue.split('" "');
  return pieces.map((piece, index) => {
    if (index === 0) piece = piece.slice(1);
    if (index === pieces.length - 1) piece = piece.slice(0, -1);
    let result = "";
    for (let i = 0; i < piece.length; i++) {
      if (piece[i] === "\\" && i + 1 < piece.length) {
        result += piece[i + 1];
        i++;
      } else {
        result += piece[i];
      }
    }
    return result.replaceAll("%%", "%");
  });
}

function assertWellFormedUnit(text: string): void {
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    assert.ok(/^\[[A-Za-z]+\]$/.test(line) || /^[A-Za-z][A-Za-z0-9]*=/.test(line), `unexpected unit-file line: ${JSON.stringify(line)}`);
  }
}

// ---------------------------------------------------------------------------
// launchd plist
// ---------------------------------------------------------------------------

test("renderLaunchdPlist produces well-formed, balanced XML with entities escaped", () => {
  const xml = renderLaunchdPlist(baseOptions("daily"));
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">/);
  assert.match(xml, /<plist version="1\.0">/);
  assert.equal((xml.match(/<dict>/g) || []).length, (xml.match(/<\/dict>/g) || []).length, "dict tags must balance");
  assert.equal((xml.match(/<array>/g) || []).length, (xml.match(/<\/array>/g) || []).length, "array tags must balance");
  assert.equal((xml.match(/<plist/g) || []).length, (xml.match(/<\/plist>/g) || []).length, "plist tags must balance");
  // Every literal '&' in the document must be part of a recognized entity -
  // a bare, unescaped '&' is exactly the failure mode that produces an
  // invalid plist and a job that silently never runs.
  assert.doesNotMatch(xml, /&(?!amp;|lt;|gt;)/, "no unescaped ampersand");
});

test("renderLaunchdPlist round-trips &, <, > through ProgramArguments via an independent XML decoder", () => {
  // extractProgramArguments/unescapeXml decode generically (they don't call
  // escapeXml), so if production escaped '<'/'>' before '&' - double-escaping
  // the '&' those entities introduce - the decode would not recover the
  // original string and this would fail, not pass by sharing the same bug.
  const xml = renderLaunchdPlist(baseOptions("weekly"));
  assert.deepEqual(extractProgramArguments(xml), [trickyExecutable, trickyScript, "auto", "--once"]);
});

test("renderLaunchdPlist: daily omits Weekday, weekly sets it, both set Hour/Minute", () => {
  const daily = renderLaunchdPlist(baseOptions("daily"));
  const weekly = renderLaunchdPlist(baseOptions("weekly"));
  assert.match(daily, /<key>Hour<\/key>\s*<integer>3<\/integer>/);
  assert.match(daily, /<key>Minute<\/key>\s*<integer>0<\/integer>/);
  assert.doesNotMatch(daily, /<key>Weekday<\/key>/);
  assert.match(weekly, /<key>Hour<\/key>\s*<integer>3<\/integer>/);
  assert.match(weekly, /<key>Minute<\/key>\s*<integer>0<\/integer>/);
  assert.match(weekly, /<key>Weekday<\/key>\s*<integer>0<\/integer>/);
});

test("renderLaunchdPlist sets low-priority keys, a log path, and never sets RunAtLoad", () => {
  const xml = renderLaunchdPlist(baseOptions("daily"));
  assert.match(xml, /<key>ProcessType<\/key>\s*<string>Background<\/string>/);
  assert.match(xml, /<key>LowPriorityIO<\/key>\s*<true\/>/);
  assert.match(xml, /<key>Nice<\/key>\s*<integer>\d+<\/integer>/);
  const logStrings = extractPlistStrings(xml).filter((value) => value === baseOptions("daily").logPath);
  assert.equal(logStrings.length, 2, "StandardOutPath and StandardErrorPath should both be present");
  assert.doesNotMatch(xml, /RunAtLoad/);
});

test("renderLaunchdPlist embeds the Label", () => {
  const xml = renderLaunchdPlist(baseOptions("daily"));
  assert.match(xml, /<key>Label<\/key>\s*<string>agentclean-auto<\/string>/);
});

// ---------------------------------------------------------------------------
// systemd service
// ---------------------------------------------------------------------------

test("renderSystemdService is a well-formed, low-priority oneshot unit", () => {
  const unit = renderSystemdService(baseOptions("daily"));
  assertWellFormedUnit(unit);
  assert.match(unit, /^\[Unit\]$/m);
  assert.match(unit, /^\[Service\]$/m);
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^IOSchedulingClass=idle$/m);
  assert.match(unit, /^Nice=\d+$/m);
});

test("renderSystemdService quotes ExecStart args and doubles a literal %, leaving & untouched", () => {
  const unit = renderSystemdService(baseOptions("daily"));
  const execLine = /^ExecStart=(.*)$/m.exec(unit);
  assert.ok(execLine, "ExecStart line must be present");
  const expected = [trickyExecutable, trickyScript, "auto", "--once"].map(quoteSystemdArgExpectation).join(" ");
  assert.equal(execLine![1], expected);
  // '&' needs no escaping in an ExecStart value (it isn't a shell), so it
  // must appear completely unchanged inside its quoted argument.
  assert.ok(execLine![1].includes("& friends"));
  // A literal '%' must be doubled or it is parsed as a specifier prefix.
  assert.ok(execLine![1].includes("100%%"));
});

test("renderSystemdService's ExecStart round-trips ', \\, and % through an independent unquoter", () => {
  // unquoteSystemdExecStart is a character-scan decode, not a mirror of
  // quoteSystemdArg's replaceAll formula, so a real ordering bug (escaping
  // '"' before '\', which would double-escape the backslash that introduces)
  // fails this round trip instead of passing because both sides agree.
  const unit = renderSystemdService(baseOptions("daily"));
  const execValue = /^ExecStart=(.*)$/m.exec(unit)![1];
  assert.deepEqual(unquoteSystemdExecStart(execValue), [trickyExecutable, trickyScript, "auto", "--once"]);
});

// ---------------------------------------------------------------------------
// systemd timer
// ---------------------------------------------------------------------------

test("renderSystemdTimer: daily vs weekly OnCalendar, with catch-up and jitter", () => {
  const daily = renderSystemdTimer(baseOptions("daily"));
  const weekly = renderSystemdTimer(baseOptions("weekly"));
  assertWellFormedUnit(daily);
  assertWellFormedUnit(weekly);
  assert.match(daily, /^OnCalendar=daily$/m);
  assert.match(weekly, /^OnCalendar=weekly$/m);
  for (const unit of [daily, weekly]) {
    assert.match(unit, /^Persistent=true$/m);
    assert.match(unit, /^RandomizedDelaySec=\d+$/m);
    assert.match(unit, /^\[Install\]$/m);
    assert.match(unit, /^WantedBy=timers\.target$/m);
  }
});

// ---------------------------------------------------------------------------
// The space-and-& path survives every renderer, not just the plist
// ---------------------------------------------------------------------------

test("a path with a space and an & survives intact through every renderer", () => {
  const options = baseOptions("weekly");

  const plist = renderLaunchdPlist(options);
  assert.deepEqual(extractProgramArguments(plist).slice(0, 2), [trickyExecutable, trickyScript]);

  const service = renderSystemdService(options);
  const execLine = /^ExecStart=(.*)$/m.exec(service)![1];
  assert.equal(execLine, [options.executable, options.script, "auto", "--once"].map(quoteSystemdArgExpectation).join(" "));

  // The timer never references executable/script at all; passing the same
  // tricky options through it must simply not throw and must still render a
  // well-formed unit.
  const timer = renderSystemdTimer(options);
  assertWellFormedUnit(timer);
  assert.match(timer, /^\[Timer\]$/m);
});

// ---------------------------------------------------------------------------
// Unsupported platform
// ---------------------------------------------------------------------------

test("installScheduler and uninstallScheduler throw a message naming the cron fallback on an unsupported platform", async () => {
  await withPlatform("freebsd", async () => {
    await assert.rejects(installScheduler("/usr/bin/node", "/opt/agentclean/dist/cli.js", "daily"), /cron/i);
    await assert.rejects(uninstallScheduler(), /cron/i);
  });
});

test("installScheduler still validates interval and absolute paths ahead of any platform-specific work", async () => {
  await withPlatform("freebsd", async () => {
    await assert.rejects(installScheduler("relative/node", "/opt/agentclean/dist/cli.js", "daily"), /absolute/i);
    await assert.rejects(installScheduler("/usr/bin/node", "/opt/agentclean/dist/cli.js", "monthly"), /daily or weekly/i);
  });
});
