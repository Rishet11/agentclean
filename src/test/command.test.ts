import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "../core/command.js";

test("commands use argument boundaries instead of a shell", async () => {
  const result = await runCommand([process.execPath, "-e", "process.stdout.write(process.argv[1])", "value with spaces; not shell code"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "value with spaces; not shell code");
});
