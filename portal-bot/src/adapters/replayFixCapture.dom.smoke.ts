// A FAILED REPLAY STEP'S WINDOW REPORTS THE PERSON'S FIXES (owner 2026-11-21: "the fix screen was hit,
// I approved it, then it was still getting stuck on the same run"). Real Chromium, a local fixture
// page on 127.0.0.1 (never a real portal).
//
// A recipe step's control is gone from the page (the step fails, or is skipped and the run stops short
// of review). RecipeAdapter.armFixCaptureAfterFailure
// then watches the same page, read only, and reports what the person does there through
// options.onHumanFixStep: their typing and their ordinary clicks. Their final-submit click is never a
// fix step: it is handed on once as the sighting signal (the backend records it), and nothing after it
// is reported (the latch: whatever follows a filing is not part of
// the recipe). Without an onHumanFixStep caller nothing is armed.
//
// KILL TESTS (each must turn this file red):
//   K1 recipeAdapter.armFixCaptureAfterFailure: return false at the top   → F1 F2 fail.
//   K2 recipeAdapter.armFixCaptureAfterFailure: drop the latch on the submit-observed note → F3 fails.
//   K2b ...: stop handing the sighting on (Helm, #257 review: a filing in this window must be visible) → F3 fails.
//   K3 recipeAdapter.armFixCaptureAfterFailure: drop the onHumanFixStep check → F4 fails.
//
// Run: npx tsx portal-bot/src/adapters/replayFixCapture.dom.smoke.ts
import "../smokeArtifactDirs";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";
import { HUMAN_SUBMIT_OBSERVED_NOTE } from "../humanCapture";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

let posts = 0;
const PAGE = `<!doctype html><html><body>
  <h1>Step 1: Applicant</h1>
  <form id="f" method="post" action="/apply/submit" onsubmit="return false;">
    <label for="txtFirstName">First Name</label><input type="text" id="txtFirstName">
    <label for="txtCompany">Company Name</label><input type="text" id="txtCompany">
    <button type="button" id="btnShow" onclick="document.getElementById('more').hidden=false">Show more</button>
    <div id="more" hidden><label for="txtNotes">Job Notes</label><input type="text" id="txtNotes"></div>
    <button type="button" id="btnSubmit" onclick="document.getElementById('done').textContent='SUBMITTED'">Submit Application</button>
    <button type="button" id="btnAfter" onclick="document.getElementById('done').textContent+=' AFTER'">Continue</button>
  </form>
  <div id="done"></div>
</body></html>`;
const server = http.createServer((req, res) => {
  if (req.method !== "GET") posts++;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(PAGE);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

const steps: RecipeStep[] = [
  { action: "goto", phase: "open", value: url, note: "entry url" },
  { action: "fill", phase: "fill", selector: { css: "#txtFirstName" }, field: "homeownerFirstName", value: "X", note: "contact: first name" },
  // THE STEP THAT FAILS: its control is no longer on the page.
  { action: "fill", phase: "fill", selector: { css: "#txtGoneForever" }, field: "zip", value: "00000", note: "contact: zip" },
  { action: "stopForReview", selector: {} } as RecipeStep,
];
const recipe = {
  id: "r-fix", scopeType: "ahj", profileKey: "or|test|fix", state: "OR", ahj: "Test AHJ", utility: "",
  portalPlatform: "accela", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "structural",
} as unknown as PortalRecipe;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript({ content: "globalThis.__name = globalThis.__name || function (fn) { return fn; };" });
const page = await context.newPage();

const got: RecipeStep[] = [];
const adapter = new RecipeAdapter(recipe, { homeownerFirstName: "Wynema", zip: "97420" }, {}, {
  autoSubmit: false, onHumanFixStep: (s) => got.push(s),
});
(adapter as unknown as { page: unknown }).page = page;
const fill = await adapter.fillApplication({} as never);
const failedAt = (fill.data as { failedStepIndex?: number } | undefined)?.failedStepIndex;

await check("setup: the replay does not get past the step whose control is gone (failed, or skipped short of review)", () => {
  // Either the step fails (failedStepIndex 2), or the replay goes on and ends NOT at the review page —
  // both are a run whose window index.ts keeps for the person (fill failed, or review not reached).
  assert.ok(fill.ok === false ? failedAt === 2 : /NOT the review page/.test(String(fill.message)), `fill ${fill.ok} at ${failedAt}: ${fill.message}`);
});

const armed = await adapter.armFixCaptureAfterFailure();
// The person, in the same window: types the company, opens a hidden section, types there.
await page.click("#txtCompany");
await page.keyboard.type("Hand Typed Co");
await page.keyboard.press("Tab");
await page.click("#btnShow");
await page.click("#txtNotes");
await page.keyboard.type("roof notes");
await page.keyboard.press("Tab");
await page.waitForTimeout(300);
const beforeSubmit = got.length;
// Their own submit, then a click after it.
await page.click("#btnSubmit");
await page.waitForTimeout(300);
await page.click("#btnAfter");
await page.waitForTimeout(300);

await check("F1 the fix capture arms on the failed step's page", () => {
  assert.equal(armed, true);
});
await check("F2 the person's typing and ordinary clicks are reported as steps", () => {
  const kinds = got.slice(0, beforeSubmit).map((s) => `${s.action}:${s.value ?? ""}:${JSON.stringify(s.selector)}`);
  assert.ok(got.some((s) => s.action === "fill" && s.value === "Hand Typed Co"), `steps: ${JSON.stringify(kinds)}`);
  assert.ok(got.some((s) => s.action === "click" && /Show more/.test(JSON.stringify(s.selector) + String(s.note ?? ""))), `steps: ${JSON.stringify(kinds)}`);
  assert.ok(got.some((s) => s.action === "fill" && s.value === "roof notes"), `steps: ${JSON.stringify(kinds)}`);
});
await check("F3 their submit is handed on ONCE as the sighting signal (never a step), and nothing after it is reported", () => {
  const after = got.slice(beforeSubmit);
  assert.deepEqual(after.map((s) => s.note), [HUMAN_SUBMIT_OBSERVED_NOTE], `reported after the submit: ${JSON.stringify(after)}`);
  assert.match(String(after[0]?.value ?? ""), /Submit Application/, "the sighting names the control clicked");
  assert.ok(!got.slice(0, beforeSubmit).some((s) => /Submit Application/.test(JSON.stringify(s.selector) + String(s.note ?? ""))), "the submit click is not a step");
});

// Without a caller that keeps the fixes, nothing is armed.
const page2 = await context.newPage();
const plain = new RecipeAdapter(recipe, { homeownerFirstName: "Wynema", zip: "97420" }, {}, { autoSubmit: false });
(plain as unknown as { page: unknown }).page = page2;
await page2.goto(url);
await check("F4 no onHumanFixStep caller: nothing is armed", async () => {
  assert.equal(await plain.armFixCaptureAfterFailure(), false);
});
await check("the fixture portal received no POST from automation or capture", () => {
  assert.equal(posts, 0);
});

await browser.close();
server.close();
if (failures > 0) {
  console.error(`\n${failures} replay fix capture smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll replay fix capture smoke tests passed.");
process.exit(0);
