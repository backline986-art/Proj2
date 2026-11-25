// A CHECK ON A QUESTION THE PORTAL KEEPS HIDDEN FOR THIS PROJECT IS NOT APPLICABLE, NOT A FAILURE.
//
// Live City of Bend (CityView), replay v4 of 2026-11-15, step 25 of 26: the learn job's last page
// carried two "Do you agree?" disclaimers and the recipe a check for each (ids PRPermit3_… and
// PRPermit36_…). This project's page renders the second one's whole block hidden; the step resolved
// its input by its own recorded id, waited 30 s for it to become visible, and failed the walk one
// step before the recorded final submit — review never reached.
//
//   MUST-PASS  hidden: the first disclaimer is ticked; the second — input AND label hidden — is skipped,
//              named "not applicable"; the walk goes on and stops at the recorded final submit (never
//              clicked).
//   MUST-KEEP  styled: a styled checkbox (its <input> concealed, its LABEL shown) is still ticked by
//              force / by its label — a hidden input alone is not a hidden question.
//
// Synthetic page. Run: npx tsx portal-bot/src/adapters/hiddenQuestionCheck.dom.smoke.ts
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const PAGE = `<!doctype html><html><head><title>Permit Center Portal</title>
<style>
  .styled input[type=checkbox]{position:absolute;opacity:0;width:1px;height:1px}
  .styled .face{display:inline-block;width:18px;height:18px;border:1px solid #333;vertical-align:middle}
  .styled input:checked + .face{background:#2a2}
</style></head><body>
  <h2>Review</h2>
  <div id="blkPRPermit3" class="cv-input-container">
    <input id="PRPermit3_attFlagPermitDisclaimer__rev_" name="PRPermit3_attFlagPermitDisclaimer__rev_" type="checkbox" required aria-required="true">
    <label class="cv-input-label" for="PRPermit3_attFlagPermitDisclaimer__rev_">Do you agree?<span class="required">*</span></label>
  </div>
  <!-- As live: the second disclaimer's block is kept hidden for this project. -->
  <div id="blkPRPermit36" class="cv-input-container" style="display:none">
    <input id="PRPermit36_attFlagPermitDisclaimer__rev_" name="PRPermit36_attFlagPermitDisclaimer__rev_" type="checkbox" aria-required="false">
    <label class="cv-input-label" for="PRPermit36_attFlagPermitDisclaimer__rev_">Do you agree?<span class="required">*</span></label>
  </div>
  <!-- MUST-KEEP: a styled checkbox — the input is concealed, the label is what a person sees and clicks. -->
  <label class="styled" for="terms"><input id="terms" name="terms" type="checkbox"><span class="face"></span> I accept the terms</label>
  <p><button id="bnext" type="button">Submit Application</button></p>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const mkRecipe = (steps: RecipeStep[]) => ({
  id: "hqc1", scopeType: "ahj", profileKey: "zz||maplecrest", state: "ZZ", ahj: "City of Maplecrest", utility: "",
  portalPlatform: "cityview", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "electrical",
} as unknown as PortalRecipe);
const agree = (id: string): RecipeStep => ({
  action: "check", phase: "fill", note: "Do you agree?*",
  selector: { label: "Do you agree?*", fallbacks: [{ css: `#${id}` }, { css: `[data-cy="inp-${id}"]` }] },
  fingerprint: { id, name: id, section: "I acknowledge I have authority to submit this application" },
} as RecipeStep);
const STEPS: RecipeStep[] = [
  agree("PRPermit3_attFlagPermitDisclaimer__rev_"),
  agree("PRPermit36_attFlagPermitDisclaimer__rev_"),
  { action: "check", phase: "fill", note: "I accept the terms", selector: { label: "I accept the terms", fallbacks: [{ css: "#terms" }] } } as RecipeStep,
  { action: "click", phase: "review", note: "final submit: Submit Application (recorded, NOT clicked)", isFinalSubmit: true, selector: { role: "button", name: "Submit Application", exact: true, fallbacks: [{ css: "#bnext" }] } } as RecipeStep,
];

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(url);
const a = new RecipeAdapter(mkRecipe(STEPS), {}, {}, { autoSubmit: false });
(a as unknown as { page: unknown }).page = page;
const t0 = Date.now();
let result: { ok?: boolean; message?: string } | null = null;
let threw = "";
try { result = (await a.fillApplication({} as never)) as { ok?: boolean; message?: string }; } catch (e) { threw = String((e as Error)?.message ?? e); }
const took = Date.now() - t0;
const first = await page.locator("#PRPermit3_attFlagPermitDisclaimer__rev_").isChecked().catch(() => false);
const second = await page.locator("#PRPermit36_attFlagPermitDisclaimer__rev_").isChecked().catch(() => false);
const terms = await page.locator("#terms").isChecked().catch(() => false);
const aging = ((a as unknown as { agingNotes?: string[] }).agingNotes ?? []).join(" | ");
const drift = ((a as unknown as { driftWarnings?: string[] }).driftWarnings ?? []).join(" | ");
const msg = String(result?.message ?? threw);

check("MUST-PASS hidden: the shown disclaimer is ticked", () => assert.equal(first, true, `first=${first} drift=${drift.slice(0, 300)}`));
check("MUST-PASS hidden: the hidden disclaimer is skipped, named not applicable (never ticked, never a timeout)", () => {
  assert.equal(second, false, `second=${second}`);
  assert.match(aging, /"Do you agree\?\*" skipped: not applicable — its control is on the page but inside a block the portal keeps hidden/, aging.slice(0, 400));
  assert.ok(took < 25_000, `took ${took} ms — the 30 s actionability timeout is the failure this rule removes`);
});
check("MUST-PASS hidden: the walk goes on to the recorded final submit and stops there (never clicked)", () => {
  assert.match(msg, /review|submit/i, `message=${msg.slice(0, 300)} ok=${String(result?.ok)}`);
  assert.doesNotMatch(msg, /Element is not visible|Timeout/, msg.slice(0, 300));
});
check("MUST-KEEP styled: a styled checkbox (input concealed, label shown) is still ticked", () => assert.equal(terms, true, `terms=${terms} aging=${aging.slice(0, 300)}`));

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} hidden-question-check smoke check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll hidden-question-check smoke checks passed (real Chromium).");
process.exit(0);
