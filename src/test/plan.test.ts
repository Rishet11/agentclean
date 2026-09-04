import assert from "node:assert/strict";
import test from "node:test";
import { createPlan, verifyPlan } from "../core/plan.js";

test("plan hash detects edits", () => {
  const plan = createPlan([], ["/safe-root"], 1, { policyHash: "policy", platform: process.platform, home: "/home", providerIds: [] });
  assert.equal(verifyPlan(plan), true);
  plan.roots.push("/unexpected-root");
  assert.equal(verifyPlan(plan), false);
});
