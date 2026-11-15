// A MATCH THAT CARRIES THE STEP'S WORDS BUT NOT ITS RECORDED ID MAY BE A NAMESAKE (#228).
// dom-smoke-timeout: 900
//
// Live on City of Tigard (Tyler EnerGov), 2026-11-14: the learner recorded the record-type click as
//
//   { role: "link", name: "Apply", exact: true, fallbacks: [{ css: "#apply-btn-ResidentialRenewableEnergy-Prescriptive" }] }
//
// The real control's accessible name is its aria-label ("Apply Residential Renewable Energy -
// Prescriptive"), so that role+name never matches it. It matches exactly ONE element: the top
// menu's "Apply" tab, step 1's own recorded target. resolveLocator accepted that single visible
// match at level 0 and never asked the recorded id. The click reported ok, the application never
// opened, and the next step ("Address Type") waited out the stall watchdog. The record-type button
// renders ~116 ms after the assistant's Search. The page also carries a hidden ng-hide twin of it,
// and a hidden twin of the menu tab in #sidebarMenu.
//
// The rules under test. Nothing suspected, nothing changes: a pick no earlier click could be is
// clicked exactly as without the check. A suspected namesake is displaced at once by the element its
// recorded id names when that element's accessible name or face EQUALS the recorded words; else it
// buys one bounded wait (NAMESAKE_WAIT_MS, 10 s) for it and NEVER a stop. If the control renders it
// is clicked; if not, the click goes where it would have gone without the check, and a drift warning
// names the suspicion, once per suspected control per run. A click whose node could not be read
// afterwards (a full navigation) is no evidence. The role is the learner's own reading
// (extractFieldsInPage + recordedRoleOf).
//
// A WAIT-path case holds the rows until the test has SEEN the suspicion (`?delay=hold`), so it never
// races the resolution. A "now" case renders the rows synchronously with the Search click.
//
//   MUST PASS  (each fails with recipeAdapter.ts at origin/main):
//     A0/M2/m1/m1n  rows already up: displaced at once (no wait). M2's record type is an href-less,
//         role-less <a> routed by onclick (AngularJS ng-click), which the learner reads as a link.
//         m1's menu is rebuilt on every hashchange (stamp lost; the tab keeps the id step 1's click
//         read). m1n's menu has no ids at all (the selector that found it is step 1's own).
//     Aw/M2w/m1w/m1nw  the same shapes with the rows held until the suspicion: the WAIT finds them.
//     A   the live timing, rows ~150 ms after Search (either path).
//     B   rows 1.5 s after Search (either path).
//     m2  rows 4.5 s after Search (a slow government search): inside the 10 s wait.
//     R   the record type needs a second click: assertAdvanced's retry asks the same recorded
//         identity, so it clicks the record type again, never the menu tab.
//     C   rows never render: NOT stopped. After the bounded wait it clicks what it would have
//         clicked without the check (the menu tab), and a drift warning names the suspicion.
//   MUST KEEP  (each passes with recipeAdapter.ts at origin/main):
//     a   PowerClerk's per-render ids: the id alone never wins (fill and click).
//     b   two {role:button, name:Next, fallbacks:[{css:"#button-Next"}]} steps both click.
//     c   a recorded id gone, a role+name no other step is for: NO added wait (< 1 s).
//     d   review R1, an in-page counter-id wizard: no wait, no note.
//     PB  the same counter-id wizard on FULL page loads (location.href, and a form GET): no wait, no
//         note. The earlier Next's node cannot be read after its click; that is no evidence.
//     NB  counter-id neighbours with nothing suspected: the recorded id now names "Continue Later",
//         "Next page" or "Save and Submit", a control whose name CONTAINS the step's word. Main's
//         pick stands, no note.
//     CS  a suspected footer Next whose step's recorded id now names a visible "Next page": not
//         equal words, so the footer Next is clicked, no wait.
//     e   page 2's fresh Next carries step 1's #button-Next: page 3, at most one wait.
//     f   a persistent footer Next both steps recorded under the same drifted id: no wait.
//     P1/P2  the re-review's persistent footer (#btnNext1/#btnNext2 at learn; one #next now): page 3.
//     N4/N4n  four footer Nexts (#btnNext1..4 at learn), with and without an id now: page 5, one
//         wait and one drift line in all, not three.
//     g   review R4: a WRITE is never moved by this rule.
//     h   review R2: a recorded id now naming a same-word control of another role: refused.
//
//   npx tsx portal-bot/src/adapters/recordedIdentityNamesake.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const failedLabels: string[] = [];
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; failedLabels.push(label); console.error(`  FAIL - ${label}\n         ${detail}`); }
};
/** The recipe adapter's namesake wait (NAMESAKE_WAIT_MS), mirrored for the timing checks. */
const WAIT_MS = 10_000;
/** How long after the test SEES the suspicion a held row render is released. The first look after
 *  the suspicion is one page round trip, so it has long happened by then: the wait finds the rows. */
const HOLD_RELEASE_MS = 1000;

// ---- the EnerGov self-service shape -----------------------------------------------------------
// A hash-routed SPA: the menu stays put (unless ?rerender=1), the view re-renders. Each result row
// carries its Apply link TWICE (ng-show / ng-hide), hidden copy first, both with the same id. A
// decoy type comes first so a positional or text-only pick lands on the wrong permit.
//   ?delay=N     rows N ms after Search (0: synchronously; -1: the search finds nothing)
//   ?delay=hold  rows when the test calls window.__releaseRows(), or 4 s after Search at the latest
//   ?nosidebar=1 no hidden twin of the menu tab
//   ?rerender=1  the menu is rebuilt by innerHTML on every hashchange (a stamp on it is lost)
//   ?noid=1      the menu tabs carry no id
//   ?nohref=1    the record-type anchors carry no href and no role, and route by onclick
//   ?twoclick=1  the record-type anchors route only on their SECOND click
const ENERGOV = `<!doctype html><html><head><style>
  body { font: 14px sans-serif; padding: 16px; }
  .ng-hide { display: none !important; }
  #sidebarMenu { display: none; }
  .mainMenuNav-a { display: inline-block; padding: 8px 14px; background: #246; color: #fff; text-decoration: none; }
  .btn { display: inline-block; padding: 6px 12px; background: #06c; color: #fff; text-decoration: none; cursor: pointer; }
  .row { margin: 8px 0; }
</style></head><body>
  <nav id="topMenu"></nav>
  <div id="sidebarMenu"></div>
  <main id="view"></main>
<script>
  var q = new URLSearchParams(location.search);
  var HOLD = q.get('delay') === 'hold';
  var DELAY = HOLD ? 4000 : Number(q.get('delay') || '150');
  var NOID = !!q.get('noid'), NOHREF = !!q.get('nohref'), RERENDER = !!q.get('rerender'), TWOCLICK = !!q.get('twoclick');
  if (q.get('nosidebar')) document.getElementById('sidebarMenu').remove();
  // Reported to the test process, so neither a retry's reload nor the stall watchdog closing the page
  // can lose the evidence.
  var report = function (k, v) { try { if (window.__smokeEvent) window.__smokeEvent(k, v); } catch (e) { /* not wired */ } };
  function menu() {
    var id = function (x) { return NOID ? '' : ' id="' + x + '"'; };
    var html = '<a' + id('link-Menu-Home') + ' class="mainMenuNav-a" href="#/home">Home</a> '
      + '<a' + id('link-Menu-Apply') + ' class="mainMenuNav-a menu-apply" href="#/applicationAssistant">Apply</a>';
    document.getElementById('topMenu').innerHTML = html;
    var side = document.getElementById('sidebarMenu');
    if (side) side.innerHTML = '<a' + id('link-Menu-Apply') + ' class="mainMenuNav-a menu-apply" href="#/applicationAssistant">Apply</a>';
    document.querySelectorAll('.menu-apply').forEach(function (a) { a.addEventListener('click', function () { report('menu', ''); }); });
  }
  window.__typeClick = function (el) {
    var n = Number(el.getAttribute('data-n') || '0') + 1;
    el.setAttribute('data-n', String(n));
    report('typeclick', el.id + ':' + n);
    if (n >= 2) location.hash = el.getAttribute('data-route');
  };
  function applyLink(type, label, href, hidden) {
    var a = TWOCLICK
      ? '<a id="apply-btn-' + type + '" class="btn btn-primary" tabindex="0" role="link" aria-label="Apply ' + label + '" data-route="' + href + '" onclick="window.__typeClick(this)">\\n Apply\\n </a>'
      : NOHREF
      ? '<a id="apply-btn-' + type + '" class="btn btn-primary" tabindex="0" aria-label="Apply ' + label + '" onclick="location.hash=\\'' + href + '\\'">\\n Apply\\n </a>'
      : '<a id="apply-btn-' + type + '" class="btn btn-primary" tabindex="0" role="link" aria-label="Apply ' + label + '" href="' + href + '">\\n Apply\\n </a>';
    return '<div ng-show="' + (hidden ? '!' : '') + 'vm.isCollapsed" class="apply-btn-align' + (hidden ? ' ng-hide' : '') + '" aria-hidden="' + (hidden ? 'true' : 'false') + '">' + a + '</div>';
  }
  function rows() {
    return [['ResidentialMechanical', 'Residential Mechanical', '#/permit/apply/12/0/0'],
            ['ResidentialRenewableEnergy-Prescriptive', 'Residential Renewable Energy - Prescriptive', '#/permit/apply/94/0/0']]
      .map(function (r) { return '<div class="row"><span>' + r[1] + '</span>' + applyLink(r[0], r[1], r[2], true) + applyLink(r[0], r[1], r[2], false) + '</div>'; })
      .join('');
  }
  // The rows go in once per search, whichever comes first: the test's release or the timer.
  function showRows(by) {
    var r = document.getElementById('results');
    if (!r || r.innerHTML) return;
    r.innerHTML = rows();
    report('rows', by);
  }
  window.__releaseRows = function () { showRows('released'); };
  function render() {
    var h = location.hash || '#/home';
    var v = document.getElementById('view');
    if (h === '#/applicationAssistant') {
      v.innerHTML = '<h2>Application Assistant</h2><input id="assistantSearch" aria-label="Search applications" value="solar">'
        + ' <button id="button-Search" type="button">Search</button><div id="results"></div>';
      document.getElementById('button-Search').addEventListener('click', function () {
        report('search', '');
        if (DELAY < 0) return; // the search found nothing for this address
        if (DELAY === 0) { showRows('sync'); return; }
        setTimeout(function () { showRows('timer'); }, DELAY);
      });
    } else if (h.indexOf('#/permit/apply/') === 0) {
      report('opened', h);
      v.innerHTML = '<h2>Residential Permit Application</h2><label for="addressType">Address Type</label> '
        + '<select id="addressType"><option value="">Select...</option><option>Location</option><option>Parcel</option></select>';
    } else {
      v.innerHTML = '<h2>Home</h2>';
    }
  }
  menu();
  window.addEventListener('hashchange', function () { if (RERENDER) menu(); render(); });
  render();
</script>
</body></html>`;

// ---- PowerClerk's per-render ids --------------------------------------------------------------
// The recorded #pcInputBase34 / #pcButton7 now name OTHER, VISIBLE controls on this render.
const POWERCLERK = `<!doctype html><html><head><style>body { font: 14px sans-serif; padding: 16px; }</style></head><body>
  <h3>Inverter Clone System</h3>
  <label for="pcInputBase34">Energy Source</label>
  <select id="pcInputBase34"><option>Select...</option><option>Solar PV</option><option>Wind</option></select>
  <label for="pcInputBase40">Model</label>
  <select id="pcInputBase40"><option>Select...</option><option>IQ8PLUS-72-2-US</option></select>
  <button id="pcButton7" type="button" onclick="window.__deleted=(window.__deleted||0)+1">Remove Inverter</button>
  <button id="pcButton9" type="button" onclick="window.__added=(window.__added||0)+1">Add Inverter</button>
</body></html>`;

// ---- a wizard whose Next is re-rendered with the same id on every page ------------------------
const WIZARD = `<!doctype html><html><head><style>body { font: 14px sans-serif; padding: 16px; }</style></head><body>
  <main id="view"></main>
<script>
  window.__page = 1;
  function render() {
    var v = document.getElementById('view');
    v.innerHTML = '<h2>Page ' + window.__page + '</h2>' + (window.__page < 3 ? '<button id="button-Next" type="button">Next</button>' : '<p>Review</p>');
    var b = document.getElementById('button-Next');
    if (b) b.addEventListener('click', function () { window.__page++; render(); });
  }
  render();
</script>
</body></html>`;

// ---- a recorded id that is simply gone --------------------------------------------------------
const GONE = `<!doctype html><html><head><style>body { font: 14px sans-serif; padding: 16px; }</style></head><body>
  <button id="btn-start" type="button" onclick="document.getElementById('more').style.display='block'">Start</button>
  <div id="more" style="display:none"><button id="btn-continue-live" type="button" onclick="window.__continued=(window.__continued||0)+1">Continue</button></div>
</body></html>`;

// ---- (d) review R1: a counter-id wizard ---------------------------------------------------------
// Every rendered control takes the next `cw-N`. At learn the views carried one more counted component
// each (Description cw-1, Next cw-2, City cw-3, Next cw-4, Phone cw-5); this render counts only the
// Nexts, so view 1's Next is cw-1 (Description's recorded id) and view 2's is cw-2 (view 1's recorded
// Next) — each a FRESH node carrying an id an earlier step recorded.
const COUNTER = `<!doctype html><html><head><style>body { font: 14px sans-serif; padding: 16px; }</style></head><body>
  <main id="view"></main>
<script>
  window.__view = 1;
  var n = 0;
  function render() {
    var v = document.getElementById('view');
    if (window.__view === 1) v.innerHTML = '<h2>Project</h2><label for="desc">Description</label> <input id="desc"> <button type="button" id="cw-' + (++n) + '">Next</button>';
    else if (window.__view === 2) v.innerHTML = '<h2>Site</h2><label for="city">City</label> <input id="city"> <button type="button" id="cw-' + (++n) + '">Next</button>';
    else v.innerHTML = '<h2>Contact</h2><label for="phone">Phone</label> <input id="phone">';
    var b = v.querySelector('button');
    if (b) b.addEventListener('click', function () { window.__view++; render(); });
  }
  render();
</script>
</body></html>`;

// ---- (PB) the counter-id wizard on FULL page loads, server-rendered ------------------------------
// The same ids as (d), but every Next loads a new document: `location.href` (mode=href) or a form GET
// (mode=form), the way Accela, CityView and iWorQ postbacks advance.
function postbackPage(v: number, mode: string): string {
  const next = (id: string): string => mode === "form"
    ? `<form method="get" action="/pb"><input type="hidden" name="v" value="${v + 1}"><input type="hidden" name="mode" value="form"><button type="submit" id="${id}">Next</button></form>`
    : `<button type="button" id="${id}" onclick="location.href='/pb?v=${v + 1}&mode=href'">Next</button>`;
  const body = v === 1 ? `<h2>Project</h2><label for="desc">Description</label> <input id="desc"> ${next("cw-1")}`
    : v === 2 ? `<h2>Site</h2><label for="city">City</label> <input id="city"> ${next("cw-2")}`
      : `<h2>Contact</h2><label for="phone">Phone</label> <input id="phone">`;
  return `<!doctype html><html><head><style>body { font: 14px sans-serif; padding: 16px; }</style></head><body>${body}</body></html>`;
}

// ---- (NB) counter-id neighbours: ?w= the step's control, ?w2= its neighbour ------------------------
// The step recorded #button-1034 for its control; on this render the ids shifted by one, so #button-1034
// is the neighbour, whose name CONTAINS the step's word.
const NEIGHBOUR = `<!doctype html><html><head><style>body { font: 14px sans-serif; padding: 16px; }</style></head><body>
  <main id="view"></main>
<script>
  var q = new URLSearchParams(location.search);
  window.__view = 1; window.__mine = 0; window.__other = 0;
  var v = document.getElementById('view');
  v.innerHTML = '<h2>Project</h2><label for="desc">Description</label> <input id="desc"> '
    + '<button id="button-1033" type="button"></button> <button id="button-1034" type="button"></button>';
  document.getElementById('button-1033').textContent = q.get('w');
  document.getElementById('button-1034').textContent = q.get('w2');
  document.getElementById('button-1034').addEventListener('click', function () { window.__other++; });
  document.getElementById('button-1033').addEventListener('click', function () {
    window.__mine++; window.__view = 2;
    v.innerHTML = '<h2>Details</h2><label for="pname">Project Name</label> <input id="pname">';
  });
</script>
</body></html>`;

// ---- (f) / (P1, P2, CS, N4) a persistent footer Next ----------------------------------------------
// The view re-renders; the footer (and its Next) never does. ?id= names the footer button's id;
// ?noid=1 gives it none; ?hook=1 gives it the data-test-role hook P2's first step recorded; ?pager=X
// adds a persistent "Next page" button with id X.
const FOOTER = `<!doctype html><html><head><style>body { font: 14px sans-serif; padding: 16px; }</style></head><body>
  <main id="view"></main>
  <footer id="foot"></footer>
<script>
  var q = new URLSearchParams(location.search);
  window.__page = 1; window.__pager = 0;
  var idAttr = q.get('noid') ? '' : ' id="' + (q.get('id') || 'button-1037') + '"';
  document.getElementById('foot').innerHTML = '<button' + idAttr + (q.get('hook') ? ' data-test-role="next-btn"' : '') + ' type="button">Next</button>'
    + (q.get('pager') ? ' <button id="' + q.get('pager') + '" class="pager" type="button">Next page</button>' : '');
  function render() { document.getElementById('view').innerHTML = '<h2>Page ' + window.__page + '</h2>'; }
  document.querySelector('#foot button').addEventListener('click', function () { window.__page++; render(); });
  var pager = document.querySelector('#foot .pager');
  if (pager) pager.addEventListener('click', function () { window.__pager++; });
  render();
</script>
</body></html>`;

// ---- (g) review R4: a write whose recorded id now names a placeholder box ----------------------
const WRITE = `<!doctype html><html><head><style>body { font: 14px sans-serif; padding: 16px; }</style></head><body>
  <h3>Site</h3>
  <label for="a1">City</label> <input id="a1">
  <input id="c9" placeholder="City (mailing)">
</body></html>`;

// ---- (h) review R2: a wizard Next button and a results pager's Next LINK -----------------------
const PAGER = `<!doctype html><html><head><style>body { font: 14px sans-serif; padding: 16px; }</style></head><body>
  <main id="view"></main>
  <div class="pager">Results 1-10 <a id="tok7" href="#more">Next</a></div>
<script>
  window.__page = 1; window.__wizard = 0; window.__pager = 0;
  document.getElementById('tok7').addEventListener('click', function (e) { e.preventDefault(); window.__pager++; });
  function render() {
    var v = document.getElementById('view');
    v.innerHTML = '<h2>Step ' + window.__page + '</h2>' + (window.__page === 1 ? '<button id="tok9" type="button">Next</button>' : '<p>Done</p>');
    var b = document.getElementById('tok9');
    if (b) b.addEventListener('click', function () { window.__wizard++; window.__page++; render(); });
  }
  render();
</script>
</body></html>`;

const PAGES: Record<string, string> = { "/pc": POWERCLERK, "/wizard": WIZARD, "/gone": GONE, "/counter": COUNTER, "/nb": NEIGHBOUR, "/footer": FOOTER, "/write": WRITE, "/pager": PAGER };
const server = http.createServer((q, r) => {
  const [p, qs] = String(q.url ?? "/").split("?");
  const sp = new URLSearchParams(qs ?? "");
  const body = p === "/pb" ? postbackPage(Number(sp.get("v") || "1"), sp.get("mode") || "href") : PAGES[p] ?? ENERGOV;
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const recipeOf = (steps: RecipeStep[], url: string) => ({
  id: "rin1", scopeType: "ahj", profileKey: "or|city of tigard|x", state: "OR", ahj: "City of Tigard", utility: "",
  portalPlatform: "energov", portalUrl: url, status: "complete", version: 1, steps,
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe);

// The four steps exactly as the Tigard learn recorded them.
const TIGARD_STEPS: RecipeStep[] = [
  { action: "click", phase: "open", selector: { role: "link", name: "Apply", exact: true, fallbacks: [{ css: "#link-Menu-Apply" }] }, note: "navigate: Apply" },
  { action: "click", phase: "fill", selector: { role: "button", name: "Search", exact: true, fallbacks: [{ css: "#button-Search" }] }, note: "application assistant: Search" },
  { action: "click", phase: "fill", selector: { role: "link", name: "Apply", exact: true, fallbacks: [{ css: "#apply-btn-ResidentialRenewableEnergy-Prescriptive" }] }, note: "record type (verified): Residential Renewable Energy - Prescriptive" },
  { action: "select", phase: "fill", selector: { label: "Address Type", fallbacks: [{ css: "#addressType" }] }, value: "Location", note: "Address Type" },
] as RecipeStep[];
// m1n: a menu with no ids, so the learn recorded step 1 by role+name alone.
const TIGARD_NOID_STEPS: RecipeStep[] = TIGARD_STEPS.map((s, i) => (i === 0 ? { ...s, selector: { role: "link", name: "Apply", exact: true } } : s)) as RecipeStep[];
// R: the record-type click recorded as an advance, so a click that does not move the page is retried.
const TIGARD_RETRY_STEPS: RecipeStep[] = TIGARD_STEPS.map((s, i) => (i === 2 ? { ...s, note: "advance: Apply (record type)" } : s)) as RecipeStep[];

type Data = { driftWarnings?: string[]; agingNotes?: string[]; skipped?: string[]; failedStepIndex?: number; healedSteps?: Array<{ stepIndex: number; selector?: unknown }> };
const browser = await chromium.launch();

// What the fixture reported (menu-tab clicks, the Search click, the rows, the application route
// opened), per page, each with the time it arrived.
type Ev = { kind: string; value: string; t: number };
const events = new WeakMap<Page, Ev[]>();
async function freshPage(path: string): Promise<Page> {
  const ctx = await browser.newContext();
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await ctx.newPage();
  const seen: Ev[] = [];
  events.set(page, seen);
  await page.exposeFunction("__smokeEvent", (kind: string, value: string) => { seen.push({ kind, value, t: Date.now() }); });
  await page.goto(`${base}${path}`);
  return page;
}
const evs = (page: Page, kind: string): Ev[] => (events.get(page) ?? []).filter((e) => e.kind === kind);
const menuClicks = (page: Page): number => evs(page, "menu").length;
const openedRoute = (page: Page): string => [...new Set(evs(page, "opened").map((e) => e.value))].join(" ");

// THE HOLD: release the page's rows HOLD_RELEASE_MS after the adapter's namesake check has named a
// suspicion, so a wait-path case can never see them at its first look. origin/main has no such check
// (nothing to wrap): the fixture's own 4 s timer renders the rows there.
function releaseRowsAfterSuspicion(adapter: RecipeAdapter, page: Page): void {
  const a = adapter as unknown as { namesakeSuspicion?: (...args: unknown[]) => unknown };
  const proto = a.namesakeSuspicion;
  if (typeof proto !== "function") return;
  let fired = false;
  a.namesakeSuspicion = function (this: unknown, ...args: unknown[]) {
    const r = proto.apply(this, args);
    const why = typeof r === "string" ? r : (r as { why?: string } | null)?.why;
    if (why && !fired) {
      fired = true;
      setTimeout(() => { void page.evaluate("window.__releaseRows && window.__releaseRows()").catch(() => null); }, HOLD_RELEASE_MS);
    }
    return r;
  };
}

async function replay(page: Page, steps: RecipeStep[], fieldValues: Record<string, string> = {}, stallTimeoutMs = 45_000, prepare?: (a: RecipeAdapter) => void) {
  // A short stall watchdog instead of the production 8 minutes: without the fix, the step after the
  // namesake click waits it out exactly as it did live, and the smoke should not take half an hour.
  // Always well above the 10 s namesake wait, so the watchdog never fires DURING it.
  const adapter = new RecipeAdapter(recipeOf(steps, page.url()), fieldValues, {}, { autoSubmit: false, stallTimeoutMs });
  (adapter as unknown as { page: unknown }).page = page;
  prepare?.(adapter);
  const t0 = Date.now();
  const res = await adapter.fillApplication({} as never);
  const data = (res as unknown as { data?: Data }).data ?? {};
  return { adapter, res, data, ms: Date.now() - t0 };
}
const said = (d: Data): string[] => [...(d.driftWarnings ?? []), ...(d.agingNotes ?? [])];
const blocking228 = (d: Data): string[] => (d.driftWarnings ?? []).filter((w) => /#228/.test(w));
/** How many namesake waits the run STARTED (0 where the adapter has no such check). */
const waitsStarted = (adapter: RecipeAdapter): number => (adapter as unknown as { namesakeWaited?: Set<string> }).namesakeWaited?.size ?? 0;

// ---- MUST PASS: the record type opens and the application's first field fills ------------------
type Path = "now" | "wait" | "either";
type Why = "stamp" | "id" | "selector";
const WHY: Record<Why, RegExp> = {
  stamp: /a suspected namesake \(it is the very control step 1 clicked\)/,
  id: /a suspected namesake \(it carries #link-Menu-Apply, the id of the control step 1 clicked\)/,
  selector: /a suspected namesake \(the selector that found it is step 1's own, and the control that step clicked carried no id\)/,
};
for (const c of [
  { tag: "A0", what: "rows up before the step resolves", path: "/?delay=0", steps: TIGARD_STEPS, expect: "now" as Path, why: "stamp" as Why },
  { tag: "Aw", what: "rows held until the suspicion", path: "/?delay=hold", steps: TIGARD_STEPS, expect: "wait" as Path, why: "stamp" as Why },
  { tag: "A", what: "the live timing, rows 150 ms after Search", path: "/?delay=150", steps: TIGARD_STEPS, expect: "either" as Path, why: "stamp" as Why },
  { tag: "B", what: "rows 1.5 s after Search", path: "/?delay=1500", steps: TIGARD_STEPS, expect: "either" as Path, why: "stamp" as Why },
  { tag: "M2", what: "an href-less, role-less record-type <a> routed by onclick, rows up", path: "/?delay=0&nohref=1", steps: TIGARD_STEPS, expect: "now" as Path, why: "stamp" as Why },
  { tag: "M2w", what: "the same, rows held until the suspicion", path: "/?delay=hold&nohref=1", steps: TIGARD_STEPS, expect: "wait" as Path, why: "stamp" as Why },
  { tag: "m1", what: "the menu rebuilt on every hashchange (stamp lost), rows up", path: "/?delay=0&rerender=1", steps: TIGARD_STEPS, expect: "now" as Path, why: "id" as Why },
  { tag: "m1w", what: "the same, rows held until the suspicion", path: "/?delay=hold&rerender=1", steps: TIGARD_STEPS, expect: "wait" as Path, why: "id" as Why },
  { tag: "m1n", what: "the menu rebuilt with no ids at all, rows up", path: "/?delay=0&rerender=1&noid=1", steps: TIGARD_NOID_STEPS, expect: "now" as Path, why: "selector" as Why },
  { tag: "m1nw", what: "the same, rows held until the suspicion", path: "/?delay=hold&rerender=1&noid=1", steps: TIGARD_NOID_STEPS, expect: "wait" as Path, why: "selector" as Why },
  { tag: "m2", what: "rows 4.5 s after Search (a slow search)", path: "/?delay=4500", steps: TIGARD_STEPS, expect: "wait" as Path, why: "stamp" as Why },
]) {
  console.log(`\n${c.tag} ${c.what}`);
  const page = await freshPage(c.path);
  const held = c.path.includes("delay=hold");
  const { res, data, ms } = await replay(page, c.steps, {}, 30_000, held ? (a) => releaseRowsAfterSuspicion(a, page) : undefined);
  const opened = openedRoute(page);
  const menu = menuClicks(page);
  const addressType = await page.locator("#addressType").inputValue().catch(() => "(not on the page)");
  const rowsBy = evs(page, "rows").map((e) => e.value).join(",");
  console.log(`   ok=${res.ok} in ${(ms / 1000).toFixed(1)}s, opened=${JSON.stringify(opened)}, menu clicks=${menu}, Address Type=${JSON.stringify(addressType)}, rows by=${rowsBy}`);
  console.log(`   notes: ${JSON.stringify(said(data).filter((w) => /#228/.test(w)).map((w) => w.slice(0, 300)))}`);
  check(`${c.tag}: MUST PASS — the replay opens the recorded record type, not the menu's "Apply"`,
    opened === "#/permit/apply/94/0/0",
    `opened=${JSON.stringify(opened)} — the namesake menu tab was clicked (or the decoy type), and the application never opened`);
  check(`${c.tag}: MUST PASS — the menu tab is clicked once (by step 1), never again by the record-type step`,
    menu === 1, `menu clicks=${menu}`);
  check(`${c.tag}: MUST PASS — Address Type fills on the opened application`,
    addressType === "Location", `Address Type=${JSON.stringify(addressType)}`);
  check(`${c.tag}: MUST PASS — the run completes`, res.ok === true, String(res.message ?? "").slice(0, 300));
  const rescue = said(data).find((w) => /#228/.test(w) && /apply-btn-ResidentialRenewableEnergy-Prescriptive/.test(w)) ?? "";
  check(`${c.tag}: the rescue is reported, so the recipe is re-recorded`, !!rescue, JSON.stringify(said(data)));
  // The step landed on the control it recorded: a self-heal (agingNotes), never a defect that fails
  // a clean score (driftWarnings).
  check(`${c.tag}: the rescue is an aging note, not a blocking drift warning`,
    (data.agingNotes ?? []).includes(rescue) && blocking228(data).length === 0,
    `drift=${JSON.stringify(data.driftWarnings ?? [])}`);
  // Displacement happens only under suspicion, so the note always names it, on either path.
  check(`${c.tag}: the rescue names the suspicion (${c.why})`, WHY[c.why].test(rescue), rescue);
  const waitedS = Number(/rendered (\d+\.\d) s into the wait/.exec(rescue)?.[1] ?? NaN);
  if (c.expect === "now") check(`${c.tag}: the rows were up — displaced at once, no wait`, !!rescue && !/into the wait/.test(rescue), rescue);
  if (c.expect === "wait" && held) {
    check(`${c.tag}: the WAIT found the record type, released by the test after the suspicion (rendered ${waitedS} s into the wait)`,
      waitedS > 0 && waitedS < 3.5 && rowsBy === "released", `rows by=${rowsBy}; ${rescue}`);
  }
  if (c.tag === "m2") check(`m2: the namesake wait found it after the slow search (rendered ${waitedS} s into the wait)`, waitedS >= 2 && waitedS < 7, rescue);
  await page.context().close().catch(() => null);
}

// ---- MUST PASS (R): assertAdvanced's retry asks the same recorded identity ----------------------
// The record type routes only on its second click. Its first click (displaced onto it) leaves the page
// where it was, so assertAdvanced retries the advance. The retry re-resolves the step; without the
// guard there, the role+name would take the menu tab again.
{
  console.log("\nR the record type routes on its second click (assertAdvanced's retry)");
  const page = await freshPage("/?delay=0&twoclick=1");
  const { res, data, ms } = await replay(page, TIGARD_RETRY_STEPS, {}, 30_000);
  const opened = openedRoute(page);
  const menu = menuClicks(page);
  const typeClicks = evs(page, "typeclick").map((e) => e.value);
  const addressType = await page.locator("#addressType").inputValue().catch(() => "(not on the page)");
  const rescues = (data.agingNotes ?? []).filter((w) => /#228/.test(w) && /apply-btn-ResidentialRenewableEnergy-Prescriptive/.test(w));
  console.log(`   ok=${res.ok} in ${(ms / 1000).toFixed(1)}s, opened=${JSON.stringify(opened)}, menu clicks=${menu}, record-type clicks=${JSON.stringify(typeClicks)}, Address Type=${JSON.stringify(addressType)}`);
  console.log(`   said: ${JSON.stringify(said(data).map((w) => w.slice(0, 200)))}`);
  check("R: MUST PASS — the retry clicks the record type again and it opens", opened === "#/permit/apply/94/0/0",
    `opened=${JSON.stringify(opened)} record-type clicks=${JSON.stringify(typeClicks)}`);
  check("R: MUST PASS — the menu tab is clicked once (by step 1), never by the retry", menu === 1, `menu clicks=${menu}`);
  check("R: MUST PASS — both record-type clicks landed on the recorded control", typeClicks.join(",") === "apply-btn-ResidentialRenewableEnergy-Prescriptive:1,apply-btn-ResidentialRenewableEnergy-Prescriptive:2",
    JSON.stringify(typeClicks));
  check("R: MUST PASS — Address Type fills and the run completes", addressType === "Location" && res.ok === true,
    `Address Type=${JSON.stringify(addressType)} ok=${res.ok}: ${String(res.message ?? "").slice(0, 300)}`);
  check("R: the rescue is said once, not once per resolution", rescues.length === 1, JSON.stringify(rescues));
  await page.context().close().catch(() => null);
}

// ---- MUST PASS (C): the search found nothing — the record type never renders --------------------
// Never a stop at the record-type step: after the bounded wait it clicks what it would have clicked
// without the check (the menu tab), and says so. Without the check the second menu click comes at
// once; with it, a full wait after the Search.
{
  const tag = "C rows never render";
  console.log(`\n${tag}`);
  const page = await freshPage("/?delay=-1");
  const { res, data, ms } = await replay(page, TIGARD_STEPS, {}, 30_000);
  const menus = evs(page, "menu");
  const search = evs(page, "search")[0];
  const gap = menus.length >= 2 && search ? menus[1].t - search.t : -1;
  console.log(`   ok=${res.ok} in ${(ms / 1000).toFixed(1)}s, failedStepIndex=${data.failedStepIndex}, menu clicks=${menus.length}, second menu click ${gap} ms after Search`);
  console.log(`   drift: ${JSON.stringify(blocking228(data).map((w) => w.slice(0, 300)))}`);
  console.log(`   message: ${String(res.message ?? "").slice(0, 300)}`);
  // Not a MUST PASS: without the check the step clicks the menu tab too. Round 2 stopped here.
  check("C: never a stop — the record-type step clicks as it would without the check (the menu tab, a second time)",
    menus.length === 2 && data.failedStepIndex !== 2, `menu clicks=${menus.length} failedStepIndex=${data.failedStepIndex}`);
  check(`C: MUST PASS — that click came only after the bounded wait for its own control (${gap} ms after Search)`,
    gap >= WAIT_MS - 500 && gap < WAIT_MS + 6000, `second menu click ${gap} ms after Search`);
  const line = blocking228(data).find((w) => /suspected namesake/.test(w) && /it is the very control step 1 clicked/.test(w) && /apply-btn-ResidentialRenewableEnergy-Prescriptive never rendered \(waited 1\d\.\d s\)/.test(w)) ?? "";
  check("C: MUST PASS — a drift warning names the suspicion, so a person reading the run sees it", !!line, JSON.stringify(data.driftWarnings ?? []));
  check("C: the drift warning is said once", blocking228(data).length === 1, JSON.stringify(blocking228(data)));
  check("C: nothing opened", openedRoute(page) === "", `opened=${JSON.stringify(openedRoute(page))}`);
  check("C: the recipe is not patched by a heal of the record-type step", !(data.healedSteps ?? []).some((h) => h.stepIndex === 2), JSON.stringify(data.healedSteps ?? []));
  await page.context().close().catch(() => null);
}

// ---- MUST KEEP --------------------------------------------------------------------------------

// (a) PowerClerk's per-render ids must not win.
{
  console.log("\na PowerClerk per-render ids");
  const page = await freshPage("/pc");
  const steps: RecipeStep[] = [
    { action: "select", phase: "fill", selector: { css: "#pcInputBase34", fallbacks: [{ label: "Model", nth: 0 }] }, value: "IQ8PLUS-72-2-US", note: "Model" },
    { action: "click", phase: "fill", selector: { role: "button", name: "Add Inverter", exact: true, fallbacks: [{ css: "#pcButton7" }] }, note: "Add Inverter" },
  ] as RecipeStep[];
  const { res, data } = await replay(page, steps);
  const energy = await page.locator("#pcInputBase34").inputValue();
  const model = await page.locator("#pcInputBase40").inputValue();
  const added = await page.evaluate(() => (window as unknown as { __added?: number }).__added ?? 0).catch(() => -1);
  const deleted = await page.evaluate(() => (window as unknown as { __deleted?: number }).__deleted ?? 0).catch(() => -1);
  console.log(`   ok=${res.ok}, Energy Source=${JSON.stringify(energy)}, Model=${JSON.stringify(model)}, added=${added}, deleted=${deleted}`);
  console.log(`   skipped=${JSON.stringify(data.skipped)} said=${JSON.stringify(said(data)).slice(0, 600)}`);
  check("a: MUST KEEP — {css:#pcInputBase34, fallbacks:[{label:Model, nth:0}]} fills Model, not the Energy Source the id now names",
    model === "IQ8PLUS-72-2-US" && energy === "Select...", `Model=${JSON.stringify(model)} Energy Source=${JSON.stringify(energy)}`);
  check("a: MUST KEEP — a click whose id now names a visible \"Remove Inverter\" still clicks \"Add Inverter\"",
    added === 1 && deleted === 0, `added=${added} deleted=${deleted} — a per-render id displaced the control the step's words name`);
  check("a: no namesake handling fired", !said(data).some((w) => /#228/.test(w)), JSON.stringify(said(data)));
  await page.context().close().catch(() => null);

  // The label-primary shape: the id fallback names Energy Source; the label still wins.
  const page2 = await freshPage("/pc");
  const steps2: RecipeStep[] = [
    { action: "select", phase: "fill", selector: { label: "Model", fallbacks: [{ css: "#pcInputBase34" }] }, value: "IQ8PLUS-72-2-US", note: "Model" },
  ] as RecipeStep[];
  await replay(page2, steps2);
  const energy2 = await page2.locator("#pcInputBase34").inputValue();
  const model2 = await page2.locator("#pcInputBase40").inputValue();
  check("a: MUST KEEP — {label:Model, fallbacks:[{css:#pcInputBase34}]} fills Model, Energy Source untouched",
    model2 === "IQ8PLUS-72-2-US" && energy2 === "Select...", `Model=${JSON.stringify(model2)} Energy Source=${JSON.stringify(energy2)}`);
  await page2.context().close().catch(() => null);
}

// (b) Two "Next" steps that recorded the same id: the second is not a namesake of the first. Its run
// time is the baseline a two-Next replay costs with no #228 handling at all (the replay's own settles
// and end-of-run reads), which the at-most-one-wait checks below are measured against.
let twoNextBaselineMs = 0;
{
  console.log("\nb two Next steps sharing #button-Next");
  const page = await freshPage("/wizard");
  const next: RecipeStep = { action: "click", phase: "fill", selector: { role: "button", name: "Next", exact: true, fallbacks: [{ css: "#button-Next" }] }, note: "advance: Next" } as RecipeStep;
  const { res, data, ms } = await replay(page, [next, { ...next }]);
  twoNextBaselineMs = ms;
  const reached = await page.evaluate(() => (window as unknown as { __page: number }).__page).catch(() => -1);
  console.log(`   ok=${res.ok} in ${(ms / 1000).toFixed(1)}s, reached page ${reached}`);
  check("b: MUST KEEP — both Next steps click (page 3 reached)", reached === 3 && res.ok === true,
    `reached page ${reached}, ok=${res.ok}: ${String(res.message ?? "").slice(0, 200)}`);
  check("b: no namesake handling fired", !said(data).some((w) => /#228/.test(w)), JSON.stringify(said(data)));
  await page.context().close().catch(() => null);
}

// (c) A recorded id that is gone, a role+name that is nobody else's target: no wait.
{
  console.log("\nc recorded id gone, no namesake");
  const page = await freshPage("/gone");
  const steps: RecipeStep[] = [
    { action: "click", phase: "fill", selector: { role: "button", name: "Start", exact: true, fallbacks: [{ css: "#btn-start" }] }, note: "start" },
    { action: "click", phase: "fill", selector: { role: "button", name: "Continue", exact: true, fallbacks: [{ css: "#btn-continue-recorded" }] }, note: "continue" },
  ] as RecipeStep[];
  const { adapter, res, data } = await replay(page, steps);
  const continued = await page.evaluate(() => (window as unknown as { __continued?: number }).__continued ?? 0).catch(() => -1);
  check("c: MUST KEEP — the step still clicks the one control its role+name names", continued === 1 && res.ok === true,
    `continued=${continued} ok=${res.ok}: ${String(res.message ?? "").slice(0, 200)}`);
  check("c: no namesake handling fired", !said(data).some((w) => /#228/.test(w)), JSON.stringify(said(data)));
  // The resolution itself, timed: exactly the acting path's guard, for the Continue step, with the
  // run's own click records in place.
  const a = adapter as unknown as { currentStepIdx: number; identityGuard: unknown; resolveLocator: (s: unknown, h?: string) => Promise<unknown> };
  a.currentStepIdx = 1;
  a.identityGuard = steps[1];
  const t0 = Date.now();
  // A throw here is reported as this case's failure, never allowed to hide the cases after it.
  const threw = await a.resolveLocator(steps[1].selector, "").then(() => "", (e: unknown) => String(e instanceof Error ? e.message : e));
  const dt = Date.now() - t0;
  a.identityGuard = null;
  check("c: the timed resolution ran", threw === "", threw);
  console.log(`   resolution of the Continue step took ${dt} ms`);
  check(`c: MUST KEEP — no added wait (resolution ${dt} ms, well under 1 s)`, dt < 1000, `took ${dt}ms`);
  await page.context().close().catch(() => null);
}

// (d) review R1: a counter-id wizard. Each Next is a fresh node carrying an id an earlier step
// recorded (view 1's Next is cw-1, Description's recorded id; view 2's is cw-2, view 1's recorded
// Next). Neither is the node an earlier click went to, nor carries that node's id: both click, with
// no wait and no note.
const counterNext = (id: string): RecipeStep => ({ action: "click", phase: "fill", selector: { role: "button", name: "Next", exact: true, fallbacks: [{ css: `#${id}` }] }, fingerprint: { id }, note: "advance: Next" } as RecipeStep);
const COUNTER_STEPS: RecipeStep[] = [
  { action: "fill", phase: "fill", selector: { label: "Description", fallbacks: [{ css: "#cw-1" }] }, value: "Roof-mount PV", note: "Description" },
  counterNext("cw-2"),
  // Bound to fields: a recorded literal that looks like the learn project's own data is left blank.
  { action: "fill", phase: "fill", selector: { label: "City", fallbacks: [{ css: "#cw-3" }] }, field: "siteCity", note: "City" },
  counterNext("cw-4"),
  { action: "fill", phase: "fill", selector: { label: "Phone", fallbacks: [{ css: "#cw-5" }] }, field: "installerPhone", note: "Phone" },
] as RecipeStep[];
{
  console.log("\nd counter-id wizard (review R1)");
  const page = await freshPage("/counter");
  const { res, data, ms } = await replay(page, COUNTER_STEPS, { siteCity: "Salem", installerPhone: "555-0100" });
  const view = await page.evaluate(() => (window as unknown as { __view: number }).__view).catch(() => -1);
  const phone = await page.locator("#phone").inputValue().catch(() => "(not on the page)");
  console.log(`   ok=${res.ok} in ${(ms / 1000).toFixed(1)}s, view=${view}, Phone=${JSON.stringify(phone)}, failedStepIndex=${data.failedStepIndex}`);
  console.log(`   skipped=${JSON.stringify(data.skipped ?? [])} said=${JSON.stringify(said(data)).slice(0, 600)}`);
  if (!res.ok) console.log(`   message: ${String(res.message ?? "").slice(0, 300)}`);
  check("d: MUST KEEP — both counter-id Nexts click and the last view fills",
    res.ok === true && view === 3 && phone === "555-0100",
    `ok=${res.ok} view=${view} Phone=${JSON.stringify(phone)} failedStepIndex=${data.failedStepIndex}: ${String(res.message ?? "").slice(0, 300)}`);
  check("d: no blocking #228 warning", blocking228(data).length === 0, JSON.stringify(blocking228(data)));
  check(`d: no #228 handling fired — no wait, no note (the whole run took ${(ms / 1000).toFixed(1)}s)`, !said(data).some((w) => /#228/.test(w)), JSON.stringify(said(data)));
  await page.context().close().catch(() => null);
}

// (PB) the counter-id wizard where every Next is a full page load. Step 4's pick #cw-2 is the id step 2
// RECORDED, and step 2's clicked node is gone with its document, so its id cannot be read. That is
// no evidence: no wait, no note (round 3 fell back to step 2's recorded ids and waited 10 s).
for (const mode of ["href", "form"]) {
  console.log(`\nPB counter-id wizard on full page loads (${mode})`);
  const page = await freshPage(`/pb?v=1&mode=${mode}`);
  const { adapter, res, data, ms } = await replay(page, COUNTER_STEPS, { siteCity: "Salem", installerPhone: "555-0100" });
  const url = page.url();
  const phone = await page.locator("#phone").inputValue().catch(() => "(not on the page)");
  console.log(`   ok=${res.ok} in ${(ms / 1000).toFixed(1)}s, url=${url.replace(base, "")}, Phone=${JSON.stringify(phone)}, waits started=${waitsStarted(adapter)}`);
  console.log(`   said=${JSON.stringify(said(data)).slice(0, 600)}`);
  if (!res.ok) console.log(`   message: ${String(res.message ?? "").slice(0, 300)}`);
  check(`PB(${mode}): MUST KEEP — both Nexts load their page and the last view fills`,
    res.ok === true && /v=3/.test(url) && phone === "555-0100", `ok=${res.ok} url=${url} Phone=${JSON.stringify(phone)}: ${String(res.message ?? "").slice(0, 300)}`);
  check(`PB(${mode}): MUST KEEP — no #228 handling fired, no wait (the whole run took ${(ms / 1000).toFixed(1)}s)`,
    !said(data).some((w) => /#228/.test(w)) && waitsStarted(adapter) === 0, `waits started=${waitsStarted(adapter)} ${JSON.stringify(said(data))}`);
  await page.context().close().catch(() => null);
}

// (NB) counter-id neighbours, nothing suspected: the step's recorded #button-1034 now names its
// neighbour, whose name CONTAINS the step's word. Level 0's exact role+name has the right control and
// keeps it (round 3 moved the click onto the neighbour).
for (const [w, w2] of [["Continue", "Continue Later"], ["Next", "Next page"], ["Save", "Save and Submit"]]) {
  console.log(`\nNB "${w}" whose recorded id now names "${w2}"`);
  const page = await freshPage(`/nb?w=${encodeURIComponent(w)}&w2=${encodeURIComponent(w2)}`);
  const steps: RecipeStep[] = [
    { action: "fill", phase: "fill", selector: { label: "Description", fallbacks: [{ css: "#desc" }] }, value: "Roof-mount PV", note: "Description" },
    { action: "click", phase: "fill", selector: { role: "button", name: w, exact: true, fallbacks: [{ css: "#button-1034" }] }, fingerprint: { id: "button-1034" }, note: `advance: ${w}` },
    { action: "fill", phase: "fill", selector: { label: "Project Name", fallbacks: [{ css: "#pname" }] }, field: "projectName", note: "Project Name" },
  ] as RecipeStep[];
  const { res, data, ms } = await replay(page, steps, { projectName: "Smith PV" });
  const counts = await page.evaluate(() => ({ mine: (window as unknown as { __mine: number }).__mine, other: (window as unknown as { __other: number }).__other })).catch(() => ({ mine: -1, other: -1 }));
  const pname = await page.locator("#pname").inputValue().catch(() => "(not on the page)");
  console.log(`   ok=${res.ok} in ${(ms / 1000).toFixed(1)}s, "${w}" clicks=${counts.mine}, "${w2}" clicks=${counts.other}, Project Name=${JSON.stringify(pname)}`);
  if (!res.ok) console.log(`   message: ${String(res.message ?? "").slice(0, 300)}`);
  check(`NB(${w}): MUST KEEP — "${w}" is clicked once, "${w2}" never, and the next page fills`,
    counts.mine === 1 && counts.other === 0 && pname === "Smith PV" && res.ok === true,
    `mine=${counts.mine} other=${counts.other} Project Name=${JSON.stringify(pname)} ok=${res.ok}: ${String(res.message ?? "").slice(0, 300)}`);
  check(`NB(${w}): no #228 handling fired`, !said(data).some((w3) => /#228/.test(w3)), JSON.stringify(said(data)));
  await page.context().close().catch(() => null);
}

// A two-Next replay that must reach page 3 with ok=true, paying the namesake wait at most once.
async function twoNexts(tag: string, path: string, steps: RecipeStep[]): Promise<{ data: Data; page: Page; adapter: RecipeAdapter }> {
  const page = await freshPage(path);
  const { adapter, res, data, ms } = await replay(page, steps);
  const reached = await page.evaluate(() => (window as unknown as { __page: number }).__page).catch(() => -1);
  console.log(`   ok=${res.ok} in ${(ms / 1000).toFixed(1)}s, reached page ${reached}, failedStepIndex=${data.failedStepIndex}`);
  console.log(`   #228: ${JSON.stringify(said(data).filter((w) => /#228/.test(w)).map((w) => w.slice(0, 260)))}`);
  if (!res.ok) console.log(`   message: ${String(res.message ?? "").slice(0, 300)}`);
  check(`${tag}: MUST KEEP — both Next steps click (page 3 reached, ok=true), never a namesake stop`, reached === 3 && res.ok === true,
    `reached page ${reached}, ok=${res.ok}: ${String(res.message ?? "").slice(0, 300)}`);
  // One wait over the plain two-Next replay (case b), never two.
  const bound = twoNextBaselineMs + WAIT_MS + 5000;
  check(`${tag}: the namesake wait is paid at most once (run took ${(ms / 1000).toFixed(1)}s, a plain two-Next replay ${(twoNextBaselineMs / 1000).toFixed(1)}s)`,
    twoNextBaselineMs > 0 && ms < bound, `took ${ms}ms, bound ${bound}ms`);
  return { data, page, adapter };
}

// (e) page 2's Next is a FRESH node carrying step 1's recorded (and live) #button-Next, while step 2
// recorded #button-Next-2: structurally Tigard's re-rendered menu tab, told apart only by the wait.
console.log("\ne drifted wizard ids (fresh Next carries step 1's id)");
{
  const next = (id: string): RecipeStep => ({ action: "click", phase: "fill", selector: { role: "button", name: "Next", exact: true, fallbacks: [{ css: `#${id}` }] }, note: "advance: Next" } as RecipeStep);
  const { page } = await twoNexts("e", "/wizard", [next("button-Next"), next("button-Next-2")]);
  await page.context().close().catch(() => null);
}

// (f) A persistent footer Next whose id drifted since the learn (#button-1034 → #button-1037): step 2's
// pick IS the node step 1 clicked, but both steps recorded #button-1034 — one control clicked twice.
{
  console.log("\nf persistent footer Next, both steps recorded the same drifted id");
  const page = await freshPage("/footer");
  const next: RecipeStep = { action: "click", phase: "fill", selector: { role: "button", name: "Next", exact: true, fallbacks: [{ css: "#button-1034" }] }, fingerprint: { id: "button-1034" }, note: "advance: Next" } as RecipeStep;
  const { res, data, ms } = await replay(page, [next, { ...next }]);
  const reached = await page.evaluate(() => (window as unknown as { __page: number }).__page).catch(() => -1);
  console.log(`   ok=${res.ok} in ${(ms / 1000).toFixed(1)}s, reached page ${reached}, failedStepIndex=${data.failedStepIndex}`);
  if (!res.ok) console.log(`   message: ${String(res.message ?? "").slice(0, 300)}`);
  check("f: MUST KEEP — the footer Next is clicked twice (page 3 reached), not treated as a namesake", reached === 3 && res.ok === true,
    `reached page ${reached}, ok=${res.ok}: ${String(res.message ?? "").slice(0, 300)}`);
  check("f: no #228 handling fired (no wait, no warning)", !said(data).some((w) => /#228/.test(w)), JSON.stringify(said(data)));
  await page.context().close().catch(() => null);
}

const footerNext = (id: string): RecipeStep => ({ action: "click", phase: "fill", selector: { role: "button", name: "Next", exact: true, fallbacks: [{ css: `#${id}` }] }, fingerprint: { id }, note: "advance: Next" } as RecipeStep);

// (P1) the re-review's persistent footer: the learn saw #btnNext1 / #btnNext2, the portal now renders
// one persistent #next. Step 2's pick is the node step 1 clicked; its own #btnNext2 never renders.
console.log("\nP1 one persistent footer #next, the learn saw #btnNext1 / #btnNext2");
{
  const { page } = await twoNexts("P1", "/footer?id=next&hook=1", [footerNext("btnNext1"), footerNext("btnNext2")]);
  await page.context().close().catch(() => null);
}

// (P2) the same footer; the earlier step recorded only a css hook, so no id ties the two steps.
console.log("\nP2 the earlier step recorded only a css hook");
{
  const { page } = await twoNexts("P2", "/footer?id=next&hook=1", [
    { action: "click", phase: "fill", selector: { role: "button", name: "Next", exact: true, fallbacks: [{ css: '[data-test-role="next-btn"]' }] }, note: "advance: Next" },
    { action: "click", phase: "fill", selector: { role: "button", name: "Next", exact: true, fallbacks: [{ css: "#nextLearned" }] }, fingerprint: { id: "nextLearned" }, note: "advance: Next" },
  ] as RecipeStep[]);
  await page.context().close().catch(() => null);
}

// (CS) the P1 footer, where step 2's recorded #btnNext2 now names a visible persistent "Next page".
// Step 2's pick (the footer Next step 1 clicked) IS suspected, but "Next page" is not the recorded
// "Next": not a hit, and a shown id naming another control buys no wait. The footer Next is clicked,
// as main clicks it (round 3's containment moved the click onto "Next page").
console.log("\nCS suspected footer Next; the recorded id now names \"Next page\"");
{
  const { adapter, data, page } = await twoNexts("CS", "/footer?id=next&pager=btnNext2", [footerNext("btnNext1"), footerNext("btnNext2")]);
  const pager = await page.evaluate(() => (window as unknown as { __pager: number }).__pager).catch(() => -1);
  console.log(`   "Next page" clicks=${pager}, waits started=${waitsStarted(adapter)}`);
  check("CS: MUST KEEP — \"Next page\" is never clicked", pager === 0, `"Next page" clicks=${pager}`);
  // Not a MUST KEEP: origin/main has no suspicion to name.
  check("CS: the footer Next was not waited on — the recorded id is shown, naming another control, and the line says so",
    waitsStarted(adapter) === 0 && blocking228(data).some((w) => /#btnNext2 is on the page but names another control, so it was not waited for/.test(w)),
    `waits started=${waitsStarted(adapter)} ${JSON.stringify(said(data))}`);
  await page.context().close().catch(() => null);
}

// (N4 / N4n) FOUR footer Nexts the learn saw as #btnNext1..#btnNext4, on one persistent footer Next
// (with an id now, and with none). The first suspicion waits once; every later Next picks the same
// control and clicks it with no further wait and no second line. Round 3 paid three waits.
for (const [tag, path] of [["N4", "/footer?id=next"], ["N4n", "/footer?noid=1"]]) {
  console.log(`\n${tag} four footer Nexts${tag === "N4n" ? " (no id on the footer button)" : ""}`);
  const page = await freshPage(path);
  const { adapter, res, data, ms } = await replay(page, [footerNext("btnNext1"), footerNext("btnNext2"), footerNext("btnNext3"), footerNext("btnNext4")]);
  const reached = await page.evaluate(() => (window as unknown as { __page: number }).__page).catch(() => -1);
  const lines = blocking228(data);
  console.log(`   ok=${res.ok} in ${(ms / 1000).toFixed(1)}s, reached page ${reached}, waits started=${waitsStarted(adapter)}, #228 drift lines=${lines.length}`);
  console.log(`   #228: ${JSON.stringify(lines.map((w) => w.slice(0, 260)))}`);
  if (!res.ok) console.log(`   message: ${String(res.message ?? "").slice(0, 300)}`);
  check(`${tag}: MUST KEEP — all four Nexts click (page 5 reached, ok=true)`, reached === 5 && res.ok === true,
    `reached page ${reached}, ok=${res.ok}: ${String(res.message ?? "").slice(0, 300)}`);
  check(`${tag}: MUST KEEP — at most one namesake wait in the whole run (waits started=${waitsStarted(adapter)})`, waitsStarted(adapter) <= 1, `waits started=${waitsStarted(adapter)}`);
  check(`${tag}: MUST KEEP — at most one #228 drift line in the whole run`, lines.length <= 1, JSON.stringify(lines));
  // A four-Next replay costs about two two-Next replays (case b); one wait on top, never three.
  const bound = 2 * twoNextBaselineMs + WAIT_MS + 12_000;
  check(`${tag}: MUST KEEP — total added time stays within one wait (run took ${(ms / 1000).toFixed(1)}s, bound ${(bound / 1000).toFixed(1)}s)`,
    twoNextBaselineMs > 0 && ms < bound, `took ${ms}ms, bound ${bound}ms`);
  await page.context().close().catch(() => null);
}

// (g) review R4: a WRITE is never moved by this rule. Its recorded id #c9 now names a visible box whose
// placeholder carries the word "City"; the labelled City box is the one written.
{
  console.log("\ng a write whose recorded id names a placeholder box (review R4)");
  const page = await freshPage("/write");
  const steps: RecipeStep[] = [
    { action: "fill", phase: "fill", selector: { label: "City", fallbacks: [{ css: "#c9" }] }, fingerprint: { id: "c9" }, field: "siteCity", note: "City" },
  ] as RecipeStep[];
  const { res, data } = await replay(page, steps, { siteCity: "Salem" });
  const labelled = await page.locator("#a1").inputValue();
  const placeholderBox = await page.locator("#c9").inputValue();
  console.log(`   ok=${res.ok}, labelled City=${JSON.stringify(labelled)}, placeholder box=${JSON.stringify(placeholderBox)}`);
  check("g: MUST KEEP — the labelled City gets Salem; the \"City (mailing)\" placeholder box stays empty",
    labelled === "Salem" && placeholderBox === "", `labelled=${JSON.stringify(labelled)} placeholderBox=${JSON.stringify(placeholderBox)}`);
  check("g: no #228 handling fired", !said(data).some((w) => /#228/.test(w)), JSON.stringify(said(data)));
  await page.context().close().catch(() => null);
}

// (h) review R2: the wizard's "Next" BUTTON was recorded with #tok7, which now names a results pager's
// "Next" LINK. Same words, other role (the learner's own reading of the link): the button is clicked,
// the pager never is.
{
  console.log("\nh recorded id now names a same-word control of another role (review R2)");
  const page = await freshPage("/pager");
  const steps: RecipeStep[] = [
    { action: "click", phase: "fill", selector: { role: "button", name: "Next", exact: true, fallbacks: [{ css: "#tok7" }] }, fingerprint: { id: "tok7" }, note: "advance: Next" },
  ] as RecipeStep[];
  const { res, data, ms } = await replay(page, steps);
  const counts = await page.evaluate(() => ({ wizard: (window as unknown as { __wizard: number }).__wizard, pager: (window as unknown as { __pager: number }).__pager })).catch(() => ({ wizard: -1, pager: -1 }));
  console.log(`   ok=${res.ok} in ${(ms / 1000).toFixed(1)}s, wizard clicks=${counts.wizard}, pager clicks=${counts.pager}`);
  check("h: MUST KEEP — the wizard's Next button is clicked once and the pager's Next link never",
    counts.wizard === 1 && counts.pager === 0 && res.ok === true, `wizard=${counts.wizard} pager=${counts.pager} ok=${res.ok}`);
  check("h: no #228 handling fired", !said(data).some((w) => /#228/.test(w)), JSON.stringify(said(data)));
  await page.context().close().catch(() => null);
}

await browser.close();
server.close();
if (failedLabels.length) console.log(`\nfailed checks:\n${failedLabels.map((l) => `  - ${l}`).join("\n")}`);
console.log(failures === 0 ? "\nrecordedIdentityNamesake.dom.smoke: PASS" : `\nrecordedIdentityNamesake.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
