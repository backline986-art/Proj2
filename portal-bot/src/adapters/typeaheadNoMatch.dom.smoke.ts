// A LOCATION SEARCH THAT TAKES ONLY THE WHOLE ADDRESS + ENTER, AND ONE THAT FINDS NOTHING (#139).
//
// Two watched learns on 2026-11-11 looped on a location search until the portal session expired:
// a CityView "Search for location" (a jQuery-UI box: class ui-autocomplete-input, no ARIA) was
// typed the street-name core as a plain fill, answered "The search value did not match an
// address", and Next bounced to "Submission Error" page after page; an iWorQ "Search properties"
// answered "No results match your search" and the run went on without a word. The owner showed by
// hand that the WHOLE one-line address + Enter selects the location.
//
// The type-ahead half of typeaheadFill.dom.smoke.ts (#575); split out because the two together run
// past the DOM runner's 600 s budget. SYNTHETIC addresses only. Each case asserts no page is visited
// twice (the walk's own page trace) and no search is sent twice (the server's log).
//
//   npx tsx portal-bot/src/adapters/typeaheadNoMatch.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { AutoLearnAdapter, type LearnPlanner, type LearnResult } from "./autoLearnAdapter";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const JOB = { street: "4821 W Quillfeather Dr", city: "Marrowvale", state: "UT", zip: "84999" };

// ---- the replica ---------------------------------------------------------------------------------
// The live shape (a CityView permit portal's "Location of Work Being Done", 2026-11-11), with
// SYNTHETIC data: a jQuery-UI-style search box (class ui-autocomplete-input, autocomplete=off — no
// role=combobox, no aria-autocomplete), help text "Begin typing a street address…", a REQUIRED
// read-only "The location you have selected" box, a "Locations" table, and a form whose FIRST submit
// is a hidden, unlabelled default button: Enter in the box posts the form back and the server either
// selects the location (the row appears, the selected box fills, the search box comes back EMPTY) or
// answers "The search value did not match an address". It offers no suggestion list at all. Modes:
//   fullenter  the server matches ONLY the job's full one-line address (a partial is "did not match");
//   door       nothing matches; a "Can't find address?" button reveals Street Address / City / Zip;
//   nodoor     nothing matches and there is no door;
//   blank      no search box: a required "Permit Holder Code" no data answers (the walk cannot fill
//              it) — Next bounces to "Submission Error" with the same page.
const LOC_FULL = `${JOB.street}, ${JOB.city}, ${JOB.state} ${JOB.zip}`;
const LOC_SELECTED = "4821 W QUILLFEATHER DR, MARROWVALE, UT 84999";
const locLoose = (s: string): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const locLog: Record<string, { enters: string[]; nexts: number; gets: number }> = {};
const logOf = (mode: string) => (locLog[mode] ??= { enters: [], nexts: 0, gets: 0 });
const escHtml = (s: string): string => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const locPage = (mode: string, o: { selected?: string; error?: string; title?: string } = {}): string => {
  const door = mode === "door";
  const blank = mode === "blank";
  const sel = o.selected ?? "";
  return `<!doctype html><html><head><title>${o.title ?? "Permit Application | Synthetic City"}</title>
<style>body{font:14px sans-serif;margin:16px} .cv-default-submit{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
 .cv-error{color:#b00} label{display:block;margin-top:8px} input[type=text],textarea{width:420px}</style></head><body>
<h1>Permit Application</h1><h2>${blank ? "Permit Holder" : "Location of Work Being Done"}</h2>
${o.error ? `<div class="cv-error validation-summary-errors" role="alert"><ul><li>${escHtml(o.error)}</li></ul></div>` : ""}
<form method="post" action="/loc?mode=${mode}">
<input type="submit" name="brepeatlocation" aria-hidden="true" tabindex="-1" class="cv-default-submit" value="">
<input type="hidden" name="selected" value="${escHtml(sel)}">
${blank ? `<label for="holder">Permit Holder Code:<span class="required">*</span></label><input type="text" id="holder" name="holder">` : `
<div class="cv-input-container"><div id="help" class="cv-inline-help">Begin typing a street address or Tax Lot Number above and we will search existing locations within the jurisdiction.</div>
<label for="cvlocdesc">Search for location:<span class="required">*</span></label>
<input aria-describedby="help" autocomplete="off" id="cvlocdesc" name="cvlocdesc" type="text" class="ui-autocomplete-input"></div>
${door ? `<input type="button" id="openNewLocation" class="cv-additionalsingle-btn" value="Can't find address?">` : ""}
<label for="uselocation">The location you have selected: <span class="required">*</span></label>
<textarea id="uselocation" name="uselocation" readonly rows="2">${escHtml(sel)}</textarea>
<table id="locations"><caption>Locations</caption><tr><th>Address</th></tr>${sel ? `<tr><td>${escHtml(sel)}</td></tr>` : ""}</table>
${door ? `<div id="newLocation" style="display:none"><p>Please enter the street address of the location; staff will confirm it.</p>
<label for="streetAddressNL">Street Address:</label><input type="text" id="streetAddressNL" name="streetAddressNL">
<label for="cityNL">City:</label><input type="text" id="cityNL" name="cityNL">
<label for="zipNL">Zip:</label><input type="text" id="zipNL" name="zipNL"></div>
<script>window.__doorClicks = 0; document.getElementById("openNewLocation").addEventListener("click", function () { window.__doorClicks++; document.getElementById("newLocation").style.display = "block"; });</script>` : ""}`}
<p><button type="submit" name="bnext" value="1">Next Step</button></p>
</form></body></html>`;
};
async function locPost(req: http.IncomingMessage, res: http.ServerResponse, mode: string): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const log = logOf(mode);
  const selected = body.get("selected") || "";
  if (body.has("bnext")) {
    log.nexts++;
    const manual = mode === "door" && !!body.get("streetAddressNL") && !!body.get("cityNL") && !!body.get("zipNL");
    const holder = mode === "blank" && !!body.get("holder");
    if (selected || manual || holder) { res.writeHead(303, { Location: `/review?mode=${mode}` }); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(locPage(mode, { selected, title: "Submission Error - Permit Application | Synthetic City", error: mode === "blank" ? "Permit Holder Code is required" : "The location you have selected is required" }));
    return;
  }
  // Enter in the search box: the form's default (hidden) submit posts the search back.
  const q = body.get("cvlocdesc") || "";
  log.enters.push(q);
  res.writeHead(200, { "Content-Type": "text/html" });
  if (mode === "fullenter" && locLoose(q) === locLoose(LOC_FULL)) return void res.end(locPage(mode, { selected: LOC_SELECTED }));
  res.end(locPage(mode, { selected, error: "The search value did not match an address" }));
}


const REVIEW = `<!doctype html><html><head><title>Review Application</title></head><body>
<h1>Review</h1><p>Review your application before you submit it.</p>
<button type="button" id="submit">Submit Application</button></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  if (u.pathname === "/loc") {
    const mode = u.searchParams.get("mode") || "fullenter";
    if (req.method === "POST") { void locPost(req, res, mode); return; }
    logOf(mode).gets++;
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(locPage(mode));
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(REVIEW);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

// ---- the walks -----------------------------------------------------------------------------------
// The live planner typed the street-name core ("718 NE 8th") as a literal, unbound; it is copied here
// (a synthetic partial of the job's street) so the walk has to turn it into the job's full address.
const locPlanner: LearnPlanner = async (req) => {
  if (/review/i.test(req.pageTitle || "")) return { fills: [], atReview: true };
  const fills: Array<{ selectorIndex: number; value: string; field?: string }> = [];
  const box = req.fields.findIndex((f) => /^Search for location/.test(f.label));
  if (box >= 0) fills.push({ selectorIndex: box, value: "4821 W Quillfeather" });
  const next = req.fields.findIndex((f) => f.label === "Next Step");
  return { fills, atReview: false, ...(next >= 0 ? { advanceSelectorIndex: next } : {}) };
};
async function learnLoc(mode: string, maxPages = 3): Promise<{ result: LearnResult; page: Page; ms: number }> {
  const page = await ctx.newPage();
  const url = `${base}/loc?mode=${mode}`;
  await page.goto(url);
  const adapter = new AutoLearnAdapter(`Location ${mode}`, locPlanner, { maxPages, siteIdentity: { city: JOB.city, zip: JOB.zip } });
  (adapter as unknown as { page: unknown }).page = page;
  const t0 = Date.now();
  const result = await adapter.learn(
    { portalUrl: url } as never,
    { projectAddress: `${JOB.street}, ${JOB.city}, ${JOB.state}, ${JOB.zip}`, city: JOB.city, state: JOB.state, zip: JOB.zip, homeownerName: "Synthetic Owner", permitType: "building" } as never,
  );
  return { result, page, ms: Date.now() - t0 };
}
/** The walk's own page trace, reduced to "title @ path": a page visited twice repeats a line. */
const visits = (r: LearnResult): string[] => (r.pageTrace ?? []).map((t) => (/^p\d+\s+("[^"]*"\s+\[[^\]]*\])/.exec(t)?.[1] ?? t));
const noRepeat = (list: string[]): boolean => new Set(list).size === list.length;

// (1) The box answers only the FULL one-line address + Enter; the pick shows in the Locations table.
let locRecorded: RecipeStep | undefined;
{
  const { result, page, ms } = await learnLoc("fullenter");
  const log = logOf("fullenter");
  locRecorded = result.steps.find((s) => s.action === "fill" && /^Search for location/.test(String(s.note ?? "")));
  console.log(`   loc fullenter: ${ms} ms url=${page.url()} enters=${JSON.stringify(log.enters)} nexts=${log.nexts} trace=${JSON.stringify(visits(result))}`);
  console.log(`   message: ${result.message.slice(0, 300)}`);
  check("(1) learn: the job's FULL one-line address is typed and Enter pressed — the portal selects it and the application advances",
    /\/review/.test(page.url()) && log.enters.length >= 1 && locLoose(log.enters[0]) === locLoose(LOC_FULL),
    `ended at ${page.url()}; enters=${JSON.stringify(log.enters)} stop=${result.stopReason} message=${result.message.slice(0, 300)}`);
  check("(1) ...the street-name core is never what Enter searched, and no search is sent twice",
    log.enters.every((q) => locLoose(q) === locLoose(LOC_FULL)) && noRepeat(log.enters.map(locLoose)),
    JSON.stringify(log.enters));
  check("(1) ...recorded as a typeahead fill BOUND to the street (never the portal's text), the advance pressed once",
    locRecorded?.fillStrategy === "typeahead" && locRecorded?.field === "street" && !locRecorded?.value && log.nexts === 1,
    `recorded ${JSON.stringify(locRecorded)} nexts=${log.nexts}`);
  check("(1) ...nothing reported as not picked or left blank (the emptied search box is not a miss)",
    !result.typeaheadMisses?.length && !(result.requiredFieldMisses ?? []).some((m) => /location/i.test(m)),
    `misses=${JSON.stringify(result.typeaheadMisses)} required=${JSON.stringify(result.requiredFieldMisses)}`);
  check("(1) ...no page visited twice", noRepeat(visits(result)), JSON.stringify(visits(result)));
  await page.close();
}
// (1r) The replay of that step selects the same way, and does not call the emptied box a failure.
if (locRecorded) {
  const page = await ctx.newPage();
  const url = `${base}/loc?mode=fullenter`;
  const before = logOf("fullenter").enters.length;
  const recipe = {
    id: "r-loc", scopeType: "ahj", profileKey: "ut|marrowvale|x", state: "UT", ahj: "Marrowvale", utility: "",
    portalPlatform: "cityview", portalUrl: url, status: "complete", version: 1,
    steps: [{ action: "goto", phase: "open", value: url, note: "entry url" }, locRecorded],
    createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "structural",
  } as unknown as PortalRecipe;
  const adapter = new RecipeAdapter(recipe, { street: JOB.street, city: JOB.city, state: JOB.state, zip: JOB.zip, projectAddress: `${JOB.street}, ${JOB.city}, ${JOB.state}, ${JOB.zip}` }, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  const r = await adapter.fillApplication({} as never);
  const data = (r.data ?? {}) as Record<string, unknown>;
  const warnings = ((data.driftWarnings as string[] | undefined) ?? []).filter((w) => /location/i.test(w));
  const selectedNow = ((await page.locator("#uselocation").inputValue().catch(() => "")) ?? "").trim();
  console.log(`   replay loc: ok=${r.ok} selected=${JSON.stringify(selectedNow)} enters=${JSON.stringify(logOf("fullenter").enters.slice(before))} warnings=${JSON.stringify(warnings)}`);
  check("(1r) replay: the recorded step types the full address, presses Enter once, and the portal selects it — not FAILED",
    selectedNow === LOC_SELECTED && logOf("fullenter").enters.slice(before).length === 1 && !warnings.some((w) => /FAILED/.test(w)),
    `selected=${JSON.stringify(selectedNow)} enters=${JSON.stringify(logOf("fullenter").enters.slice(before))} warnings=${JSON.stringify(warnings)}`);
  await page.close();
}

// (2) No match, and the portal's own "Can't find address?" door: clicked once, its boxes filled.
{
  const { result, page, ms } = await learnLoc("door");
  const log = logOf("door");
  const filled = result.steps.filter((s) => /Street Address|City|Zip/.test(String(s.note ?? "")) && s.action === "fill");
  const doorClicks = result.steps.filter((s) => s.action === "click" && /can.?t find address/i.test(String(s.note ?? "")));
  console.log(`   loc door: ${ms} ms url=${page.url()} enters=${JSON.stringify(log.enters)} nexts=${log.nexts} steps=${JSON.stringify(result.steps.map((s) => `${s.action}:${s.note ?? ""}:${s.field ?? ""}`))}`);
  console.log(`   message: ${result.message.slice(0, 400)}`);
  check("(2) learn: no match → the \"Can't find address?\" door is clicked ONCE and recorded",
    doorClicks.length === 1, JSON.stringify(result.steps.map((s) => `${s.action}:${s.note ?? ""}`)));
  check("(2) ...its Street Address / City / Zip are filled, each BOUND (street / city / zip), and the application advances",
    filled.length === 3 && ["street", "city", "zip"].every((f) => filled.some((s) => s.field === f && !s.value)) && /\/review/.test(page.url()),
    `filled=${JSON.stringify(filled)} url=${page.url()} stop=${result.stopReason}`);
  check("(2) ...the type-ahead that found no match is still listed by label in the run's message",
    (result.typeaheadMisses ?? []).some((m) => /^"Search for location/.test(m)) && /Search for location/.test(result.message),
    `misses=${JSON.stringify(result.typeaheadMisses)} message=${result.message.slice(0, 300)}`);
  check("(2) ...Enter searched the full address once, never twice", log.enters.length === 1 && locLoose(log.enters[0]) === locLoose(LOC_FULL), JSON.stringify(log.enters));
  check("(2) ...no page visited twice", noRepeat(visits(result)), JSON.stringify(visits(result)));
  await page.close();
}

// (3) No match and no door: the walk stops NAMED on that page, the portal's message in the item.
{
  const { result, page, ms } = await learnLoc("nodoor");
  const log = logOf("nodoor");
  console.log(`   loc nodoor: ${ms} ms stop=${result.stopReason} pages=${result.pageCount} enters=${JSON.stringify(log.enters)} nexts=${log.nexts}`);
  console.log(`   message: ${result.message.slice(0, 500)}`);
  const item = (result.typeaheadMisses ?? []).find((m) => /^"Search for location/.test(m)) ?? "";
  check("(3) learn: no match and no door → a NAMED stop on that page (never advanced, never retried)",
    result.stopReason === "typeahead_no_match" && result.pageCount === 1 && log.nexts === 0,
    `stop=${result.stopReason} pages=${result.pageCount} nexts=${log.nexts} message=${result.message.slice(0, 300)}`);
  check("(3) ...the item names the box, the value typed and the portal's own message",
    /4821 W Quillfeather Dr, Marrowvale, UT 84999/.test(item) && /The search value did not match an address/.test(item),
    item || JSON.stringify(result.typeaheadMisses));
  check("(3) ...and the run's message lists it by label",
    /Stopped for a person on page 1/.test(result.message) && /Search for location/.test(result.message) && /did not match an address/.test(result.message),
    result.message.slice(0, 400));
  check("(3) ...the required box is a review item (required field left blank)",
    (result.requiredFieldMisses ?? []).some((m) => /Search for location/.test(m)), JSON.stringify(result.requiredFieldMisses));
  check("(3) ...Enter searched the full address once, never twice", log.enters.length === 1, JSON.stringify(log.enters));
  await page.close();
}

// (4) A required box the walk cannot fill: the bounce back is the named stop, not a loop.
{
  const { result, page, ms } = await learnLoc("blank", 4);
  const log = logOf("blank");
  console.log(`   loc blank: ${ms} ms stop=${result.stopReason} pages=${result.pageCount} nexts=${log.nexts}`);
  console.log(`   message: ${result.message.slice(0, 400)}`);
  check("(4) learn: a required box still blank after its re-plan, brought back by the portal, ends the walk NAMED",
    result.stopReason === "required_blank" && /Permit Holder Code/.test(result.message) && log.nexts === 1 && result.pageCount === 2,
    `stop=${result.stopReason} pages=${result.pageCount} nexts=${log.nexts} message=${result.message.slice(0, 300)}`);
  check("(4) ...and it is a review item", (result.requiredFieldMisses ?? []).some((m) => /Permit Holder Code/.test(m)), JSON.stringify(result.requiredFieldMisses));
  await page.close();
}


await browser.close();
server.close();
console.log(failures === 0 ? "typeaheadNoMatch.dom.smoke: PASS" : `typeaheadNoMatch.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
