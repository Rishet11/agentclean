// Discovers compiled test files and hands them to node --test as explicit
// paths. Node 20 cannot expand globs in --test, and cmd.exe never expands
// them, so neither a shell glob nor a quoted glob is portable.
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const testDir = path.join(process.cwd(), "dist", "test");
const entries = await readdir(testDir).catch(() => {
  console.error(`no compiled tests found at ${testDir}; run npm run build first`);
  process.exit(1);
});
const files = entries.filter((name) => name.endsWith(".test.js")).sort().map((name) => path.join(testDir, name));
if (files.length === 0) {
  console.error(`no *.test.js files in ${testDir}`);
  process.exit(1);
}
const child = spawn(process.execPath, ["--test", ...files, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
