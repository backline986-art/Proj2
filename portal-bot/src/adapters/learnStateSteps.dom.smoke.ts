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
// Synthetic pages in those shapes; the recorded steps copy the saved recipes' selector shapes
// (recipes241/), never their values.
//
// MUST-PASS: A reaches the review hand-off with the five clicks skipped, named, never clicked into a
//   timeout (A2: on a last page whose words do not say review, by the recipe's own review tail; A3:
//   a write follows, so the page's own review reading decides); B verifies the agreeing answer and
//   names the differing one, each within seconds (B3: the disabled box); C skips the "OK" of a popup
//   that is hidden (C) or not there (C2) and never clicks "Book an Inspection"; D skips the absent
//   conditional control and still fills what follows; G skips a mid-flow non-advancing click left on
//   a hidden control; H / H2 skip conditional controls on PowerClerk's shape (a generic test hook
//   on every box) without writing their value into another box; K3 still skips a conditional
//   control that only its unique test id names when it is truly absent.
// MUST-PASS (re-review of #237; MUST-EXCLUDE of the fix round's skip): a revealed conditional
//   control findable ONLY through its unique data-testid / data-test / data-cy / data-qa (a drifted
//   label, a per-render id) is written on the job that reveals it (K1), and so is a revealed checkbox
//   that only a neighbouring div labels (K2). The fix round judged both "absent" and skipped them.
// MUST-EXCLUDE: a hidden control that SHOWS within the grace is clicked, not skipped (E); an
//   ENABLED select is written as before, never judged "answered by the portal" (B2); a conditional
//   switch whose real box is concealed inside a visible label is written, not skipped (F); a revealed
//   PowerClerk block is written (H3); a select or box the portal disables for 3 s WHILE IT WORKS,
//   keeping its old value meanwhile, is busy — written with the job's value as on main (I, I2); a
//   review-tail hand patch the name rescue can land (a "Continue" rendered as a link) is clicked
//   (A4); a control or popup OK that a 4 s round-trip of the portal's own reveals is acted on, as
//   main's 10 s wait did (J, J2 — J2 is the shape no other wait in the engine absorbs).
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
// A3 writes the reviewer note box after its pager clicks, so only the page's own review reading
// licenses the skip there.
const REVIEW = shell(`
  <div class="title-strip">
    <button id="HeaderPrevBtn" class="btn" type="button">Previous page</button>
    <span class="page-title">Interconnection Application</span>
    <button id="HeaderNextBtn" class="btn invisible" type="button">Next page</button>
  </div>
  <h2>Review and Submit</h2>
  <p>Please review your application before submitting. Account holder: Pat Example.</p>
  <label for="revNote">Note to the reviewer</label><input id="revNote">
  <button id="SubmitButton" type="button">Submit</button>`);

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

// B — EnerGov's shape (Tigard 4 and 10: a label primary, an #id fallback, an aria-label on the
// select): the portal answered two selects itself and disabled them; the live select comes FIRST, so
// its must-exclude is read before anything else on the page can stop the run. B3 is the disabled box,
// in a run of its own (a fill on a disabled box is run-fatal on main, which would mask B).
const ANSWERED = shell(`
  <h2>Location</h2>
  <label for="scope">Scope of Work</label>
  <select id="scope" aria-label="Scope of Work"><option value="">-- Select --</option><option value="PV">Solar PV</option><option value="ESS">Battery</option></select>
  <label for="juris">Jurisdiction</label>
  <select id="juris" aria-label="Jurisdiction" disabled><option value="">-- Select --</option><option value="TIG" selected>City of Exampleton</option><option value="CO">Example County</option></select>
  <label for="ptype">Permit Type</label>
  <select id="ptype" aria-label="Permit Type" disabled><option value="">-- Select --</option><option value="R" selected>Residential</option><option value="C">Commercial</option></select>`);
const ANSWERED_BOX = shell(`
  <h2>Location</h2>
  <label for="parcel">Parcel</label><input id="parcel" aria-label="Parcel" value="R0001234" disabled>`);

// C — Bend's shape: the upload-error popup sits in the DOM, display:none (C), or is not there at all
// (C2); the page's own header carries a control whose text CONTAINS "ok".
const popupPage = (popup: boolean): string => shell(`
  <nav><a href="/inspections" id="bookLink">Book an Inspection</a> <a href="/lookup">Lookup</a></nav>
  ${popup ? `<div id="uploadErrorPopup" role="dialog" style="display:none"><p>The file could not be uploaded.</p><button id="uploadErrorPopupOk" type="button">OK</button></div>` : ""}
  <h2>Attachments</h2>
  <label for="desc">Description</label><input id="desc">`);
const NO_POPUP = popupPage(false);
const HIDDEN_POPUP = popupPage(true);

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

// H — PowerClerk's shape of D: EVERY input carries the platform's generic test hook
// data-test-role="textbox-element", and the learner records that hook as a fallback on each data step
// (PacifiCorp 32f3d2b2 111/112: label, then #...Input, then the bare hook). PowerClerk's ids are
// random, and one in four starts with a digit — 112's "#865S27BYAFHZInput" is not a valid CSS selector
// at all, so its id level can never match (the model below copies that shape). The battery inverter
// block is display:none (H) or not rendered (H2) on a job whose answers did not reveal it; H3 shows it.
const pcBlock = (style: string): string => style === "absent" ? "" : `<div id="battInv" style="${style}">
    <label for="BI7MAKE0001Input">Battery Inverter Manufacturer</label><input id="BI7MAKE0001Input" data-test-role="textbox-element">
    <label for="8Q7MODL0002Input">Battery Inverter Model</label><input id="8Q7MODL0002Input" data-test-role="textbox-element"></div>`;
const PC_COND = (style: string): string => shell(`
  <h2>Inverter Clone System</h2>
  <label for="NB7BATT0003Input">Number of Batteries</label><input id="NB7BATT0003Input" data-test-role="textbox-element" value="1">
  ${pcBlock(style)}
  <label for="BD7DISC0004Input">Battery Disconnect Manufacturer</label><input id="BD7DISC0004Input" data-test-role="textbox-element" value="DisconnectCo">
  <label for="IQ7QNTY0005Input">Inverter Quantity</label><input id="IQ7QNTY0005Input" data-test-role="textbox-element">`);

// I — a control the portal disables WHILE IT WORKS, keeping its old value meanwhile (an Angular
// control.disable(), a default such as "New Construction" or "0"): answering the previous control
// locks it for 3 s, then it enables. It is busy, not answered — the job's value must be written.
const busy = (lockId: string, body: string, triggerId: string): string => shell(`<h2>Work</h2>${body}`, `
  document.getElementById('${triggerId}').addEventListener('change', function () {
    var c = document.getElementById('${lockId}');
    c.disabled = true;
    setTimeout(function () { c.disabled = false; }, 3000);
  });`);
const BUSY_SELECT = busy("ctype", `
  <label for="wclass">Work Class</label>
  <select id="wclass"><option value="">-- Select --</option><option value="PV">Solar PV</option><option value="RR">Re-roof</option></select>
  <label for="ctype">Construction Type</label>
  <select id="ctype"><option value="">-- Select --</option><option value="N" selected>New Construction</option><option value="A">Alteration</option></select>`, "wclass");
const BUSY_BOX = busy("val", `
  <label for="pkind">Permit Kind</label>
  <select id="pkind"><option value="">-- Select --</option><option value="RES">Residential</option><option value="COM">Commercial</option></select>
  <label for="val">Valuation</label><input id="val" value="0">`, "pkind");

// A4 — the hand-patched "Continue" (recorded as a button) is rendered as a LINK styled as a button
// on this run; the name rescue lands it, as on main, so it is never skipped as learn state.
const LINK_CONTINUE = shell(`
  <h2>Step 3 of 4: Contact</h2>
  <label for="email">Contact Email</label><input id="email">
  <a class="btn" href="/review2">Continue</a>`);
const REVIEW2 = shell(`<h2>Review and Submit</h2><p>Please review your application before submitting.</p>`);

// J — a reveal that waits on the portal's own 4 s round-trip: Energy Source answered, the inverter
// make select is rendered when the request returns (well after a fixed 2.5 s grace). Reached from an
// entry page through an advance, as a reveal is in a real run (the run's settle probe is on the page
// from its first byte, so the portal's request is seen).
const SLOW_ENTRY = shell(`
  <h2>Project</h2>
  <label for="proj">Project Name</label><input id="proj">
  <button id="toEquip" type="button" onclick="location.href='/slowreveal'">Next</button>`);
const SLOW_REVEAL = shell(`
  <h2>Equipment</h2>
  <label for="esrc">Energy Source</label>
  <select id="esrc"><option value="">-- Select --</option><option value="PV">Solar PV</option><option value="W">Wind</option></select>
  <div id="makeHost"></div>`, `
  document.getElementById('esrc').addEventListener('change', function () {
    fetch('/slow').then(function () {
      document.getElementById('makeHost').innerHTML = '<label for="make">Inverter Manufacturer</label>'
        + '<select id="make"><option value="">-- Select --</option><option value="EP">Example Power</option><option value="OT">Other</option></select>';
    });
  });`);

// J2 — an in-page "Validate Address" click whose answer is a modal OK after the portal's own 4 s
// round-trip. A click waits only for controls to mount (not for the page to settle), so the OK step
// arrives while the request is in flight.
const VERIFY = shell(`
  <h2>Location</h2>
  <button id="validate" type="button">Validate Address</button>
  <div id="verifyModal" role="dialog" style="display:none"><p>Address verified.</p><button id="verifyOk" type="button">OK</button></div>
  <label for="desc2">Description</label><input id="desc2"><input type="hidden" id="okClicked" value="">`, `
  document.getElementById('validate').addEventListener('click', function () {
    fetch('/slow').then(function () { document.getElementById('verifyModal').style.display = 'block'; });
  });
  document.getElementById('verifyOk').addEventListener('click', function () {
    document.getElementById('verifyModal').style.display = 'none';
    document.getElementById('okClicked').value = '1';
  });`);
const VERIFY_ENTRY = SLOW_ENTRY.replace("/slowreveal", "/verify");

// K: a revealed control that ONLY its unique test hook can find (re-review of #237, rrProbe K1/K2).
// K1: the portal renamed the label since the learn ("Make" to "Manufacturer"), and its framework ids
// are per-render (#mui-12 recorded, #mui-31 now). The test hook is the stable level the learner
// recorded for exactly this drift. K2: a checkbox that a NEIGHBOURING div labels (no <label>, no id):
// getByLabel can never resolve it, and its data-testid always can. `revealed` false: this job's answers
// revealed nothing, and the block is not rendered (K3).
const testHookPage = (attr: string, revealed: boolean): string => shell(`
  <h2>Energy Storage</h2>
  <label for="ess">Energy storage included?</label>
  <select id="ess"><option value="">--</option><option${revealed ? " selected" : ""}>Yes</option><option${revealed ? "" : " selected"}>No</option></select>
  <div id="battBlock">${revealed ? `<label for="mui-31">Battery Inverter Manufacturer</label><input id="mui-31" ${attr}="battery-inverter-make">` : ""}</div>
  <label for="kw">Total System Export (kW)</label><input id="kw">`);
const neighbourCheckPage = (revealed: boolean): string => shell(`
  <h2>Energy Storage</h2>
  ${revealed ? `<div class="row"><div class="chk"><input type="checkbox" data-testid="battery-dc-coupled"></div><div class="lbl">Battery is DC coupled</div></div>` : ""}
  <label for="kw">Total System Export (kW)</label><input id="kw">`);
const TEST_HOOK_ATTRS = ["data-testid", "data-test", "data-cy", "data-qa"] as const;
const K_PAGES: Record<string, string> = {
  ...Object.fromEntries(TEST_HOOK_ATTRS.map((a) => [`/k1/${a}`, testHookPage(a, true)])),
  "/k1none": testHookPage("data-testid", false), "/k2": neighbourCheckPage(true), "/k2none": neighbourCheckPage(false),
};

const PAGES: Record<string, string> = { ...K_PAGES, "/verifyentry": VERIFY_ENTRY, "/verify": VERIFY, "/busyselect": BUSY_SELECT, "/busybox": BUSY_BOX, "/linkcontinue": LINK_CONTINUE, "/review2": REVIEW2, "/slowentry": SLOW_ENTRY, "/slowreveal": SLOW_REVEAL, "/switch": SWITCH, "/hiddentoggle": HIDDEN_TOGGLE, "/review": REVIEW, "/summary": SUMMARY, "/answered": ANSWERED, "/answeredbox": ANSWERED_BOX, "/nopopup": NO_POPUP, "/hiddenpopup": HIDDEN_POPUP, "/noreveal": NO_REVEAL, "/lateshow": LATE_SHOW,
  "/pchidden": PC_COND("display:none"), "/pcabsent": PC_COND("absent"), "/pcshown": PC_COND("") };
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  // The portal's own slow round-trip (J): answered after 4 s.
  if (url.pathname === "/slow") { setTimeout(() => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); }, 4000); return; }
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
  // Keyed by id, else the test id (K2's box has no id); a checkbox reads as its checked state.
  const values = await pg.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll("input, select")).map((el) => [
    el.id || el.getAttribute("data-testid") || "",
    (el as HTMLInputElement).type === "checkbox" ? String((el as HTMLInputElement).checked) : (el as HTMLInputElement).value,
  ]))).catch(() => ({} as Record<string, string>));
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

// `npx tsx <this file> A,H` runs only those groups (all by default).
const only = (process.argv[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const want = (k: string): boolean => !only.length || only.includes(k);

const browser = await chromium.launch();
try {
  // ---- A: the PGE header pager on the review page ------------------------------------------------
  if (want("A")) {
  // b16d667e 68-73 as recorded: five role/name-only pager clicks (getByRole leaves a visibility:hidden
  // button out, so they read ABSENT), then the flagged Submit directly — no stopForReview between.
  const pager = (): RecipeStep => ({ action: "click", note: "human-patch: Next page", selector: { role: "button", name: "Next page" } } as RecipeStep);
  // The css-primary shape reads HIDDEN instead (the button is found and is invisible).
  const cssPager = (): RecipeStep => ({ action: "click", note: "human-patch: Next page", selector: { css: "#HeaderNextBtn", fallbacks: [{ role: "button", name: "Next page" }] } } as RecipeStep);
  const finalSubmit = { action: "click", phase: "review", note: "final submit: Submit (recorded, NOT clicked)", isFinalSubmit: true, selector: { role: "button", name: "Submit", exact: true, fallbacks: [{ css: "#SubmitButton" }] } } as RecipeStep;
  const a = await run(browser, recipeOf("learnstate-a", "/review", [pager(), pager(), pager(), pager(), pager(), finalSubmit]));
  console.log(`   A ${tail(a)}`);
  check("A MUST-PASS the run reaches the review hand-off (ok) instead of FAILING on the hidden pager", a.ok, tail(a));
  check("A MUST-PASS ...each of the five pager clicks is skipped, named as hand-patched on the review page",
    a.aging.filter((n) => /Next page/.test(n) && /review page/i.test(n) && /#237/.test(n)).length === 5, JSON.stringify(a.aging));
  check("A MUST-PASS ...never clicked into a 30 s timeout (whole run well under one click timeout)", a.ms < 30_000, `${a.ms} ms`);
  check("A ...and the final submit is not clicked", !a.trace.some((t) => /final submit/i.test(t.note) && t.outcome === "ok"), JSON.stringify(a.trace));

  const a2 = await run(browser, recipeOf("learnstate-a2", "/summary", [
    cssPager(), cssPager(), cssPager(), cssPager(), cssPager(),
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]));
  console.log(`   A2 ${tail(a2)}`);
  check("A2 MUST-PASS in the recipe's review tail (no write before the stop) the hidden pager clicks are skipped and the stop is reached",
    a2.ok && a2.aging.filter((n) => /Next page/.test(n) && /#237/.test(n)).length === 5, tail(a2));
  check("A2 MUST-PASS ...without a click timeout", a2.ms < 30_000, `${a2.ms} ms`);

  // A3 — NOT a review tail (a write follows the clicks): only the page's own review reading licenses it.
  const a3 = await run(browser, recipeOf("learnstate-a3", "/review", [
    cssPager(), cssPager(),
    { action: "fill", note: "Note to the reviewer", field: "workDescription", selector: { label: "Note to the reviewer", fallbacks: [{ css: "#revNote" }] } } as RecipeStep,
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]), { workDescription: "Rooftop solar" });
  console.log(`   A3 ${tail(a3)}`);
  check("A3 MUST-PASS on a page that reads as the review step, hidden hand-patched pager clicks are skipped (the page says review)",
    a3.ok && a3.aging.filter((n) => /Next page/.test(n) && /reads as the review step/.test(n) && /#237/.test(n)).length === 2, tail(a3));
  check("A3 MUST-PASS ...and the write after them lands", a3.values.revNote === "Rooftop solar", JSON.stringify(a3.values));

  // A4 — a review-tail hand patch the name rescue can still land is clicked, never skipped.
  const a4 = await run(browser, recipeOf("learnstate-a4", "/linkcontinue", [
    { action: "fill", note: "Contact Email", field: "contactEmail", selector: { label: "Contact Email", fallbacks: [{ css: "#email" }] } } as RecipeStep,
    { action: "click", note: "human-patch: Continue", selector: { role: "button", name: "Continue" } } as RecipeStep,
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]), { contactEmail: "pat@example.test" });
  console.log(`   A4 ${tail(a4)} path=${new URL(a4.url).pathname}`);
  check("A4 MUST-EXCLUDE a hand-patched Continue rendered as a link is landed by the name rescue (review reached), not skipped",
    new URL(a4.url).pathname === "/review2" && !a4.aging.some((n) => /#237/.test(n)) && !a4.skipped.length, tail(a4) + ` path=${new URL(a4.url).pathname}`);
  }

  // ---- B: selects the portal already answered and disabled --------------------------------------
  if (want("B")) {
  // Tigard 4 / 10 as recorded: the label, then the #id.
  const tig = (note: string, id: string, value: string): RecipeStep => ({ action: "select", phase: "fill", note, value, selector: { label: note, fallbacks: [{ css: `#${id}` }] } } as RecipeStep);
  const b = await run(browser, recipeOf("learnstate-b", "/answered", [
    tig("Scope of Work", "scope", "Solar PV"),
    tig("Jurisdiction", "juris", "City of Exampleton"),
    tig("Permit Type", "ptype", "Commercial"),
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]));
  console.log(`   B ${tail(b)}`);
  check("B2 MUST-EXCLUDE the ENABLED select is written as before", b.values.scope === "PV" && b.verified.includes("Scope of Work"), JSON.stringify(b.values));
  check("B MUST-PASS the agreeing disabled select is VERIFIED (not a false SKIPPED)", b.verified.includes("Jurisdiction") && !b.skipped.some((s) => /Jurisdiction/.test(s)), tail(b));
  // Verified is the whole record: an agingNote on every correct run would read as "worth
  // re-recording", which no re-record can clear (the portal answers it every time).
  check("B MUST-PASS ...and it is quiet: no agingNote for a control that agrees", !b.aging.some((n) => /Jurisdiction/.test(n)), JSON.stringify(b.aging));
  check("B MUST-PASS the differing disabled select is a NAMED drift (portal's answer vs this job's), not 'landed nothing'",
    b.drift.some((w) => /Permit Type/.test(w) && /answered by the portal/i.test(w)) && !b.drift.some((w) => /landed nothing/.test(w)), JSON.stringify(b.drift));
  check("B MUST-PASS no 38 s select timeouts — the whole page in well under one select's old cost", b.ms < 20_000, `${b.ms} ms`);
  check("B ...and nothing typed into the portal's answers", b.values.juris === "TIG" && b.values.ptype === "R", JSON.stringify(b.values));

  const b3 = await run(browser, recipeOf("learnstate-b3", "/answeredbox", [
    { action: "fill", phase: "fill", note: "Parcel", field: "parcelNumber", selector: { label: "Parcel", fallbacks: [{ css: "#parcel" }] } } as RecipeStep,
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]), { parcelNumber: "R0001234" });
  console.log(`   B3 ${tail(b3)}`);
  check("B3 MUST-PASS the agreeing disabled box is verified, nothing typed, no fill timeout", b3.ok && b3.verified.includes("Parcel") && b3.values.parcel === "R0001234" && b3.ms < 20_000, tail(b3));
  }

  // ---- C: the learn's popup "OK", no popup at replay ---------------------------------------------
  if (want("C")) {
  // Bend 22 as recorded: "advance: OK", exact, with the popup's own id as a fallback.
  for (const [key, path] of [["C", "/hiddenpopup"], ["C2", "/nopopup"]] as const) {
    const c = await run(browser, recipeOf(`learnstate-${key.toLowerCase()}`, path, [
      { action: "click", phase: "fill", note: "advance: OK", selector: { role: "button", name: "OK", exact: true, fallbacks: [{ css: "#uploadErrorPopupOk" }] } } as RecipeStep,
      { action: "fill", note: "Description", field: "workDescription", selector: { css: "#desc", fallbacks: [{ label: "Description" }] } } as RecipeStep,
      { action: "stopForReview", note: "review" } as RecipeStep,
    ]), { workDescription: "Rooftop solar" });
    console.log(`   ${key} ${tail(c)}`);
    const where = path === "/hiddenpopup" ? "in the DOM but hidden" : "not on the page";
    check(`${key} MUST-PASS the popup's OK (${where}) is skipped as not applicable, named`, c.aging.some((n) => /"OK"/.test(n) && /not applicable/i.test(n) && /#237/.test(n)), JSON.stringify(c.aging));
    // The name rescue takes the SHORTEST label containing "ok" — "Lookup" here, "Book an Inspection"
    // live. Either way the page is left; the application's own URL must still be the one shown.
    check(`${key} MUST-PASS ...and no navigation link is clicked in its place (still on the application)`, new URL(c.url).pathname === path, c.url);
    check(`${key} MUST-PASS ...the run carries on: the next step fills and the review stop is reached`, c.ok && c.values.desc === "Rooftop solar", tail(c));
  }
  }

  // ---- D: a control the learn saw only after a reveal --------------------------------------------
  if (want("D")) {
  const d = await run(browser, recipeOf("learnstate-d", "/noreveal", [
    { action: "select", note: "Battery Inverter Manufacturer", value: "Example Power", conditional: true, selector: { css: "#battMake", fallbacks: [{ label: "Battery Inverter Manufacturer" }] } } as RecipeStep,
    { action: "fill", note: "Total System Export (kW)", field: "exportKw", selector: { css: "#kw", fallbacks: [{ label: "Total System Export (kW)" }] } } as RecipeStep,
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]), { exportKw: "7.6" });
  console.log(`   D ${tail(d)}`);
  check("D MUST-PASS the absent conditional control is skipped, named as not revealed on this job",
    d.aging.some((n) => /Battery Inverter Manufacturer/.test(n) && /reveal/i.test(n) && /#237/.test(n)), JSON.stringify(d.aging));
  check("D MUST-PASS ...the run carries on to the next fill and the review stop", d.ok && d.values.kw === "7.6", tail(d));
  // skipForNoBattery's convention: the section does not apply to this filing — not a step that
  // failed to land, so never in `skipped` (which scores the run as failed, re-record or not).
  check("D MUST-PASS ...counted as not applicable, never as a step that did not land",
    !d.skipped.some((s) => /Battery Inverter/.test(s)) && /Replayed 3 recorded step/.test(d.message), JSON.stringify(d.skipped) + d.message.slice(0, 80));
  }

  // ---- E: hidden for a moment, then shown: clicked, never skipped --------------------------------
  if (want("E")) {
  const e = await run(browser, recipeOf("learnstate-e", "/lateshow", [
    { action: "click", note: "human-patch: Show Details", selector: { css: "#showMore" } } as RecipeStep,
    { action: "fill", note: "Description of Work", field: "workDescription", selector: { css: "#c1", fallbacks: [{ label: "Description of Work" }] } } as RecipeStep,
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]), { workDescription: "Rooftop solar" });
  console.log(`   E ${tail(e)}`);
  check("E MUST-EXCLUDE a control that shows within the grace is CLICKED (the box it reveals is filled)", e.ok && e.values.c1 === "Rooftop solar" && !e.aging.some((n) => /#237/.test(n)), tail(e));
  }

  // ---- F: a conditional styled switch whose real box is concealed inside a visible label ----------
  if (want("F")) {
  const f = await run(browser, recipeOf("learnstate-f", "/switch", [
    { action: "check", note: "Remote monitoring", conditional: true, selector: { css: "#mon", fallbacks: [{ label: "Remote monitoring" }] } } as RecipeStep,
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]));
  console.log(`   F ${tail(f)}`);
  check("F MUST-EXCLUDE a conditional switch whose widget is up is never skipped as 'not revealed'", !f.aging.some((n) => /#237/.test(n)) && !f.skipped.some((s) => /Remote monitoring/.test(s)), tail(f));
  }

  // ---- G: a non-advancing click left on a hidden control, mid-flow (a write follows) --------------
  if (want("G")) {
  const g = await run(browser, recipeOf("learnstate-g", "/hiddentoggle", [
    { action: "click", note: "human-patch: Show Help", selector: { css: "#toggleHelp", fallbacks: [{ role: "button", name: "Show Help" }] } } as RecipeStep,
    { action: "fill", note: "Notes to the utility", field: "workDescription", selector: { css: "#notes", fallbacks: [{ label: "Notes to the utility" }] } } as RecipeStep,
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]), { workDescription: "Rooftop solar" });
  console.log(`   G ${tail(g)}`);
  check("G MUST-PASS a non-advancing click resolution leaves on a hidden control is skipped, named", g.aging.some((n) => /Show Help/.test(n) && /hidden/i.test(n) && /#237/.test(n)), JSON.stringify(g.aging));
  check("G MUST-PASS ...never clicked into a timeout: the next write lands and the stop is reached quickly", g.ok && g.values.notes === "Rooftop solar" && g.ms < 30_000, tail(g));
  }

  // ---- H: D on PowerClerk's shape — every input carries the generic test hook ---------------------
  if (want("H")) {
  const HOOK = { css: "[data-test-role=\"textbox-element\"]" };
  const pcSteps = (): RecipeStep[] => [
    { action: "fill", field: "batteryMake", note: "Battery Inverter Manufacturer", conditional: true, selector: { label: "Battery Inverter Manufacturer", fallbacks: [{ css: "#BI7MAKE0001Input" }, HOOK] } } as RecipeStep,
    { action: "fill", field: "batteryModel", note: "Battery Inverter Model", conditional: true, selector: { label: "Battery Inverter Model", fallbacks: [{ css: "#8Q7MODL0002Input" }, HOOK] } } as RecipeStep,
    { action: "fill", field: "invQty", note: "Inverter Quantity", selector: { label: "Inverter Quantity", fallbacks: [{ css: "#IQ7QNTY0005Input" }, HOOK] } } as RecipeStep,
    { action: "stopForReview", note: "review" } as RecipeStep,
  ];
  const pcValues = { batteryMake: "ExampleCo", batteryModel: "EX-1", invQty: "2" };
  const named = (r: Run): number => r.aging.filter((n) => /Battery Inverter (Manufacturer|Model)/.test(n) && /reveal/i.test(n) && /#237/.test(n)).length;
  for (const [key, path] of [["H", "/pchidden"], ["H2", "/pcabsent"]] as const) {
    const h = await run(browser, recipeOf(`learnstate-${key.toLowerCase()}`, path, pcSteps()), pcValues);
    console.log(`   ${key} ${tail(h)}`);
    check(`${key} MUST-PASS a conditional control the generic hook also matches (block ${path === "/pchidden" ? "hidden" : "not rendered"}) is skipped, named — the hook names every textbox, not this one`,
      named(h) === 2, JSON.stringify(h.aging));
    check(`${key} MUST-PASS ...its value is never written into another hooked textbox (Battery Disconnect keeps the portal's value)`,
      h.values.BD7DISC0004Input === "DisconnectCo" && !Object.values(h.values).some((v) => v === "ExampleCo" || v === "EX-1"), JSON.stringify(h.values));
    check(`${key} MUST-PASS ...the run carries on: the next fill lands and the review stop is reached without a fill timeout`,
      h.ok && h.values.IQ7QNTY0005Input === "2" && h.ms < 30_000, tail(h));
    check(`${key} MUST-PASS ...counted as not applicable, never in skipped`, !h.skipped.some((s) => /Battery Inverter/.test(s)), JSON.stringify(h.skipped));
  }
  const h3 = await run(browser, recipeOf("learnstate-h3", "/pcshown", pcSteps()), pcValues);
  console.log(`   H3 ${tail(h3)}`);
  check("H3 MUST-EXCLUDE when this job's answers DID reveal the block, both conditional controls are written",
    h3.ok && h3.values.BI7MAKE0001Input === "ExampleCo" && h3.values["8Q7MODL0002Input"] === "EX-1" && named(h3) === 0, tail(h3) + JSON.stringify(h3.values));
  }

  // ---- I: a control disabled while the portal works is busy, not answered ------------------------
  if (want("I")) {
  const sel = (note: string, id: string, value: string): RecipeStep => ({ action: "select", phase: "fill", note, value, selector: { label: note, fallbacks: [{ css: `#${id}` }] } } as RecipeStep);
  const i1 = await run(browser, recipeOf("learnstate-i", "/busyselect", [
    sel("Work Class", "wclass", "Solar PV"),
    sel("Construction Type", "ctype", "Alteration"),
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]));
  console.log(`   I ${tail(i1)} values=${JSON.stringify(i1.values)}`);
  check("I MUST-EXCLUDE a select disabled for 3 s while the portal works (holding its default) is WRITTEN with the job's value, never left as the portal's answer",
    i1.values.ctype === "A" && !i1.skipped.some((s) => /Construction Type/.test(s)) && !i1.drift.some((w) => /answered by the portal/.test(w)), tail(i1) + JSON.stringify(i1.values));
  const i2 = await run(browser, recipeOf("learnstate-i2", "/busybox", [
    sel("Permit Kind", "pkind", "Residential"),
    { action: "fill", phase: "fill", note: "Valuation", field: "declaredValuation", selector: { label: "Valuation", fallbacks: [{ css: "#val" }] } } as RecipeStep,
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]), { declaredValuation: "25000" });
  console.log(`   I2 ${tail(i2)} values=${JSON.stringify(i2.values)}`);
  check("I2 MUST-EXCLUDE a box disabled for 3 s while the portal works (holding \"0\") is WRITTEN with the job's value",
    i2.values.val === "25000" && !i2.skipped.some((s) => /Valuation/.test(s)) && !i2.drift.some((w) => /answered by the portal/.test(w)), tail(i2) + JSON.stringify(i2.values));
  }

  // ---- J: a conditional control revealed by the portal's own slow round-trip -----------------------
  if (want("J")) {
  const j = await run(browser, recipeOf("learnstate-j", "/slowentry", [
    { action: "fill", phase: "fill", note: "Project Name", field: "projectName", selector: { label: "Project Name", fallbacks: [{ css: "#proj" }] } } as RecipeStep,
    { action: "click", phase: "fill", note: "advance: Next", selector: { role: "button", name: "Next", exact: true, fallbacks: [{ css: "#toEquip" }] } } as RecipeStep,
    { action: "select", phase: "fill", note: "Energy Source", value: "Solar PV", selector: { label: "Energy Source", fallbacks: [{ css: "#esrc" }] } } as RecipeStep,
    { action: "select", phase: "fill", note: "Inverter Manufacturer", value: "Example Power", conditional: true, selector: { label: "Inverter Manufacturer", fallbacks: [{ css: "#make" }] } } as RecipeStep,
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]), { projectName: "Example Rooftop" });
  console.log(`   J ${tail(j)} values=${JSON.stringify(j.values)}`);
  check("J MUST-EXCLUDE a conditional control the answer reveals after a 4 s round-trip is WRITTEN, not skipped",
    j.values.make === "EP" && !j.aging.some((n) => /#237/.test(n)), tail(j) + JSON.stringify(j.values));

  const j2 = await run(browser, recipeOf("learnstate-j2", "/verifyentry", [
    { action: "fill", phase: "fill", note: "Project Name", field: "projectName", selector: { label: "Project Name", fallbacks: [{ css: "#proj" }] } } as RecipeStep,
    { action: "click", phase: "fill", note: "advance: Next", selector: { role: "button", name: "Next", exact: true, fallbacks: [{ css: "#toEquip" }] } } as RecipeStep,
    { action: "click", phase: "fill", note: "click: Validate Address", selector: { role: "button", name: "Validate Address", exact: true, fallbacks: [{ css: "#validate" }] } } as RecipeStep,
    { action: "click", phase: "fill", note: "click: OK", selector: { role: "button", name: "OK", exact: true, fallbacks: [{ css: "#verifyOk" }] } } as RecipeStep,
    { action: "fill", phase: "fill", note: "Description", field: "workDescription", selector: { label: "Description", fallbacks: [{ css: "#desc2" }] } } as RecipeStep,
    { action: "stopForReview", note: "review" } as RecipeStep,
  ]), { projectName: "Example Rooftop", workDescription: "Rooftop solar" });
  console.log(`   J2 ${tail(j2)} values=${JSON.stringify(j2.values)}`);
  check("J2 MUST-EXCLUDE a popup OK that opens after the portal's 4 s round-trip is CLICKED (the page is let settle before the grace), not skipped as not applicable",
    j2.values.okClicked === "1" && !j2.aging.some((n) => /#237/.test(n)) && j2.values.desc2 === "Rooftop solar", tail(j2) + JSON.stringify(j2.values));
  }

  // ---- K: a revealed conditional control that only its unique test hook finds -----------------------
  // The probe asks EVERY level the step recorded. A data-testid / data-test / data-cy / data-qa level
  // names its control (the learner's drift-recovery level); only PowerClerk's component hook,
  // data-test-role (H), is passed over beside an identity (re-review of #237).
  if (want("K")) {
  const exportKw = { action: "fill", phase: "fill", field: "exportKw", note: "Total System Export (kW)", selector: { label: "Total System Export (kW)", fallbacks: [{ css: "#kw" }] } } as RecipeStep;
  const stop = { action: "stopForReview", note: "review" } as RecipeStep;
  // rrProbe K1 as the reviewer wrote it: a drifted label, a stale per-render id, the unique hook.
  const makeStep = (attr: string): RecipeStep => ({ action: "fill", phase: "fill", field: "batteryInverterMake", conditional: true, note: "Battery Inverter Make",
    selector: { label: "Battery Inverter Make", fallbacks: [{ css: "#mui-12" }, { css: `[${attr}="battery-inverter-make"]` }] } } as RecipeStep);
  const dcStep = { action: "check", phase: "fill", conditional: true, note: "Battery is DC coupled",
    selector: { label: "Battery is DC coupled", fallbacks: [{ css: "[data-testid=\"battery-dc-coupled\"]" }] } } as RecipeStep;
  const kValues = { batteryInverterMake: "ExampleCo", exportKw: "7.6" };
  const no237 = (r: Run): boolean => !r.aging.some((n) => /#237/.test(n));
  for (const attr of TEST_HOOK_ATTRS) {
    const k1 = await run(browser, recipeOf(`learnstate-k1-${attr}`, `/k1/${attr}`, [makeStep(attr), exportKw, stop]), kValues);
    console.log(`   K1 [${attr}] ${tail(k1)} values=${JSON.stringify(k1.values)}`);
    check(`K1 MUST-PASS a revealed conditional box only its unique ${attr} finds (label drifted, id per-render) is WRITTEN on the job that reveals it, never skipped as not revealed`,
      k1.ok && k1.values["mui-31"] === "ExampleCo" && no237(k1) && !k1.skipped.length && k1.values.kw === "7.6", tail(k1) + JSON.stringify(k1.values));
  }
  const k2 = await run(browser, recipeOf("learnstate-k2", "/k2", [dcStep, exportKw, stop]), kValues);
  console.log(`   K2 ${tail(k2)} values=${JSON.stringify(k2.values)}`);
  check("K2 MUST-PASS a revealed conditional checkbox only a neighbouring div labels (getByLabel never resolves it) is CHECKED through its data-testid, never skipped",
    k2.ok && k2.values["battery-dc-coupled"] === "true" && no237(k2) && !k2.skipped.length, tail(k2) + JSON.stringify(k2.values));

  // K3: the same recipes on a job whose answers revealed nothing. Every level, the test hook
  // included, finds nothing: the conditional skip still holds.
  const k3 = await run(browser, recipeOf("learnstate-k3", "/k1none", [makeStep("data-testid"), exportKw, stop]), kValues);
  console.log(`   K3 ${tail(k3)} values=${JSON.stringify(k3.values)}`);
  check("K3 MUST-KEEP the K1 step, truly absent (no level finds anything), is skipped, named as not revealed, and the run carries on",
    k3.ok && k3.aging.some((n) => /Battery Inverter Make/.test(n) && /reveal/i.test(n) && /#237/.test(n)) && k3.values.kw === "7.6" && k3.ms < 30_000, tail(k3) + JSON.stringify(k3.values));
  const k3b = await run(browser, recipeOf("learnstate-k3b", "/k2none", [dcStep, exportKw, stop]), kValues);
  console.log(`   K3b ${tail(k3b)} values=${JSON.stringify(k3b.values)}`);
  check("K3b MUST-KEEP the K2 checkbox, truly absent, is skipped, named, and the run carries on",
    k3b.ok && k3b.aging.some((n) => /Battery is DC coupled/.test(n) && /reveal/i.test(n) && /#237/.test(n)) && k3b.values.kw === "7.6" && k3b.ms < 30_000, tail(k3b) + JSON.stringify(k3b.values));
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} learn-state check(s) FAILED.`); process.exit(1); }
console.log("\nAll learn-state checks passed (real Chromium).");
process.exit(0);
