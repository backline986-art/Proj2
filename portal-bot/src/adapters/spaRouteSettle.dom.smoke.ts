// A CLICK THAT ROUTES A SINGLE-PAGE APP IS NOT DONE UNTIL THE APP HAS SETTLED (#245).
//
// Live scratch replay 2026-11-15, City of Tigard (Tyler EnerGov, AngularJS, hash-routed), from the
// Playwright API log:
//   11:01:11.018 click menu "Apply"      → #/applicationAssistant          (the assistant starts initialising)
//   11:01:11.821 click "Search" (0.8 s)  → ?sectionName=All&showTemplates=false (results route)
//   11:01:12.142 the assistant's initialisation ends → ?showTemplates=false (results gone)
// The record type in the results never rendered and the run stopped two steps later. The learn had
// ~15 s between those steps and never raced.
//
// The fixture is that shape, synthetic: a hash-routed app whose assistant view, opened from the menu,
// initialises with a request that takes INIT_MS and then rewrites its own route, clearing any
// results; Search routes to ?sectionName=All&showTemplates=false and renders results from a 100 ms
// request. The REAL RecipeAdapter replays recorded steps against it. A spy on the adapter's phase
// timer reads every route settle (how long, what it saw) so the added time is measured, not guessed.
//
//   race     goto home → a no-navigation click (Show announcements) → menu "Apply" → "advance: Search"
//            → the record-type link that only exists in the results → "Address Type" on the form.
//            MUST PASS (fails with the fix removed): the form is reached and "Address Type" holds
//            "Location"; the route settle after "Apply" waited for the init and saw the rewrite.
//            MUST KEEP: the no-navigation click's settle returns at once (no page read, ~0 ms).
//   undone   an assistant whose every search is taken back by the app 400 ms later (results cleared,
//            route rewritten without sectionName) → "advance: Search" is NOT reported as advanced: the
//            run stops at that step, "the portal did not advance", naming the route the page took
//            back. (With the fix removed it reads the URL as the click left it, calls Search an
//            advance, and dies a step later on the missing record type.)
//   fullpage PowerClerk-style full page loads: a link to a new document that fires a 600 ms request
//            on load → the replay still reaches the next page's select; the settle waited for that
//            request (the new document carried the probe from its init script), so the added time is
//            the request plus the quiet window, not a guess.
//
//   npx tsx portal-bot/src/adapters/spaRouteSettle.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

/** How long the assistant's initialisation request takes (Tigard: 1.12 s from route change to rewrite). */
const INIT_MS = 1000;
const SEARCH_MS = 100;
const UNDO_MS = 300;
const FULL_LOAD_XHR_MS = 600;

const APP = (mode: string): string => `<!doctype html><html><head><title>Self Service</title></head>
<body style="font:14px sans-serif;padding:16px">
<nav id="menu"><a id="menu-home" href="javascript:void(0)" onclick="go('#/home')">Home</a>
  <a id="menu-apply" href="javascript:void(0)" onclick="go('#/assistant')">Apply</a></nav>
<div id="view"></div>
<script>
var MODE = ${JSON.stringify(mode)};
var results = [];
var lastPath = "";
var announcements = false;
function go(h) { location.hash = h; }
function parse() {
  var h = location.hash.slice(1); var q = h.indexOf("?");
  return { path: q < 0 ? h : h.slice(0, q), params: new URLSearchParams(q < 0 ? "" : h.slice(q + 1)) };
}
function view(html) { document.getElementById("view").innerHTML = html; }
function renderHome() {
  view('<h2>Welcome</h2><button id="toggle-ann" type="button" onclick="announcements=!announcements;renderHome()">Show announcements</button>'
    + (announcements ? '<p id="ann">No announcements today.</p>' : ''));
}
function renderAssistant() {
  var list = results.map(function (r) { return '<li><a id="apply-btn-' + r.id + '" href="javascript:void(0)" onclick="go(\\'#/form\\')">' + r.label + '</a></li>'; }).join("");
  view('<h2>Application Assistant</h2><label for="q">Search for application names and keywords</label> <input id="q" type="text">'
    + ' <button id="search-btn" type="button" aria-label="Search" onclick="go(\\'#/assistant?sectionName=All&showTemplates=false\\')">Search</button>'
    + '<ul id="results">' + list + '</ul>');
}
function renderForm() {
  view('<h2>1 Locations</h2><label for="addressTypeSelect">Address Type</label> <select id="addressTypeSelect"><option value="">Select...</option><option>Location</option><option>Parcel</option></select>');
}
function route() {
  var r = parse();
  if (r.path === "/assistant") {
    if (lastPath !== "/assistant") {
      // THE VIEW OPENS AND INITIALISES: a request, then it rewrites its OWN route — and clears any
      // results it was showing (Tigard's assistant: ?sectionName=All became ?showTemplates=false).
      results = [];
      if (MODE === "race") fetch("/api/init").then(function (x) { return x.json(); }).then(function () {
        results = [];
        location.replace("#/assistant?showTemplates=false");
      });
    }
    if (r.params.get("sectionName") === "All") {
      fetch("/api/search").then(function (x) { return x.json(); }).then(function (d) {
        results = d.results; renderAssistant();
        // UNDONE: the app takes the search back moments later, every time.
        if (MODE === "undo") fetch("/api/undo").then(function (x) { return x.json(); }).then(function () {
          results = []; location.replace("#/assistant?showTemplates=false");
        });
      });
    }
    renderAssistant();
  } else if (r.path === "/form") renderForm();
  else renderHome();
  lastPath = r.path;
}
window.addEventListener("hashchange", route);
route();
</script></body></html>`;

const FULL1 = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
<h2>Step 1: Service</h2><label for="proj">Project Name</label> <input id="proj" type="text">
<a id="next" href="/full/2">Next</a></body></html>`;
const FULL2 = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
<h2>Step 2: System</h2><label for="src">Energy Source</label>
<select id="src"><option value="">Select...</option><option>Solar PV</option></select>
<script>document.addEventListener("DOMContentLoaded", function () { fetch("/api/slow").then(function (x) { return x.text(); }); });</script>
</body></html>`;

const served: Array<{ at: number; path: string }> = [];
const server = http.createServer((q, r) => {
  const url = new URL(String(q.url ?? "/"), "http://127.0.0.1");
  served.push({ at: Date.now(), path: url.pathname + url.search });
  const json = (ms: number, body: unknown): void => { setTimeout(() => { r.writeHead(200, { "Content-Type": "application/json" }); r.end(JSON.stringify(body)); }, ms); };
  if (url.pathname === "/api/init") return json(INIT_MS, { ok: true });
  if (url.pathname === "/api/search") return json(SEARCH_MS, { results: [{ id: "ResidentialSolar", label: "Apply for Residential Solar" }, { id: "Fence", label: "Apply for Fence" }] });
  if (url.pathname === "/api/undo") return json(UNDO_MS, { ok: true });
  if (url.pathname === "/api/slow") return json(FULL_LOAD_XHR_MS, { ok: true });
  r.writeHead(200, { "Content-Type": "text/html" });
  if (url.pathname === "/full/1") return r.end(FULL1);
  if (url.pathname === "/full/2") return r.end(FULL2);
  r.end(APP(url.searchParams.get("mode") || "race"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch();

interface Settle { step: number; ms: number; value: { clickedUrl: string; settledUrl: string; result: { settled: boolean; waitedMs: number; reason: string } } | null }
interface Run { res: { ok: boolean; message: string; data?: Record<string, unknown> }; settles: Settle[]; page: import("playwright").Page; close: () => Promise<void> }

async function replay(id: string, entry: string, steps: RecipeStep[]): Promise<Run> {
  const recipe = {
    id, scopeType: "ahj", profileKey: "or|spa-town|", state: "OR", ahj: "Spa Town", utility: "",
    portalPlatform: "energov", portalUrl: entry, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
    steps: [{ action: "goto", phase: "open", value: entry, note: "entry url" } as RecipeStep, ...steps, { action: "stopForReview" } as RecipeStep],
  } as unknown as PortalRecipe;
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(8000);
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await ctx.newPage();
  await page.goto(entry);
  const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  // THE SPY: every route settle the replay pays, with what it returned. With the fix removed there is
  // no "route-settle" phase at all, and this stays empty.
  const settles: Settle[] = [];
  const a = adapter as unknown as { timed: (n: string, f: () => Promise<unknown>) => Promise<unknown>; currentStepIdx: number };
  const orig = a.timed.bind(adapter);
  a.timed = async (name, fn) => {
    if (name !== "route-settle") return orig(name, fn);
    const t0 = Date.now();
    const v = await orig(name, fn);
    settles.push({ step: a.currentStepIdx, ms: Date.now() - t0, value: v as Settle["value"] });
    return v;
  };
  let res: Run["res"];
  try { res = await adapter.fillApplication({} as ProjectRecord) as Run["res"]; } catch (e) { res = { ok: false, message: `threw ${String(e).slice(0, 300)}` }; }
  return { res, settles, page, close: () => ctx.close() };
}
const fmt = (s: Settle[]): string => JSON.stringify(s.map((x) => ({ step: x.step, ms: x.ms, ...(x.value ? { clicked: x.value.clickedUrl.replace(base, ""), settled: x.value.settledUrl.replace(base, ""), waited: x.value.result.waitedMs, why: x.value.result.reason } : { none: true }) })));
const trace = (r: Run): Array<{ i: number; outcome: string; note: string }> => ((r.res.data?.trace as Array<{ i: number; outcome: string; note: string }>) ?? []);

// ── race: Tigard's shape ────────────────────────────────────────────────────────────────────────
{
  const steps: RecipeStep[] = [
    { action: "click", phase: "open", selector: { role: "button", name: "Show announcements", exact: true, fallbacks: [{ css: "#toggle-ann" }] }, note: "show announcements" } as RecipeStep,
    { action: "click", phase: "open", selector: { role: "link", name: "Apply", exact: true, fallbacks: [{ css: "#menu-apply" }] }, note: "navigate to application: Apply" } as RecipeStep,
    { action: "click", phase: "fill", selector: { role: "button", name: "Search", exact: true, fallbacks: [{ css: "#search-btn" }] }, note: "advance: Search" } as RecipeStep,
    { action: "click", phase: "fill", selector: { role: "link", name: "Apply for Residential Solar", exact: true, fallbacks: [{ css: "#apply-btn-ResidentialSolar" }] }, note: "pick application: Residential Solar" } as RecipeStep,
    { action: "select", phase: "fill", selector: { label: "Address Type", fallbacks: [{ css: "#addressTypeSelect" }] }, value: "Location", note: "Address Type" } as RecipeStep,
  ];
  const t0 = Date.now();
  const r = await replay("spa-race", `${base}/app?mode=race#/home`, steps);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const value = await r.page.locator("#addressTypeSelect").inputValue({ timeout: 1000 }).catch(() => "(no form)");
  const hits = served.filter((h) => /^\/api\//.test(h.path)).map((h) => h.path);
  console.log(`   race (${secs}s): ok=${r.res.ok} msg=${String(r.res.message).slice(0, 220)}`);
  console.log(`   race trace=${JSON.stringify(trace(r).map((t) => `${t.i}:${t.outcome}`))} settles=${fmt(r.settles)}`);
  await r.close();
  check("race: the form was reached and \"Address Type\" holds \"Location\" (the results survived the assistant's initialisation)",
    value === "Location", `value=${value} hits=${JSON.stringify(hits)}`);
  check("race: the run did not stop on the record-type link (or anywhere before review)",
    r.res.ok && r.res.data?.failedStepIndex === undefined, `ok=${r.res.ok} failedStepIndex=${String(r.res.data?.failedStepIndex)} trace=${JSON.stringify(trace(r))}`);
  const apply = r.settles.find((s) => s.step === 2 && s.value);
  check("race: the settle after \"Apply\" waited for the init request and saw the app's own rewrite",
    !!apply && apply.ms >= INIT_MS - 100 && /showTemplates=false$/.test(apply.value!.settledUrl) && apply.value!.result.settled && /url×/.test(apply.value!.result.reason),
    fmt(r.settles));
  const noNav = r.settles.find((s) => s.step === 1);
  check("MUST KEEP race: the no-navigation click paid nothing (no settle, < 20 ms)", !!noNav && noNav.value === null && noNav.ms < 20, fmt(r.settles));
  const search = r.settles.find((s) => s.step === 3 && s.value);
  console.log(`   ADDED TIME race: no-navigation click ${noNav?.ms ?? "?"} ms; "Apply" (view init ${INIT_MS} ms) ${apply?.ms ?? "?"} ms; "Search" (request ${SEARCH_MS} ms) ${search?.ms ?? "?"} ms; result link (no request) ${r.settles.find((s) => s.step === 4 && s.value)?.ms ?? "?"} ms`);
}

// ── undone: an advance whose route the app takes back ────────────────────────────────────────────
{
  const steps: RecipeStep[] = [
    { action: "click", phase: "open", selector: { role: "link", name: "Apply", exact: true, fallbacks: [{ css: "#menu-apply" }] }, note: "navigate to application: Apply" } as RecipeStep,
    { action: "click", phase: "fill", selector: { role: "button", name: "Search", exact: true, fallbacks: [{ css: "#search-btn" }] }, note: "advance: Search" } as RecipeStep,
    { action: "click", phase: "fill", selector: { role: "link", name: "Apply for Residential Solar", exact: true, fallbacks: [{ css: "#apply-btn-ResidentialSolar" }] }, note: "pick application: Residential Solar" } as RecipeStep,
  ];
  const t0 = Date.now();
  const r = await replay("spa-undo", `${base}/app?mode=undo#/home`, steps);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const failedAt = Number(r.res.data?.failedStepIndex ?? -1);
  console.log(`   undone (${secs}s): ok=${r.res.ok} failedStepIndex=${failedAt} msg=${String(r.res.message).slice(0, 400)}`);
  console.log(`   undone trace=${JSON.stringify(trace(r).map((t) => `${t.i}:${t.outcome}`))} settles=${fmt(r.settles)}`);
  await r.close();
  check("undone: \"advance: Search\" is not reported as advanced — the run stops AT that step",
    !r.res.ok && failedAt === 2 && !trace(r).some((t) => t.i === 2 && t.outcome === "ok"), `failedStepIndex=${failedAt} trace=${JSON.stringify(trace(r))}`);
  check("undone: the stop says the portal did not advance and names the route the page took back",
    /the portal did not advance/.test(r.res.message) && /took back the route the click opened \(\/app\?mode=undo#\/assistant\?sectionName=All&showTemplates=false → \/app\?mode=undo#\/assistant\?showTemplates=false\)/.test(r.res.message),
    String(r.res.message).slice(0, 400));
}

// ── fullpage: PowerClerk-style full page loads still behave as today ──────────────────────────────
{
  const steps: RecipeStep[] = [
    { action: "click", phase: "fill", selector: { role: "link", name: "Next", exact: true, fallbacks: [{ css: "#next" }] }, note: "advance: Next" } as RecipeStep,
    { action: "select", phase: "fill", selector: { label: "Energy Source", fallbacks: [{ css: "#src" }] }, value: "Solar PV", note: "Energy Source" } as RecipeStep,
  ];
  const t0 = Date.now();
  const r = await replay("full-page", `${base}/full/1`, steps);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const value = await r.page.locator("#src").inputValue({ timeout: 1000 }).catch(() => "(not on page 2)");
  console.log(`   fullpage (${secs}s): ok=${r.res.ok} msg=${String(r.res.message).slice(0, 200)}`);
  console.log(`   fullpage trace=${JSON.stringify(trace(r).map((t) => `${t.i}:${t.outcome}`))} settles=${fmt(r.settles)}`);
  await r.close();
  check("fullpage: the next document's select was filled (\"Solar PV\")", value === "Solar PV", `value=${value} msg=${String(r.res.message).slice(0, 200)}`);
  const next = r.settles.find((s) => s.step === 1 && s.value);
  check("fullpage: the settle counted the new document's load-time request (waited for it, then the quiet window)",
    !!next && next.value!.result.settled && next.ms >= FULL_LOAD_XHR_MS - 100 && /net×/.test(next.value!.result.reason), fmt(r.settles));
  console.log(`   ADDED TIME fullpage: "Next" (a ${FULL_LOAD_XHR_MS} ms load-time request) ${next?.ms ?? "?"} ms`);
}

await browser.close();
server.close();
console.log(failures === 0 ? "spaRouteSettle.dom.smoke: PASS" : `spaRouteSettle.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
