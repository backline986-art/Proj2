// AN UPLOAD STEP ON A PAGE WITH NO FILE SLOT AND NOTHING TO FILL CLICKS THROUGH TO THE NEXT PAGE ONCE.
//
// Live City of Bend (CityView), replay v3 of 2026-11-15: the learn's one "Next Step" from Location
// landed on Upload Files (the Contacts page was already complete and the portal passed it); on
// replay the same Next landed ON Contacts. The upload step — selector `[data-al-upl="f0"]`, the
// learner's stamp, nothing a drift precheck can resolve — ran there, found 0 slots and was skipped;
// the recipe's next advance then moved to Upload Files, the recorded "OK" and "Do you agree?" ran a
// page behind, and the walk ended on "Do you agree? is not on this page".
//
// The rule (the drift seek's, applied where an upload step finds no slot): when the page has nothing
// to fill and the recipe's own next step is its advance, click that advance once as a pass-through and
// look for the slots on the page it reaches. MUST-KEEP: a page WITH a required blank is never clicked
// through — the upload is reported as having no slot, as before.
//
// Synthetic pages. Run: npx tsx portal-bot/src/adapters/uploadPassThroughPage.dom.smoke.ts
import assert from "node:assert/strict";
import http from "node:http";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const tmp = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "upl-pass-"));
const pdf = nodePath.join(tmp, "plan-set.pdf");
nodeFs.writeFileSync(pdf, "%PDF-1.4\n%%EOF\n");

const HEAD = `<!doctype html><html><head><title>Permit Center Portal</title></head><body><h1>Permit Application</h1>`;
const LOC = `${HEAD}<h2>Location</h2>
  <label for="cvlocdesc">Search for location:*</label><input id="cvlocdesc" type="text" required>
  <p><button id="bnext" type="button" onclick="location.href='/contacts'">Next Step</button></p></body></html>`;
// Nothing to fill: the account's contacts already stand; the portal just shows them.
const CONTACTS = (required: boolean) => `${HEAD}<h2>Contacts</h2>
  <table><tr><td>Applicant</td><td>Quillfeather Solar LLC</td></tr></table>
  ${required ? `<label for="otherp">Other parties (required here):*</label><input id="otherp" type="text" required aria-required="true">` : ""}
  <p><button id="bnext" type="button" onclick="location.href='/upload'">Next Step</button></p></body></html>`;
const UPLOAD = `${HEAD}<h2>Upload Files</h2>
  <label for="f0">Plan Set</label><input id="f0" type="file" onchange="sessionStorage.setItem('UP', this.files[0] ? this.files[0].name : '')">
  <p><button id="bnext" type="button" onclick="location.href='/review'">Next Step</button></p></body></html>`;
const REVIEW = `${HEAD}<h2>Review</h2>
  <label><input id="agree" type="checkbox" onchange="sessionStorage.setItem('AGREE', this.checked ? '1' : '')"> Do you agree?*</label>
  <p><button id="bsubmit" type="button">Submit</button></p></body></html>`;

let contactsRequired = false;
const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  const u = String(q.url);
  r.end(/contacts/.test(u) ? CONTACTS(contactsRequired) : /upload/.test(u) ? UPLOAD : /review/.test(u) ? REVIEW : LOC);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const mkRecipe = (steps: RecipeStep[]) => ({
  id: "upt1", scopeType: "ahj", profileKey: "zz||maplecrest", state: "ZZ", ahj: "City of Maplecrest", utility: "",
  portalPlatform: "cityview", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "electrical",
} as unknown as PortalRecipe);
const NEXT: RecipeStep = { action: "click", phase: "fill", note: "advance: Next Step", selector: { role: "button", name: "Next Step", exact: true, fallbacks: [{ css: "#bnext" }] } } as RecipeStep;
// The learn's shape: Location → ONE Next → upload (the Contacts page had no step).
const STEPS: RecipeStep[] = [
  { action: "fill", phase: "fill", field: "street", note: "Search for location:*", selector: { label: "Search for location:*", fallbacks: [{ css: "#cvlocdesc" }] } } as RecipeStep,
  NEXT,
  { action: "upload", phase: "fill", docType: "plan_set", note: "upload plan_set: Browse..", selector: { css: "[data-al-upl=\"f0\"]" } } as RecipeStep,
  NEXT,
  { action: "check", phase: "fill", note: "Do you agree?*", selector: { label: "Do you agree?*", fallbacks: [{ css: "#agree" }] } } as RecipeStep,
];

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

// CASE A — the live shape: the Contacts page has nothing to fill.
contactsRequired = false;
const pA = await context.newPage();
await pA.goto(url);
const aA = new RecipeAdapter(mkRecipe(STEPS), { street: "4821 W Quillfeather Dr" }, { plan_set: pdf }, { autoSubmit: false });
(aA as unknown as { page: unknown }).page = pA;
let okA: unknown = null;
try { okA = ((await aA.fillApplication({} as never)) as { ok?: boolean }).ok; } catch (e) { okA = `threw: ${String((e as Error)?.message ?? e).slice(0, 200)}`; }
const upA = await pA.evaluate(() => sessionStorage.getItem("UP") || "").catch(() => "");
const agreeA = await pA.evaluate(() => sessionStorage.getItem("AGREE") || "").catch(() => "");
const urlA = pA.url();
const driftA = ((aA as unknown as { driftWarnings?: string[] }).driftWarnings ?? []).join(" | ");

check("MUST-PASS: the plan set is attached on the Upload page (the pass-through Contacts page was clicked through)", () => {
  assert.equal(upA, "plan-set.pdf", `UP=${JSON.stringify(upA)} url=${urlA} drift=${driftA.slice(0, 400)}`);
});
check("MUST-PASS: the walk reaches Review and ticks Do you agree", () => {
  assert.match(urlA, /\/review$/, `url=${urlA} ok=${String(okA)} drift=${driftA.slice(0, 300)}`);
  assert.equal(agreeA, "1", `AGREE=${JSON.stringify(agreeA)}`);
});
check("the click-through is named, once", () => {
  assert.match(driftA, /clicked through 1 page this jurisdiction has that the recipe does not \(nothing to fill on it, and no file slot\)/, driftA.slice(0, 400));
  assert.doesNotMatch(driftA, /has no matching file slot/, driftA.slice(0, 400));
});

// CASE B — MUST-KEEP: a page with a required blank is never clicked through; the upload reports no slot.
contactsRequired = true;
const pB = await context.newPage();
await pB.goto(url);
const aB = new RecipeAdapter(mkRecipe(STEPS), { street: "4821 W Quillfeather Dr" }, { plan_set: pdf }, { autoSubmit: false });
(aB as unknown as { page: unknown }).page = pB;
try { await aB.fillApplication({} as never); } catch { /* the walk's own end is not this case's question */ }
const upB = await pB.evaluate(() => sessionStorage.getItem("UP") || "").catch(() => "");
const driftB = ((aB as unknown as { driftWarnings?: string[] }).driftWarnings ?? []).join(" | ");
check("MUST-KEEP: with a required blank on the page, nothing is clicked through and the upload is reported without a slot", () => {
  assert.equal(upB, "", `UP=${JSON.stringify(upB)}`);
  assert.match(driftB, /has no matching file slot on this page/, driftB.slice(0, 400));
  assert.doesNotMatch(driftB, /clicked through 1 page/, driftB.slice(0, 400));
});

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} upload-pass-through smoke check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll upload-pass-through smoke checks passed (real Chromium).");
process.exit(0);
