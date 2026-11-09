// #340 — A RUNNING REPLAY CAN BE STOPPED: A PERSON'S CANCEL, OR NO PROGRESS FOR TOO LONG.
//
// Browser-free (a fake Playwright page, as recipeAdapter.test.ts does). Pins:
//   - cancel mid-run: the abort lands between steps and NOTHING further is filled or clicked; the
//     result names who cancelled; stopAtReview then hands nothing over and touches no page;
//   - the stall clock: a step that never returns is ended by the watchdog (it closes the page under
//     it), the run fails NAMING the step it was stuck on, and the steps after it never run;
//   - "progress" is a NEW (step, array pass): a run that keeps re-reaching the same step stalls;
//   - the budget is never unbounded (PORTAL_REPLAY_STALL_MINUTES; default 8).
//
// KILL TESTS:
//   K1 drop the checkReplayStop() call at the top of runAll's step loop → (a) fails (fills go on).
//   K2 drop startStopWatchdog() around runAll → (b) hangs until the test's own deadline and fails.
//   K3 make ReplayStallWatch.note() refresh on a repeated key → (c) fails.
//
//   npx tsx portal-bot/src/adapters/replayStopControl.test.ts
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";

process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-stop-test-"));
  process.env.REPLAY_CAPTURE_DIR = dir;
  process.env.REPLAY_RUN_DIR = path.join(dir, "runs");
  process.env.PORTAL_SCREENSHOT_DIR = path.join(dir, "screenshots");
}
const { RecipeAdapter } = await import("./recipeAdapter");
const { ReplayStallWatch, replayStallMsFromEnv, cancelRequestOf } = await import("./replayStopControl");

let failures = 0;
const check = async (label: string, fn: () => Promise<void> | void): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

interface Log { fills: string[]; clicks: string[]; closed: boolean; touchedAfterClose: number }

/** A fake page. `onFill(key)` runs before a fill is recorded; `hangOn` fills never return until the
 *  page is closed (then they throw, as Playwright does). */
function makePage(log: Log, opts: { onFill?: (key: string) => void; hangOn?: string } = {}) {
  let release: (() => void) | null = null;
  const closedGate = new Promise<void>((r) => { release = r; });
  const guard = () => { if (log.closed) { log.touchedAfterClose++; throw new Error("Target page, context or browser has been closed"); } };
  const locatorFor = (key: string): any => {
    const loc: any = {
      first: () => loc, nth: () => loc,
      count: async () => { guard(); return 1; },
      click: async () => { guard(); log.clicks.push(key); },
      fill: async () => {
        guard();
        if (opts.hangOn === key) { await closedGate; throw new Error("Target page, context or browser has been closed"); }
        opts.onFill?.(key);
        log.fills.push(key);
      },
      selectOption: async () => { guard(); }, check: async () => { guard(); }, uncheck: async () => { guard(); },
      press: async () => undefined, waitFor: async () => { guard(); }, setInputFiles: async () => undefined,
      evaluateAll: async () => [], innerText: async () => "",
    };
    return loc;
  };
  const page: any = {
    goto: async () => { guard(); }, waitForLoadState: async () => undefined, reload: async () => undefined,
    frames: () => [],
    getByRole: (role: string, o?: { name?: string }) => locatorFor(`role:${role}:${o?.name ?? ""}`),
    getByLabel: (label: string) => locatorFor(`label:${label}`),
    getByPlaceholder: (p: string) => locatorFor(`placeholder:${p}`),
    getByTestId: (t: string) => locatorFor(`testId:${t}`),
    getByText: (t: unknown) => (t instanceof RegExp ? { ...locatorFor("text:re"), count: async () => 0 } : locatorFor(`text:${String(t)}`)),
    locator: (css: string) => locatorFor(`css:${css}`),
    frameLocator: () => page,
    waitForFunction: async () => true,
    close: async () => { log.closed = true; release?.(); },
  };
  return page;
}

function recipe(steps: RecipeStep[]): PortalRecipe {
  return {
    id: "r340", scopeType: "utility", profileKey: "or||pacificorp", state: "OR", ahj: "", utility: "PacifiCorp",
    portalPlatform: "test", portalUrl: "", status: "complete", version: 1, steps,
    createdBy: "test", createdAt: "", updatedAt: "", notes: "",
  } as PortalRecipe;
}
const fill = (label: string): RecipeStep => ({ action: "fill", selector: { label }, field: `f${label}`, note: label } as RecipeStep);
const values: Record<string, string> = { fQty: "12", fManufacturer: "Qcells", fModel: "Q.TRON 430" };
const project = {} as ProjectRecord;

await check("(a) cancel mid-run stops at the next step boundary: nothing further is filled or clicked, the result names who, and stopAtReview hands nothing over", async () => {
  const log: Log = { fills: [], clicks: [], closed: false, touchedAfterClose: 0 };
  const ctrl = new AbortController();
  const steps = [fill("Qty"), fill("Manufacturer"), fill("Model"), { action: "click", selector: { role: "button", name: "Next" } } as RecipeStep, { action: "stopForReview" } as RecipeStep];
  const adapter = new RecipeAdapter(recipe(steps), values, {}, { abortSignal: ctrl.signal, stallTimeoutMs: 60_000 });
  (adapter as unknown as { page: unknown }).page = makePage(log, {
    // The person presses Stop while the FIRST fill is in flight.
    onFill: (key) => { if (key === "label:Qty") ctrl.abort({ by: "dana@keelix.test", at: "2026-11-09T17:00:00.000Z" }); },
  });
  const r = await adapter.fillApplication(project);
  assert.equal(r.ok, false, "a cancelled run read as reaching review");
  assert.deepEqual(log.fills, ["label:Qty"], `steps ran after the cancel: ${log.fills.join(", ")}`);
  assert.deepEqual(log.clicks, [], "a cancelled run clicked something");
  assert.match(String(r.message), /cancelled by dana@keelix\.test/);
  assert.match(String(r.message), /nothing was submitted/);
  const data = (r.data ?? {}) as { runCancelled?: { by: string; stepIndex: number } };
  assert.equal(data.runCancelled?.by, "dana@keelix.test");
  assert.equal(data.runCancelled?.stepIndex, 1, "the stop is not at the boundary after the step in flight");
  const before = log.fills.length + log.clicks.length;
  const review = await adapter.stopAtReview();
  assert.equal(review.ok, false, "a cancelled run was handed over at review");
  assert.ok((review.data as { runCancelled?: unknown }).runCancelled, "stopAtReview did not carry the cancel");
  assert.equal(log.fills.length + log.clicks.length, before, "stopAtReview acted on the page of a cancelled run");
});

await check("(a2) cancel while a step hangs: the watchdog closes the page under it, the run ends cancelled DURING that step, and nothing after it runs", async () => {
  const log: Log = { fills: [], clicks: [], closed: false, touchedAfterClose: 0 };
  const ctrl = new AbortController();
  const steps = [fill("Qty"), fill("Manufacturer"), fill("Model")];
  // The stall budget runs out well after the cancel lands, so the cancel is what ends the run.
  const adapter = new RecipeAdapter(recipe(steps), values, {}, { abortSignal: ctrl.signal, stallTimeoutMs: 400 });
  (adapter as unknown as { page: unknown }).page = makePage(log, { hangOn: "label:Manufacturer" });
  setTimeout(() => ctrl.abort({ by: "dana@keelix.test", at: "2026-11-09T17:00:00.000Z" }), 30);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"hung">((r) => { deadlineTimer = setTimeout(() => r("hung"), 20_000); });
  const r = await Promise.race([adapter.fillApplication(project), deadline]).finally(() => clearTimeout(deadlineTimer));
  assert.notEqual(r, "hung", "a cancel never ended a hung step");
  const res = r as Awaited<ReturnType<typeof adapter.fillApplication>>;
  assert.equal(res.ok, false);
  assert.equal(log.closed, true);
  assert.deepEqual(log.fills, ["label:Qty"]);
  assert.match(String(res.message), /cancelled by dana@keelix\.test .* during step 2/);
  assert.ok(((res.data ?? {}) as { runCancelled?: unknown }).runCancelled, "the hung-step cancel was not reported as a cancel");
});

await check("(b) the stall clock ends a run stuck on one step: the page is closed under it, the run fails naming the step, and later steps never run", async () => {
  const log: Log = { fills: [], clicks: [], closed: false, touchedAfterClose: 0 };
  const steps = [fill("Qty"), fill("Manufacturer"), fill("Model")];
  const adapter = new RecipeAdapter(recipe(steps), values, {}, { stallTimeoutMs: 150 });
  (adapter as unknown as { page: unknown }).page = makePage(log, { hangOn: "label:Manufacturer" });
  // A REF'D deadline: it keeps the event loop alive the way a live browser does (the watchdog is unref'd).
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"hung">((r) => { deadlineTimer = setTimeout(() => r("hung"), 20_000); });
  const r = await Promise.race([adapter.fillApplication(project), deadline]).finally(() => clearTimeout(deadlineTimer));
  assert.notEqual(r, "hung", "the stall watchdog never ended a hung step");
  const res = r as Awaited<ReturnType<typeof adapter.fillApplication>>;
  assert.equal(res.ok, false);
  assert.equal(log.closed, true, "the watchdog did not close the page under the hung step");
  assert.deepEqual(log.fills, ["label:Qty"], `steps ran after the stall: ${log.fills.join(", ")}`);
  assert.match(String(res.message), /^Replay stalled: no new step completed/);
  assert.match(String(res.message), /stuck on step 2 "Manufacturer"/);
  assert.match(String(res.message), /nothing was submitted/);
  assert.equal(((res.data ?? {}) as { replayStalled?: { stepIndex: number } }).replayStalled?.stepIndex, 1);
});

await check("(c) progress is a NEW (step, array pass): re-reaching the same step does not reset the clock, a new step or a new pass does", () => {
  let now = 0;
  const w = new ReplayStallWatch(8 * 60_000, () => now);
  assert.equal(w.note(5, 1, "Array 1 Qty"), true);
  for (let t = 1; t <= 9; t++) {
    now = t * 60_000;
    assert.equal(w.note(5, 1, "Array 1 Qty"), false, "a repeat of the same step counted as progress");
  }
  assert.ok((w.stalledMs() ?? 0) >= 8 * 60_000, "a run repeating one step for 9 minutes is not stalled");
  assert.match(w.message(), /stuck on step 6 "Array 1 Qty"/);
  assert.equal(w.note(5, 2, "Array 1 Qty"), true, "array pass 2 of the same step is new progress");
  assert.equal(w.stalledMs(), null);
  now += 7 * 60_000;
  assert.equal(w.note(6, 2, "Array 1 Model"), true);
  assert.equal(w.stalledMs(), null);
});

await check("(d) the budget is never unbounded: default 8 minutes; zero, negative or junk is the default; under a minute is a minute", () => {
  assert.equal(replayStallMsFromEnv({}), 8 * 60_000);
  assert.equal(replayStallMsFromEnv({ PORTAL_REPLAY_STALL_MINUTES: "0" }), 8 * 60_000);
  assert.equal(replayStallMsFromEnv({ PORTAL_REPLAY_STALL_MINUTES: "-3" }), 8 * 60_000);
  assert.equal(replayStallMsFromEnv({ PORTAL_REPLAY_STALL_MINUTES: "never" }), 8 * 60_000);
  assert.equal(replayStallMsFromEnv({ PORTAL_REPLAY_STALL_MINUTES: "0.2" }), 60_000);
  assert.equal(replayStallMsFromEnv({ PORTAL_REPLAY_STALL_MINUTES: "12" }), 12 * 60_000);
});

await check("(e) a signal that was not aborted is no cancel; a bare abort still stops the run, naming nobody", () => {
  assert.equal(cancelRequestOf(new AbortController().signal), null);
  assert.equal(cancelRequestOf(null), null);
  const c = new AbortController();
  c.abort();
  assert.equal(cancelRequestOf(c.signal)?.by, "an operator");
});

if (failures) { console.error(`\n${failures} replayStopControl check(s) FAILED.`); process.exit(1); }
console.log("\nAll replayStopControl checks passed.");
process.exit(0);
