import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(command: string[], cwd?: string, timeoutMs = 30_000): Promise<CommandResult> {
  if (command.length === 0) throw new Error("empty command");
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
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
