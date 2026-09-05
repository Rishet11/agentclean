import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { runCommand } from "../core/command.js";
import { homePath, stateDir } from "../core/paths.js";

export interface SchedulerStatus {
  installed: boolean;
  details: string;
  platform: NodeJS.Platform;
  // Reserved for a future next-fire-time estimate. Neither platform's status
  // check populates it today: launchctl print's output is explicitly
  // undocumented ("NOT API in any sense"), and computing it independently
  // would add untested calendar-math this change doesn't need.
  nextRun?: string;
}

/**
 * Shared shape for every file-body renderer below. Each renderer only reads
 * the fields it needs (the systemd timer, for instance, never references
 * `executable`/`script`) - the point of a single shared shape is that tests
 * can build one fixture and pass it through all three.
 */
export interface SchedulerRenderOptions {
  label: string;
  executable: string;
  script: string;
  interval: "daily" | "weekly";
  logPath: string;
}

const windowsTaskName = "AgentClean";
// Reverse-DNS launchd label. Uses the GitHub-hosted-project convention
// (io.github.<owner>.<repo>) rather than presuming ownership of a
// agentclean.com domain, which nothing here establishes.
const launchdLabel = "io.github.rishet11.agentclean.auto";
const systemdUnitName = "agentclean-auto";

// This is a disk-walking job; it must never contend with the user for I/O or
// CPU. Nice=19 and IOSchedulingClass=idle are each platform's most
// deprioritized setting.
const niceValue = 19;
// No time-of-day is mandated by spec for launchd (systemd's OnCalendar=daily
// /weekly shorthand has its own built-in default of midnight). 03:00 local
// time is an assumption: an off-hours default that still fires the same day
// it's installed if that time has already passed today, and pushed out to
// the next matching day otherwise.
const calendarHour = 3;
const calendarMinute = 0;
// 0 and 7 both mean Sunday in launchd.plist's StartCalendarInterval; cron
// agrees 0 is Sunday, so the same constant serves both.
const calendarWeekday = 0;
// Spreads installs so they don't all fire the same instant.
const randomizedDelaySeconds = 1800;

function parseInterval(interval: string): "daily" | "weekly" {
  if (interval === "daily" || interval === "weekly") return interval;
  throw new Error("interval must be daily or weekly");
}

function unsupportedPlatformMessage(): string {
  return `automatic scheduling is not supported on ${process.platform}; run "agentclean auto --once" from your own cron job instead`;
}

function cronScheduleField(interval: "daily" | "weekly"): string {
  return interval === "weekly" ? `${calendarMinute} ${calendarHour} * * ${calendarWeekday}` : `${calendarMinute} ${calendarHour} * * *`;
}

// crontab lines are handed to /bin/sh, so this is real shell quoting (unlike
// the argv-array quoting used everywhere else in this file) - single quotes,
// with the standard close-escape-reopen trick for an embedded quote.
function quoteForCrontabDisplay(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function cronFallbackMessage(executable: string, script: string, interval: "daily" | "weekly"): string {
  const line = `${cronScheduleField(interval)} ${quoteForCrontabDisplay(executable)} ${quoteForCrontabDisplay(script)} auto --once`;
  return `no supported scheduler is available on this system; run "crontab -e" and add:\n${line}`;
}

// ---------------------------------------------------------------------------
// macOS: launchd
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  // Order matters: '&' must be escaped first, or the '&' introduced by the
  // '<'/'>' replacements below would themselves get mangled on a second pass.
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function xmlString(value: string): string {
  return `<string>${escapeXml(value)}</string>`;
}

export function renderLaunchdPlist(options: SchedulerRenderOptions): string {
  const calendarKeys = [`      <key>Hour</key>\n      <integer>${calendarHour}</integer>`, `      <key>Minute</key>\n      <integer>${calendarMinute}</integer>`];
  if (options.interval === "weekly") calendarKeys.push(`      <key>Weekday</key>\n      <integer>${calendarWeekday}</integer>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${xmlString(options.label)}
  <key>ProgramArguments</key>
  <array>
    ${xmlString(options.executable)}
    ${xmlString(options.script)}
    ${xmlString("auto")}
    ${xmlString("--once")}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
${calendarKeys.join("\n")}
  </dict>
  <key>ProcessType</key>
  ${xmlString("Background")}
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>${niceValue}</integer>
  <key>StandardOutPath</key>
  ${xmlString(options.logPath)}
  <key>StandardErrorPath</key>
  ${xmlString(options.logPath)}
</dict>
</plist>
`;
}

function launchAgentsDir(): string {
  return homePath("Library", "LaunchAgents");
}

function launchdPlistPath(): string {
  return path.join(launchAgentsDir(), `${launchdLabel}.plist`);
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function installLaunchd(executable: string, script: string, interval: "daily" | "weekly"): Promise<void> {
  const getuid = process.getuid;
  if (!getuid) throw new Error("cannot determine current user id");
  const uid = getuid();
  const logPath = path.join(stateDir(), "scheduler.log");
  await mkdir(stateDir(), { recursive: true });
  await mkdir(launchAgentsDir(), { recursive: true });
  const plistPath = launchdPlistPath();
  const plist = renderLaunchdPlist({ label: launchdLabel, executable, script, interval, logPath });

  // Remove any stale registration under this label first; a `bootstrap` over
  // an already-loaded label fails with "service already loaded". Nothing was
  // necessarily loaded yet (first install), so this failure is expected and
  // ignored unconditionally, as instructed.
  await runCommand(["launchctl", "bootout", `gui/${uid}/${launchdLabel}`], undefined, 15_000).catch(() => undefined);

  await writeFile(plistPath, plist, "utf8");

  const bootstrap = await runCommand(["launchctl", "bootstrap", `gui/${uid}`, plistPath], undefined, 15_000);
  if (bootstrap.code === 0) return;
  // Fallback for systems predating the bootstrap/bootout verbs (pre-El Capitan).
  // A real bootstrap failure (bad plist, permissions) can plausibly fail load
  // too, so surface both messages rather than letting load's - which may just
  // be "verb not recognized" - hide the more diagnostic bootstrap error.
  const load = await runCommand(["launchctl", "load", "-w", plistPath], undefined, 15_000);
  if (load.code !== 0) {
    const detail = [bootstrap.stderr.trim(), load.stderr.trim()].filter(Boolean).join(" / ");
    throw new Error(detail || "could not load LaunchAgent");
  }
}

async function uninstallLaunchd(): Promise<void> {
  const getuid = process.getuid;
  if (!getuid) throw new Error("cannot determine current user id");
  const uid = getuid();
  const plistPath = launchdPlistPath();

  const bootout = await runCommand(["launchctl", "bootout", `gui/${uid}/${launchdLabel}`], undefined, 15_000);
  if (bootout.code !== 0) {
    const unload = await runCommand(["launchctl", "unload", plistPath], undefined, 15_000).catch(() => undefined);
    if (unload && unload.code !== 0 && (await fileExists(plistPath))) {
      throw new Error(unload.stderr.trim() || bootout.stderr.trim() || "could not unload LaunchAgent");
    }
  }
  await rm(plistPath, { force: true });
}

async function darwinStatus(platform: NodeJS.Platform): Promise<SchedulerStatus> {
  const getuid = process.getuid;
  if (!getuid) return { installed: false, details: "cannot determine current user id", platform };
  const uid = getuid();
  const result = await runCommand(["launchctl", "print", `gui/${uid}/${launchdLabel}`], undefined, 15_000).catch(() => undefined);
  return result && result.code === 0 ? { installed: true, details: launchdLabel, platform } : { installed: false, details: "not installed", platform };
}

// ---------------------------------------------------------------------------
// Linux: systemd --user
// ---------------------------------------------------------------------------

function escapePercent(value: string): string {
  return value.replaceAll("%", "%%");
}

// systemd's ExecStart= splits on whitespace like a limited shell unless an
// argument is quoted; '&', unlike in a real shell or in XML, has no special
// meaning here at all. '%' does: it prefixes specifier expansion (%h, %i,
// ...), so a literal '%' must be doubled or newer systemd rejects the unit.
function quoteSystemdArg(value: string): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `"${escapePercent(escaped)}"`;
}

export function renderSystemdService(options: SchedulerRenderOptions): string {
  const execStart = [options.executable, options.script, "auto", "--once"].map(quoteSystemdArg).join(" ");
  return `[Unit]
Description=agentclean scheduled cleanup (${escapePercent(options.label)})

[Service]
Type=oneshot
Nice=${niceValue}
IOSchedulingClass=idle
ExecStart=${execStart}
`;
}

export function renderSystemdTimer(options: SchedulerRenderOptions): string {
  const onCalendar = options.interval === "weekly" ? "weekly" : "daily";
  return `[Unit]
Description=agentclean scheduled cleanup timer (${escapePercent(options.label)})

[Timer]
OnCalendar=${onCalendar}
Persistent=true
RandomizedDelaySec=${randomizedDelaySeconds}

[Install]
WantedBy=timers.target
`;
}

function systemdUserDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "systemd", "user");
}

function systemdServicePath(dir: string): string {
  return path.join(dir, `${systemdUnitName}.service`);
}

function systemdTimerPath(dir: string): string {
  return path.join(dir, `${systemdUnitName}.timer`);
}

/**
 * `systemctl --user --version` only proves the binary exists, not that a
 * user D-Bus/systemd instance is reachable - true in minimal containers and
 * bare SSH sessions with no login session (no pam_systemd, no
 * XDG_RUNTIME_DIR). `is-system-running` actually talks to the bus, so its
 * failure mode distinguishes "no user instance" from every other state
 * (running, degraded, starting, ...), all of which mean the bus answered.
 */
async function systemdUserAvailable(): Promise<boolean> {
  if (!process.env.XDG_RUNTIME_DIR) return false;
  const result = await runCommand(["systemctl", "--user", "is-system-running"], undefined, 10_000).catch(() => undefined);
  if (!result) return false;
  if (/failed to connect/i.test(result.stderr)) return false;
  return true;
}

async function installSystemd(executable: string, script: string, interval: "daily" | "weekly"): Promise<void> {
  const dir = systemdUserDir();
  await mkdir(dir, { recursive: true });
  // Unlike launchd, a systemd --user service logs to the journal
  // automatically (journalctl --user -u agentclean-auto); there is no
  // explicit log file to wire up, so logPath is left unused here.
  const service = renderSystemdService({ label: systemdUnitName, executable, script, interval, logPath: "" });
  const timer = renderSystemdTimer({ label: systemdUnitName, executable, script, interval, logPath: "" });
  await writeFile(systemdServicePath(dir), service, "utf8");
  await writeFile(systemdTimerPath(dir), timer, "utf8");

  const reload = await runCommand(["systemctl", "--user", "daemon-reload"], undefined, 15_000);
  if (reload.code !== 0) throw new Error(reload.stderr.trim() || "could not reload systemd user units");

  const enable = await runCommand(["systemctl", "--user", "enable", "--now", `${systemdUnitName}.timer`], undefined, 15_000);
  if (enable.code !== 0) throw new Error(enable.stderr.trim() || "could not enable systemd timer");
}

// systemctl's own exit-status table documents 4 ("no such unit") for a
// status-style query against a unit that doesn't exist; matched together
// with a text fallback since not every systemd version is guaranteed to
// surface exactly that code for `disable --now`.
function isMissingUnit(result: { code: number; stderr: string } | undefined): boolean {
  if (!result) return false;
  return result.code === 4 || /no such file or directory|does not exist|not loaded/i.test(result.stderr);
}

async function uninstallSystemd(): Promise<void> {
  const dir = systemdUserDir();
  const disable = await runCommand(["systemctl", "--user", "disable", "--now", `${systemdUnitName}.timer`], undefined, 15_000).catch(() => undefined);
  if (disable && disable.code !== 0 && !isMissingUnit(disable)) {
    throw new Error(disable.stderr.trim() || "could not disable systemd timer");
  }
  await rm(systemdTimerPath(dir), { force: true });
  await rm(systemdServicePath(dir), { force: true });
  await runCommand(["systemctl", "--user", "daemon-reload"], undefined, 15_000).catch(() => undefined);
}

async function linuxStatus(platform: NodeJS.Platform): Promise<SchedulerStatus> {
  if (!(await systemdUserAvailable())) return { installed: false, details: "systemd --user is not available on this system", platform };
  const result = await runCommand(["systemctl", "--user", "is-active", `${systemdUnitName}.timer`], undefined, 15_000).catch(() => undefined);
  const active = result?.code === 0 && result.stdout.trim() === "active";
  return active ? { installed: true, details: `${systemdUnitName}.timer`, platform } : { installed: false, details: "not installed", platform };
}

// ---------------------------------------------------------------------------
// Windows: Task Scheduler (unchanged)
// ---------------------------------------------------------------------------

function taskCommand(executable: string, script: string): string {
  const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`;
  return `${quote(executable)} ${quote(script)} auto --once`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function installScheduler(executable: string, script: string, interval: string): Promise<void> {
  if (!path.isAbsolute(executable) || !path.isAbsolute(script)) throw new Error("scheduled executable and script must be absolute paths");
  const parsedInterval = parseInterval(interval);

  if (process.platform === "win32") {
    const schedule = parsedInterval === "daily" ? "DAILY" : "WEEKLY";
    const result = await runCommand(["schtasks", "/Create", "/F", "/SC", schedule, "/TN", windowsTaskName, "/TR", taskCommand(executable, script), "/RL", "LIMITED"], undefined, 30_000);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "could not install Task Scheduler task");
    return;
  }

  if (process.platform === "darwin") {
    await installLaunchd(executable, script, parsedInterval);
    return;
  }

  if (process.platform === "linux") {
    if (!(await systemdUserAvailable())) throw new Error(cronFallbackMessage(executable, script, parsedInterval));
    await installSystemd(executable, script, parsedInterval);
    return;
  }

  throw new Error(unsupportedPlatformMessage());
}

export async function uninstallScheduler(): Promise<void> {
  if (process.platform === "win32") {
    const result = await runCommand(["schtasks", "/Delete", "/F", "/TN", windowsTaskName], undefined, 30_000);
    if (result.code !== 0 && !/does not exist|cannot find/i.test(result.stderr)) throw new Error(result.stderr.trim() || "could not remove Task Scheduler task");
    return;
  }

  if (process.platform === "darwin") {
    await uninstallLaunchd();
    return;
  }

  if (process.platform === "linux") {
    if (!(await systemdUserAvailable())) throw new Error("systemd --user is not available on this system; there is no agentclean scheduler entry to remove here (if you added a crontab line yourself, remove it with \"crontab -e\")");
    await uninstallSystemd();
    return;
  }

  throw new Error(unsupportedPlatformMessage());
}

export async function schedulerStatus(): Promise<SchedulerStatus> {
  const platform = process.platform;

  if (platform === "win32") {
    const result = await runCommand(["schtasks", "/Query", "/TN", windowsTaskName], undefined, 30_000).catch(() => undefined);
    return result?.code === 0 ? { installed: true, details: windowsTaskName, platform } : { installed: false, details: "not installed", platform };
  }

  if (platform === "darwin") return await darwinStatus(platform);
  if (platform === "linux") return await linuxStatus(platform);

  return { installed: false, details: unsupportedPlatformMessage(), platform };
}
