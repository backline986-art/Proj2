// #232 — THE CLOSING STEP TELLS EACH ENDING ITS OWN WAY, never "staged to the review screen" for a run
// that failed, paused, or never started.
//
// Browser-free (a fake page, as replayStopControl.test.ts does). The DOM smoke
// replayCloseAndBound.dom.smoke.ts drives the plain STOPPED ending through the real runner; these are
// the endings a fixture cannot reach without a live filing, a signer gap or an existing draft:
//   (a) an existing draft stops the run before it starts (openSubmission's site-draft read, #302):
//       "the recipe was NOT replayed — …", nothing staged, nothing submitted;
//   (b) a run that PAUSED for a person: "PAUSED for a person at step N of M", the step's reason;
//   (c) a run that got to its review marker and then failed: no "before reaching the review screen";
//   (d) a filing or draft-creating submit was attempted: never "Nothing was submitted" — the person
//       is told to check the portal first; an approved click whose request never left still is;
//   (e) a clean run keeps today's sentence.
//
// KILL TEST: main's recipeAdapter.ts (no replayEnd / endReplay) closes every one of these with
// "Human review required … The recipe staged … to the review screen", and (a)–(d) fail on it.
//
//   npx tsx portal-bot/src/adapters/replayCloseMessage.test.ts
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";

process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-close-test-"));
  process.env.REPLAY_CAPTURE_DIR = dir;
  process.env.REPLAY_RUN_DIR = path.join(dir, "runs");
  process.env.PORTAL_SCREENSHOT_DIR = path.join(dir, "screenshots");
}
const { RecipeAdapter } = await import("./recipeAdapter");

let failures = 0;
let passes = 0;
const check = async (label: string, fn: () => Promise<string | null>): Promise<void> => {
  let why: string | null;
  try { why = await fn(); } catch (e) { why = `threw: ${(e as Error).message}`; }
  if (why === null) { passes++; console.log(`  ok   - ${label}`); }
  else { failures++; console.error(`  FAIL - ${label}\n         ${why}`); }
};

const steps: RecipeStep[] = [
  { action: "goto", value: "https://portal.example.test/apply", note: "entry url" },
  { action: "fill", selector: { label: "Description of work" }, note: "Description of work", value: "Residential solar PV" },
  { action: "fill", selector: { label: "Signature" }, note: "Signature", field: "signerName" } as RecipeStep,
  { action: "stopForReview" },
];
const recipe: PortalRecipe = {
  id: "r232-close", scopeType: "utility", profileKey: "wa||fixture-power", state: "WA", ahj: "", utility: "Fixture Power",
  portalPlatform: "test", portalUrl: "https://portal.example.test/", status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "",
} as PortalRecipe;

/** A page with nothing on it: every read answers empty, nothing throws. The ledger read answers `ledger`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakePage(ledger: unknown[] = []): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loc: any = {
    first: () => loc, nth: () => loc, count: async () => 0, isVisible: async () => false,
    evaluateAll: async () => [], innerText: async () => "", textContent: async () => "",
  };
  return {
    url: () => "https://portal.example.test/apply", title: async () => "Apply",
    evaluate: async () => ledger, waitForLoadState: async () => undefined, waitForFunction: async () => true,
    frames: () => [], mainFrame: () => ({ url: () => "https://portal.example.test/apply" }),
    locator: () => loc, getByRole: () => loc, getByLabel: () => loc, getByText: () => loc,
    screenshot: async () => Buffer.from(""), on: () => undefined, off: () => undefined,
    isClosed: () => false, context: () => ({ on: () => undefined, off: () => undefined, pages: () => [] }),
  };
}

type Internals = {
  page: unknown;
  endReplay?: (r: { ok: boolean; message: string; pauseReason?: string; data?: Record<string, unknown> }) => unknown;
  replayEnd?: unknown;
  reachedReviewMarker?: boolean;
  finalSubmitAttempted?: boolean;
  finalSubmitNothingSent?: boolean;
  draftSubmitAttempted?: boolean;
};
function adapterWith(page: unknown, siteDraft?: { street: string }) {
  const a = new RecipeAdapter(recipe, {}, {}, siteDraft ? { siteDraft } : {});
  (a as unknown as Internals).page = page;
  return a;
}
/** The run ended this way — through endReplay, as fillApplication's every exit does. */
function ended(a: InstanceType<typeof RecipeAdapter>, r: { ok: boolean; message: string; pauseReason?: string; data?: Record<string, unknown> }): void {
  const i = a as unknown as Internals;
  if (typeof i.endReplay === "function") i.endReplay(r);
}
const STAGED = /staged .* to the review screen\. Verify|Human review required|click submit manually/i;
const msgOf = (r: { message?: unknown }): string => String(r.message ?? "");

await check("(a) an existing draft stops the run before it starts: the close says NOT replayed, nothing staged or submitted", async () => {
  const ledger = [{ id: "NEM-90017", href: "https://portal.example.test/p/1", row: "NEM-90017 Application Draft Jordan Testcase 1234 N Example St Lynden" }];
  const a = adapterWith(fakePage(ledger), { street: "1234 North Example Street" });
  const opened = await a.openSubmission({} as ProjectRecord);
  if (opened.ok) return `openSubmission did not stop on the draft: ${msgOf(opened)}`;
  const m = msgOf(await a.stopAtReview());
  if (STAGED.test(m)) return `closed with the staged sentence: ${m.slice(0, 300)}`;
  if (!/: the recipe was NOT replayed — this address already has an unsubmitted draft on the portal \(NEM-90017\)\. Nothing was staged at the review screen and nothing was submitted\. AUTOMATION HAS STOPPED\.$/.test(m)) return m.slice(0, 300);
  return null;
});

await check("(b) a run that PAUSED for a person says so, at its step, with its reason, before review", async () => {
  const a = adapterWith(fakePage());
  ended(a, { ok: false, pauseReason: "signature_no_signer", message: "Recipe step failed (fill — Signature): no authorized signer is on file for this client", data: { failedStepIndex: 2 } });
  const r = await a.stopAtReview();
  const m = msgOf(r);
  if (STAGED.test(m)) return `closed with the staged sentence: ${m.slice(0, 300)}`;
  if (!/: the replay PAUSED for a person at step 3 of 4 \("Signature"\) before reaching the review screen: no authorized signer is on file for this client\. Nothing was submitted\. AUTOMATION HAS STOPPED\.$/.test(m)) return m.slice(0, 300);
  const at = (r.data as { replayStoppedAt?: { stepIndex?: number; pauseReason?: string } } | undefined)?.replayStoppedAt;
  if (at?.stepIndex !== 2 || at?.pauseReason !== "signature_no_signer") return `replayStoppedAt=${JSON.stringify(at)}`;
  return null;
});

await check("(c) a run that reached its review marker and then failed never says 'before reaching the review screen'", async () => {
  const a = adapterWith(fakePage());
  (a as unknown as Internals).reachedReviewMarker = true;
  ended(a, { ok: false, message: "Recipe step failed (stopForReview): a required answer is still empty: Meter number", data: { failedStepIndex: 3 } });
  const m = msgOf(await a.stopAtReview());
  if (STAGED.test(m)) return `closed with the staged sentence: ${m.slice(0, 300)}`;
  if (!/: the replay STOPPED at step 4 of 4 \("stopForReview"\): a required answer is still empty: Meter number\. Nothing was submitted\./.test(m)) return m.slice(0, 300);
  return null;
});

await check("(d) a filing or draft-creating submit was attempted: never 'Nothing was submitted' — check the portal first; an approved click whose request never left still is", async () => {
  const filing = adapterWith(fakePage());
  Object.assign(filing as unknown as Internals, { reachedReviewMarker: true, finalSubmitAttempted: true, finalSubmitNothingSent: false });
  ended(filing, { ok: false, message: "the portal did not answer the submit", data: { failedStepIndex: 3 } });
  const m1 = msgOf(await filing.stopAtReview());
  if (STAGED.test(m1) || /Nothing was submitted/.test(m1) || !/A submit was clicked in this run — check on the portal what it did before anything is staged or clicked again\./.test(m1)) return `final submit attempted: ${m1.slice(0, 300)}`;
  const draft = adapterWith(fakePage());
  Object.assign(draft as unknown as Internals, { draftSubmitAttempted: true });
  ended(draft, { ok: false, message: "the page after the draft submit did not read as draft-created", data: { failedStepIndex: 1 } });
  const m2 = msgOf(await draft.stopAtReview());
  if (STAGED.test(m2) || /Nothing was submitted/.test(m2) || !/A submit was clicked in this run/.test(m2)) return `draft submit attempted: ${m2.slice(0, 300)}`;
  const held = adapterWith(fakePage());
  Object.assign(held as unknown as Internals, { reachedReviewMarker: true, finalSubmitAttempted: true, finalSubmitNothingSent: true });
  ended(held, { ok: false, message: "the approved submit's request was held back", data: { failedStepIndex: 3 } });
  const m3 = msgOf(await held.stopAtReview());
  if (STAGED.test(m3) || !/Nothing was submitted\./.test(m3) || /A submit was clicked/.test(m3)) return `request never left: ${m3.slice(0, 300)}`;
  return null;
});

await check("(e) a clean run keeps today's sentence", async () => {
  const a = adapterWith(fakePage());
  (a as unknown as Internals).reachedReviewMarker = true;
  ended(a, { ok: true, message: "Replayed 4 recorded step(s)." });
  const m = msgOf(await a.stopAtReview());
  if (!/^Human review required\. .*The recipe staged .*Fixture Power.* to the review screen\. Verify every field/.test(m) || /the replay STOPPED|PAUSED for a person|NOT replayed/.test(m)) return m.slice(0, 300);
  return null;
});

console.log(`\nreplayCloseMessage: ${passes} passed, ${failures} failed (of ${passes + failures} checks)`);
if (failures) { console.error(`replayCloseMessage: ${failures} check(s) FAILED`); process.exit(1); }
console.log("replayCloseMessage: all checks passed");
