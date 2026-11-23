// #243 — A REPLAY THAT RUNS OUT OF RECORDED STEPS BEFORE ITS REVIEW MARKER IS NOT "STOPPED AT REVIEW",
// AND A SIGNER'S NAME BOX IS NOT THE HOMEOWNER'S NAME — in real Chromium, through the REAL runner
// (stageWithRecipe) and the REAL outcome (repository.derivePortalRunOutcome).
//
// Live 2026-11-15 (scratch replay, integration build, nothing filed):
//   City of Meridian (Accela ACA) recipe of 27 steps whose learn never advanced past page 1 — no
//   Continue, no final submit, no stopForReview. It replayed 26 steps, ended on "Step 1 > Page 1"
//   (address search never run, signature empty) and reported ok=true, "Replayed 26 recorded step(s);
//   stopped at review. Review screen checked against the project: 16 field(s) read, 2 project
//   value(s) confirmed present, no mismatch." and "staged … to the review screen". The two
//   "confirmations" were the street number and the owner name the run itself had typed on page 1.
//   City of Star (iWorQ), same day: a one-page form with no homeowner field reported "VERIFY BEFORE
//   SUBMITTING — homeownerName: shows <the client's authorized signer>" off its "Signature Name" box.
//
// The Accela pages are built from the CAPTURED Oregon ePermitting services page
// (fixtures/marionServices/services.html: its real step bar — General Info / Services / Review /
// Pay Fees / Completion — page title, "Continue Application »" action bar and chrome); only the
// page's middle is swapped. The iWorQ-shaped page is synthetic. Every name and address is invented.
//
//   E  END OF RECIPE
//      MUST-PASS    a recipe with no review marker that ends on page 1 — WITH the project's own values
//                   typed on it (so the review read-back "confirms" 2 of them) — is paused_for_human
//                   (stopped_before_review), says it ENDED on the page's own title before the review
//                   step, never "stopped at review" / "staged … to the review screen", and never the
//                   read-back's pass sentence "… no mismatch"; 0 filing POSTs. Also with the review
//                   page handed over to a person (onSubmitCaptured), which reads it before the hand-over.
//      MUST-EXCLUDE a recipe with no review marker whose last step lands ON CapConfirm (the page names
//                   itself the review step) keeps "stopped at review", awaiting_human_submit.
//      MUST-EXCLUDE a recipe that reaches its own recorded final submit keeps today's message.
//   S  THE SIGNER IS NOT THE HOMEOWNER
//      MUST-PASS    on a form whose only name box is "Signature Name", the review check never reports
//                   the signer's name as the homeowner's (homeownerName is "could not confirm", not a
//                   disagreement showing the signer).
//      MUST-EXCLUDE a wrong name in an "Owner Name" box beside the signature is still caught, and a
//                   right one is confirmed with no mismatch.
//
//   npx tsx portal-bot/src/adapters/replayEndOfRecipe.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { PORTAL_SAFETY_IN_PAGE_SOURCE } from "../../../shared/src/portalSafety";
import { stageWithRecipe } from "../index";
import { derivePortalRunOutcome } from "../../../backend/src/repository";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";
process.env.PORTAL_HEADLESS = "true";

let failures = 0;
let passes = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { passes++; console.log(`  ok   - ${label}`); }
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// ---- the Accela pages, built from the captured services page --------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const SERVICES = fs.readFileSync(path.join(here, "fixtures", "marionServices", "services.html"), "utf8");
const TITLE_CAPTURED = "<td>Step 2</td><td>:</td><td>Services</td><td>&gt;</td><td>Service</td>";
const CONTENT_START = SERVICES.indexOf('<div ng-non-bindable="true">', SERVICES.indexOf("SecondAnchorInACAMainContent"));
const CONTENT_END = SERVICES.indexOf('<div class="actionbar_bottom">');
const PM = "ctl00_PlaceHolderMain_";
const PAGE1_PATH = "/fernhollow/Cap/CapEdit.aspx?stepNumber=2&pageNumber=1&currentStep=0&currentPage=0&Module=Building";
const CONFIRM_PATH = "/fernhollow/Cap/CapConfirm.aspx?stepNumber=4&pageNumber=1&currentStep=2&currentPage=0&Module=Building";
const ACTION_CONTINUE = "ctl00$PlaceHolderMain$actionBarBottom$btnContinue";

/** The captured page with its middle replaced; `step` is the step-bar entry shown current. */
function accela(opts: { step: 1 | 3; title: string[]; content: string; action: string }): string {
  let h = SERVICES.slice(0, CONTENT_START) + opts.content + SERVICES.slice(CONTENT_END);
  if (opts.step === 1) {
    h = h.replace('<td class="breadcrump-selected">', '<td class="breadcrump-was">')
      .replace('<td class="breadcrump">', '<td class="breadcrump-selected">')
      .replace('<td class="breadcrump-was">', '<td class="breadcrump">');
  } else {
    h = h.replace('<td class="breadcrump-selected">', '<td class="breadcrump">').replace('<td class="breadcrump-disable">', '<td class="breadcrump-selected">');
  }
  if (!h.includes(TITLE_CAPTURED)) throw new Error("fixture: the captured page title moved");
  h = h.replace(TITLE_CAPTURED, opts.title.map((c) => `<td>${c}</td>`).join(""));
  h = h.replace(/(<form name="aspnetForm" method="post" action=")[^"]*(")/, `$1${opts.action.replace(/&/g, "&amp;")}$2`);
  // The postback plumbing the capture stripped (its scripts were removed).
  const script = `<script>(function(){
  var form = document.getElementById('aspnetForm');
  function hidden(n){ var i = form.querySelector('input[name="' + n + '"]'); if (!i) { i = document.createElement('input'); i.type = 'hidden'; i.name = n; form.appendChild(i); } return i; }
  window.WebForm_PostBackOptions = function(t){ this.eventTarget = t; };
  window.WebForm_DoPostBackWithOptions = function(o){ hidden('__EVENTTARGET').value = o.eventTarget; form.submit(); };
  window.__doPostBack = function(t){ window.WebForm_DoPostBackWithOptions({ eventTarget: t }); };
  window.ProcessLoading = function(){ this.showLoading = function(){}; };
  window.Continue = function(){ return true; };
  window.WebForm_OnSubmit = function(){ return true; };
  window.SetNotAsk = function(){}; window.doSaveAndResume = function(){}; window.IsSaveButtonEnabled = function(){ return true; };
})();</script>`;
  return h.replace("</body>", `${script}</body>`);
}

/** Page 1 of the application: an address and the application's own details — the shape of
 *  Meridian's "Step 1 > Page 1" (no review wording anywhere in its middle). */
const page1 = (): string => accela({
  step: 1, title: ["Step 1", ":", "General Info", "&gt;", "Page 1"], action: PAGE1_PATH,
  content: `<div ng-non-bindable="true">
  <div class="ACA_TabRow"><div class="ACA_Title_Bar"><h1>Address</h1></div></div>
  <label for="${PM}txtStreetNo">Street No.:</label> <input id="${PM}txtStreetNo" name="${PM}txtStreetNo" style="width:80px">
  <label for="${PM}txtStreetName">Street Name:</label> <input id="${PM}txtStreetName" name="${PM}txtStreetName" style="width:200px">
  <a href="javascript:void(0)" id="${PM}btnFindAddress">Find Address</a>
  <div class="ACA_TabRow"><div class="ACA_Title_Bar"><h1>Application Information</h1></div></div>
  <label for="${PM}txtAppName">Application Name - For residential please provide builder name or homeowners first and last name:</label> <input id="${PM}txtAppName" name="${PM}txtAppName" style="width:300px">
  <label for="${PM}txtDesc">Provide a detailed description of your project</label> <textarea id="${PM}txtDesc" name="${PM}txtDesc" rows="3" cols="60"></textarea>
  <label for="${PM}txtPanels">Number of panels:</label> <input id="${PM}txtPanels" name="${PM}txtPanels" style="width:80px">
</div>`,
});
const confirmPage = (): string => accela({
  step: 3, title: ["Step 3", ":", "Review"], action: CONFIRM_PATH,
  content: `<div ng-non-bindable="true" class="ACA_Area_CapConfirm">
  <p>Please review all information below. Click the "Edit" buttons to make changes to sections or "Continue Application" to move on.</p>
  <div class="ACA_TabRow"><div class="ACA_Title_Bar"><h1>Work Location</h1></div></div><p>4127 LARKSPUR LN, FERNHOLLOW ID 83600</p>
  <div class="ACA_TabRow"><div class="ACA_Title_Bar"><h1>Application Information</h1></div></div>
  <table class="ACA_GridView"><tr><td>Application Name:</td><td>Quillon Testcase</td></tr><tr><td>Number of panels:</td><td>16</td></tr></table>
</div>`,
});

// ---- the iWorQ-shaped one-page form (synthetic) ----------------------------------------------------
/** A one-page application whose only name box is the signature's. `owner`: an "Owner Name" box too. */
const iworqPage = (owner: boolean): string => `<!doctype html><html><head><title>Solar Permit or Panel Application - Fernhollow</title></head><body>
<header><h2>Solar Permit or Panel Application</h2></header>
<form id="permit" action="/iworq/submit" method="post" style="width:900px">
  <h3>Property Information</h3>
  <label for="prop">* Property Address:</label> <input id="prop" name="prop" style="width:300px">
  ${owner ? `<label for="own">* Owner Name:</label> <input id="own" name="own" style="width:300px">` : ""}
  <h3>Project Info</h3>
  <label for="desc">* Description of Work:</label> <textarea id="desc" name="desc" rows="3" cols="60"></textarea>
  <h3>Signature</h3>
  <p>I hereby certify, under penalty of perjury, that all information contained in this application and any accompanying documents is true, correct, and complete to the best of my knowledge and belief.</p>
  <label for="agree">* I Agree to the Terms on this Form:</label> <input type="checkbox" id="agree" name="agree">
  <label for="sig">* Signature Name:</label> <input id="sig" name="sig" style="width:300px">
  <p>A copy of the bid is required for solar applications.</p>
  <button type="submit" id="go">Submit</button>
</form></body></html>`;

const counts = { advance: 0, filing: 0 };
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const send = (html: string, code = 200): void => { res.writeHead(code, { "content-type": "text/html; charset=utf-8" }); res.end(html); };
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (url.pathname === "/iworq/submit") { counts.filing++; send("<!doctype html><html><body><h1>Application submitted</h1></body></html>"); return; }
      const isContinue = new URLSearchParams(body).get("__EVENTTARGET") === ACTION_CONTINUE;
      if (/CapConfirm/i.test(url.pathname) && isContinue) { counts.filing++; send("<!doctype html><html><body><h1>Step 5 : Record Issuance</h1><p>Your application has been successfully submitted.</p></body></html>"); return; }
      if (isContinue && /pageNumber=1/.test(url.search)) { counts.advance++; res.writeHead(302, { location: CONFIRM_PATH }); res.end(); return; }
      send(page1());
    });
    return;
  }
  if (/CapConfirm/i.test(url.pathname)) { send(confirmPage()); return; }
  if (/CapEdit/i.test(url.pathname)) { send(page1()); return; }
  if (url.pathname === "/iworq/new-permit") { send(iworqPage(false)); return; }
  if (url.pathname === "/iworq/new-permit-owner") { send(iworqPage(true)); return; }
  send("<!doctype html><html><body>not found</body></html>", 404);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// ---- recipes, project, runner ----------------------------------------------------------------------
const HOMEOWNER = "Quillon Testcase";
const SIGNER = "Marisol Signwell";
const PROJECT = {
  id: "p-243", projectAddress: "4127 Larkspur Ln, Fernhollow, ID 83600", city: "Fernhollow", state: "ID", zip: "83600",
  homeownerName: HOMEOWNER, permitType: "electrical",
} as unknown as ProjectRecord;
const VALUES: Record<string, string> = {
  streetNumber: "4127", streetNameCore: "Larkspur", street: "4127 Larkspur Ln", homeownerName: HOMEOWNER,
  workDescription: "Roof-mounted solar PV, 6.4 kW DC, 16 modules", moduleQty: "16", authorizedSignerName: SIGNER,
  installerContactName: "Bramble Wrongname",
};
const CONT_SEL = { role: "link", name: "Continue Application »", exact: true, fallbacks: [{ css: `#${PM}actionBarBottom_btnContinue` }] };
const PAGE1_FILLS: RecipeStep[] = [
  { action: "fill", selector: { label: "Street No.:" }, field: "streetNumber", note: "Street No.:" },
  { action: "fill", selector: { label: "Street Name:" }, field: "streetNameCore", note: "Street Name:" },
  { action: "fill", selector: { label: "Application Name - For residential please provide builder name or homeowners first and last name:" }, field: "homeownerName", note: "Application Name" },
  { action: "fill", selector: { label: "Provide a detailed description of your project" }, field: "workDescription", note: "Provide a detailed description of your project" },
  { action: "fill", selector: { label: "Number of panels:" }, field: "moduleQty", note: "Number of panels:" },
];
const ADVANCE: RecipeStep = { action: "click", selector: CONT_SEL, note: "advance: Continue Application »" };
const FINAL: RecipeStep = { action: "click", selector: CONT_SEL, isFinalSubmit: true, note: "final submit: Continue Application » (recorded, NOT clicked)" };
const recipeOf = (steps: RecipeStep[], entry: string): PortalRecipe => ({
  id: "replay-end-of-recipe-smoke", scopeType: "ahj", profileKey: "id|fernhollow|", state: "ID", ahj: "City of Fernhollow", utility: "",
  portalPlatform: "auto-learned", portalUrl: entry, status: "complete", version: 1,
  steps: [{ action: "goto", value: entry, note: "entry url" }, ...steps], createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
});
type FillData = { reviewMismatches?: Array<{ field: string; found: string; expected: string }>; reviewFieldsConfirmed?: number; reviewFieldsSeen?: number; stoppedBeforeReview?: string };
async function staged(name: string, steps: RecipeStep[], entry: string, handOver = false) {
  counts.advance = 0; counts.filing = 0;
  const progress: string[] = [];
  const r = await stageWithRecipe(recipeOf(steps, entry), PROJECT, VALUES, {}, [], {
    headless: true, onProgress: (e: unknown) => { const m = (e as { message?: unknown })?.message; if (typeof m === "string") progress.push(m); },
    ...(handOver ? { onSubmitCaptured: () => {} } : {}),
  } as never);
  const outcome = derivePortalRunOutcome(r);
  const steps0 = Array.isArray(r.steps) ? (r.steps as Array<{ message?: unknown; data?: unknown }>) : [];
  const fill = steps0[2] ?? {};
  const fillMsg = String(fill.message ?? "");
  const msg = [String(r.message ?? ""), ...steps0.map((s) => String(s?.message ?? ""))].filter(Boolean).join(" | ");
  const data = (fill.data ?? {}) as FillData;
  console.log(`  [${name}] ok=${String(r.ok)} pause=${String(r.pauseReason ?? "-")} status=${outcome.status} advance=${counts.advance} filing=${counts.filing}\n         ${fillMsg.slice(0, 420)}`);
  return { r, outcome, msg, fillMsg, data, progress };
}

// What the shared reading says about the two Accela pages (printed: the verdicts below depend on it).
{
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  await ctx.route("**/*", (route) => (new URL(route.request().url()).hostname === "127.0.0.1" ? route.fallback() : route.abort()));
  const p = await ctx.newPage();
  for (const [label, u] of [["page 1", `${base}${PAGE1_PATH}`], ["CapConfirm", `${base}${CONFIRM_PATH}`], ["iWorQ form", `${base}/iworq/new-permit`]] as const) {
    await p.goto(u, { waitUntil: "domcontentloaded" });
    await p.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = await p.evaluate(() => (globalThis as any).__portalSafety.terminalPageInPage());
    console.log(`     ${label}: reviewPage=${t.reviewPage} readOnlyPage=${t.readOnlyPage} terminal=${t.terminal}`);
  }
  await browser.close();
}

console.log("\nE. end of recipe — a recipe that runs out of steps before its review marker");
for (const handOver of [false, true]) {
  const tag = handOver ? " (handed over)" : "";
  const o = await staged(`ends on page 1, no marker${tag}`, PAGE1_FILLS, `${base}${PAGE1_PATH}`, handOver);
  check(`MUST-PASS${tag} the read-back found the run's own values on page 1 (the trap: 'confirmed' is not 'review')`,
    Number(o.data.reviewFieldsConfirmed ?? 0) >= 2, `reviewFieldsConfirmed=${String(o.data.reviewFieldsConfirmed)}`);
  check(`MUST-PASS${tag} it is paused_for_human (stopped_before_review), never awaiting_human_submit`,
    o.outcome.status === "paused_for_human" && o.outcome.pauseReason === "stopped_before_review", `status=${o.outcome.status} pause=${o.outcome.pauseReason}`);
  check(`MUST-PASS${tag} it says the recipe ENDED on the page's own title before the review step, which was not reached`,
    /ENDED on "Step 1: General Info > Page 1" before the review step — the review step was not reached/.test(o.fillMsg)
      && /did NOT stage .* at its review screen — it ENDED on "Step 1: General Info > Page 1"/.test(o.msg), o.msg.slice(0, 600));
  check(`MUST-PASS${tag} never 'stopped at review', never 'staged … to the review screen', never the read-back's pass sentence`,
    !/stopped at review/i.test(o.msg) && !/staged .* to the review screen/.test(o.msg) && !/no mismatch/.test(o.msg), o.msg.slice(0, 600));
  if (handOver) {
    check("MUST-PASS (handed over) the hand-over line names the page, never 'Staged to review'",
      o.progress.some((m) => /The recipe ended on "Step 1: General Info > Page 1" — NOT the review page/.test(m)) && !o.progress.some((m) => /Staged to review/.test(m)),
      JSON.stringify(o.progress.filter((m) => /review/i.test(m)).slice(-3)));
  }
  check(`0 filing POSTs${tag}`, counts.filing === 0, `filing=${counts.filing}`);
}
{
  const o = await staged("no marker, last step lands ON CapConfirm", [...PAGE1_FILLS, ADVANCE], `${base}${PAGE1_PATH}`);
  check("MUST-EXCLUDE a recipe with no marker whose last step lands on the page that names itself review keeps 'stopped at review' (awaiting_human_submit)",
    counts.advance === 1 && o.outcome.status === "awaiting_human_submit" && !o.outcome.pauseReason && /stopped at review/.test(o.fillMsg) && /staged .* to the review screen/.test(o.msg),
    `advance=${counts.advance} status=${o.outcome.status} ${o.msg.slice(0, 400)}`);
  check("0 filing POSTs", counts.filing === 0, `filing=${counts.filing}`);
}
{
  const o = await staged("reaches its recorded final submit", [...PAGE1_FILLS, ADVANCE, FINAL], `${base}${PAGE1_PATH}`);
  check("MUST-EXCLUDE a recipe that reaches its own recorded final submit keeps today's message (stopped at review, staged)",
    o.outcome.status === "awaiting_human_submit" && /stopped at review\. Review screen checked against the project/.test(o.fillMsg) && /staged .* to the review screen/.test(o.msg),
    `status=${o.outcome.status} ${o.msg.slice(0, 400)}`);
  check("0 filing POSTs", counts.filing === 0, `filing=${counts.filing}`);
}

console.log("\nS. the signer is not the homeowner — the review check's field attribution");
/** `ownerField`: what the "Owner Name" box is bound to — homeownerName (right), or another person's
 *  key (a drifted binding writing the wrong name in; a recorded literal would be left blank). */
const SIG_STEPS = (ownerField: string | null): RecipeStep[] => [
  { action: "fill", selector: { css: "#sig" }, field: "authorizedSignerName", note: "e-signature: signer name (consent)" },
  { action: "fill", selector: { label: "* Property Address:" }, field: "street", note: "Property Address" },
  ...(ownerField !== null ? [{ action: "fill", selector: { label: "* Owner Name:" }, field: ownerField, note: "Owner Name" } as RecipeStep] : []),
  { action: "fill", selector: { label: "* Description of Work:" }, field: "workDescription", note: "Description of Work:" },
  { action: "check", selector: { label: "* I Agree to the Terms on this Form:" }, note: "I Agree to the Terms on this Form:" },
  { action: "click", selector: { role: "button", name: "Submit", exact: true }, isFinalSubmit: true, note: "final submit: Submit (recorded, NOT clicked)" },
];
const homeownerMismatch = (d: FillData) => (d.reviewMismatches ?? []).find((m) => m.field === "homeownerName");
{
  const o = await staged("one-page form, the only name box is the signature's", SIG_STEPS(null), `${base}/iworq/new-permit`);
  const hm = homeownerMismatch(o.data);
  check("MUST-PASS the signer's name is never reported as the homeowner's",
    !(o.data.reviewMismatches ?? []).some((m) => m.found.includes(SIGNER)) && !o.fillMsg.includes(`homeownerName: shows "${SIGNER}`),
    `${JSON.stringify(o.data.reviewMismatches)} | ${o.fillMsg.slice(0, 300)}`);
  check("MUST-PASS the homeowner's name is 'could not confirm' (no such field), not a disagreement",
    !hm || /could not confirm; not a disagreement/.test(hm.found), JSON.stringify(hm));
  check("...the run still stops at its recorded final submit (stopped at review), 0 filing POSTs",
    /stopped at review/.test(o.fillMsg) && counts.filing === 0, `filing=${counts.filing} ${o.fillMsg.slice(0, 200)}`);
}
{
  const o = await staged("an Owner Name box with a WRONG name beside the signature", SIG_STEPS("installerContactName"), `${base}/iworq/new-permit-owner`);
  const hm = homeownerMismatch(o.data);
  check("MUST-EXCLUDE a wrong owner name beside the signature is still caught, showing that name (never the signer's)",
    !!hm && /Bramble Wrongname/.test(hm.found) && !hm.found.includes(SIGNER), JSON.stringify(o.data.reviewMismatches));
}
{
  const o = await staged("an Owner Name box with the RIGHT name beside the signature", SIG_STEPS("homeownerName"), `${base}/iworq/new-permit-owner`);
  check("MUST-EXCLUDE the right owner name beside the signature is confirmed, with no homeownerName mismatch",
    !homeownerMismatch(o.data) && Number(o.data.reviewFieldsConfirmed ?? 0) >= 2, `confirmed=${String(o.data.reviewFieldsConfirmed)} ${JSON.stringify(o.data.reviewMismatches)}`);
}

server.close();
console.log(`\nreplayEndOfRecipe: ${passes} passed, ${failures} failed (of ${passes + failures} checks)`);
if (failures) { console.error(`replayEndOfRecipe: ${failures} check(s) FAILED`); process.exit(1); }
console.log("replayEndOfRecipe: all checks passed (real Chromium, captured Accela chrome + a synthetic one-page form)");
process.exit(0);
