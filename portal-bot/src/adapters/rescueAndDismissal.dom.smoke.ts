// A STAND-IN FOUND BY NAME MUST CARRY THE WHOLE NAME, AND A POPUP'S OK WITH NO POPUP IS NOT A STEP (#233).
//
// The live-confirmed defect is Bend's electrical recipe step 22, "advance: OK" on
// #uploadErrorPopupOk: the learn's upload hit an error popup and the learner dismissed it as a
// step. On a run whose upload goes through the popup is a closed <dialog> with a display:none OK.
// Live 2026-11-14 the step clicked that hidden OK into a 30 s timeout and three reloads and failed
// the run; on the auditors' probe page the name rescue matched "OK" as a SUBSTRING of "Book an
// Inspection" (label.includes(want), shortest label wins) and navigated off the application.
//
// Pinned here, each on a synthetic page shaped like the evidence:
//   [1] Bend 22  — MUST PASS: no popup shown, the OK step is skipped NAMED (the popup's closed, or
//                  not in the DOM at all), "Book an Inspection" is never clicked, and the run goes on
//                  to tick "Do you agree?*".
//   [2] popups   — MUST KEEP: a popup that IS showing (at once, at 1.2 s, at 4 s) has its OK clicked
//                  as recorded; a dialog showing under other markup goes main's way at once (its
//                  "Ok" found by name, no wait); a dismissal whose words a gate refuses keeps main's
//                  path to that gate (no wait).
//   [3] words    — MUST EXCLUDE: the rescue never resolves "Search" to "Research" or "OK" to "Book
//                  an Inspection" / "Lookup" / "Bookmarks", and the closed-menu reveal never hovers a
//                  "Research" menu for "Search". MUST PASS: "Search Records"; a ligature glued after
//                  the label ("Nextarrow_forward") still reads "Next"; "Log<span>in</span>" reads
//                  "Login".
//   [4] Oregon   — MUST KEEP: "Apply" still reaches "check_circleApply" (the ligature strip) past a
//                  disabled decorative pill, and "Apply Now".
//   [5] hidden   — MUST KEEP: an ordinary control hidden then shown is clicked as on main, and so is
//                  a bare "Close" with no recorded popup handle (not a dismissal step).
//
//   npx tsx portal-bot/src/adapters/rescueAndDismissal.dom.smoke.ts
import "../smokeArtifactDirs";
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

const shell = (body: string, script = ""): string => `<!doctype html><html><head><style>
  body { font: 14px sans-serif; padding: 12px; }
  nav a { display:inline-block; padding:6px 10px; }
  button, a.btn { display:inline-block; padding:6px 10px; margin:4px; }
  .dropdown { position: relative; display: inline-block; }
  .dropdown-menu { display: none; position: absolute; background: #fff; min-width: 200px; } .dropdown:hover .dropdown-menu { display: block; }
  .dropdown-menu a { display: block; padding: 6px; }
</style></head><body>${body}<script>${script}</script></body></html>`;

// Every click a fixture sees lands in window.__hits, so "what was clicked" is read, not inferred.
const HITS = "window.__hits = []; document.addEventListener('click', function (e) { var t = e.target.closest('a, button'); if (t) window.__hits.push(t.id || t.textContent.trim()); }, true);";

// [1] Bend p6, from the live step-22 capture's shape: the control bar's links (here with the
// auditors' "Book an Inspection", which leaves the application), "Permit Application - Upload Files"
// with its Next Step (recipe step 21, whose redirect brings the disclaimer), and a CLOSED upload-error
// <dialog class="cvpopup"> whose OK is display:none.
const bend = (withPopup: boolean): string => shell(`
  <nav id="navBar" class="controlBar" aria-label="Portal navigation links">
    <a id="lnkMyItems" href="#/items">My Items</a>
    <a id="bookInspection" href="/inspections">Book an Inspection</a>
    <a id="lnkPortalHelp" href="#/help">Portal Help</a>
  </nav>
  <form id="permitForm" onsubmit="return false;">
    <section id="uploadStep"><h2 class="tabTitle">Permit Application - Upload Files</h2>
      <button type="button" id="dummyUploadCompleteThenRedirect">Next Step</button>
    </section>
    <section id="disclaimerStep" style="display:none"><h2 class="tabTitle">Permit Application - Disclaimer</h2>
      <input type="checkbox" id="agree"><label for="agree">Do you agree?*</label>
    </section>
    ${withPopup ? `<dialog id="uploadErrorPopup" class="cvpopup"><h2 id="uploadErrorPopupTitle" class="tabTitle">Error</h2><div id="uploadErrorPopupText"></div>
      <button id="uploadErrorPopupOk" type="button" style="display:none;">OK</button></dialog>` : ""}
  </form>`, `${HITS}
  document.getElementById('dummyUploadCompleteThenRedirect').addEventListener('click', function () {
    setTimeout(function () { document.getElementById('uploadStep').style.display = 'none'; document.getElementById('disclaimerStep').style.display = ''; }, 600);
  });`);

// [2] The popup SHOWING (at once, at 1.2 s, at 4 s): its OK closes it and the disclaimer appears.
const popup = (at: number): string => shell(`
  <form onsubmit="return false;"><h2>Permit Application - Upload Files</h2>
    <dialog id="uploadErrorPopup" class="cvpopup"><div>An error has occurred.</div>
      <button id="uploadErrorPopupOk" type="button">OK</button></dialog>
    <section id="disclaimerStep" style="display:none"><input type="checkbox" id="agree"><label for="agree">Do you agree?*</label></section>
  </form>`, `${HITS}
  document.getElementById('uploadErrorPopupOk').addEventListener('click', function () {
    document.getElementById('uploadErrorPopup').close(); document.getElementById('disclaimerStep').style.display = '';
  });
  var open = function () { document.getElementById('uploadErrorPopup').showModal(); }; ${at < 0 ? "open();" : `setTimeout(open, ${at});`}`);

const PAGES: Record<string, string> = {
  "/bend": bend(true),
  "/bendgone": bend(false),
  "/inspections": shell(`<h2>Book an Inspection</h2><p>Choose a permit.</p>`, HITS),
  "/popupshown": popup(-1),
  "/popuplate": popup(1200),
  "/popupslow": popup(4000),
  // [2] A dialog showing under markup the recording did not name: no #uploadErrorPopupOk, and an
  // "Ok" button the recorded exact role+name does not match.
  "/popupother": shell(`
    <form onsubmit="return false;"><h2>Permit Application - Upload Files</h2>
      <dialog id="sessionNotice" class="cvpopup"><div>Your upload is still processing.</div>
        <button id="altOk" type="button">Ok</button></dialog>
      <section id="disclaimerStep" style="display:none"><input type="checkbox" id="agree"><label for="agree">Do you agree?*</label></section>
    </form>`, `${HITS}
    document.getElementById('altOk').addEventListener('click', function () {
      document.getElementById('sessionNotice').close(); document.getElementById('disclaimerStep').style.display = '';
    });
    document.getElementById('sessionNotice').showModal();`),
  // [2] A dismissal-shaped step a gate refuses (its note says "submit"): the popup closed.
  "/submitgate": shell(`
    <form onsubmit="return false;"><h2>Review</h2>
      <dialog id="submitPopup" class="cvpopup"><button id="submitPopupOk" type="button" style="display:none">OK</button></dialog>
    </form>`, HITS),
  // [3] A hidden recorded "Search", and two content links that carry the letters: a fragment
  // ("Research", the shorter) and the whole word ("Search Records").
  "/wholeword": shell(`
    <main><button id="hiddenSearch" style="display:none">Search</button>
      <a id="research" class="btn" href="#/research">Research</a>
      <a id="searchRecords" class="btn" href="#/records">Search Records</a>
    </main>`, HITS),
  // [3] A hidden recorded "OK" (no popup handle — the rescue's own question), and only fragments.
  "/bookok": shell(`
    <main><button id="hiddenOk" style="display:none">OK</button>
      <a id="lookup" class="btn" href="#/lookup">Lookup</a>
      <a id="bookmarks" class="btn" href="#/bookmarks">Bookmarks</a>
      <a id="bookInspection" class="btn" href="#/inspections">Book an Inspection</a>
    </main>`, HITS),
  // [3] A ligature glued AFTER the label (no whitespace node between): the button reads
  // "Nextarrow_forward". And a label split across elements that must still read whole ("Login").
  "/trail": shell(`
    <main><button id="hiddenNext" style="display:none">Next</button>
      <button id="realNext" type="button"><span>Next</span><i class="material-icons">arrow_forward</i></button>
      <button id="hiddenLogin" style="display:none">Login</button>
      <a id="loginLink" class="btn" href="#/login">Log<span>in</span></a>
    </main>`, HITS),
  // [3] The closed-menu reveal's door: a DISABLED "Research" trigger (so the rescue passes it by)
  // over a hover menu with one hidden entry, Oregon's menu shape. The recorded "Search" is not on the
  // page at all: a hidden one would itself be the first trigger the reveal arms (its innerText still
  // reads "Search"), and the Research menu would never be asked about.
  "/researchmenu": shell(`
    <main><h2>Records</h2>
      <div class="dropdown"><button id="researchBtn" disabled>Research</button>
        <div class="dropdown-menu"><a id="researchEntry" href="#/library">Research Library</a></div></div>
    </main>`, HITS),
  // [4] Oregon ePermitting, reduced: a disabled decorative pill carrying the bare word, and the real
  // link whose name is the icon ligature glued to the label ("check_circleApply").
  "/ligature": shell(`
    <h2 id="heading">Dashboard</h2>
    <button id="pill" disabled class="dropbtn1">Apply</button>
    <div class="nav"><a id="real" href="#go"><i class="material-icons">check_circle</i>Apply</a></div>`,
  `${HITS} document.getElementById('real').addEventListener('click', function (e) { e.preventDefault(); document.getElementById('heading').textContent = 'Applied'; });`),
  "/applynow": shell(`
    <h2 id="heading">Dashboard</h2>
    <button id="hiddenApply" style="display:none">Apply</button>
    <a id="applyNow" class="btn" href="#go">Apply Now</a>`,
  `${HITS} document.getElementById('applyNow').addEventListener('click', function (e) { e.preventDefault(); document.getElementById('heading').textContent = 'Applied'; });`),
  // [5] An ordinary Next and a bare Close, both hidden until 1.5 s.
  "/lateshown": shell(`
    <main><h2 id="heading">Contacts</h2><input id="kw" aria-label="Keyword">
      <button id="closeBtn" type="button" style="display:none">Close</button>
      <button id="nextBtn" type="button" style="display:none">Next</button>
    </main>`, `${HITS}
    setTimeout(function () { document.getElementById('closeBtn').style.display = ''; document.getElementById('nextBtn').style.display = ''; }, 1500);
    document.getElementById('nextBtn').addEventListener('click', function () { document.getElementById('heading').textContent = 'Step 2'; document.getElementById('kw').id = 'kw2'; });`),
};

const server = http.createServer((q, r) => {
  const body = PAGES[String(q.url ?? "").split("?")[0]];
  r.writeHead(body ? 200 : 404, { "Content-Type": "text/html" });
  r.end(body ?? "not here");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

interface Run { ok: boolean; message: string; hits: string[]; path: string; drift: string[]; aging: string[]; skipped: string[]; described: Array<{ note: string; said: string }>; ms: number; checked?: boolean }
const recipeOf = (path: string, steps: RecipeStep[]): PortalRecipe => ({
  id: `rd-${path.slice(1)}`, scopeType: "ahj", profileKey: `or|synthetic${path.slice(1)}|x`, state: "OR", ahj: "City of Example", utility: "",
  portalPlatform: "synthetic", portalUrl: `${base}${path}`, status: "complete", version: 1,
  steps, createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "electrical",
} as unknown as PortalRecipe);

async function run(path: string, steps: RecipeStep[]): Promise<Run> {
  const page = await context.newPage();
  await page.goto(`${base}${path}`);
  const adapter = new RecipeAdapter(recipeOf(path, steps), {}, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  // What the skip trace said about each skipped step (describeResolved), read as it is said.
  const described: Run["described"] = [];
  const spy = adapter as unknown as { describeResolved: (step: RecipeStep, actual?: unknown) => Promise<string> };
  const real = spy.describeResolved.bind(adapter);
  spy.describeResolved = async (step, actual) => {
    const said = await real(step, actual);
    described.push({ note: String(step.note ?? ""), said });
    return said;
  };
  const t0 = Date.now();
  const res = await adapter.fillApplication({} as never);
  const ms = Date.now() - t0;
  const data = (res as unknown as { data?: { driftWarnings?: string[]; agingNotes?: string[]; skipped?: string[] } }).data ?? {};
  const hits = await page.evaluate(() => (window as unknown as { __hits?: string[] }).__hits ?? []).catch(() => [] as string[]);
  const where = new URL(page.url());
  const checked = await page.evaluate(() => (document.getElementById("agree") as HTMLInputElement | null)?.checked).catch(() => undefined);
  await page.close();
  const out: Run = {
    ok: res.ok, message: String(res.message ?? ""), hits, path: `${where.pathname}${where.hash}`, ms, checked,
    drift: data.driftWarnings ?? [], aging: data.agingNotes ?? [], skipped: data.skipped ?? [], described,
  };
  console.log(`   ${path}: ok=${out.ok} ${Math.round(ms / 100) / 10}s hits=${JSON.stringify(hits)} at=${out.path}`);
  console.log(`      message: ${out.message.replace(/\s+/g, " ").slice(0, 220)}`);
  return out;
}

// Resolution only — what the rescue hands back for a step, without spending a click on a miss.
async function resolveOnly(path: string, step: RecipeStep): Promise<{ id: string; drift: string[]; menuOpen: boolean }> {
  const page = await context.newPage();
  await page.goto(`${base}${path}`);
  const adapter = new RecipeAdapter(recipeOf(path, [step]), {}, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  const resolve = (adapter as unknown as { resolveLocator: (s: unknown, h?: string) => Promise<unknown> }).resolveLocator.bind(adapter);
  const loc = await resolve(step.selector, String(step.note ?? "")) as { count?: () => Promise<number>; first?: () => { evaluate: (fn: (el: Element) => string) => Promise<string> } } | null;
  const n = loc && typeof loc.count === "function" ? await loc.count().catch(() => 0) : 0;
  const id = n && typeof loc?.first === "function" ? await loc.first().evaluate((el) => el.id).catch(() => "") : "";
  const menuOpen = await page.evaluate(() => {
    const m = document.querySelector(".dropdown-menu") as HTMLElement | null;
    return !!m && getComputedStyle(m).display !== "none";
  });
  const drift = (adapter as unknown as { driftWarnings: string[] }).driftWarnings;
  console.log(`   ${path} resolved: count=${n} id=${JSON.stringify(id)} menuOpen=${menuOpen}`);
  await page.close();
  return { id, drift, menuOpen };
}

const NEXT_STEP = { action: "click", phase: "fill", selector: { role: "button", name: "Next Step", exact: true, fallbacks: [{ css: "#dummyUploadCompleteThenRedirect" }] }, note: "advance: Next Step" };
// Recipe 8bbd9a74 step 22, verbatim.
const OK_STEP = { action: "click", phase: "fill", selector: { role: "button", name: "OK", exact: true, fallbacks: [{ css: "#uploadErrorPopupOk" }] }, note: "advance: OK" };
const AGREE_STEP = { action: "check", phase: "fill", selector: { label: "Do you agree?*", fallbacks: [{ css: "#agree" }] }, note: "Do you agree?*" };

// -------------------------------------------------------------------------------------------
console.log("\n[1] Bend 22: a dismissal whose popup is not shown is skipped named; the run goes on");
for (const p of ["/bend", "/bendgone"]) {
  const r = await run(p, [NEXT_STEP, OK_STEP, AGREE_STEP] as RecipeStep[]);
  check(`${p}: THE REGRESSION — "Book an Inspection" is never clicked, the run never leaves the application, and nothing is clicked for the OK`, () => {
    assert.deepEqual(r.hits, ["dummyUploadCompleteThenRedirect"], JSON.stringify(r.hits));
    assert.equal(r.path, p, r.path);
  });
  check(`${p}: ...the OK step is skipped as not applicable, said so by name`, () => {
    assert.ok(r.skipped.some((s) => /advance: OK/.test(s)), JSON.stringify(r.skipped));
    assert.ok(r.aging.some((a) => /advance: OK.*not showing on this run — skipped as not applicable/.test(a)), JSON.stringify(r.aging));
  });
  check(`${p}: ...never handed to the name rescue, not even by the trace's diagnostic`, () => {
    assert.ok(!r.aging.some((a) => /found an enabled one by name/.test(a)), JSON.stringify(r.aging));
    assert.ok(!r.drift.some((d) => /name containing "OK"/.test(d)), JSON.stringify(r.drift));
    const line = r.described.find((t) => /advance: OK/.test(t.note));
    assert.ok(line && /popup is not showing/.test(line.said), JSON.stringify(r.described));
  });
  check(`${p}: ...and the run goes on: the next recorded step ticks "Do you agree?*" and the run is not failed`, () => {
    assert.equal(r.checked, true, `checked=${r.checked}`);
    assert.equal(r.ok, true, r.message.slice(0, 200));
    assert.doesNotMatch(r.message, /Timeout \d+ms/);
  });
  check(`${p}: ...after the popup's wait, never a 30 s click timeout and reloads`, () => {
    assert.ok(r.ms >= 6000 && r.ms < 25000, `${r.ms} ms`);
  });
}

// -------------------------------------------------------------------------------------------
console.log("\n[2] MUST KEEP: a showing popup's OK is clicked as recorded");
for (const p of ["/popupshown", "/popuplate", "/popupslow"]) {
  const r = await run(p, [OK_STEP, AGREE_STEP] as RecipeStep[]);
  check(`${p}: the showing popup's OK is clicked, not skipped, and the run goes on`, () => {
    assert.deepEqual(r.hits, ["uploadErrorPopupOk"], JSON.stringify(r.hits));
    assert.ok(!r.skipped.some((s) => /advance: OK/.test(s)), JSON.stringify(r.skipped));
    assert.equal(r.checked, true, `checked=${r.checked}`);
    assert.equal(r.ok, true, r.message.slice(0, 200));
  });
}
{
  const r = await run("/popupother", [OK_STEP, AGREE_STEP] as RecipeStep[]);
  check("/popupother: a dialog up under markup the recording did not name goes main's way — its \"Ok\" found by name and clicked", () => {
    assert.deepEqual(r.hits, ["altOk"], JSON.stringify(r.hits));
    assert.ok(!r.skipped.some((s) => /advance: OK/.test(s)), JSON.stringify(r.skipped));
    assert.equal(r.ok, true, r.message.slice(0, 200));
  });
  check("/popupother: ...at once — no wait main did not pay", () => {
    assert.ok(r.ms < 5000, `${r.ms} ms`);
  });
}
{
  const r = await run("/submitgate", [
    { action: "click", phase: "fill", selector: { role: "button", name: "OK", exact: true, fallbacks: [{ css: "#submitPopupOk" }] }, note: "submit: OK" },
  ] as RecipeStep[]);
  check("/submitgate: a dismissal whose words the submit gate refuses keeps main's path to that gate — nothing clicked, no wait, no dismissal note", () => {
    assert.deepEqual(r.hits, [], JSON.stringify(r.hits));
    assert.ok(r.skipped.some((s) => /submit: OK/.test(s)), JSON.stringify(r.skipped));
    assert.ok(!r.aging.some((a) => /not showing on this run/.test(a)), JSON.stringify(r.aging));
    assert.ok(r.ms < 5000, `${r.ms} ms`);
  });
}

// -------------------------------------------------------------------------------------------
console.log("\n[3] the name rescue and the closed-menu reveal match whole words");
{
  const r = await resolveOnly("/wholeword", { action: "click", phase: "fill", selector: { role: "button", name: "Search", exact: true }, note: "lookup: Search" } as RecipeStep);
  check("/wholeword: MUST EXCLUDE — 'Research' (the shorter label, a fragment) is not the rescue's pick", () => {
    assert.notEqual(r.id, "research");
  });
  check("/wholeword: MUST PASS — 'Search Records' (the whole word) is", () => {
    assert.equal(r.id, "searchRecords");
  });
}
{
  const r = await resolveOnly("/bookok", { action: "click", phase: "fill", selector: { role: "button", name: "OK", exact: true }, note: "lookup: OK" } as RecipeStep);
  check("/bookok: THE REGRESSION — 'OK' never resolves to 'Book an Inspection', 'Lookup' or 'Bookmarks'", () => {
    assert.ok(!["bookInspection", "lookup", "bookmarks"].includes(r.id), `resolved #${r.id}`);
  });
}
{
  const r = await resolveOnly("/researchmenu", { action: "click", phase: "fill", selector: { role: "button", name: "Search", exact: true }, note: "lookup: Search" } as RecipeStep);
  check("/researchmenu: MUST EXCLUDE — the reveal never takes a 'Research' menu for 'Search': no entry picked, the menu never hovered open", () => {
    assert.ok(r.id !== "researchEntry" && r.id !== "researchBtn", `resolved #${r.id}`);
    assert.equal(r.menuOpen, false);
  });
}
{
  // "Login" first, so its must-keep is measured even when the glued-ligature step fails after it.
  const r = await run("/trail", [
    { action: "click", phase: "fill", selector: { role: "button", name: "Login", exact: true }, note: "contacts: Login" },
    { action: "click", phase: "fill", selector: { role: "button", name: "Next", exact: true }, note: "contacts: Next" },
  ] as RecipeStep[]);
  check("/trail: MUST KEEP — 'Log<span>in</span>' still reads 'Login' and is the stand-in", () => {
    assert.ok(r.hits.includes("loginLink"), JSON.stringify(r.hits));
  });
  check("/trail: MUST KEEP — a ligature glued AFTER the label: 'Nextarrow_forward' still reads 'Next' and is the stand-in", () => {
    assert.ok(r.hits.includes("realNext"), JSON.stringify(r.hits));
  });
}

// -------------------------------------------------------------------------------------------
console.log("\n[4] MUST KEEP: Oregon ePermitting's 'check_circleApply', and 'Apply Now'");
{
  // The live recipe's shape: the recorded text (exact) matches only the disabled pill, and the
  // role=link fallback (exact) cannot match the ligature-polluted name — only the rescue reaches it.
  const r = await run("/ligature", [
    { action: "click", phase: "open", selector: { text: "Apply", exact: true, fallbacks: [{ role: "link", name: "Apply", exact: true }] }, note: "application entry: Apply" },
  ] as RecipeStep[]);
  check("/ligature: 'Apply' reaches 'check_circleApply' after the ligature strip, never the disabled pill", () => {
    assert.deepEqual(r.hits, ["real"], JSON.stringify(r.hits));
    assert.equal(r.ok, true, r.message.slice(0, 200));
  });
  const n = await run("/applynow", [
    { action: "click", phase: "open", selector: { role: "button", name: "Apply", exact: true }, note: "application entry: Apply" },
  ] as RecipeStep[]);
  check("/applynow: 'Apply' reaches 'Apply Now' (whole word inside a longer label)", () => {
    assert.deepEqual(n.hits, ["applyNow"], JSON.stringify(n.hits));
    assert.equal(n.ok, true, n.message.slice(0, 200));
  });
}

// -------------------------------------------------------------------------------------------
console.log("\n[5] MUST KEEP: a control hidden then shown is clicked as on main");
{
  const r = await run("/lateshown", [
    // A bare "Close" with no recorded popup handle is not a dismissal step: main's path.
    { action: "click", phase: "fill", selector: { role: "button", name: "Close", exact: true }, note: "human-patch: Close" },
    { action: "click", phase: "fill", selector: { role: "button", name: "Next", exact: true, fallbacks: [{ css: "#nextBtn" }] }, note: "advance: Next" },
  ] as RecipeStep[]);
  // (The page dismisser also clicks a visible "Close" before later clicks — main's behaviour, so the
  // Close may be hit more than once; what is pinned is that neither step is skipped.)
  check("/lateshown: the bare Close and the ordinary Next, shown at 1.5 s, are both clicked, neither skipped, and the run completes", () => {
    assert.ok(r.hits.includes("closeBtn") && r.hits.includes("nextBtn"), JSON.stringify(r.hits));
    assert.ok(r.hits.indexOf("closeBtn") < r.hits.indexOf("nextBtn"), JSON.stringify(r.hits));
    assert.ok(!r.skipped.length, JSON.stringify(r.skipped));
    assert.equal(r.ok, true, r.message.slice(0, 200));
  });
  check("/lateshown: ...and nothing says it was a dismissal", () => {
    assert.ok(!r.aging.some((a) => /not showing on this run/.test(a)), JSON.stringify(r.aging));
  });
}

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} rescue/dismissal check(s) FAILED.`); process.exit(1); }
console.log("\nAll rescue/dismissal checks passed (real Chromium).");
process.exit(0);
