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
// request. The REAL RecipeAdapter replays recorded steps against it. A spy on the adapter's route
// settle reads every one (how long, what it saw) so the added time is measured, not guessed; a spy
// on executeClick (on main too) times each click's whole step.
//
// Check labels: MUST PASS fails with the fix removed; MUST KEEP passes on main and with the fix (a
// behaviour main has that the fix must not break); COST measures the new code itself, so it has
// nothing to measure on main and fails there for that reason only.
//
//   race       goto home → a no-navigation click (Show announcements) → menu "Apply" → "advance: Search"
//              → the record-type link that only exists in the results → "Address Type" on the form.
//              MUST PASS: the form is reached and "Address Type" holds "Location"; the route settle
//              after "Apply" waited for the init and saw the rewrite. MUST KEEP: the no-navigation
//              click's whole step stays fast. COST: its route settle returns at once.
//   undone     an assistant whose every search is taken back by the app 400 ms later (results cleared,
//              route rewritten without sectionName) → "advance: Search" is NOT reported as advanced: the
//              run stops at that step, "the portal did not advance", naming the route the page took
//              back — in the page-context bracket, so the backend's verdict never reads URL words.
//   chain      Tigard's real request chain (six learn traces): view template → settings → api/user/my
//              (~500 ms) → a 4-request batch → the route rewrite (~1.1 s after the click) → a trending
//              request still in flight past the 4 s bound. MUST PASS: the form is still reached (the
//              settle waited past the rewrite before its bound ran out) and the unsettled settle is
//              named in the step's slow-step phases, with what was still in flight.
//   searchsync MUST KEEP (review of #245): a search page whose router re-adds its default page=1 150 ms
//              after the search; the results are links and the search box stays, so the page's identity
//              never changes. "advance: Search" must read as advanced and the run reach the form. The
//              round-1 rule called the re-added page=1 "the click taken back" and false-stopped here.
//   transient  MUST KEEP (review of #245): a wizard whose Continue goes through #/loading for 250 ms to
//              #/w?step=N+1; steps 1 and 2 share heading and inputs. Each Continue is one advance, and
//              the run fills step 3's select. The round-1 rule called step 1 → step 2 "back on the route
//              it left", retried Continue and skipped a page.
//   fullpage   PowerClerk-style full page loads: a link to a new document that fires a 600 ms request
//              on load → the replay still reaches the next page's select; the settle waited for that
//              request (the new document carried the probe from its init script), so the added time is
//              the request plus the quiet window, not a guess.
//   ticker     COST: a route change on a page whose clock re-renders every 100 ms settles in the quiet
//              window, not the 4 s bound — DOM mutations are not activity for a route settle.
//
//   npx tsx portal-bot/src/adapters/spaRouteSettle.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import * as settleModule from "../settle";
import { RecipeAdapter } from "./recipeAdapter";

// Read off the namespace, not imported by name, so a kill run on main's settle.ts (which has no
// settleAfterRoute) still runs every leg and fails each for its own reason instead of at import.
const { installSettleProbe } = settleModule;
const ROUTE_SETTLE_MS = Number((settleModule as Record<string, unknown>).ROUTE_SETTLE_MS ?? 4000);
const settleAfterRoute = (settleModule as Record<string, unknown>).settleAfterRoute as
  | ((page: import("playwright").Page, beforeUrl: string) => Promise<{ result: { settled: boolean } } | null>)
  | undefined;
// The backend's own verdict on a failed replay's message: the one rule, not a copy.
const { replayFailureBlamesRecipe, replayFailureTextWithoutPageContext } = await import("../../../backend/src/portalRecipes");

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
/** Tigard's chain, from the learn traces: stage delays, and a trending request long enough that the
 *  chain (~4.6 s) runs clearly past the 4 s bound — not at its edge, so the leg is not timing-flaky. */
const CHAIN_MS: Record<string, number> = { template: 100, settings: 100, user: 500, b1: 300, b2: 300, b3: 300, b4: 300, trending: 3500 };
/** The chain end to end (the batch runs in parallel): the rewrite lands at ~1.0 s, trending ends ~4.5 s. */
const CHAIN_TOTAL_MS = CHAIN_MS.template + CHAIN_MS.settings + CHAIN_MS.user + CHAIN_MS.b1 + CHAIN_MS.trending;
/** The no-navigation click's whole step must stay under this (MUST KEEP; main and the fix both measured
 *  far under it — see the ADDED TIME line). A route settle paid by a click that changed nothing would
 *  cost at least the 300 ms quiet window and trip it. */
const NO_NAV_CLICK_MAX_MS = 250;

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
function j(p) { return fetch(p).then(function (x) { return x.json(); }); }
function parse() {
  var h = location.hash.slice(1); var q = h.indexOf("?");
  return { path: q < 0 ? h : h.slice(0, q), params: new URLSearchParams(q < 0 ? "" : h.slice(q + 1)) };
}
function view(html) { document.getElementById("view").innerHTML = html; }
function renderHome() {
  view('<h2>Welcome</h2><label for="home-q">Search records</label> <input id="home-q" type="text">'
    + ' <button id="toggle-ann" type="button" onclick="announcements=!announcements;renderHome()">Show announcements</button>'
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
function rewrite() { results = []; location.replace("#/assistant?showTemplates=false"); }
function route() {
  var r = parse();
  if (r.path === "/assistant") {
    if (lastPath !== "/assistant") {
      // THE VIEW OPENS AND INITIALISES: a request, then it rewrites its OWN route — and clears any
      // results it was showing (Tigard's assistant: ?sectionName=All became ?showTemplates=false).
      results = [];
      if (MODE === "race") j("/api/init").then(rewrite);
      // TIGARD'S CHAIN: each stage starts when the one before ends; the rewrite lands after the batch,
      // and trending is still in flight long after it.
      if (MODE === "chain") j("/api/chain/template").then(function () { return j("/api/chain/settings"); })
        .then(function () { return j("/api/chain/user"); })
        .then(function () { return Promise.all([j("/api/chain/b1"), j("/api/chain/b2"), j("/api/chain/b3"), j("/api/chain/b4")]); })
        .then(function () { rewrite(); return j("/api/chain/trending"); });
    }
    if (r.params.get("sectionName") === "All") {
      j("/api/search").then(function (d) {
        results = d.results; renderAssistant();
        // UNDONE: the app takes the search back moments later, every time.
        if (MODE === "undo") j("/api/undo").then(rewrite);
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

// A search page whose router normalises every search URL to carry its default page=1, 150 ms after it
// lands. The results are links and the search box stays: the page's identity never changes.
const SEARCHSYNC = `<!doctype html><html><head><title>Records</title></head>
<body style="font:14px sans-serif;padding:16px">
<h2 id="heading">Records</h2><div id="view"></div>
<script>
function parse() {
  var h = location.hash.slice(1); var q = h.indexOf("?");
  return { path: q < 0 ? h : h.slice(0, q), params: new URLSearchParams(q < 0 ? "" : h.slice(q + 1)) };
}
function view(html) { document.getElementById("view").innerHTML = html; }
var searches = 0;
function doSearch() { searches++; location.hash = "#/search?q=solar"; }
function route() {
  var r = parse();
  if (r.path === "/form") {
    document.getElementById("heading").textContent = "Permit form";
    view('<label for="mount">Mount Type</label> <select id="mount"><option value="">Select...</option><option>Roof Mount</option></select>');
    return;
  }
  document.getElementById("heading").textContent = "Records";
  var q = r.params.get("q");
  view('<label for="q">Search records</label> <input id="q" type="text"> <button id="search-btn" type="button" onclick="doSearch()">Search</button>'
    + '<ul id="results">' + (q ? '<li><a id="res-solar" href="#/form">Solar Permit</a></li>' : '') + '</ul>');
  if (!r.params.get("page")) setTimeout(function () {
    var now = parse();
    if (now.path === "/search" && !now.params.get("page")) { now.params.set("page", "1"); location.replace("#/search?" + now.params.toString()); }
  }, 150);
}
window.addEventListener("hashchange", route);
route();
</script></body></html>`;

// A wizard whose Continue goes through a transient #/loading route to the next step. Steps 1 and 2
// show the same heading and the same inputs (a header search box), so only the URL says it moved.
const TRANSIENT = `<!doctype html><html><head><title>Wizard</title></head>
<body style="font:14px sans-serif;padding:16px">
<header><label for="site-q">Search site</label> <input id="site-q" type="text"></header>
<h2>Application</h2><div id="view"></div>
<script>
var continues = [];
function step() { var m = /step=(\\d+)/.exec(location.hash); return m ? Number(m[1]) : 0; }
function view(html) { document.getElementById("view").innerHTML = html; }
function next() {
  var n = step(); continues.push([n, Date.now()]);
  location.hash = "#/loading";
  setTimeout(function () { location.replace("#/w?step=" + (n + 1)); }, 250);
}
function route() {
  if (location.hash.indexOf("#/loading") === 0) { view('<p>Loading...</p>'); return; }
  var n = step();
  if (n >= 3) view('<p>Step ' + n + ' of 3</p><label for="final">Final answer</label> <select id="final"><option value="">Select...</option><option>Done</option></select>');
  else view('<p>Step ' + n + ' of 3</p><button id="continue" type="button" onclick="next()">Continue</button>');
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

const TICKER = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
<p>Now: <span id="clock"></span></p><a id="go" href="#/next">Go</a>
<script>setInterval(function () { document.getElementById("clock").textContent = String(Date.now()); }, 100);</script>
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
  const stage = /^\/api\/chain\/(\w+)$/.exec(url.pathname)?.[1];
  if (stage && CHAIN_MS[stage] !== undefined) return json(CHAIN_MS[stage], { ok: true });
  r.writeHead(200, { "Content-Type": "text/html" });
  if (url.pathname === "/full/1") return r.end(FULL1);
  if (url.pathname === "/full/2") return r.end(FULL2);
  if (url.pathname === "/ticker") return r.end(TICKER);
  if (url.pathname === "/searchsync") return r.end(SEARCHSYNC);
  if (url.pathname === "/transient") return r.end(TRANSIENT);
  r.end(APP(url.searchParams.get("mode") || "race"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch();

interface Settle { step: number; ms: number; value: { clickedUrl: string; settledUrl: string; result: { settled: boolean; waitedMs: number; reason: string } } | null }
interface Run {
  res: { ok: boolean; message: string; data?: Record<string, unknown> };
  settles: Settle[];
  clicks: Array<{ step: number; ms: number; start: number; end: number }>;
  page: import("playwright").Page;
  close: () => Promise<void>;
}

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
  // THE SPIES. Every route settle the replay pays, with what it returned: with the fix removed there is
  // no routeSettle at all, and `settles` stays empty. Every click's whole executeClick (main has it
  // too, so the click times are measured on both sides of a kill run).
  const settles: Settle[] = [];
  const clicks: Run["clicks"] = [];
  const a = adapter as unknown as {
    routeSettle?: (from: string) => Promise<unknown>;
    executeClick: (...args: unknown[]) => Promise<unknown>;
    currentStepIdx: number;
  };
  if (typeof a.routeSettle === "function") {
    const orig = a.routeSettle.bind(adapter);
    a.routeSettle = async (from) => {
      const t0 = Date.now();
      const v = await orig(from);
      settles.push({ step: a.currentStepIdx, ms: Date.now() - t0, value: v as Settle["value"] });
      return v;
    };
  }
  const origClick = a.executeClick.bind(adapter);
  a.executeClick = async (...args) => {
    const t0 = Date.now();
    try { return await origClick(...args); } finally { const end = Date.now(); clicks.push({ step: a.currentStepIdx, ms: end - t0, start: t0, end }); }
  };
  let res: Run["res"];
  try { res = await adapter.fillApplication({} as ProjectRecord) as Run["res"]; } catch (e) { res = { ok: false, message: `threw ${String(e).slice(0, 300)}` }; }
  return { res, settles, clicks, page, close: () => ctx.close() };
}
const fmt = (s: Settle[]): string => JSON.stringify(s.map((x) => ({ step: x.step, ms: x.ms, ...(x.value ? { clicked: x.value.clickedUrl.replace(base, ""), settled: x.value.settledUrl.replace(base, ""), waited: x.value.result.waitedMs, why: x.value.result.reason } : { none: true }) })));
const trace = (r: Run): Array<{ i: number; outcome: string; note: string }> => ((r.res.data?.trace as Array<{ i: number; outcome: string; note: string }>) ?? []);
const skippedOf = (r: Run): unknown[] => (r.res.data?.skipped as unknown[] | undefined) ?? [];
const clean = (r: Run): boolean => r.res.ok && r.res.data?.failedStepIndex === undefined && skippedOf(r).length === 0;
const cleanDetail = (r: Run): string => `ok=${r.res.ok} failedStepIndex=${String(r.res.data?.failedStepIndex)} skipped=${JSON.stringify(skippedOf(r)).slice(0, 300)} msg=${String(r.res.message).slice(0, 300)}`;

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
  console.log(`   race trace=${JSON.stringify(trace(r).map((t) => `${t.i}:${t.outcome}`))} slow=${JSON.stringify(r.res.data?.slowSteps ?? [])} settles=${fmt(r.settles)} clicks=${JSON.stringify(r.clicks)}`);
  await r.close();
  check("race: the form was reached and \"Address Type\" holds \"Location\" (the results survived the assistant's initialisation)",
    value === "Location", `value=${value} hits=${JSON.stringify(hits)}`);
  check("race: no step was failed or skipped on the way (the record-type link was there to click)", clean(r), cleanDetail(r));
  const apply = r.settles.find((s) => s.step === 2 && s.value);
  check("race: the settle after \"Apply\" waited for the init request and saw the app's own rewrite",
    !!apply && apply.ms >= INIT_MS - 100 && /showTemplates=false$/.test(apply.value!.settledUrl) && apply.value!.result.settled && /url×/.test(apply.value!.result.reason),
    fmt(r.settles));
  const noNavClick = r.clicks.find((c) => c.step === 1);
  check(`MUST KEEP race: the no-navigation click's whole step stays under ${NO_NAV_CLICK_MAX_MS} ms (no settle paid where the URL did not change)`,
    !!noNavClick && noNavClick.ms < NO_NAV_CLICK_MAX_MS, JSON.stringify(r.clicks));
  const noNav = r.settles.find((s) => s.step === 1);
  check("COST race: the no-navigation click's route settle returned at once (nothing settled, < 20 ms)", !!noNav && noNav.value === null && noNav.ms < 20, fmt(r.settles));
  const search = r.settles.find((s) => s.step === 3 && s.value);
  console.log(`   ADDED TIME race: no-navigation click ${noNav?.ms ?? "?"} ms settle, ${noNavClick?.ms ?? "?"} ms whole step; "Apply" (view init ${INIT_MS} ms) ${apply?.ms ?? "?"} ms; "Search" (request ${SEARCH_MS} ms) ${search?.ms ?? "?"} ms; result link (no request) ${r.settles.find((s) => s.step === 4 && s.value)?.ms ?? "?"} ms`);
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
    /the portal did not advance/.test(r.res.message) && /took back the route the click opened — .*\[url=\/app\?mode=undo#\/assistant\?sectionName=All&showTemplates=false → \/app\?mode=undo#\/assistant\?showTemplates=false\]/.test(r.res.message),
    String(r.res.message).slice(0, 400));
  // THE ROUTES NEVER STEER THE VERDICT (review of #245): the text the backend classifies is the text
  // before the first page-context bracket, and it must carry no URL material — a portal's URL words
  // ("mfa-setup", "sessionToken=…dns…", "code=500&kind=server") turned this stop into an MFA, DNS or
  // server-error attribution when the routes sat inline.
  const classified = replayFailureTextWithoutPageContext(r.res.message);
  check("undone: the text the backend classifies says the page took back the route, and carries no URL material",
    /took back the route the click opened/.test(classified) && !/sectionName|showTemplates|mode=undo|→/.test(classified), classified.slice(0, 300));
  // The same stop on a portal whose routes carry those words: each route the message names, wherever
  // it sits, swapped for one (the page-context bracket after it carries the live URL, left as is).
  const poisoned = String(r.res.message)
    .split("/app?mode=undo#/assistant?sectionName=All&showTemplates=false →").join("/app#/account/mfa-setup?sessionToken=Q7dnsK2 →")
    .split("→ /app?mode=undo#/assistant?showTemplates=false").join("→ /Error.aspx?code=500&kind=server");
  const verdict = replayFailureBlamesRecipe(poisoned);
  check("undone: with URL words for MFA, DNS and a server error in the routes, the stop is still unattributed (kept and flagged for a person)",
    poisoned !== r.res.message && verdict.attribution === "unknown", `${verdict.attribution} — ${verdict.reason} :: ${poisoned.slice(0, 300)}`);
}

// ── chain: Tigard's request chain, past the bound ─────────────────────────────────────────────────
{
  const steps: RecipeStep[] = [
    { action: "click", phase: "open", selector: { role: "link", name: "Apply", exact: true, fallbacks: [{ css: "#menu-apply" }] }, note: "navigate to application: Apply" } as RecipeStep,
    { action: "click", phase: "fill", selector: { role: "button", name: "Search", exact: true, fallbacks: [{ css: "#search-btn" }] }, note: "advance: Search" } as RecipeStep,
    { action: "click", phase: "fill", selector: { role: "link", name: "Apply for Residential Solar", exact: true, fallbacks: [{ css: "#apply-btn-ResidentialSolar" }] }, note: "pick application: Residential Solar" } as RecipeStep,
    { action: "select", phase: "fill", selector: { label: "Address Type", fallbacks: [{ css: "#addressTypeSelect" }] }, value: "Location", note: "Address Type" } as RecipeStep,
  ];
  const from = served.length;
  const t0 = Date.now();
  const r = await replay("spa-chain", `${base}/app?mode=chain#/home`, steps);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const value = await r.page.locator("#addressTypeSelect").inputValue({ timeout: 1000 }).catch(() => "(no form)");
  const hits = served.slice(from).filter((h) => /^\/api\//.test(h.path)).map((h) => h.path.replace("/api/chain/", "c:"));
  const slow = (r.res.data?.slowSteps as Array<{ i: number; ms: number; phases?: Record<string, number> }> | undefined) ?? [];
  console.log(`   chain (${secs}s): ok=${r.res.ok} msg=${String(r.res.message).slice(0, 220)}`);
  console.log(`   chain trace=${JSON.stringify(trace(r).map((t) => `${t.i}:${t.outcome}`))} slow=${JSON.stringify(slow)} settles=${fmt(r.settles)}`);
  await r.close();
  check("chain: the form was reached and \"Address Type\" holds \"Location\" (the settle outlasted the rewrite though not the chain)",
    value === "Location", `value=${value} hits=${JSON.stringify(hits)}`);
  check("chain: no step was failed or skipped on the way", clean(r), cleanDetail(r));
  const apply = r.settles.find((s) => s.step === 1 && s.value);
  check(`chain: the settle after "Apply" saw the rewrite, then reached the ${ROUTE_SETTLE_MS} ms bound with trending in flight`,
    !!apply && /showTemplates=false$/.test(apply.value!.settledUrl) && !apply.value!.result.settled && /request\(s\) in flight/.test(apply.value!.result.reason),
    fmt(r.settles));
  const named = slow.find((s) => s.i === 1 && Object.keys(s.phases ?? {}).some((k) => /^route-settle unsettled: timeout after \d+ms: 1 request\(s\) in flight/.test(k)));
  check("chain: the unsettled route settle is named, with what was in flight, in the slow step's phases (an operator can see the protection lapsed)",
    !!named, JSON.stringify(slow));
  console.log(`   ADDED TIME chain: "Apply" (chain ~${CHAIN_TOTAL_MS} ms, past the bound) ${apply?.ms ?? "?"} ms; "Search" ${r.settles.find((s) => s.step === 2 && s.value)?.ms ?? "?"} ms`);
}

// ── searchsync: a router that re-adds its default page after a search ────────────────────────────
{
  const steps: RecipeStep[] = [
    { action: "click", phase: "fill", selector: { role: "button", name: "Search", exact: true, fallbacks: [{ css: "#search-btn" }] }, note: "advance: Search" } as RecipeStep,
    { action: "click", phase: "fill", selector: { role: "link", name: "Solar Permit", exact: true, fallbacks: [{ css: "#res-solar" }] }, note: "pick application: Solar Permit" } as RecipeStep,
    { action: "select", phase: "fill", selector: { label: "Mount Type", fallbacks: [{ css: "#mount" }] }, value: "Roof Mount", note: "Mount Type" } as RecipeStep,
  ];
  const t0 = Date.now();
  const r = await replay("spa-searchsync", `${base}/searchsync#/search?page=1`, steps);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const value = await r.page.locator("#mount").inputValue({ timeout: 1000 }).catch(() => "(no form)");
  // Counted by the page, so the advance's own retry click (inside the same step) is counted too.
  const searchClicks = await r.page.evaluate(() => (globalThis as unknown as { searches: number }).searches).catch(() => -1);
  console.log(`   searchsync (${secs}s): ok=${r.res.ok} failedStepIndex=${String(r.res.data?.failedStepIndex)} msg=${String(r.res.message).slice(0, 300)}`);
  console.log(`   searchsync trace=${JSON.stringify(trace(r).map((t) => `${t.i}:${t.outcome}`))} settles=${fmt(r.settles)}`);
  await r.close();
  check("MUST KEEP searchsync: \"advance: Search\" reads as advanced though the router re-added page=1, and the form is filled (\"Roof Mount\")",
    value === "Roof Mount" && clean(r), `value=${value} ${cleanDetail(r)}`);
  check("MUST KEEP searchsync: Search was clicked once (no retry of an advance that held)", searchClicks === 1, `searches=${searchClicks}`);
}

// ── transient: a wizard that passes through #/loading ────────────────────────────────────────────
{
  const steps: RecipeStep[] = [
    { action: "click", phase: "fill", selector: { role: "button", name: "Continue", exact: true, fallbacks: [{ css: "#continue" }] }, note: "advance: Continue" } as RecipeStep,
    { action: "click", phase: "fill", selector: { role: "button", name: "Continue", exact: true, fallbacks: [{ css: "#continue" }] }, note: "advance: Continue" } as RecipeStep,
    { action: "select", phase: "fill", selector: { label: "Final answer", fallbacks: [{ css: "#final" }] }, value: "Done", note: "Final answer" } as RecipeStep,
  ];
  const t0 = Date.now();
  const r = await replay("spa-transient", `${base}/transient#/w?step=1`, steps);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const value = await r.page.locator("#final").inputValue({ timeout: 1000 }).catch(() => "(no step 3)");
  const continues = await r.page.evaluate(() => (globalThis as unknown as { continues: Array<[number, number]> }).continues).catch(() => [] as Array<[number, number]>);
  const at = await r.page.evaluate(() => location.hash).catch(() => "?");
  // WHICH RECIPE STEP CLICKED EACH CONTINUE: the wizard step it was clicked on, by the executeClick
  // window it fell in. The advance's own retry happens inside the same step's window, so a retry that
  // skipped a page reads as two Continues in step 1 (on wizard steps 1 and 2), not one per step.
  const byStep = [1, 2].map((s) => {
    const w = r.clicks.find((c) => c.step === s);
    return w ? continues.filter(([, t]) => t >= w.start && t <= w.end).map(([n]) => n) : [];
  });
  console.log(`   transient (${secs}s): ok=${r.res.ok} failedStepIndex=${String(r.res.data?.failedStepIndex)} at=${at} continues by recipe step=${JSON.stringify(byStep)} msg=${String(r.res.message).slice(0, 300)}`);
  console.log(`   transient trace=${JSON.stringify(trace(r).map((t) => `${t.i}:${t.outcome}`))} settles=${fmt(r.settles)} drift=${JSON.stringify(r.res.data?.driftWarnings ?? [])}`);
  await r.close();
  check("MUST KEEP transient: recipe step 1 clicked Continue once, on wizard step 1, and recipe step 2 once, on wizard step 2 (no retry skipped a page)",
    JSON.stringify(byStep) === "[[1],[2]]", `continues by recipe step=${JSON.stringify(byStep)} all=${JSON.stringify(continues)} at=${at}`);
  check("MUST KEEP transient: step 3's select was filled (\"Done\") and nothing failed or was skipped", value === "Done" && clean(r), `value=${value} ${cleanDetail(r)}`);
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
  check("MUST KEEP fullpage: the next document's select was filled (\"Solar PV\")", value === "Solar PV", `value=${value} msg=${String(r.res.message).slice(0, 200)}`);
  const next = r.settles.find((s) => s.step === 1 && s.value);
  check("fullpage: the settle counted the new document's load-time request (waited for it, then the quiet window)",
    !!next && next.value!.result.settled && next.ms >= FULL_LOAD_XHR_MS - 100 && /net×/.test(next.value!.result.reason), fmt(r.settles));
  console.log(`   ADDED TIME fullpage: "Next" (a ${FULL_LOAD_XHR_MS} ms load-time request) ${next?.ms ?? "?"} ms`);
}

// ── ticker: a view that never goes DOM-quiet still settles in the quiet window ────────────────────
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${base}/ticker#/here`);
  await installSettleProbe(page);
  const before = page.url();
  await page.click("#go");
  const t0 = Date.now();
  const r = settleAfterRoute ? await settleAfterRoute(page, before) : null;
  const ms = Date.now() - t0;
  await ctx.close();
  console.log(`   ticker: ${settleAfterRoute ? `${ms} ms ${JSON.stringify(r?.result ?? null)}` : "settle.ts has no settleAfterRoute (the fix is absent)"}`);
  check(`COST ticker: a route change on a page with a 100 ms clock settles in the quiet window (< 1 s), not the ${ROUTE_SETTLE_MS} ms bound`,
    !!r && r.result.settled && ms < 1000, `${ms} ms ${JSON.stringify(r?.result ?? null)}`);
}

await browser.close();
server.close();
console.log(failures === 0 ? "spaRouteSettle.dom.smoke: PASS" : `spaRouteSettle.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
