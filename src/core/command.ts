import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Environment variables that re-point git at a different repository than the
 * one implied by cwd. Git sets several of these for the processes it spawns,
 * so anything running inside a hook, a `rebase -x`, a `filter-branch` or a
 * merge driver inherits them.
 *
 * That is a safety problem here, not a tidiness one: with GIT_DIR set,
 * `git status --porcelain` run against a worktree path reports the *other*
 * repository's status, so a worktree holding uncommitted work can read as
 * clean, and `git worktree remove` can act on a repository the user never
 * pointed us at. Every git invocation must resolve purely from its cwd.
 */
const gitScopeVariables = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_NAMESPACE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_VERSION",
];

export function scrubbedEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source };
  for (const name of gitScopeVariables) delete environment[name];
  // A scheduled or non-interactive run must never block on a credential prompt.
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

export async function runCommand(command: string[], cwd?: string, timeoutMs = 30_000): Promise<CommandResult> {
  if (command.length === 0) throw new Error("empty command");
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: scrubbedEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: 124, stdout, stderr });
    }, timeoutMs);
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 4_000_000) child.kill();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 1_000_000) child.kill();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}
