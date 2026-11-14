// A MATCH THAT CARRIES THE STEP'S WORDS BUT NOT ITS RECORDED ID IS A NAMESAKE (#228).
//
// Live on City of Tigard (Tyler EnerGov), 2026-11-14: the learner recorded the record-type click as
//
//   { role: "link", name: "Apply", exact: true, fallbacks: [{ css: "#apply-btn-ResidentialRenewableEnergy-Prescriptive" }] }
//
// The real control's accessible name is its aria-label ("Apply Residential Renewable Energy -
// Prescriptive"), so that role+name never matches it. It matches exactly ONE element — the top menu's
// "Apply" tab, which is step 1's own recorded target. resolveLocator accepted that single visible
// match at level 0 and never asked the recorded id; the click reported ok, the application never
// opened, and the next step ("Address Type") waited out the stall watchdog. The record-type button
// renders ~116 ms after the assistant's Search, and the page carries a hidden ng-hide twin of it
// (and a hidden twin of the menu tab in #sidebarMenu).
//
//   MUST PASS  — (A) the live shape (rows ~150 ms after Search) opens the RIGHT record type and fills
//                Address Type; (B) rows 1.5 s after Search, which forces the namesake WAIT, the same;
//                (C) rows that never render: the click is REFUSED, named, the menu tab is not clicked
//                a second time, and the heal does not click it either.
//   MUST KEEP  — (a) PowerClerk's per-render id: `{css:"#pcInputBase34", fallbacks:[{label:"Model",
//                nth:0}]}` where #pcInputBase34 now names a visible "Energy Source" still fills Model;
//                the label-primary shape the same; and a click recorded by "Add Inverter" whose id now
//                names a visible "Remove Inverter" still clicks Add Inverter (the id alone never wins);
//                (b) two "Next" steps sharing #button-Next on consecutive pages both click;
//                (c) a step whose recorded id is gone and whose role+name is nobody else's target
//                clicks with NO added wait.
//
//   npx tsx portal-bot/src/adapters/recordedIdentityNamesake.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// ---- the EnerGov self-service shape -----------------------------------------------------------
// A hash-routed SPA: the menu stays put, the view re-renders. Each result row carries its Apply link
// TWICE (ng-show / ng-hide), hidden copy first, both with the same id. A decoy type comes first so a
// positional or text-only pick lands on the wrong permit.
const ENERGOV = `<!doctype html><html><head><style>
  body { font: 14px sans-serif; padding: 16px; }
  .ng-hide { display: none !important; }
  #sidebarMenu { display: none; }
  .mainMenuNav-a { display: inline-block; padding: 8px 14px; background: #246; color: #fff; text-decoration: none; }
  .btn { display: inline-block; padding: 6px 12px; background: #06c; color: #fff; text-decoration: none; }
  .row { margin: 8px 0; }
</style></head><body>
  <nav id="topMenu">
    <a id="link-Menu-Home" class="mainMenuNav-a" href="#/home">Home</a>
    <a id="link-Menu-Apply" class="mainMenuNav-a" href="#/applicationAssistant">Apply</a>
  </nav>
  <div id="sidebarMenu"><a id="link-Menu-Apply" class="mainMenuNav-a" href="#/applicationAssistant">Apply</a></div>
  <main id="view"></main>
<script>
  var DELAY = Number(new URLSearchParams(location.search).get('delay') || '150');
  // Reported to the test process, so neither a retry's reload nor the stall watchdog closing the page
  // can lose the evidence.
  var report = function (k, v) { try { if (window.__smokeEvent) window.__smokeEvent(k, v); } catch (e) { /* not wired */ } };
  var bump = function () { report('menu', ''); };
  document.querySelectorAll('[id="link-Menu-Apply"]').forEach(function (a) {
    a.addEventListener('click', bump);
  });
  function applyLink(type, label, href, hidden) {
    return '<div ng-show="' + (hidden ? '!' : '') + 'vm.isCollapsed" class="apply-btn-align' + (hidden ? ' ng-hide' : '') + '" aria-hidden="' + (hidden ? 'true' : 'false') + '">'
      + '<a id="apply-btn-' + type + '" class="btn btn-primary" tabindex="0" role="link" aria-label="Apply ' + label + '" href="' + href + '">\\n Apply\\n </a></div>';
  }
  function rows() {
    return [['ResidentialMechanical', 'Residential Mechanical', '#/permit/apply/12/0/0'],
            ['ResidentialRenewableEnergy-Prescriptive', 'Residential Renewable Energy - Prescriptive', '#/permit/apply/94/0/0']]
      .map(function (r) { return '<div class="row"><span>' + r[1] + '</span>' + applyLink(r[0], r[1], r[2], true) + applyLink(r[0], r[1], r[2], false) + '</div>'; })
      .join('');
  }
  function render() {
    var h = location.hash || '#/home';
    var v = document.getElementById('view');
    if (h === '#/applicationAssistant') {
      v.innerHTML = '<h2>Application Assistant</h2><input id="assistantSearch" aria-label="Search applications" value="solar">'
        + ' <button id="button-Search" type="button">Search</button><div id="results"></div>';
      document.getElementById('button-Search').addEventListener('click', function () {
        if (DELAY < 0) return; // the search found nothing for this address
        setTimeout(function () { document.getElementById('results').innerHTML = rows(); }, DELAY);
      });
    } else if (h.indexOf('#/permit/apply/') === 0) {
      report('opened', h);
      v.innerHTML = '<h2>Residential Permit Application</h2><label for="addressType">Address Type</label> '
        + '<select id="addressType"><option value="">Select...</option><option>Location</option><option>Parcel</option></select>';
    } else {
      v.innerHTML = '<h2>Home</h2>';
    }
  }
  window.addEventListener('hashchange', render);
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

const server = http.createServer((q, r) => {
  const p = String(q.url ?? "/").split("?")[0];
  const body = p === "/pc" ? POWERCLERK : p === "/wizard" ? WIZARD : p === "/gone" ? GONE : ENERGOV;
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

type Data = { driftWarnings?: string[]; agingNotes?: string[]; skipped?: string[]; failedStepIndex?: number };
const browser = await chromium.launch();

// What the fixture reported (menu-tab clicks, the application route opened), per page.
const events = new WeakMap<Page, Array<{ kind: string; value: string }>>();
async function freshPage(path: string): Promise<Page> {
  const ctx = await browser.newContext();
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await ctx.newPage();
  const seen: Array<{ kind: string; value: string }> = [];
  events.set(page, seen);
  await page.exposeFunction("__smokeEvent", (kind: string, value: string) => { seen.push({ kind, value }); });
  await page.goto(`${base}${path}`);
  return page;
}
const menuClicks = (page: Page): number => (events.get(page) ?? []).filter((e) => e.kind === "menu").length;
const openedRoute = (page: Page): string => [...new Set((events.get(page) ?? []).filter((e) => e.kind === "opened").map((e) => e.value))].join(" ");
async function replay(page: Page, steps: RecipeStep[]) {
  // A 45 s stall watchdog instead of the production 8 minutes: without the fix, the step after the
  // namesake click waits it out exactly as it did live, and the smoke should not take half an hour.
  const adapter = new RecipeAdapter(recipeOf(steps, page.url()), {}, {}, { autoSubmit: false, stallTimeoutMs: 45_000 });
  (adapter as unknown as { page: unknown }).page = page;
  const t0 = Date.now();
  const res = await adapter.fillApplication({} as never);
  const data = (res as unknown as { data?: Data }).data ?? {};
  return { adapter, res, data, ms: Date.now() - t0 };
}
const said = (d: Data): string[] => [...(d.driftWarnings ?? []), ...(d.agingNotes ?? [])];

// (A) and (B): the record type opens and the application's first field fills.
// (A0) rows already up when the step resolves: the recorded id displaces the namesake with no wait.
for (const [tag, delay] of [
  ["A0 rows rendered at once (displacement, no wait)", 0],
  ["A live shape, rows 150 ms after Search", 150],
  ["B rows 1.5 s after Search (the namesake wait)", 1500],
] as const) {
  console.log(`\n${tag}`);
  const page = await freshPage(`/?delay=${delay}`);
  const { res, data, ms } = await replay(page, TIGARD_STEPS);
  const opened = openedRoute(page);
  const menu = menuClicks(page);
  const addressType = await page.locator("#addressType").inputValue().catch(() => "(not on the page)");
  console.log(`   ok=${res.ok} in ${(ms / 1000).toFixed(1)}s, opened=${JSON.stringify(opened)}, menu clicks=${menu}, Address Type=${JSON.stringify(addressType)}`);
  console.log(`   notes: ${JSON.stringify(said(data).filter((w) => /#228/.test(w)).map((w) => w.slice(0, 220)))}`);
  check(`${tag.split(" ")[0]}: MUST PASS — the replay opens the recorded record type, not the menu's "Apply"`,
    opened === "#/permit/apply/94/0/0",
    `opened=${JSON.stringify(opened)} — the namesake menu tab was clicked (or the decoy type), and the application never opened`);
  check(`${tag.split(" ")[0]}: MUST PASS — the menu tab is clicked once (by step 1), never again by the record-type step`,
    menu === 1, `menu clicks=${menu}`);
  check(`${tag.split(" ")[0]}: MUST PASS — Address Type fills on the opened application`,
    addressType === "Location", `Address Type=${JSON.stringify(addressType)}`);
  check(`${tag.split(" ")[0]}: the run completes`, res.ok === true, String(res.message ?? "").slice(0, 300));
  const rescue = said(data).find((w) => /#228/.test(w) && /apply-btn-ResidentialRenewableEnergy-Prescriptive/.test(w)) ?? "";
  check(`${tag.split(" ")[0]}: the rescue is reported, so the recipe is re-recorded`, !!rescue, JSON.stringify(said(data)));
  if (delay === 0) {
    check("A0: the rows were up before the step resolved — displaced with no wait", !!rescue && !/rendered .* after the namesake/.test(rescue), rescue);
  }
  if (delay === 1500) {
    check("B: the namesake WAIT is what found it", /rendered 1\.\d s after the namesake/.test(rescue), rescue);
  }
  await page.context().close().catch(() => null);
}

// (C): the search found nothing — the record type never renders.
{
  const tag = "C rows never render";
  console.log(`\n${tag}`);
  const page = await freshPage("/?delay=-1");
  const { res, data, ms } = await replay(page, TIGARD_STEPS);
  const opened = openedRoute(page);
  const menu = menuClicks(page);
  console.log(`   ok=${res.ok} in ${(ms / 1000).toFixed(1)}s, failedStepIndex=${data.failedStepIndex}, menu clicks=${menu}`);
  console.log(`   message: ${String(res.message ?? "").slice(0, 400)}`);
  check("C: MUST PASS — the record-type click is NOT satisfied by the earlier step's menu tab (menu clicked once)",
    menu === 1, `menu clicks=${menu} — the namesake was clicked and the step reported ok`);
  check("C: MUST PASS — the run stops AT the record-type step, named",
    res.ok === false && data.failedStepIndex === 2 && /NOT clicked/.test(String(res.message ?? "")) && /step 1's recorded control/.test(String(res.message ?? "")),
    `ok=${res.ok} failedStepIndex=${data.failedStepIndex} message=${String(res.message ?? "").slice(0, 300)}`);
  check("C: nothing opened", opened === "", `opened=${JSON.stringify(opened)}`);
  check(`C: the refusal is prompt — one bounded wait, no retries or reloads (took ${(ms / 1000).toFixed(1)}s)`,
    ms < 25000, `took ${ms}ms`);
  await page.context().close().catch(() => null);
}

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

// (b) Two "Next" steps that recorded the same id: the second is not a namesake of the first.
{
  console.log("\nb two Next steps sharing #button-Next");
  const page = await freshPage("/wizard");
  const next: RecipeStep = { action: "click", phase: "fill", selector: { role: "button", name: "Next", exact: true, fallbacks: [{ css: "#button-Next" }] }, note: "advance: Next" } as RecipeStep;
  const { res, data } = await replay(page, [next, { ...next }]);
  const reached = await page.evaluate(() => (window as unknown as { __page: number }).__page).catch(() => -1);
  console.log(`   ok=${res.ok}, reached page ${reached}`);
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
  // The resolution itself, timed: exactly the acting path's guard, for the Continue step.
  const a = adapter as unknown as { currentStepIdx: number; identityGuard: unknown; namesakeStop: unknown; resolveLocator: (s: unknown, h?: string) => Promise<unknown> };
  a.currentStepIdx = 1;
  a.identityGuard = { step: steps[1], namesake: true };
  const t0 = Date.now();
  await a.resolveLocator(steps[1].selector, "");
  const dt = Date.now() - t0;
  a.identityGuard = null;
  console.log(`   resolution of the Continue step took ${dt} ms`);
  check(`c: MUST KEEP — no added wait (resolution ${dt} ms, well under 1 s)`, dt < 1000 && a.namesakeStop == null,
    `took ${dt}ms, namesakeStop=${JSON.stringify(a.namesakeStop)}`);
  await page.context().close().catch(() => null);
}

await browser.close();
server.close();
console.log(failures === 0 ? "\nrecordedIdentityNamesake.dom.smoke: PASS" : `\nrecordedIdentityNamesake.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
