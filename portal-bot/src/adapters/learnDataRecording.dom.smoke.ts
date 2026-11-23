// THE LEARNER NEVER WRITES THE LEARN JOB'S DATA OR A DATE INTO A SELECTOR (#235).
//
// What the 2026-11-14 audit found saved in four recipes, recorded here the same way, live: a
// results grid whose rows are ticked by a radio labelled (by its neighbouring cell) with the
// property's address, and a certification box whose only neighbouring text is the day's date.
// The walk records what the page showed — so without the learner's last pass the recipe carries
// the learn property's address as a label (plus the row's ordinal id) and "Date: <today>" as the
// certification's label, and every other job replays against them.
//
//   MUST: the saved address pick is a ROW ROLE ("address"), its selector the marker, no ordinal
//         id as a fallback, and nowhere in any saved selector or note is the learn address;
//   MUST: the certification is saved by the control's own id, its note's date stood in, and no
//         saved selector or note carries today's date;
//   MUST: the walk still reaches review, and the final submit is recorded, never clicked.
// All values synthetic.
//
// Run: npx tsx portal-bot/src/adapters/learnDataRecording.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";
import type { ProjectRecord, RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const today = ((): string => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`; })();
const G = "ctl00_PlaceHolderMain_ucAddressSearchResult_ucAddressList_gv";
let finalClicks = 0;
const APPLY = `<!doctype html><html><head><title>Step 2: Location</title></head><body>
<h1>Step 2: Location</h1>
<h3>Address Search Results</h3>
<table id="${G}"><tr><th></th><th>Address</th><th>City</th></tr>
  <tr><td><input type="radio" id="${G}_CB_0" name="${G}_RadioButtonFieldGroupName" value="0"></td><td>9180 W QUILLMERE BLVD</td><td>Fernhollow</td></tr>
  <tr><td><input type="radio" id="${G}_CB_1" name="${G}_RadioButtonFieldGroupName" value="1"></td><td>2208 E LANTERNWOOD ST</td><td>Fernhollow</td></tr>
</table>
<h3>Certification</h3>
<div><input type="checkbox" id="ctl00_PlaceHolderMain_capReviewCertification1_termReviewAccept" name="ctl00$PlaceHolderMain$capReviewCertification1$termReviewAccept"> <span>Date: ${today}</span></div>
<p><a id="btnContinue" href="/review">Continue</a></p>
</body></html>`;
const REVIEW = `<!doctype html><html><head><title>Step 4: Review</title></head><body>
<h1>Step 4: Review</h1><p>Review your application before submitting.</p>
<button id="btnSubmit" type="button" onclick="fetch('/submit',{method:'POST'})">Submit Application</button>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.method === "POST") { finalClicks++; res.writeHead(200); res.end("filed"); return; }
  const body = req.url?.startsWith("/review") ? REVIEW : APPLY;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// A planner that does what the live learn did: ticks the grid row reading as this job's address,
// ticks the certification, advances; on review it names the submit (recorded, never clicked).
const planner: LearnPlanner = async (req) => {
  if (/review/i.test(req.pageTitle)) {
    const submit = req.fields.findIndex((f) => f.fieldType === "button" && /submit application/i.test(String(f.label ?? "")));
    return { fills: [], atReview: true, ...(submit >= 0 ? { finalSubmitSelectorIndex: submit } : {}) };
  }
  const fills: Array<{ selectorIndex: number; value: string }> = [];
  req.fields.forEach((f, i) => {
    const l = String(f.label ?? "");
    if (f.fieldType === "radio" && /lanternwood/i.test(l)) fills.push({ selectorIndex: i, value: "true" });
    if (f.fieldType === "checkbox" && /termReviewAccept/i.test(JSON.stringify(f.selector))) fills.push({ selectorIndex: i, value: "true" });
  });
  const cont = req.fields.findIndex((f) => f.fieldType === "button" && /^continue$/i.test(String(f.label ?? "").trim()));
  return { fills, atReview: false, ...(cont >= 0 ? { advanceSelectorIndex: cont } : {}) };
};

const project = {
  id: "p235", clientId: null, projectAddress: "2208 E Lanternwood St, Fernhollow, ID, 83999", city: "Fernhollow", state: "ID", zip: "83999",
  homeownerName: "Priya Lanternwood", permitType: "electrical", parserSnapshot: {},
} as unknown as ProjectRecord;

const browser = await chromium.launch();
const ctx = await browser.newContext();
ctx.setDefaultTimeout(8000);
await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
const page = await ctx.newPage();
await page.goto(`${base}/apply`);
const adapter = new AutoLearnAdapter("Learn Data Recording Smoke", planner, { maxPages: 4, policyProfile: "none" });
(adapter as unknown as { page: unknown }).page = page;
let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
let threw = "";
try { r = await adapter.learn({ portalUrl: `${base}/apply` } as never, project); } catch (e) { threw = String(e).slice(0, 300); }
await ctx.close().catch(() => null);
await browser.close();
server.close();

const steps: RecipeStep[] = r?.steps ?? [];
const saved = (st: RecipeStep): string => JSON.stringify([st.selector, st.note]).toUpperCase();
const rowPick = steps.find((s) => s.action === "check" && (s.rowRole || /LANTERNWOOD/i.test(saved(s))));
const cert = steps.find((s) => s.action === "check" && /termReviewAccept|Date:/i.test(saved(s)));
console.log(`   reachedReview=${String(r?.reachedReview)} ${threw}\n   steps=${JSON.stringify(steps.map((s) => ({ a: s.action, sel: s.selector, note: s.note, rowRole: s.rowRole })))}`.slice(0, 2500));

check("the walk reached review (the grid pick and the certification were recorded)", r?.reachedReview === true && !!rowPick && !!cert, `reachedReview=${String(r?.reachedReview)} rowPick=${!!rowPick} cert=${!!cert} ${threw}`);
check("MUST: the address pick is saved as a ROW ROLE with the marker selector", rowPick?.rowRole === "address" && rowPick?.selector?.css === '[data-al-resultrow="1"]', JSON.stringify(rowPick));
check("MUST: no recorded row position survives as a fallback", !(rowPick?.selector?.fallbacks ?? []).length, JSON.stringify(rowPick?.selector));
check("MUST: the learn address appears in no saved selector or note", !steps.some((s) => /LANTERNWOOD|2208 E/.test(saved(s))), JSON.stringify(steps.filter((s) => /LANTERNWOOD|2208 E/.test(saved(s)))));
check("MUST: the certification is saved by the control's own id", cert?.selector?.css === '[id="ctl00_PlaceHolderMain_capReviewCertification1_termReviewAccept"]' && !cert?.selector?.label, JSON.stringify(cert));
check("MUST: today's date appears in no saved selector or note", !steps.some((s) => saved(s).includes(today)), JSON.stringify(steps.filter((s) => saved(s).includes(today))));
check("the final submit is recorded and never clicked", steps.some((s) => s.isFinalSubmit) && finalClicks === 0, `finalClicks=${finalClicks}`);

if (failures > 0) { console.error(`\nlearnDataRecording.dom.smoke: ${failures} FAILURE(S)`); process.exit(1); }
console.log("\nlearnDataRecording.dom.smoke: PASS");
process.exit(0);
