// STEPS THAT BELONGED TO THE LEARN'S PAGE STATE, NOT THE APPLICATION (#237), IN REAL CHROMIUM.
//
// The 2026-11-14 audit of all 22 saved recipes found four shapes of a recorded step that only made
// sense on the page the LEARN saw, each run-fatal or minutes-long at replay:
//   A. PGE b16d667e 68-72 — five hand-patched "Next page" clicks on #HeaderNextBtn, a title-strip
//      pager PowerClerk hides with Bootstrap's .invisible on the review page. main: locator.click
//      timed out at 30 s, the run FAILED after ~6 min with no staged hand-off (snapReplay.audit).
//   B. Tigard 92c16d00 4 and 10 — selects on controls the portal had already answered and disabled:
//      ~38 s each, then a false SKIPPED "landed nothing" (audit p4).
//   C. Bend 8bbd9a74 22 — the learn's upload-error popup "OK": no popup at replay, and the name
//      rescue clicked "Book an Inspection" (audit p6).
//   D. PacifiCorp 102/111/112, Ameren 25 — controls the learn saw only after a reveal; absent on a
//      job whose answers do not reveal them.
// Synthetic pages in those shapes (no real names, addresses or ids beyond the control shapes).
//
// MUST-PASS: A reaches the review stop with the five clicks skipped, named, never clicked into a
//   timeout (A2: on a last page whose words do not say review, by the recipe's own review tail); B
//   verifies the agreeing answer and names the differing one, each within seconds; C skips the
//   absent "OK" and never clicks "Book an Inspection"; D skips the absent conditional control and
//   still fills what follows; G skips a mid-flow non-advancing click left on a hidden control.
// MUST-EXCLUDE: a hidden control that SHOWS within the grace is clicked, not skipped (E); an
//   ENABLED select is written as before, never judged "answered by the portal" (B2); a conditional
//   switch whose real box is concealed inside a visible label is written, not skipped (F).
//
// Run: npx tsx portal-bot/src/adapters/learnStateSteps.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Browser } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const shell = (body: string, script = ""): string => `<!doctype html><html><head><title>Application</title>
<style>body{font:14px sans-serif;padding:16px} .invisible{visibility:hidden !important} .title-strip{display:flex;gap:12px;align-items:center}</style>
</head><body>${body}<script>${script}</script></body></html>`;

// A — PowerClerk's review page: the title strip's pager carries .invisible (there is no next page).
const REVIEW = shell(`
  <div class="title-strip">
    <button id="HeaderPrevBtn" class="btn" type="button">Previous page</button>
    <span class="page-title">Interconnection Application</span>
    <button id="HeaderNextBtn" class="btn invisible" type="button">Next page</button>
  </div>
  <h2>Review and Submit</h2>
  <p>Please review your application before submitting. Account holder: Pat Example.</p>
  <button id="submitApp" type="button">Submit Application</button>`);

// A2 — the same pager on a last page whose words do NOT name it the review step (the shared review
// reading cannot tell): the recipe's own shape says it — nothing after these clicks writes anything
// before the review stop.
const SUMMARY = shell(`
  <div class="title-strip">
    <button id="HeaderPrevBtn" class="btn" type="button">Previous page</button>
    <span class="page-title">Interconnection Application</span>
    <button id="HeaderNextBtn" class="btn invisible" type="button">Next page</button>
  </div>
  <h2>Application Summary</h2>
  <p>System size 7.6 kW. Account holder: Pat Example.</p>`);

// B — the portal answered two selects (and a box) itself and disabled them; one select is live.
const ANSWERED = shell(`
  <h2>Location</h2>
  <label for="juris">Jurisdiction</label>
  <select id="juris" disabled><option value="">-- Select --</option><option value="TIG" selected>City of Exampleton</option><option value="CO">Example County</option></select>
  <label for="ptype">Permit Type</label>
  <select id="ptype" disabled><option value="">-- Select --</option><option value="R" selected>Residential</option><option value="C">Commercial</option></select>
  <label for="parcel">Parcel</label><input id="parcel" value="R0001234" disabled>
  <label for="scope">Scope of Work</label>
  <select id="scope"><option value="">-- Select --</option><option value="PV">Solar PV</option><option value="ESS">Battery</option></select>`);

// C — no popup is open; the page's own navigation carries a link whose text CONTAINS "ok".
const NO_POPUP = shell(`
  <nav><a href="/inspections" id="bookLink">Book an Inspection</a> <a href="/lookup">Lookup</a></nav>
  <h2>Attachments</h2>
  <label for="desc">Description</label><input id="desc">`);

// D — a job whose answers revealed nothing: the battery inverter block is not rendered at all.
const NO_REVEAL = shell(`
  <h2>Energy Storage</h2>
  <label for="ess">Energy storage included?</label>
  <select id="ess"><option value="">-- Select --</option><option>Yes</option><option selected>No</option></select>
  <div id="battBlock"></div>
  <label for="kw">Total System Export (kW)</label><input id="kw">`);

// E — a control that is hidden for a moment and then shown (still rendering): clicked, not skipped.
const LATE_SHOW = shell(`
  <h2>Contacts</h2>
  <button id="showMore" class="invisible" type="button">Show Details</button>
  <div id="rows"></div>`, `
  setTimeout(function () { document.getElementById('showMore').classList.remove('invisible'); }, 900);
  document.getElementById('showMore').addEventListener('click', function () {
    document.getElementById('rows').innerHTML = '<label for="c1">Description of Work</label><input id="c1">';
  });`);

// F — a revealed styled switch: its real <input> is 0x0 and transparent inside a visible label (the
// common slider shape). Its widget IS up, so a conditional check on it is written, never skipped.
const SWITCH = shell(`
  <h2>Monitoring</h2>
  <style>.switch input{opacity:0;width:0;height:0;position:absolute} .slider{display:inline-block;width:40px;height:20px;background:#ccc}</style>
  <label class="switch" for="mon"><input type="checkbox" id="mon"><span class="slider"></span> Remote monitoring</label>`);

// G — a mid-flow page whose in-page toggle is hidden for good on this job (the learn's page showed
// it): a non-advancing click resolution can only leave on a hidden control, with a write after it.
const HIDDEN_TOGGLE = shell(`
  <h2>Project Details</h2>
  <button id="toggleHelp" class="btn invisible" type="button">Show Help</button>
  <label for="notes">Notes to the utility</label><input id="notes">`);

const PAGES: Record<string, string> = { "/switch": SWITCH, "/hiddentoggle": HIDDEN_TOGGLE, "/review": REVIEW, "/summary": SUMMARY, "/answered": ANSWERED, "/nopopup": NO_POPUP, "/noreveal": NO_REVEAL, "/lateshow": LATE_SHOW };
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGES[url.pathname] ?? shell(`<h1>Book an Inspection</h1><p>You left the application.</p>`));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const recipeOf = (id: string, p: string, steps: RecipeStep[]): PortalRecipe => ({
  id, scopeType: "utility", profileKey: "xx|example|", state: "OR", ahj: "", utility: "Example Utility",
  portalPlatform: "fixture", portalUrl: `${base}${p}`, status: "complete", version: 1, createdBy: "s", createdAt: "", updatedAt: "", notes: "", discipline: "",
  steps: [{ action: "goto", value: `${base}${p}`, note: "open" } as RecipeStep, ...steps],
} as unknown as PortalRecipe);

type Run = { ok: boolean; message: string; ms: number; skipped: string[]; aging: string[]; drift: string[]; verified: string[]; trace: Array<{ i: number; outcome: string; note: string }>; url: string; values: Record<string, string> };
const run = async (browser: Browser, recipe: PortalRecipe, fieldValues: Record<string, string> = {}): Promise<Run> => {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const pg = await ctx.newPage();
  const adapter = new RecipeAdapter(recipe, fieldValues, {}, { autoSubmit: false } as never);
  (adapter as unknown as { page: unknown }).page = pg;
  const t0 = Date.now();
  const r = await adapter.fillApplication({} as ProjectRecord).catch((e) => ({ ok: false, message: String(e) })) as { ok: boolean; message?: string; data?: Record<string, unknown> };
  const ms = Date.now() - t0;
  const values = await pg.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll("input, select")).map((el) => [el.id, (el as HTMLInputElement).value]))).catch(() => ({} as Record<string, string>));
  const url = pg.url();
  await ctx.close();
  const d = (r.data ?? {}) as Record<string, unknown>;
  return {
    ok: r.ok === true, message: String(r.message ?? ""), ms, url, values,
    skipped: (d.skipped as string[]) ?? [], aging: (d.agingNotes as string[]) ?? [], drift: (d.driftWarnings as string[]) ?? [],
    verified: (d.fieldsVerified as string[]) ?? [], trace: (d.trace as Run["trace"]) ?? [],
  };
};
const tail = (r: Run): string => `ok=${r.ok} ${Math.round(r.ms / 1000)}s msg=${r.message.slice(0, 160)} | skipped=${JSON.stringify(r.skipped).slice(0, 200)} | aging=${JSON.stringify(r.aging).slice(0, 400)} | drift=${JSON.stringify(r.drift).slice(0, 300)}`;

const browser = await chromium.launch();
try {
  // ---- A: the PGE header pager on the review page ------------------------------------------------
  const pager = (): RecipeStep => ({ action: "click", note: "human-patch: Next page", selector: { css: "#HeaderNextBtn", fallbacks: [{ role: "button", name: "Next page" }] } } as RecipeStep);
  const a = await run(browser, recipeOf("learnstate-a", "/review", [
    pager(), pager(), pager(), pager(), pager(),
    { action: "stopForReview", note: "review" } as RecipeStep,
    { action: "click", note: "final submit: Submit Application", isFinalSubmit: true, selector: { css: "#submitApp" } } as RecipeStep,
  ]));
  console.log(`   A ${tail(a)}`);
  check("A MUST-PASS the run reaches the review stop (ok) instead of FAILING on the hidden pager", a.ok, tail(a));
  check("A MUST-PASS ...each of the five pager clicks is skipped, named as hidden on the review page",
    a.aging.filter((n) => /Next page/.test(n) && /review page/i.test(n) && /#237/.test(n)).length === 5, JSON.stringify(a.aging));
  check("A MUST-PASS ...never clicked into a 30 s timeout (whole run well under one click timeout)", a.ms < 30_000, `${a.ms} ms`);
  check("A ...and the final submit is not clicked (the review stop is the hand-off)", !a.trace.some((t) => /final submit/i.test(t.note) && t.outcome === "ok"), JSON.stringify(a.trace));

  const a2 = await run(browser, recipeOf("learnstate-a2", "/summary", [
    pager(), pager(), pager(), pager(), pager(),
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]));
  console.log(`   A2 ${tail(a2)}`);
  check("A2 MUST-PASS in the recipe's review tail (no write before the stop) the hidden pager clicks are skipped and the stop is reached",
    a2.ok && a2.aging.filter((n) => /Next page/.test(n) && /#237/.test(n)).length === 5, tail(a2));
  check("A2 MUST-PASS ...without a click timeout", a2.ms < 30_000, `${a2.ms} ms`);

  // ---- B: selects the portal already answered and disabled --------------------------------------
  const b = await run(browser, recipeOf("learnstate-b", "/answered", [
    { action: "select", note: "Jurisdiction", value: "City of Exampleton", selector: { css: "#juris", fallbacks: [{ label: "Jurisdiction" }] } } as RecipeStep,
    { action: "select", note: "Permit Type", value: "Commercial", selector: { css: "#ptype", fallbacks: [{ label: "Permit Type" }] } } as RecipeStep,
    { action: "fill", note: "Parcel", field: "parcelNumber", selector: { css: "#parcel", fallbacks: [{ label: "Parcel" }] } } as RecipeStep,
    { action: "select", note: "Scope of Work", value: "Solar PV", selector: { css: "#scope", fallbacks: [{ label: "Scope of Work" }] } } as RecipeStep,
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]), { parcelNumber: "R0001234" });
  console.log(`   B ${tail(b)}`);
  check("B MUST-PASS the agreeing disabled select is VERIFIED (not a false SKIPPED)", b.verified.includes("Jurisdiction") && !b.skipped.some((s) => /Jurisdiction/.test(s)), tail(b));
  check("B MUST-PASS ...named as answered by the portal", b.aging.some((n) => /Jurisdiction/.test(n) && /answered by the portal/i.test(n)), JSON.stringify(b.aging));
  check("B MUST-PASS the differing disabled select is a NAMED drift (portal's answer vs this job's), not 'landed nothing'",
    b.drift.some((w) => /Permit Type/.test(w) && /answered by the portal/i.test(w)) && !b.drift.some((w) => /Permit Type.*landed nothing/.test(w)), JSON.stringify(b.drift));
  check("B MUST-PASS the agreeing disabled box is verified too", b.verified.includes("Parcel"), tail(b));
  check("B MUST-PASS no 38 s select timeouts — the whole page in well under one select's old cost", b.ms < 20_000, `${b.ms} ms`);
  check("B2 MUST-EXCLUDE the ENABLED select is written as before", b.values.scope === "PV" && b.verified.includes("Scope of Work"), JSON.stringify(b.values));
  check("B ...and nothing typed into the portal's answers", b.values.juris === "TIG" && b.values.ptype === "R" && b.values.parcel === "R0001234", JSON.stringify(b.values));

  // ---- C: the learn's popup "OK", no popup at replay ---------------------------------------------
  const c = await run(browser, recipeOf("learnstate-c", "/nopopup", [
    { action: "click", note: "human-patch: OK", selector: { role: "button", name: "OK" } } as RecipeStep,
    { action: "fill", note: "Description", field: "workDescription", selector: { css: "#desc", fallbacks: [{ label: "Description" }] } } as RecipeStep,
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]), { workDescription: "Rooftop solar" });
  console.log(`   C ${tail(c)}`);
  check("C MUST-PASS the absent popup's OK is skipped as not applicable, named", c.aging.some((n) => /"OK"/.test(n) && /not applicable/i.test(n) && /#237/.test(n)), JSON.stringify(c.aging));
  // The name rescue takes the SHORTEST label containing "ok" — "Lookup" here, "Book an Inspection"
  // live. Either way the page is left; the application's own URL must still be the one shown.
  check("C MUST-PASS ...and no navigation link is clicked in its place (still on the application)", new URL(c.url).pathname === "/nopopup", c.url);
  check("C MUST-PASS ...the run carries on: the next step fills and the review stop is reached", c.ok && c.values.desc === "Rooftop solar", tail(c));

  // ---- D: a control the learn saw only after a reveal --------------------------------------------
  const d = await run(browser, recipeOf("learnstate-d", "/noreveal", [
    { action: "select", note: "Battery Inverter Manufacturer", value: "Example Power", conditional: true, selector: { css: "#battMake", fallbacks: [{ label: "Battery Inverter Manufacturer" }] } } as RecipeStep,
    { action: "fill", note: "Total System Export (kW)", field: "exportKw", selector: { css: "#kw", fallbacks: [{ label: "Total System Export (kW)" }] } } as RecipeStep,
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]), { exportKw: "7.6" });
  console.log(`   D ${tail(d)}`);
  check("D MUST-PASS the absent conditional control is skipped, named as not revealed on this job",
    d.aging.some((n) => /Battery Inverter Manufacturer/.test(n) && /reveal/i.test(n) && /#237/.test(n)), JSON.stringify(d.aging));
  check("D MUST-PASS ...the run carries on to the next fill and the review stop", d.ok && d.values.kw === "7.6", tail(d));

  // ---- E: hidden for a moment, then shown: clicked, never skipped --------------------------------
  const e = await run(browser, recipeOf("learnstate-e", "/lateshow", [
    { action: "click", note: "human-patch: Show Details", selector: { css: "#showMore" } } as RecipeStep,
    { action: "fill", note: "Description of Work", field: "workDescription", selector: { css: "#c1", fallbacks: [{ label: "Description of Work" }] } } as RecipeStep,
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]), { workDescription: "Rooftop solar" });
  console.log(`   E ${tail(e)}`);
  check("E MUST-EXCLUDE a control that shows within the grace is CLICKED (the box it reveals is filled)", e.ok && e.values.c1 === "Rooftop solar" && !e.aging.some((n) => /#237/.test(n)), tail(e));

  // ---- F: a conditional styled switch whose real box is concealed inside a visible label ----------
  const f = await run(browser, recipeOf("learnstate-f", "/switch", [
    { action: "check", note: "Remote monitoring", conditional: true, selector: { css: "#mon", fallbacks: [{ label: "Remote monitoring" }] } } as RecipeStep,
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]));
  console.log(`   F ${tail(f)}`);

  // ---- G: a non-advancing click left on a hidden control, mid-flow (a write follows) --------------
  const g = await run(browser, recipeOf("learnstate-g", "/hiddentoggle", [
    { action: "click", note: "human-patch: Show Help", selector: { css: "#toggleHelp", fallbacks: [{ role: "button", name: "Show Help" }] } } as RecipeStep,
    { action: "fill", note: "Notes to the utility", field: "workDescription", selector: { css: "#notes", fallbacks: [{ label: "Notes to the utility" }] } } as RecipeStep,
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]), { workDescription: "Rooftop solar" });
  console.log(`   G ${tail(g)}`);
  check("G MUST-PASS a non-advancing click resolution leaves on a hidden control is skipped, named", g.aging.some((n) => /Show Help/.test(n) && /hidden/i.test(n) && /#237/.test(n)), JSON.stringify(g.aging));
  check("G MUST-PASS ...never clicked into a timeout: the next write lands and the stop is reached quickly", g.ok && g.values.notes === "Rooftop solar" && g.ms < 30_000, tail(g));
  check("F MUST-EXCLUDE a conditional switch whose widget is up is never skipped as 'not revealed'", !f.aging.some((n) => /#237/.test(n)) && !f.skipped.some((s) => /Remote monitoring/.test(s)), tail(f));
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} learn-state check(s) FAILED.`); process.exit(1); }
console.log("\nAll learn-state checks passed (real Chromium).");
process.exit(0);
