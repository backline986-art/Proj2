// A BUNDLE'S fills= COUNTER IS VETOED BY THE RUN'S OWN VERDICT (#131 round 2).
//
// rescoreBenchmark reads a run bundle after the fact: the page traces' `fills=N` are the only
// record of substantive work, and they count ATTEMPTS. The run's closing message is the authority
// on what survived: "no steps recorded", "nothing fillable" — and, since #131, "recorded N
// step(s), none of which entered form data" (a walk whose only fills were the e-signature). The
// veto on that sentence is what keeps a signer-only run on reached_form instead of
// recorded_steps, the rung the headline counts as a usable recipe.
//
// KILL TEST: narrow rescoreBenchmark's saidNothingRecorded regex back to
//   /no steps recorded|nothing fillable/ -> (2) fails (substantiveSteps 2, rung recorded_steps).
//
// Browser-free. Run: npx tsx backend/test/rescoreBenchmark.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { outcomeFromBundle } = await import("../src/rescoreBenchmark");
const { scoreLearnOutcome } = await import("../src/learnBenchmark");

let passed = 0;
let failed = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); passed++; console.log(`ok   ${label}`); }
  catch (err) { failed++; console.error(`FAIL - ${label}\n       ${err instanceof Error ? err.message : String(err)}`); }
};

/** A run bundle as learnDebug writes it: one page event per page (trace line), result.json last. */
function bundle(tag: string, message: string, traces: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rescore-${tag}-`));
  const events = [
    { type: "login", status: "logged_in" },
    { type: "application_entry_pass", ok: true },
    ...traces.map((trace, i) => ({ type: "page", page: i + 1, trace })),
  ];
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({
    status: "failed", ok: false, pageCount: traces.length, message,
    recipe: { steps: [{ action: "goto" }, { action: "click" }, { action: "check" }, { action: "fill" }, { action: "fill" }] },
  }));
  return dir;
}

const HOME = 'p1 "Permits Home" [https://portal.example/home] fields=0 fills=0 review=false';
const FORM = 'p2 "Solar Permit" [https://portal.example/new-permit/600] fields=6 fills=2 review=false';

check("(1) control: a run whose verdict does not deny its fills keeps them (recorded_steps)", () => {
  const dir = bundle("fills", "Auto-learn walked 2 page(s) and filled 1 of 2 page(s); it did not reach a review screen.", [HOME, FORM]);
  const outcome = outcomeFromBundle(dir);
  assert.ok(outcome, "the bundle reads");
  assert.equal(outcome.substantiveSteps, 2);
  assert.equal(scoreLearnOutcome(outcome).rung, "recorded_steps");
});

check("(2) a signer-only run: fills=2 on the trace, but the verdict says none entered form data -> 0, reached_form", () => {
  // City of Star: the trace counted the two e-signature boxes as fills; the recipe holds a goto,
  // a click, the type-signature switch and two signer fills — no data of this project's.
  const dir = bundle("signer", "Auto-learn walked 2 page(s) and recorded 5 step(s), none of which entered form data (the e-signature, navigation and acknowledgments only); it did not reach a review screen.", [HOME, FORM]);
  const outcome = outcomeFromBundle(dir);
  assert.ok(outcome, "the bundle reads");
  assert.equal(outcome.substantiveSteps, 0, "the run's own verdict vetoes the attempt counter");
  const score = scoreLearnOutcome(outcome);
  assert.equal(score.rung, "reached_form", `a run that filled nothing is not a usable recipe: ${score.reason}`);
  assert.match(score.reason, /filled NO fields/);
});

check("(3) the older verdicts still veto: 'no steps recorded' and 'nothing fillable'", () => {
  for (const msg of ["Auto-learn found nothing fillable on 2 page(s); no steps recorded", "Walked 2 page(s); nothing fillable was identified"]) {
    const outcome = outcomeFromBundle(bundle("old", msg, [HOME, FORM]));
    assert.equal(outcome?.substantiveSteps, 0, msg);
  }
});

console.log(`\n${passed} passed, ${failed} failed of ${passed + failed} rescore-benchmark checks.`);
if (failed) process.exit(1);
