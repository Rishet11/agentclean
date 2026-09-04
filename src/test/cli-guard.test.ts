import assert from "node:assert/strict";
import test from "node:test";
import { requiresExplicitPlan } from "../cli.js";

type Input = Parameters<typeof requiresExplicitPlan>[0];

const base: Input = { autoOnly: false, yes: false, plan: undefined, category: undefined, provider: undefined, isTty: false };

const cases: Array<{ name: string; input: Input; ok: boolean }> = [
  // The live bug: --yes in an interactive terminal with no --plan must still be refused.
  { name: "interactive --yes with no plan is refused", input: { ...base, yes: true, isTty: true }, ok: false },
  { name: "non-interactive --yes with no plan is refused", input: { ...base, yes: true, isTty: false }, ok: false },
  { name: "--yes with --plan is allowed, interactive or not", input: { ...base, yes: true, plan: "plan.json", isTty: true }, ok: true },
  { name: "--yes with --plan is allowed, non-interactive", input: { ...base, yes: true, plan: "plan.json", isTty: false }, ok: true },
  { name: "auto --once is allowed without --plan or --yes", input: { ...base, autoOnly: true }, ok: true },
  { name: "auto --once with --yes is allowed", input: { ...base, autoOnly: true, yes: true }, ok: true },
  { name: "interactive, no --yes, no --plan is allowed (will prompt)", input: { ...base, isTty: true }, ok: true },
  { name: "non-interactive, no --yes, no --plan is refused (nothing can confirm)", input: { ...base, isTty: false }, ok: false },
  { name: "--category alone does not make --yes legal", input: { ...base, yes: true, category: "ai-history", isTty: true }, ok: false },
  { name: "--provider alone does not make --yes legal", input: { ...base, yes: true, provider: "git", isTty: true }, ok: false },
  { name: "--category and --provider together still refuse --yes", input: { ...base, yes: true, category: "ai-history", provider: "git", isTty: true }, ok: false },
];

for (const { name, input, ok } of cases) {
  test(`requiresExplicitPlan: ${name}`, () => {
    const result = requiresExplicitPlan(input);
    assert.equal(result.ok, ok);
    if (!result.ok) assert.ok(result.message.length > 0);
  });
}

test("clean --category ai-history --yes is refused, not silently allowed", () => {
  const result = requiresExplicitPlan({ autoOnly: false, yes: true, plan: undefined, category: "ai-history", provider: undefined, isTty: true });
  assert.equal(result.ok, false);
});
