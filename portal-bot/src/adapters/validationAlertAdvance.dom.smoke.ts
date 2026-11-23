// A VALIDATION ALERT OPENED BY AN ADVANCE IS THE PAGE REFUSING, NOT A PAGE THE ADVANCE REACHED.
//
// Live City of Tigard (Tyler EnerGov), replay v12 of 2026-11-15, step 29 of 40: three required boxes
// stayed blank (their recorded answers were the learn job's own, rightly not replayed) and "Next"
// opened EnerGov's message dialog — "Alert: Describe Location of Solar Array is required. Without
// Service or Feeder is required. …". The #230 rule "an advance that opened a dialog has advanced into
// it" (right for Boise's address-results iframe) read that alert as the next page; the uploads and
// the e-signature then ran against a page that had not moved and failed one by one.
//
// The rule: a dialog whose own words say the page's fields are required or invalid is a refusal —
// named with those words — and the advance fails as an advance that did not take; the steps recorded
// for the next page are never run against this one. A dialog that says nothing of the kind (a results
// list, a notice) is still the page the advance reached (#230).
//
// Synthetic page and names. Run: npx tsx portal-bot/src/adapters/validationAlertAdvance.dom.smoke.ts
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

// Page 1: a required box the recipe leaves blank, and a Next that answers with the portal's alert
// dialog instead of moving (live shape: #globalMessageDialog, role=dialog, "Alert … is required. Close").
const PAGE1 = (mode: string) => `<!doctype html><html><head><title>Apply for Permit</title>
<style>#globalMessageDialog{display:none;position:fixed;top:20%;left:20%;width:400px;padding:16px;background:#fff;border:2px solid #333}</style></head><body>
  <h2>More Info</h2>
  <label for="widget">*Widget Count</label><input id="widget" type="text" required aria-required="true">
  <p><button id="button-Next" type="button">Next</button></p>
  <div id="globalMessageDialog" role="dialog" aria-labelledby="modal-header" aria-hidden="true">
    <h4 id="modal-header">${mode === "notice" ? "Notice" : "Alert"}</h4>
    <p id="dialog-body"></p>
    <button type="button" id="dialog-close">Close</button>
  </div>
  <script>
    var S = JSON.parse(sessionStorage.getItem("V") || '{"nexts":0,"alerts":0}');
    function save(){ sessionStorage.setItem("V", JSON.stringify(S)); }
    document.getElementById("button-Next").onclick = function () {
      S.nexts++; save();
      var v = document.getElementById("widget").value.trim();
      if (!v) {
        S.alerts++; save();
        var d = document.getElementById("globalMessageDialog");
        document.getElementById("dialog-body").textContent = ${mode === "notice" ? JSON.stringify("Your session will stay open while you work.") : JSON.stringify("Widget Count is required.")};
        d.style.display = "block"; d.setAttribute("aria-hidden", "false");
        return;
      }
      location.href = "/page2";
    };
    document.getElementById("dialog-close").onclick = function () { var d = document.getElementById("globalMessageDialog"); d.style.display = "none"; d.setAttribute("aria-hidden", "true"); };
  </script>
</body></html>`;
const PAGE2 = `<!doctype html><html><head><title>Apply for Permit</title></head><body><h2>Attachments</h2>
  <label for="after">After Box</label><input id="after" type="text"><button id="button-Next" type="button">Next</button></body></html>`;

let mode = "alert";
const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(/page2/.test(String(q.url)) ? PAGE2 : PAGE1(mode));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const mkRecipe = (steps: RecipeStep[]) => ({
  id: "vaa1", scopeType: "ahj", profileKey: "zz||maplecrest", state: "ZZ", ahj: "City of Maplecrest", utility: "",
  portalPlatform: "energov", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);
const STEPS: RecipeStep[] = [
  // Bound to a key this project does not carry: resolves to nothing and is skipped — the required box stays blank.
  { action: "fill", phase: "fill", field: "widgetCount", note: "*Widget Count", selector: { label: "*Widget Count", fallbacks: [{ css: "#widget" }] } } as RecipeStep,
  { action: "click", phase: "fill", note: "advance: Next", selector: { role: "button", name: "Next", exact: true, fallbacks: [{ css: "#button-Next" }] } } as RecipeStep,
  // Recorded on the NEXT page: must never run against this one.
  { action: "fill", phase: "fill", field: "afterValue", note: "After Box", selector: { label: "After Box", fallbacks: [{ css: "#after" }] } } as RecipeStep,
];

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

// CASE A — the alert: the advance did not take.
mode = "alert";
const pA = await context.newPage();
await pA.goto(url);
const aA = new RecipeAdapter(mkRecipe(STEPS), { afterValue: "typed on page 2" }, {}, { autoSubmit: false });
(aA as unknown as { page: unknown }).page = pA;
let resultA: unknown = null;
let threwA = "";
try { resultA = await aA.fillApplication({} as never); } catch (e) { threwA = String((e as Error)?.message ?? e); }
const stateA = await pA.evaluate(() => JSON.parse(sessionStorage.getItem("V") || "{}")).catch(() => ({})) as { nexts?: number; alerts?: number };
const urlA = pA.url();
const driftA = ((aA as unknown as { driftWarnings?: string[] }).driftWarnings ?? []).join(" | ");
const agingA = ((aA as unknown as { agingNotes?: string[] }).agingNotes ?? []).join(" | ");
const okA = (resultA as { ok?: boolean } | null)?.ok;
const msgA = String((resultA as { message?: string } | null)?.message ?? threwA);

check("MUST-PASS alert: the advance is named as answered by the portal's validation alert, with its words", () => {
  assert.match(driftA, /validation alert — "Alert Widget Count is required/, driftA.slice(0, 500));
});
check("MUST-PASS alert: the alert is never read as the page the advance reached", () => {
  assert.doesNotMatch(agingA, /advanced into it/, agingA.slice(0, 400));
});
check("MUST-PASS alert: the page did not move and the run does not report success", () => {
  assert.match(urlA, new RegExp(`^${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), `url=${urlA}`);
  assert.ok(okA !== true, `ok=${String(okA)} message=${msgA.slice(0, 300)}`);
});
check("MUST-PASS alert: the next page's step never ran here (no After Box on this page, none invented)", () => {
  assert.doesNotMatch(agingA + driftA, /After Box.*(filled|typed|re-anchored)/, (agingA + " | " + driftA).slice(0, 400));
});

// CASE B — MUST-KEEP (#230): a dialog that is NOT a validation alert is still the page the advance reached.
mode = "notice";
const pB = await context.newPage();
await pB.goto(url);
const aB = new RecipeAdapter(mkRecipe(STEPS.slice(0, 2)), {}, {}, { autoSubmit: false });
(aB as unknown as { page: unknown }).page = pB;
try { await aB.fillApplication({} as never); } catch { /* the walk's own end is not this case's question */ }
const agingB = ((aB as unknown as { agingNotes?: string[] }).agingNotes ?? []).join(" | ");
const driftB = ((aB as unknown as { driftWarnings?: string[] }).driftWarnings ?? []).join(" | ");
check("MUST-KEEP notice: a dialog that says nothing of required or invalid fields is still 'advanced into it' (#230)", () => {
  assert.match(agingB, /advanced into it/, `aging=${agingB.slice(0, 300)} drift=${driftB.slice(0, 300)}`);
  assert.doesNotMatch(driftB, /validation alert/, driftB.slice(0, 300));
});

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} validation-alert-advance smoke check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll validation-alert-advance smoke checks passed (real Chromium).");
process.exit(0);
