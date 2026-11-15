// AN iWorQ AUTOCOMPLETE IS TYPED INTO AND PICKED FROM, BY ITS OWN MARKUP (#244).
//
// The live shape (City of Star, iWorQ, the 2026-11-10 learn's DOM snapshot and the 2026-11-15
// replay's screenshot): the "Property Information" and "Contractor(s)" boxes are a Vue <autocomplete>
// component that renders
//   <div class="autocomplete-template"><div class="input-group">
//     <input id="autocomplete_1" aria-label="properties autocomplete" type="text" required
//            placeholder="Search properties…" class="form-control">
//     <div class="input-group-append"><button type="button" class="btn"><svg …xmark…></button></div>
//   </div></div>
// — no role, no aria-autocomplete, no widget stamp, no name — and its results panel ("No results match
// your search") spans the widget's column, inside the component, not a popup on <body>. The learner
// recorded both as plain fills; the replay typed the address, picked nothing, and called the step
// verified. A property must be SELECTED for the application to be accepted.
//
// This replica keeps that structure with SYNTHETIC data only (invented streets, numbers, cities and
// companies). Not observed live, and so modelled plainly: the results render as a bare <ul><li> inside
// the component (no listbox / menu / option class), a click writes the box and a hidden id input
// beside it, and Next refuses to go on without both ids ("A property is required…"). Modes (?mode=):
//   match     the job's property among neighbours, the company among a longer namesake;
//   none      both searches answer "No results match your search";
//   nohidden  a reopened draft: the property box already shows an earlier pick and its hidden id
//             holds it; typing empties that id (the widget's own selection), and a click writes the
//             box but never the id again (the portal did not take the pick). A hidden input that was
//             empty all along is never read as the selection (typeaheadSelectedValue.dom.smoke).
// MUST EXCLUDE on the same page: a keyword box whose only hint is "Search…", a box whose class says
// "autocomplete-off", a textarea and a number box — all stay plain fills.
//
//   npx tsx portal-bot/src/adapters/iworqAutocomplete.dom.smoke.ts
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

// ---- synthetic data ----------------------------------------------------------------------------
const JOB = { street: "4821 W Quillfeather Dr", city: "Marrowvale", state: "ID", zip: "83999" };
const COMPANY = "Quillfeather Solar & Electric LLC";
const PROPERTIES = [
  { id: "p-4812", label: "4812 W QUILLFEATHER DR" },
  { id: "p-4821r", label: "4821 W QUILLFEATHER RIDGE DR" },
  { id: "p-4821", label: "4821 W QUILLFEATHER DR" },
  { id: "p-4821s", label: "4821 S QUILLFEATHER DR" },
];
const CONTRACTORS = [
  { id: "c-17", label: "QUILLFEATHER SOLAR AND ELECTRIC LLC OF IDAHO" },
  { id: "c-42", label: "QUILLFEATHER SOLAR AND ELECTRIC LLC" },
  { id: "c-9", label: "BRINDLECOVE ROOFING LLC" },
];

// ---- the replica ---------------------------------------------------------------------------------
const widget = (n: number, resource: string, plural: string, hiddenName: string): string => `
  <div class="autocomplete-template" data-resource="${resource}">
    <div class="input-group">
      <input id="autocomplete_${n}" aria-label="${plural} autocomplete" type="text" required="required" placeholder="Search ${plural}…" class="form-control">
      <div class="input-group-append"><button type="button" class="btn clear" aria-hidden="true"><svg class="svg-inline--fa fa-xmark icon" viewBox="0 0 384 512" width="12" height="12"><path d="M0 0L384 512M384 0L0 512" stroke="currentColor"/></svg></button></div>
    </div>
    <input type="hidden" name="${hiddenName}" value="">
    <div class="autocomplete-results" style="display:none"></div>
  </div>`;

const formPage = (mode: string): string => `<!doctype html><html><head><title>Solar Permit or Panel Application - Synthetic City, ID</title>
<style>
  body{font:14px sans-serif;margin:0;padding:16px} .row{display:flex;gap:24px} .col-12{width:420px}
  .input-group{display:flex} .form-control{width:360px;padding:4px} .hidden{display:none}
  .autocomplete-results{border:1px solid #ddd;width:400px} .autocomplete-results li{padding:4px 8px;cursor:pointer}
  .list-unstyled{list-style:none;margin:0;padding:0} textarea{width:400px;height:60px}
</style></head><body>
<main id="content"><div id="form-container">
<form method="post" enctype="multipart/form-data" action="/permit/synthetic/600">
<input type="hidden" name="_token" value="synthetic-token-0000">
<p><i>- Permit must be pulled by a licensed Synthetic Electrical Contractor</i></p>
<div class="row mb-4">
  <div id="property-section" class="col-12 col-sm-6 mb-4 mb-sm-0">
    <h2 class="text-center"><span class="text-danger">*</span>  Property Information</h2>
    <p class="requiredSection requiredPropertySection hidden">A property is required to submit this application. A matching property must be selected from the search results for it to be included on the application.</p>
    ${widget(1, "properties", "properties", "property_id")}
  </div>
  <div id="contractor-section" class="col-12 col-sm-6">
    <h2 class="text-center"><span class="text-danger">*</span> Contractor(s)</h2>
    <p class="requiredSection requiredContractorSection hidden">A contractor is required to submit this application.</p>
    ${widget(2, "contractors", "contractors", "contractor_id")}
    Contractors with expired licenses are not eligible to submit this form.
  </div>
</div>
<h2>Project Info</h2>
<label for="field9001">* Description of Work:</label><br><textarea id="field9001" name="field9001" required></textarea>
<h2>Fees</h2>
<label for="fee9002">* Enter Total Project Value*:</label><br><input type="number" id="fee9002" name="fee9002" step="any" class="form-control">
<h2>Other</h2>
<label for="kw">Search permits</label><div class="input-group"><input id="kw" name="kw" type="text" placeholder="Search…" class="form-control"></div>
<label for="mail">Mailing Address</label><br><input id="mail" name="mail" type="text" class="form-control autocomplete-off">
<p><button type="button" id="next">Next</button></p>
</form></div></main>
<script>
  var MODE = ${JSON.stringify(mode)};
  var BOOKS = { properties: ${JSON.stringify(mode === "none" ? [] : PROPERTIES)}, contractors: ${JSON.stringify(mode === "none" ? [] : CONTRACTORS)} };
  window.__searches = [];
  function words(s) { return String(s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean); }
  document.querySelectorAll(".autocomplete-template").forEach(function (root) {
    var resource = root.getAttribute("data-resource");
    var box = root.querySelector("input.form-control");
    var hid = root.querySelector("input[type=hidden]");
    var results = root.querySelector(".autocomplete-results");
    var timer = null;
    if (MODE === "nohidden" && resource === "properties") { box.value = "4812 W QUILLFEATHER DR"; hid.value = "p-4812"; }
    function close() { results.style.display = "none"; results.innerHTML = ""; }
    function render(q) {
      window.__searches.push(resource + ":" + q);
      var want = words(q);
      var hits = BOOKS[resource].filter(function (r) {
        var toks = words(r.label);
        return want.every(function (w) { return toks.some(function (t) { return t.indexOf(w) === 0; }); });
      });
      results.innerHTML = "";
      if (!hits.length) {
        var none = document.createElement("p"); none.className = "m-0 p-1"; none.textContent = "No results match your search";
        results.appendChild(none);
      } else {
        var ul = document.createElement("ul"); ul.className = "list-unstyled";
        hits.forEach(function (r) {
          var li = document.createElement("li"); li.textContent = r.label;
          li.addEventListener("mousedown", function (e) { e.preventDefault(); });
          li.addEventListener("click", function () {
            box.value = r.label;
            if (MODE !== "nohidden") hid.value = r.id;
            close();
          });
          ul.appendChild(li);
        });
        results.appendChild(ul);
      }
      results.style.display = "block";
    }
    box.addEventListener("input", function () {
      hid.value = ""; clearTimeout(timer);
      var q = box.value.trim();
      if (q.length < 2) { close(); return; }
      timer = setTimeout(function () { render(q); }, 300);
    });
    root.querySelector("button.clear").addEventListener("click", function () { box.value = ""; hid.value = ""; close(); });
  });
  document.getElementById("next").addEventListener("click", function () {
    var p = document.querySelector("input[name=property_id]").value;
    var c = document.querySelector("input[name=contractor_id]").value;
    document.querySelector(".requiredPropertySection").classList.toggle("hidden", !!p);
    document.querySelector(".requiredContractorSection").classList.toggle("hidden", !!c);
    if (!p || !c) return;
    location.href = "/review?mode=" + MODE + "&p=" + encodeURIComponent(p) + "&c=" + encodeURIComponent(c);
  });
</script></body></html>`;

const REVIEW = (q: URLSearchParams): string => `<!doctype html><html><head><title>Review Application</title></head><body>
<h1>Review</h1><p>Review your application before you submit it.</p>
<p id="sel">property=${q.get("p")} contractor=${q.get("c")}</p>
<button type="button" id="submit">Submit Application</button></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  res.writeHead(200, { "Content-Type": "text/html" });
  if (u.pathname === "/review") return res.end(REVIEW(u.searchParams));
  res.end(formPage(u.searchParams.get("mode") || "match"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

type Shown = { property: string; propertyId: string; contractor: string; contractorId: string; kw: string; mail: string };
const read = async (page: Page): Promise<Shown> => {
  const v = async (sel: string): Promise<string> => page.locator(sel).inputValue({ timeout: 2000 }).catch(() => "(gone)");
  return {
    property: await v("#autocomplete_1"), propertyId: await v("input[name=property_id]"),
    contractor: await v("#autocomplete_2"), contractorId: await v("input[name=contractor_id]"),
    kw: await v("#kw"), mail: await v("#mail"),
  };
};

// ---- the learner ---------------------------------------------------------------------------------
const planner: LearnPlanner = async (req) => {
  if (/review/i.test(req.pageTitle || "")) return { fills: [], atReview: true };
  const at = (label: string): number => req.fields.findIndex((f) => f.label === label);
  const fills: Array<{ selectorIndex: number; value: string; field?: string }> = [];
  const add = (label: string, value: string, field?: string): void => {
    const i = at(label);
    if (i >= 0) fills.push({ selectorIndex: i, value, ...(field ? { field } : {}) });
  };
  add("properties autocomplete", JOB.street, "street");
  add("contractors autocomplete", COMPANY, "installerCompanyName");
  add("* Description of Work:", "Roof-mounted solar PV (synthetic test job)", "workDescription");
  add("Search permits", "SYN-0001");
  add("Mailing Address", "9 Copperfen Way", "installerAddress");
  const next = at("Next");
  return { fills, atReview: false, ...(next >= 0 ? { advanceSelectorIndex: next } : {}) };
};

async function learn(mode: string, maxPages = 2): Promise<{ result: LearnResult; page: Page; ms: number; shown: Shown | null }> {
  const page = await ctx.newPage();
  const url = `${base}/?mode=${mode}`;
  await page.goto(url);
  const adapter = new AutoLearnAdapter(`iWorQ ${mode}`, planner, { maxPages, siteIdentity: { city: JOB.city, zip: JOB.zip } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).page = page;
  const t0 = Date.now();
  const result = await adapter.learn(
    { portalUrl: url } as never,
    {
      projectAddress: `${JOB.street}, ${JOB.city}, ${JOB.state}, ${JOB.zip}`, city: JOB.city, state: JOB.state, zip: JOB.zip,
      homeownerName: "Synthetic Owner", installerCompanyName: COMPANY, permitType: "building",
    } as never,
  );
  const ms = Date.now() - t0;
  const shown = /\/review/.test(page.url()) ? null : await read(page);
  return { result, page, ms, shown };
}

// ---- the replay: the steps AS SAVED on the live recipe (plain fills, no fillStrategy) -------------
const SAVED: RecipeStep[] = [
  { action: "fill", phase: "fill", selector: { label: "properties autocomplete", fallbacks: [{ css: "#autocomplete_1" }] }, note: "properties autocomplete", fingerprint: { id: "autocomplete_1", placeholder: "Search properties…", ariaLabel: "properties autocomplete", section: "* Property Information" }, field: "street" } as RecipeStep,
  { action: "fill", phase: "fill", selector: { label: "contractors autocomplete", fallbacks: [{ css: "#autocomplete_2" }] }, note: "contractors autocomplete", fingerprint: { id: "autocomplete_2", placeholder: "Search contractors…", ariaLabel: "contractors autocomplete", section: "* Property Information" }, field: "installerCompanyName" } as RecipeStep,
  { action: "fill", phase: "fill", selector: { label: "Search permits", fallbacks: [{ css: "#kw" }] }, note: "Search permits", value: "SYN-0001" } as RecipeStep,
  { action: "fill", phase: "fill", selector: { label: "Mailing Address", fallbacks: [{ css: "#mail" }] }, note: "Mailing Address", field: "installerAddress" } as RecipeStep,
];

async function replay(mode: string, steps: RecipeStep[], gap?: LearnPlanner): Promise<{ data: Record<string, unknown>; ok: boolean; message: string; page: Page; shown: Shown; ms: number; searches: string[] }> {
  const page = await ctx.newPage();
  const url = `${base}/?mode=${mode}`;
  const recipe = {
    id: `r-iworq-${mode}`, scopeType: "ahj", profileKey: "id|synthetic city|x", state: "ID", ahj: "Synthetic City", utility: "",
    portalPlatform: "iworq", portalUrl: url, status: "complete", version: 1,
    steps: [{ action: "goto", phase: "open", value: url, note: "entry url" }, ...steps],
    createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "electrical",
  } as unknown as PortalRecipe;
  const values = {
    street: JOB.street, city: JOB.city, state: JOB.state, zip: JOB.zip,
    projectAddress: `${JOB.street}, ${JOB.city}, ${JOB.state}, ${JOB.zip}`,
    installerCompanyName: COMPANY, installerAddress: "9 Copperfen Way",
  };
  const adapter = new RecipeAdapter(recipe, values, {}, { autoSubmit: false });
  if (gap) adapter.enableLlmGapFill(gap, values);
  (adapter as unknown as { page: unknown }).page = page;
  const t0 = Date.now();
  const r = await adapter.fillApplication({} as never);
  const ms = Date.now() - t0;
  const searches = await page.evaluate(() => (window as unknown as { __searches?: string[] }).__searches ?? []).catch(() => [] as string[]);
  return { data: (r.data ?? {}) as Record<string, unknown>, ok: r.ok, message: String(r.message ?? ""), page, shown: await read(page), ms, searches };
}
const list = (d: Record<string, unknown>, k: string): string[] => (Array.isArray(d[k]) ? (d[k] as unknown[]).map(String) : []);

// ---- A) REPLAY OF THE SAVED PLAIN FILLS, MATCH: the box's markup routes them to the type-ahead -----
{
  const r = await replay("match", SAVED);
  const verified = list(r.data, "fieldsVerified");
  const unverified = list(r.data, "fieldsUnverified");
  const aging = list(r.data, "agingNotes");
  console.log(`   replay match: ${r.ms} ms shown=${JSON.stringify(r.shown)}\n   verified=${JSON.stringify(verified)} unverified=${JSON.stringify(unverified)}\n   searches=${JSON.stringify(r.searches)}`);
  check("replay: the property is SELECTED — the job's row picked and its id held (not just typed)",
    r.shown.property === "4821 W QUILLFEATHER DR" && r.shown.propertyId === "p-4821",
    `property=${JSON.stringify(r.shown.property)} id=${JSON.stringify(r.shown.propertyId)} — a plain fill types the address and the id stays empty`);
  check("replay: the contractor is SELECTED by the company rule (& is and; never the longer namesake)",
    r.shown.contractor === "QUILLFEATHER SOLAR AND ELECTRIC LLC" && r.shown.contractorId === "c-42",
    `contractor=${JSON.stringify(r.shown.contractor)} id=${JSON.stringify(r.shown.contractorId)}`);
  // Not kill evidence on its own (main reported both verified too, unselected); with the two checks
  // above, verified here means selected. Sections B and C carry "never verified unless selected".
  check("replay: both are reported verified, nothing unverified",
    verified.includes("properties autocomplete") && verified.includes("contractors autocomplete") && !unverified.length,
    `verified=${JSON.stringify(verified)} unverified=${JSON.stringify(unverified)}`);
  check("replay: the switch from the recording is said, with the markup that decided it",
    aging.some((a) => /"properties autocomplete" was recorded as a plain fill/.test(a) && /autocomplete/.test(a))
      && aging.some((a) => /"contractors autocomplete" was recorded as a plain fill/.test(a)),
    JSON.stringify(aging));
  check("MUST EXCLUDE: the \"Search…\" keyword box and the autocomplete-off box stay plain fills",
    r.shown.kw === "SYN-0001" && r.shown.mail === "9 Copperfen Way" && verified.includes("Search permits") && verified.includes("Mailing Address")
      && !aging.some((a) => /Search permits|Mailing Address/.test(a)),
    `kw=${JSON.stringify(r.shown.kw)} mail=${JSON.stringify(r.shown.mail)} aging=${JSON.stringify(aging)}`);
  await r.page.close();
}

// ---- B) REPLAY, NONE: the portal's own words, by name; nothing verified, the boxes empty ----------
{
  const r = await replay("none", SAVED);
  const warnings = list(r.data, "driftWarnings");
  const verified = list(r.data, "fieldsVerified");
  const unverified = list(r.data, "fieldsUnverified");
  console.log(`   replay none: ${r.ms} ms shown=${JSON.stringify(r.shown)}\n   warnings=${JSON.stringify(warnings.filter((w) => /autocomplete/.test(w)))}`);
  check("replay: no match is a FAILED step naming the box and quoting the portal",
    warnings.some((w) => /^FAILED "properties autocomplete"/.test(w) && /No results match your search/.test(w))
      && warnings.some((w) => /^FAILED "contractors autocomplete"/.test(w) && /No results match your search/.test(w)),
    JSON.stringify(warnings));
  check("...never verified, and the boxes are left empty",
    !verified.includes("properties autocomplete") && !verified.includes("contractors autocomplete")
      && unverified.includes("properties autocomplete") && unverified.includes("contractors autocomplete")
      && r.shown.property === "" && r.shown.contractor === "",
    `verified=${JSON.stringify(verified)} unverified=${JSON.stringify(unverified)} shown=${JSON.stringify(r.shown)}`);
  check("...and each box is searched ONCE: the required sweep does not type the same queries again",
    JSON.stringify(r.searches) === JSON.stringify([
      `properties:${JOB.street}, ${JOB.city}, ${JOB.state} ${JOB.zip}`, "properties:4821 Quillfeather", "properties:4821", `contractors:${COMPANY}`,
    ]),
    `${r.searches.length} searches: ${JSON.stringify(r.searches)}`);
  check("...and the re-assert does not also call either box a control \"no longer on this page\"",
    !warnings.some((w) => /^"(properties|contractors) autocomplete" is blank and its recorded step could not re-fill/.test(w)),
    JSON.stringify(warnings.filter((w) => /could not re-fill/.test(w))));
  check("...quoting the portal's own sentence, not the form row around it",
    warnings.some((w) => /^FAILED "properties autocomplete"/.test(w) && /the portal said: "No results match your search"/.test(w)),
    JSON.stringify(warnings.filter((w) => /^FAILED/.test(w))));
  await r.page.close();
}

// ---- B2) THE GAP-FILL DOOR: a box the search left empty is never given the planner's plain text ----
// The replay's gap-fill asks a planner about required blanks; one that answers the property box with
// the street (grounded: it IS the project's street) would type it back in, picked by nobody.
{
  const offered: string[] = [];
  const gap: LearnPlanner = async (req) => {
    for (const f of req.fields) if (!offered.includes(f.label)) offered.push(f.label);
    const fills: Array<{ selectorIndex: number; value: string; field?: string }> = [];
    const at = (label: string): number => req.fields.findIndex((f) => f.label === label);
    if (at("properties autocomplete") >= 0) fills.push({ selectorIndex: at("properties autocomplete"), value: JOB.street, field: "street" });
    if (at("contractors autocomplete") >= 0) fills.push({ selectorIndex: at("contractors autocomplete"), value: COMPANY, field: "installerCompanyName" });
    if (at("* Description of Work:") >= 0) fills.push({ selectorIndex: at("* Description of Work:"), value: "Roof-mounted solar PV", field: "workDescription" });
    return { fills, atReview: false };
  };
  const r = await replay("none", SAVED, gap);
  const gapFill = (r.data.gapFill ?? {}) as { filled?: string[] };
  console.log(`   replay none + gap-fill: ${r.ms} ms offered=${JSON.stringify(offered)} filled=${JSON.stringify(gapFill.filled)} shown=${JSON.stringify(r.shown)}`);
  check("gap-fill: the planner is asked about the other blanks (the pass ran)", offered.includes("* Description of Work:"), JSON.stringify(offered));
  check("gap-fill: a search box is never offered to the planner, and never typed into",
    !offered.includes("properties autocomplete") && !offered.includes("contractors autocomplete")
      && r.shown.property === "" && r.shown.contractor === "" && !(gapFill.filled ?? []).some((l) => /autocomplete/.test(l)),
    `offered=${JSON.stringify(offered)} filled=${JSON.stringify(gapFill.filled)} shown=${JSON.stringify(r.shown)}`);
  await r.page.close();
}

// ---- C) REPLAY, THE PICK THE PORTAL DID NOT TAKE: the id the typing emptied is never written again --
{
  const r = await replay("nohidden", SAVED.slice(0, 1));
  const warnings = list(r.data, "driftWarnings");
  const verified = list(r.data, "fieldsVerified");
  console.log(`   replay nohidden: ${r.ms} ms shown=${JSON.stringify(r.shown)} warnings=${JSON.stringify(warnings.filter((w) => /autocomplete/.test(w)))}`);
  check("replay: a pick whose selected id (emptied by the typing) was not written again is a FAILED step, named",
    warnings.some((w) => /^FAILED "properties autocomplete"/.test(w) && /selected value/.test(w) && /property_id/.test(w) && /not written again/.test(w)),
    JSON.stringify(warnings));
  check("...never verified, the box cleared", !verified.includes("properties autocomplete") && r.shown.property === "" && r.shown.propertyId === "",
    `verified=${JSON.stringify(verified)} shown=${JSON.stringify(r.shown)}`);
  await r.page.close();
}

// ---- D) LEARN, MATCH: recognised by markup, picked, recorded with the strategy and the binding ----
let recordedProperty: RecipeStep | undefined;
{
  const { result, page, ms, shown } = await learn("match");
  recordedProperty = result.steps.find((s) => s.action === "fill" && s.note === "properties autocomplete");
  const contractor = result.steps.find((s) => s.action === "fill" && s.note === "contractors autocomplete");
  const kw = result.steps.find((s) => s.action === "fill" && s.note === "Search permits");
  const mail = result.steps.find((s) => s.action === "fill" && s.note === "Mailing Address");
  console.log(`   learn match: ${ms} ms url=${page.url()} steps=${JSON.stringify(result.steps.map((s) => `${s.action}:${s.note ?? ""}${s.fillStrategy ? `[${s.fillStrategy}]` : ""}`))}`);
  check("learn: both selections took (Next went on to the review with the job's ids)",
    /\/review/.test(page.url()) && /property=p-4821 contractor=c-42/.test(await page.locator("#sel").textContent().catch(() => "") ?? ""),
    `ended at ${page.url()} shown=${JSON.stringify(shown)} misses=${JSON.stringify(result.typeaheadMisses)}`);
  check("learn: the property box is recorded as a TYPE-AHEAD bound to the street (never the row's text)",
    recordedProperty?.fillStrategy === "typeahead" && recordedProperty?.field === "street" && !recordedProperty?.value,
    JSON.stringify(recordedProperty));
  check("learn: the contractor box is recorded as a TYPE-AHEAD bound to the installer's company",
    contractor?.fillStrategy === "typeahead" && contractor?.field === "installerCompanyName" && !contractor?.value,
    JSON.stringify(contractor));
  check("MUST EXCLUDE (learn): the \"Search…\" keyword box and the autocomplete-off box carry no strategy",
    !!kw && !kw.fillStrategy && !!mail && !mail.fillStrategy, `kw=${JSON.stringify(kw)} mail=${JSON.stringify(mail)}`);
  check("learn: nothing is reported as not picked", !result.typeaheadMisses?.length, JSON.stringify(result.typeaheadMisses));
  await page.close();
}

// ---- E) LEARN, NONE: the portal's words, by name, and no step recorded for the box -----------------
{
  const { result, page, ms, shown } = await learn("none", 1);
  console.log(`   learn none: ${ms} ms stop=${result.stopReason} misses=${JSON.stringify(result.typeaheadMisses)}`);
  check("learn: no match is said by the box's name with the portal's own words",
    (result.typeaheadMisses ?? []).some((m) => /^"properties autocomplete"/.test(m) && /No results match your search/.test(m)),
    `misses=${JSON.stringify(result.typeaheadMisses)} message=${result.message.slice(0, 300)}`);
  check("...with no step recorded for it and the box left empty",
    !result.steps.some((s) => s.note === "properties autocomplete") && (shown?.property ?? "") === "",
    `steps=${JSON.stringify(result.steps.map((s) => s.note))} shown=${JSON.stringify(shown)}`);
  await page.close();
}

await browser.close();
server.close();
console.log(failures === 0 ? "iworqAutocomplete.dom.smoke: PASS" : `iworqAutocomplete.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
