// A SEARCH-AS-YOU-TYPE BOX IS TYPED INTO AND PICKED FROM (#575).
//
// The live shape (a Cityworks PublicAccess application, 2026-11-03): the application's "Location"
// is the city's GIS address search, an EDITABLE
//   <input data-cw-id="txtGISLocation" type="text" maxlength="100" role="combobox"
//          aria-autocomplete="list" aria-controls="list-…" aria-expanded="false">
// inside an Angular cw-ui-input-container, whose list does not exist until you type (the captured
// page holds no element with that id and no role=option at all). The learner upgraded every
// <input role=combobox> to a select, opened an empty list, picked nothing, and Next did nothing.
//
// This replica keeps that STRUCTURE (the container, the label-for, the aria-labelledby that points
// at nothing, the counter, the overlay container the list is rendered into after a debounce) with
// SYNTHETIC addresses only — invented streets, numbers and cities. Modes (?mode=):
//   exact      the job's address is listed among neighbours → picked, read back, and the REPLAY
//              re-finds it (and types THAT job's address for another job);
//   direction  the city lists the house under another street direction → nothing picked, the walk
//              stops with the question, the box is left empty; the replay stops the same way;
//   none       the box offers nothing → a NAMED failure within the fill's budget, box empty;
//   dupes      the same address listed twice → nothing picked, the question.
// MUST EXCLUDE: PowerClerk's readonly filtered-select and an editable combobox with no
// aria-autocomplete are still selects.
//
//   npx tsx portal-bot/src/adapters/typeaheadFill.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { AutoLearnAdapter, EXTRACT_SEL, extractFieldsInPage, toExtractedField, type LearnPlanner, type LearnResult } from "./autoLearnAdapter";
import { RecipeAdapter } from "./recipeAdapter";
import { fillTypeahead } from "../typeaheadFill";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// ---- synthetic data ----------------------------------------------------------------------------
const JOB = { street: "4821 W Quillfeather Dr", city: "Marrowvale", state: "UT", zip: "84999" };
const OTHER_JOB = { street: "77 E Brindlecove Ln", city: "Marrowvale", state: "UT", zip: "84999" };
const BOOKS: Record<string, string[]> = {
  exact: [
    "4812 W QUILLFEATHER DR, MARROWVALE, UT 84999",
    "4821 W QUILLFEATHER RIDGE DR, MARROWVALE, UT 84999",
    "4821 W QUILLFEATHER DR, MARROWVALE, UT 84999",
    "4823 W QUILLFEATHER DR, MARROWVALE, UT 84999",
    "77 E BRINDLECOVE LN, MARROWVALE, UT 84999",
    "77 W BRINDLECOVE LN, MARROWVALE, UT 84999",
  ],
  direction: [
    "4812 S QUILLFEATHER DR, MARROWVALE, UT 84999",
    "4821 S QUILLFEATHER DR, MARROWVALE, UT 84999",
  ],
  none: [],
  dupes: [
    "4821 W QUILLFEATHER DR, MARROWVALE, UT 84999",
    "4821 W QUILLFEATHER DR, MARROWVALE, UT 84999",
  ],
};

// ---- the replica ---------------------------------------------------------------------------------
const formPage = (mode: string): string => `<!doctype html><html><head><title>PublicAccess</title>
<style>
  body{font:14px sans-serif;margin:0;padding:16px}
  cw-ui-input-container{display:block;margin:8px 0;width:420px}
  .input-content input{width:400px;padding:4px}
  .cdk-overlay-container{position:fixed;top:0;left:0;width:0;height:0;z-index:1000}
  .cw-ui-autocomplete-panel{position:fixed;top:150px;left:16px;width:420px;background:#fff;border:1px solid #888}
  .cw-option{padding:4px 8px;cursor:pointer}
  .cw-error{color:#b00}
</style></head><body>
<div class="createHeader"><span>Application:</span> <span>SOLAR - Synthetic</span></div>
<div class="controlHeader"><div class="stepNumber">1</div><span>Main</span></div>
<cw-ui-grid-column class="cwGridLayout col-12-xs">
<cw-ui-input-container layoutid="txtCaseName" divider-color="accent" class="valid empty">
  <div class="above"><label for="cw-ui-input-1000000000000001"> Project Name </label><span trailing="" class="hint counter"> 0 / 80 </span></div>
  <div class="input-content"><div class="leading"></div><input data-cw-id="txtCaseName" maxlength="80" type="text" id="cw-ui-input-1000000000000001" placeholder="" aria-describedby="cw-ui-input-1000000000000001-desc cw-ui-input-1000000000000001-length" aria-labelledby="cw-ui-input-1000000000000001-label" class="ng-untouched ng-pristine ng-valid"><div class="trailing"></div></div>
  <div class="below"><span class="hint" id="cw-ui-input-1000000000000001-desc"></span></div>
</cw-ui-input-container>
</cw-ui-grid-column>
<cw-ui-grid-column class="cwGridLayout col-12-xs">
<cw-ui-input-container layoutid="txtGISLocation" divider-color="accent" class="valid empty">
  <div class="above"><label for="cw-ui-input-2000000000000002"> Location </label><span trailing="" class="hint counter"> 0 / 100 </span></div>
  <div class="input-content"><div class="leading"></div><input data-cw-id="txtGISLocation" maxlength="100" type="text" id="cw-ui-input-2000000000000002" placeholder="" aria-describedby="cw-ui-input-2000000000000002-desc cw-ui-input-2000000000000002-length" aria-labelledby="cw-ui-input-2000000000000002-label" class="ng-untouched ng-pristine ng-valid" aria-controls="list-cw-ui-input-2000000000000002" aria-autocomplete="list" aria-expanded="false" role="combobox"><div class="trailing"></div></div>
  <div class="below"><span class="hint" id="cw-ui-input-2000000000000002-desc"></span></div>
</cw-ui-input-container>
</cw-ui-grid-column>
<div id="err" class="cw-error"></div>
<div id="picked"></div>
<button type="button" id="cancel">Cancel</button>
<button type="button" id="next">Next</button>
<div class="cdk-overlay-container"></div>
<script>
  var BOOK = ${JSON.stringify(BOOKS[mode] ?? (mode === "slow" ? BOOKS.exact : []))};
  var MODE = ${JSON.stringify(mode)};
  var box = document.getElementById("cw-ui-input-2000000000000002");
  var overlay = document.querySelector(".cdk-overlay-container");
  var picked = null; var timer = null;
  window.__searches = [];
  function close() { overlay.innerHTML = ""; box.setAttribute("aria-expanded", "false"); }
  function render(q) {
    close();
    var words = q.toLowerCase().split(/\\s+/).filter(Boolean);
    var hits = BOOK.filter(function (a) {
      var toks = a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ");
      return words.every(function (w) { return toks.some(function (t) { return t.indexOf(w) === 0; }); });
    });
    window.__searches.push(q);
    var panel = document.createElement("div");
    panel.className = "cw-ui-autocomplete-panel";
    panel.setAttribute("role", "listbox");
    panel.id = "list-cw-ui-input-2000000000000002";
    if (!hits.length) {
      var none = document.createElement("div"); none.className = "cw-no-results"; none.textContent = "No results found";
      panel.appendChild(none);
    }
    hits.forEach(function (a) {
      var o = document.createElement("div");
      o.className = "cw-option"; o.setAttribute("role", "option"); o.textContent = a;
      o.addEventListener("mousedown", function (e) { e.preventDefault(); });
      o.addEventListener("click", function () {
        box.value = a; picked = a; close();
        document.getElementById("picked").textContent = "PICKED " + a;
      });
      panel.appendChild(o);
    });
    overlay.appendChild(panel);
    box.setAttribute("aria-expanded", "true");
  }
  box.addEventListener("input", function () {
    picked = null; document.getElementById("picked").textContent = "";
    clearTimeout(timer);
    var q = box.value.trim();
    if (q.length < 3) { close(); return; }
    if (MODE === "slow") {
      // A slow GIS search (the live city's): the panel opens at once with only a progress bar,
      // and the suggestions arrive 9 s later, longer than one query's own wait.
      close();
      var loadingPanel = document.createElement("div");
      loadingPanel.className = "cw-ui-autocomplete-panel"; loadingPanel.setAttribute("role", "listbox");
      loadingPanel.id = "list-cw-ui-input-2000000000000002";
      var bar = document.createElement("div"); bar.className = "cw-progress-bar"; bar.setAttribute("role", "progressbar");
      bar.style.cssText = "height:4px;background:#1976d2";
      loadingPanel.appendChild(bar); overlay.appendChild(loadingPanel); box.setAttribute("aria-expanded", "true");
      timer = setTimeout(function () { render(q); }, 9000);
      return;
    }
    // The GIS search answers after a debounce and a round trip.
    timer = setTimeout(function () { render(q); }, 350);
  });
  document.getElementById("next").addEventListener("click", function () {
    if (!picked || box.value !== picked) { document.getElementById("err").textContent = "Location is required"; return; }
    location.href = "/review?mode=" + MODE;
  });
</script></body></html>`;

const REVIEW = `<!doctype html><html><head><title>Review Application</title></head><body>
<h1>Review</h1><p>Review your application before you submit it.</p>
<button type="button" id="submit">Submit Application</button></body></html>`;

// MUST EXCLUDE shapes, for the classifier.
const CLASSIFY = `<!doctype html><html><head><title>Classify</title></head><body>
  <label for="pcMfr">Manufacturer</label>
  <input id="pcMfr" role="combobox" aria-haspopup="listbox" aria-label="Manufacturer" class="visually-hidden" readonly>
  <label for="cb">County</label><input id="cb" role="combobox" aria-label="County" autocomplete="off">
  <label for="ta">Contractor</label><input id="ta" type="search" role="combobox" aria-autocomplete="both">
  <label for="tro">Parcel</label><input id="tro" type="text" role="combobox" aria-autocomplete="list" readonly>
</body></html>`;

// ---- #139: A LOCATION SEARCH THAT ANSWERS ONLY THE FULL ADDRESS + ENTER --------------------------
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
  if (u.pathname === "/review") return res.end(REVIEW);
  if (u.pathname === "/classify") return res.end(CLASSIFY);
  if (u.pathname === "/framed") return res.end(`<!doctype html><html><head><title>Framed</title></head><body><h1>Wizard</h1><iframe id="app" name="app" src="/?mode=exact" style="width:700px;height:500px"></iframe></body></html>`);
  res.end(formPage(u.searchParams.get("mode") || "exact"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

const planner: LearnPlanner = async (req) => {
  if (/review/i.test(req.pageTitle || "")) return { fills: [], atReview: true };
  const fills: Array<{ selectorIndex: number; value: string; field?: string }> = [];
  const name = req.fields.findIndex((f) => f.label === "Project Name");
  const loc = req.fields.findIndex((f) => f.label === "Location");
  if (name >= 0) fills.push({ selectorIndex: name, value: "Synthetic Test Job", field: "projectName" });
  if (loc >= 0) fills.push({ selectorIndex: loc, value: JOB.street, field: "street" });
  const next = req.fields.findIndex((f) => f.label === "Next");
  return { fills, atReview: false, ...(next >= 0 ? { advanceSelectorIndex: next } : {}) };
};

const read = async (page: Page): Promise<{ value: string; picked: string }> => ({
  value: await page.locator("#cw-ui-input-2000000000000002").inputValue().catch(() => "(gone)"),
  picked: ((await page.locator("#picked").textContent().catch(() => "")) ?? "").trim(),
});

async function learn(mode: string, maxPages = 2): Promise<{ result: LearnResult; page: Page; ms: number; before: { value: string; picked: string } }> {
  const page = await ctx.newPage();
  const url = `${base}/?mode=${mode}`;
  await page.goto(url);
  const adapter = new AutoLearnAdapter(`Typeahead ${mode}`, planner, { maxPages, siteIdentity: { city: JOB.city, zip: JOB.zip } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).page = page;
  const t0 = Date.now();
  const result = await adapter.learn(
    { portalUrl: url } as never,
    { projectAddress: `${JOB.street}, ${JOB.city}, ${JOB.state}, ${JOB.zip}`, city: JOB.city, state: JOB.state, zip: JOB.zip, homeownerName: "Synthetic Owner", permitType: "building" } as never,
  );
  const ms = Date.now() - t0;
  // What the box holds where the walk ended (the review page has no box).
  const before = /\/review/.test(page.url()) ? { value: "(advanced)", picked: "(advanced)" } : await read(page);
  return { result, page, ms, before };
}

async function replay(mode: string, step: RecipeStep, job: typeof JOB): Promise<{ data: Record<string, unknown>; ok: boolean; message: string; page: Page; after: { value: string; picked: string }; ms: number }> {
  const page = await ctx.newPage();
  const url = `${base}/?mode=${mode}`;
  const recipe = {
    id: `r-${mode}`, scopeType: "ahj", profileKey: "ut|marrowvale|x", state: "UT", ahj: "Marrowvale", utility: "",
    portalPlatform: "cityworks", portalUrl: url, status: "complete", version: 1,
    steps: [{ action: "goto", phase: "open", value: url, note: "entry url" }, step],
    createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "structural",
  } as unknown as PortalRecipe;
  const adapter = new RecipeAdapter(recipe, { street: job.street, city: job.city, zip: job.zip, projectAddress: `${job.street}, ${job.city}, ${job.state}, ${job.zip}` }, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  const t0 = Date.now();
  const r = await adapter.fillApplication({} as never);
  const ms = Date.now() - t0;
  return { data: (r.data ?? {}) as Record<string, unknown>, ok: r.ok, message: String(r.message ?? ""), page, after: await read(page), ms };
}

// ---- A) CLASSIFICATION ---------------------------------------------------------------------------
{
  const page = await ctx.newPage();
  await page.goto(`${base}/?mode=exact`);
  const fields = (await page.$$eval(EXTRACT_SEL, extractFieldsInPage)).map(toExtractedField);
  const location = fields.find((f) => f.label === "Location");
  const name = fields.find((f) => f.label === "Project Name");
  console.log(`   location: ${location?.fieldType}/${location?.fillStrategy ?? "-"}; project name: ${name?.fieldType}/${name?.fillStrategy ?? "-"}`);
  check("the GIS Location box (editable role=combobox, aria-autocomplete=list) is a TYPEAHEAD text field, not a select",
    location?.fieldType === "text" && location?.fillStrategy === "typeahead",
    `got ${location?.fieldType}/${location?.fillStrategy} — as a select the list is opened empty and nothing is picked`);
  check("...and its label is still the matching key",
    location?.selector?.label === "Location", `selector ${JSON.stringify(location?.selector)}`);
  check("an ordinary text box carries no strategy", name?.fieldType === "text" && !name?.fillStrategy, `${name?.fieldType}/${name?.fillStrategy}`);
  await page.goto(`${base}/classify`);
  const raws = await page.$$eval(EXTRACT_SEL, extractFieldsInPage);
  const by = (id: string) => raws.find((r) => r.id === id);
  check("MUST EXCLUDE: PowerClerk's readonly filtered-select stays a select", by("pcMfr")?.fieldType === "select" && !by("pcMfr")?.typeahead, JSON.stringify(by("pcMfr")));
  check("MUST EXCLUDE: an editable combobox with no aria-autocomplete stays a select", by("cb")?.fieldType === "select" && !by("cb")?.typeahead, JSON.stringify(by("cb")));
  check("MUST EXCLUDE: a readonly box that says aria-autocomplete=list is not typed into", by("tro")?.fieldType === "select" && !by("tro")?.typeahead, JSON.stringify(by("tro")));
  check("a search-type combobox with aria-autocomplete=both is a typeahead", by("ta")?.fieldType === "text" && by("ta")?.typeahead === true, JSON.stringify(by("ta")));
  await page.close();
}

// ---- B) LEARN, EXACT: picked, read back, recorded with the strategy and the binding ---------------
let recorded: RecipeStep | undefined;
{
  const { result, page, ms } = await learn("exact");
  recorded = result.steps.find((s) => s.action === "fill" && s.note === "Location");
  console.log(`   learn exact: ${ms} ms, steps=${JSON.stringify(result.steps.map((s) => `${s.action}:${s.note ?? ""}${s.fillStrategy ? `[${s.fillStrategy}]` : ""}`))}`);
  check("learn: the job's address was picked and the application advanced",
    /\/review/.test(page.url()), `ended at ${page.url()}; misses=${JSON.stringify(result.typeaheadMisses)} message=${result.message.slice(0, 300)}`);
  check("learn: the step is recorded as a typeahead fill, BOUND to the street (never the suggestion's text)",
    recorded?.fillStrategy === "typeahead" && recorded?.field === "street" && !recorded?.value,
    `recorded ${JSON.stringify(recorded)}`);
  check("learn: nothing is reported as not picked", !result.typeaheadMisses?.length, JSON.stringify(result.typeaheadMisses));
  await page.close();
}

// ---- C) REPLAY, EXACT: the replay re-finds it — and types THAT job's address ----------------------
if (recorded) {
  const r = await replay("exact", recorded, JOB);
  console.log(`   replay exact: ${r.ms} ms ok=${r.ok} value=${JSON.stringify(r.after.value)} picked=${JSON.stringify(r.after.picked)} skipped=${JSON.stringify(r.data.skipped)}`);
  check("replay: the recorded typeahead step picks the job's suggestion",
    r.after.picked === "PICKED 4821 W QUILLFEATHER DR, MARROWVALE, UT 84999" && r.after.value === "4821 W QUILLFEATHER DR, MARROWVALE, UT 84999",
    `picked=${JSON.stringify(r.after.picked)} value=${JSON.stringify(r.after.value)} — a plain fill types the address and nobody picks it`);
  check("replay: the step is not skipped", Array.isArray(r.data.skipped) && (r.data.skipped as string[]).length === 0, JSON.stringify(r.data.skipped));
  const other = await replay("exact", recorded, OTHER_JOB);
  console.log(`   replay other job: picked=${JSON.stringify(other.after.picked)}`);
  check("replay: for ANOTHER job it types and picks that job's address (E, not its W neighbour)",
    other.after.picked === "PICKED 77 E BRINDLECOVE LN, MARROWVALE, UT 84999", `picked=${JSON.stringify(other.after.picked)}`);
  await r.page.close();
  await other.page.close();
} else {
  check("replay: a recorded typeahead step to replay", false, "the learn recorded no Location step");
}

// ---- D) LEARN, DIRECTION MISMATCH: nothing picked, the question, the box empty --------------------
{
  const { result, page, ms, before } = await learn("direction");
  console.log(`   learn direction: ${ms} ms stop=${result.stopReason} box=${JSON.stringify(before.value)} picked=${JSON.stringify(before.picked)}`);
  console.log(`   message: ${result.message.slice(0, 400)}`);
  check("learn: a direction mismatch stops the walk with the question",
    result.stopReason === "typeahead_question", `stopReason=${result.stopReason}; message=${result.message.slice(0, 300)}`);
  check("...naming the portal's address and the project's",
    /4821 S QUILLFEATHER DR/.test(result.message) && /4821 W Quillfeather Dr/.test(result.message) && /Use the portal's\?/.test(result.message),
    result.message.slice(0, 400));
  check("...with NOTHING picked and the box left empty",
    before.picked === "" && before.value === "", `picked=${JSON.stringify(before.picked)} value=${JSON.stringify(before.value)}`);
  check("...and no typeahead step recorded for it",
    !result.steps.some((s) => s.note === "Location"), JSON.stringify(result.steps.map((s) => s.note)));
  await page.close();
}

// ---- E) REPLAY, DIRECTION MISMATCH: stops the same way ---------------------------------------------
if (recorded) {
  const r = await replay("direction", recorded, JOB);
  console.log(`   replay direction: ok=${r.ok} value=${JSON.stringify(r.after.value)} message=${r.message.slice(0, 200)}`);
  check("replay: a direction mismatch stops the run for a person, named",
    !r.ok && /Stopped for a person/.test(r.message) && /4821 S QUILLFEATHER DR/.test(r.message), r.message.slice(0, 300));
  check("...nothing picked, the box empty",
    r.after.picked === "" && r.after.value === "", `picked=${JSON.stringify(r.after.picked)} value=${JSON.stringify(r.after.value)}`);
  await r.page.close();
}

// ---- E2) A SLOW LIST: a panel that shows a progress bar is still loading, not empty ---------------
{
  const page = await ctx.newPage();
  await page.goto(`${base}/?mode=slow`);
  const t0 = Date.now();
  const out = await fillTypeahead(page, page.locator("#cw-ui-input-2000000000000002"), {
    value: JOB.street, mode: "site", site: { street: JOB.street, city: JOB.city, zip: JOB.zip },
  });
  const ms = Date.now() - t0;
  const after = await read(page);
  console.log(`   slow list: ${ms} ms outcome=${out.outcome} after=${JSON.stringify(after)}`);
  check("slow list (9 s behind a progress bar): the fill waits while it loads and picks the job's address",
    out.outcome === "picked" && after.value === "4821 W QUILLFEATHER DR, MARROWVALE, UT 84999" && /^PICKED 4821 W QUILLFEATHER DR/.test(after.picked),
    JSON.stringify({ outcome: out.outcome, after }));
  check("...within the fill's 30 s budget", ms < 30_000, `${ms} ms`);
  await page.close();
}

// ---- F) NO SUGGESTIONS: a named failure, within the fill's budget ---------------------------------
{
  const page = await ctx.newPage();
  await page.goto(`${base}/?mode=none`);
  const t0 = Date.now();
  const out = await fillTypeahead(page, page.locator("#cw-ui-input-2000000000000002"), {
    value: JOB.street, mode: "site", site: { street: JOB.street, city: JOB.city, zip: JOB.zip, state: JOB.state },
  });
  const ms = Date.now() - t0;
  const searches = await page.evaluate(() => (window as unknown as { __searches: string[] }).__searches);
  const after = await read(page);
  console.log(`   no suggestions: ${ms} ms outcome=${out.outcome} why=${"why" in out ? out.why : ""} searched=${JSON.stringify(searches)}`);
  check("no suggestions is a NAMED outcome, not a pick", out.outcome === "no_suggestions" && /offered no suggestions/.test("why" in out ? out.why : ""), JSON.stringify(out));
  // #139: the job's whole one-line address goes in first (Enter there, behind the shared gate), and
  // the house + street core and the house number alone only after it.
  check("...after widening from the whole address to house + street, then the house number alone",
    JSON.stringify(searches) === JSON.stringify([LOC_FULL, "4821 Quillfeather", "4821"]), JSON.stringify(searches));
  check("...within the fill's 30 s budget", ms < 30_000, `${ms} ms`);
  check("...and the box is left empty", after.value === "" && after.picked === "", JSON.stringify(after));
  await page.close();
  if (recorded) {
    const r = await replay("none", recorded, JOB);
    const warnings = (r.data.driftWarnings as string[] | undefined) ?? [];
    console.log(`   replay none: ${r.ms} ms skipped=${JSON.stringify(r.data.skipped)} warnings=${JSON.stringify(warnings.filter((w) => /Location/.test(w)))}`);
    check("replay: no suggestions is a FAILED step with its reason, never a silent accept",
      Array.isArray(r.data.skipped) && (r.data.skipped as string[]).length === 1
        && warnings.some((w) => /^FAILED "Location"/.test(w) && /offered no suggestions/.test(w)),
      `skipped=${JSON.stringify(r.data.skipped)} warnings=${JSON.stringify(warnings)}`);
    check("...and the box is left empty", r.after.value === "", JSON.stringify(r.after));
    await r.page.close();
  }
  // The LEARN's hand-off, which is what an operator reads on a live learn: the miss is named.
  const l = await learn("none", 1);
  console.log(`   learn none: ${l.ms} ms misses=${JSON.stringify(l.result.typeaheadMisses)} box=${JSON.stringify(l.before.value)}`);
  check("learn: no suggestions is said in the result and the message (📍 Not picked), not dropped",
    (l.result.typeaheadMisses ?? []).some((m) => /^"Location"/.test(m) && /offered no suggestions/.test(m))
      && /📍 Not picked — "Location"/.test(l.result.message),
    `misses=${JSON.stringify(l.result.typeaheadMisses)} message=${l.result.message.slice(0, 300)}`);
  check("...with no step recorded for it and the box left empty",
    !l.result.steps.some((s) => s.note === "Location") && l.before.value === "" && l.before.picked === "",
    `steps=${JSON.stringify(l.result.steps.map((s) => s.note))} box=${JSON.stringify(l.before)}`);
  await l.page.close();
}

// ---- G) SEVERAL EQUAL CANDIDATES: nothing picked ---------------------------------------------------
{
  const { result, page, before } = await learn("dupes");
  console.log(`   learn dupes: stop=${result.stopReason} box=${JSON.stringify(before.value)}`);
  check("learn: the same address listed twice picks nothing and asks which",
    result.stopReason === "typeahead_question" && /2 entries/.test(result.message) && before.value === "" && before.picked === "",
    `stop=${result.stopReason} box=${JSON.stringify(before)} message=${result.message.slice(0, 300)}`);
  await page.close();
}

// ---- H) THE BOX INSIDE AN IFRAME: its list is read and clicked in its own frame ---------------------
{
  const page = await ctx.newPage();
  await page.goto(`${base}/framed`);
  const frame = page.frameLocator("#app");
  await frame.locator("#cw-ui-input-2000000000000002").waitFor({ timeout: 10_000 });
  const out = await fillTypeahead(page, frame.locator("#cw-ui-input-2000000000000002"), {
    value: JOB.street, mode: "site", site: { street: JOB.street, city: JOB.city, zip: JOB.zip },
  });
  const pickedText = ((await frame.locator("#picked").textContent().catch(() => "")) ?? "").trim();
  console.log(`   framed: outcome=${out.outcome} picked=${JSON.stringify(pickedText)}`);
  check("a typeahead inside an iframe is read and picked in its own frame",
    out.outcome === "picked" && pickedText === "PICKED 4821 W QUILLFEATHER DR, MARROWVALE, UT 84999",
    `outcome=${JSON.stringify(out)} picked=${JSON.stringify(pickedText)} — reading the top document finds no list`);
  await page.close();
}

// ---- #139: THE FULL ADDRESS + ENTER, THE MANUAL-ENTRY DOOR, THE NAMED STOP ------------------------
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
console.log(failures === 0 ? "typeaheadFill.dom.smoke: PASS" : `typeaheadFill.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
