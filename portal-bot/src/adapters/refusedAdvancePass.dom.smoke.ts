// AN ADVANCE THE PORTAL REFUSED IS NOT A STEP, AND NEITHER ARE THE WRITES ITS REDO REPEATED.
//
// The shape (a supervised learn of a permit portal): one page asks for a kind of place (a select)
// and a search box. The walk records  select, fill, "advance: Next Step".  The portal answers the
// advance with THE SAME FORM under an error notice ("The search value did not match a place") and a
// title that now says "Submission Error". The walk does the page again and records  select (same
// control), fill (same control), "advance: Next Step" — which works. The recipe kept all six steps.
// Replayed, the first advance is refused by nothing: it really advances, and the two redo writes
// then look for the previous page's controls on the next page. The backend's sequence check
// (shared/src/recipeSequence.ts) names it: "the advance at step N did not leave its page".
//
// The rule, at record time: when the walk SAW an advance come back to its own form with the portal's
// notice on it, and the redo wrote the same controls again, the recording holds ONE clean pass of
// that page — the superseded writes and the refused advance are dropped; the later writes and the
// working advance are kept, in order; a first-attempt write the redo did not repeat (the portal kept
// its value) is kept; nothing on another page is touched.
//
// The fixture is one server-rendered wizard at ONE address with ONE title and ONE page heading (the
// site's name), every step advanced by the same "Next Step":
//   1. Project Name / Project Summary                 — its own controls; the advance works.
//   2. Kind of Place / Search for place / Work Notes  — the first TWO Next Steps are refused: the
//      same form comes back under the notice (the same words both times, the value searched for
//      echoed beside it), Work Notes still holding its value, the other two blank. The third works.
//   3. Helper Name ("first helper")                   — the advance works.
//   4. Helper Name ("second helper")                  — THE SAME FORM AS 3, and a different page: the
//      box is blank, and the only thing in the portal's alert region is the maintenance banner page
//      3 carried too. Its advance works.
//   5. Review, with a Submit Application that is recorded and never clicked.
//
// MUST-PASS: step 2 is recorded once (one select, one fill — the last redo's — and one advance),
// Work Notes is kept, and the sequence check finds nothing to object to in those steps.
// MUST-EXCLUDE: step 1's fills and its same-label advance are untouched; steps 3 and 4 keep BOTH
// fills and BOTH advances (the page did change: the portal said nothing new, nothing is dropped);
// the final submit is still recorded, flagged, last, and was never clicked.
//
// KILL CHECKS (each turns this file red for its own reason):
//   K1 the learner as it was (no mark, no clean pass)       -> the MUST-PASS checks fail.
//   K2 the mark asks for no NEW word from the portal        -> the twin pages (3, 4) lose a pass.
//   K3 the mark forgets a form that already came back once  -> the second refusal's steps stay.
//
// Synthetic page, names and values. Run: npx tsx portal-bot/src/adapters/refusedAdvancePass.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { AutoLearnAdapter, type LearnPlanner, type LearnPlanRequest, type LearnPlanResponse } from "./autoLearnAdapter";
import { recipeSequenceProblems } from "../../../shared/src/recipeSequence";
import type { ProjectRecord, RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.ENTRY_SETTLE_MS = "0";
process.env.PORTAL_SECTION_READY_MS = "2000";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// ---- the portal -------------------------------------------------------------------------------
const NOTICE = "The search value did not match a place";
const BANNER = "Scheduled maintenance on Sunday evening.";
const REFUSALS = 2;
const state = {
  step: 1,
  /** Every "Next Step" the server received: the step it was pressed on, and whether it was taken. */
  nexts: [] as Array<{ step: number; taken: boolean }>,
  submits: 0,
  notes: "",
  searched: "",
};
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const shell = (title: string, banner: string, body: string): string => `<!doctype html><html><head><title>${title}</title></head><body>
  <h1>Test Portal - Service Center</h1>
  ${banner}
  <form method="post" action="/apply">
    ${body}
    <p><input type="submit" id="nextStep" name="next" value="Next Step"></p>
  </form>
</body></html>`;
const TITLE = "Sample Application | Test Portal";
const render = (refused = false): string => {
  if (state.step === 1) {
    return shell(TITLE, "", `<h3>About the work</h3>
    <div><label for="projName">Project Name</label><input id="projName" name="projName" type="text"></div>
    <div><label for="projSummary">Project Summary</label><input id="projSummary" name="projSummary" type="text"></div>`);
  }
  if (state.step === 2) {
    return shell(refused ? `Submission Error - ${TITLE}` : TITLE,
      refused ? `<div class="validation-summary-errors">${NOTICE}</div><p>You searched for: ${esc(state.searched)}</p>` : "",
      `<h3>Place of the work</h3>
    <div><label for="placeKind">Kind of Place to Search For</label>
      <select id="placeKind" name="placeKind"><option value="">Choose one</option><option>Any</option><option>Street Address</option><option>Lot</option></select></div>
    <div><label for="placeQuery">Search for place</label><input id="placeQuery" name="placeQuery" type="text"></div>
    <div><label for="workNotes">Work Notes</label><input id="workNotes" name="workNotes" type="text" value="${esc(state.notes)}"></div>`);
  }
  if (state.step === 3 || state.step === 4) {
    return shell(TITLE, `<div role="alert">${BANNER}</div>`, `<h3>People helping with the work</h3>
    <p>${state.step === 3 ? "Name the first helper." : "Name the second helper, when there is one."}</p>
    <div><label for="helperName">Helper Name</label><input id="helperName" name="helperName" type="text"></div>`);
  }
  return `<!doctype html><html><head><title>${TITLE}</title></head><body>
  <h1>Test Portal - Service Center</h1>
  <h3>Review</h3>
  <p>Review your application before submitting.</p>
  <button id="btnSubmit" type="button" onclick="fetch('/submit',{method:'POST'})">Submit Application</button>
</body></html>`;
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  const html = (body: string): void => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
  if (req.method !== "POST") { html(render()); return; }
  let raw = "";
  req.on("data", (c) => { raw += String(c); });
  req.on("end", () => {
    if (u.pathname === "/submit") { state.submits++; html("filed"); return; }
    const form = new URLSearchParams(raw);
    const pressedOn = state.step;
    // THE REFUSAL: the first Next Steps on step 2 come back as the same form under the notice. The
    // portal keeps what it could read (Work Notes) and empties the two search controls.
    if (pressedOn === 2 && state.nexts.filter((n) => n.step === 2).length < REFUSALS) {
      state.notes = form.get("workNotes") ?? "";
      state.searched = form.get("placeQuery") ?? "";
      state.nexts.push({ step: 2, taken: false });
      html(render(true));
      return;
    }
    state.nexts.push({ step: pressedOn, taken: true });
    state.step = Math.min(5, pressedOn + 1);
    html(render());
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// ---- the planner ------------------------------------------------------------------------------
const norm = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
const QUERIES = ["100 Test St", "100 Test St, Testville", "100 Test St, Testville ZZ"];
type Call = { page: string; fills: string[]; advance: string };
const calls: Call[] = [];
const planner: LearnPlanner = async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
  const at = (re: RegExp, type?: string): number => req.fields.findIndex((f) => (!type || f.fieldType === type) && re.test(norm(f.label)));
  const next = at(/^next step$/i, "button");
  const done = (page: string, fills: Array<{ selectorIndex: number; value: string }>, advance: boolean, extra: Partial<LearnPlanResponse> = {}): LearnPlanResponse => {
    const kept = fills.filter((f) => f.selectorIndex >= 0);
    calls.push({ page, fills: kept.map((f) => norm(req.fields[f.selectorIndex].label)), advance: advance && next >= 0 ? "Next Step" : "-" });
    return { fills: kept, atReview: false, ...(advance && next >= 0 ? { advanceSelectorIndex: next } : {}), ...extra };
  };
  if (/review your application/i.test(req.bodyText)) {
    const submit = at(/^submit application$/i, "button");
    return done("review", [], false, { atReview: true, ...(submit >= 0 ? { finalSubmitSelectorIndex: submit } : {}) });
  }
  if (at(/^project name/i) >= 0) {
    return done("about", [
      { selectorIndex: at(/^project name/i), value: "Sample Project" },
      { selectorIndex: at(/^project summary/i), value: "Sample roof work" },
    ], true);
  }
  if (at(/^kind of place/i) >= 0) {
    // As the live plan did: no advance named the first time (the walk's own finder pressed Next
    // Step); on the form that came back under the notice, both search controls again — not Work
    // Notes, which the portal kept. The second time it comes back the plan names Next Step itself.
    if (!req.bodyText.includes(NOTICE)) {
      return done("place", [
        { selectorIndex: at(/^kind of place/i), value: "Street Address" },
        { selectorIndex: at(/^search for place/i), value: QUERIES[0] },
        { selectorIndex: at(/^work notes/i), value: "Roof work" },
      ], false);
    }
    const second = req.bodyText.includes(`You searched for: ${QUERIES[1]}`);
    return done(second ? "place redo 2" : "place redo 1", [
      { selectorIndex: at(/^kind of place/i), value: "Street Address" },
      { selectorIndex: at(/^search for place/i), value: second ? QUERIES[2] : QUERIES[1] },
    ], second);
  }
  // No advance named on the twin pages either: the walk's own finder presses Next Step and reads the
  // next page as moved, so both advances stay recorded and the refused-advance read is asked of
  // page 4 exactly as it was of the place page (same form, an alert region that is not empty).
  if (at(/^helper name/i) >= 0) return done("helper", [{ selectorIndex: at(/^helper name/i), value: "ZZ Test Helper" }], false);
  return done("unknown", [], false);
};

const project = {
  id: "p-refused-advance", clientId: null, projectAddress: "100 Test St, Testville, ZZ, 00000", city: "Testville", state: "ZZ", zip: "00000",
  homeownerName: "ZZ Test Owner", permitType: "electrical", parserSnapshot: {},
} as unknown as ProjectRecord;

// ---- the walk ---------------------------------------------------------------------------------
const DEADLINE_S = 420;
const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
const page: Page = await ctx.newPage();

let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
let thrown = "";
let hung = false;
const T0 = Date.now();
try {
  await page.goto(`${base}/apply`);
  const adapter = new AutoLearnAdapter("Refused Advance Pass Smoke", planner, { maxPages: 10, policyProfile: "none" });
  (adapter as unknown as { page: unknown }).page = page;
  const learning = adapter.learn({ portalUrl: `${base}/apply` } as never, project).then((x) => { r = x; }, (e) => { thrown = String(e).slice(0, 300); });
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([learning, new Promise<void>((resolve) => { deadlineTimer = setTimeout(() => { hung = true; resolve(); }, DEADLINE_S * 1000); })]);
  if (deadlineTimer) clearTimeout(deadlineTimer);
  const tookS = Math.round((Date.now() - T0) / 1000);
  if (hung) { await browser.close().catch(() => null); await Promise.race([learning, new Promise((res) => setTimeout(res, 30_000))]); }
  const res = r as Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null;
  const steps: RecipeStep[] = res?.steps ?? [];
  const events: Array<Record<string, unknown>> = (() => {
    try {
      return fs.readFileSync(path.join(adapter.debug?.dir ?? "", "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  })();
  const evTypes = events.map((e) => String(e.type));

  // One line per recorded step: what it does and to which control.
  const idOf = (s: RecipeStep): string => {
    const fp = norm(s.fingerprint?.id);
    if (fp) return fp;
    const m = /^#([\w-]+)$/.exec(norm(s.selector?.css)) ?? /^\[id\s*=\s*["']([^"']+)["']\]$/.exec(norm(s.selector?.css));
    return m ? m[1] : "";
  };
  const isAdvance = (s: RecipeStep): boolean => s.action === "click" && /^advance:/i.test(norm(s.note));
  const line = (s: RecipeStep): string =>
    s.isFinalSubmit ? "FINAL" : s.action === "stopForReview" ? "REVIEW" : s.action === "goto" ? "goto" : isAdvance(s) ? norm(s.note) : `${s.action}#${idOf(s) || "?"}`;
  const lines = steps.map(line);
  const trace = `took=${tookS}s nexts=${JSON.stringify(state.nexts.map((n) => `${n.step}${n.taken ? "" : " refused"}`))} submits=${state.submits} ` +
    `plans=${JSON.stringify(calls.map((c) => `${c.page}[${c.fills.join(",")}]->${c.advance}`))} steps=${JSON.stringify(lines)} ` +
    `ok=${res?.ok} reachedReview=${res?.reachedReview} stopReason=${res?.stopReason ?? "-"} message=${norm(res?.message ?? thrown).slice(0, 240)}`;
  console.log(`   ${trace}`);
  console.log(`   events=${JSON.stringify(evTypes.filter((t) => /advance|notice|refused|recovery|stop|validation/.test(t)))}`);

  // ---- preconditions: without these the checks below pass on a walk that never met the shape ----
  check(`precondition: the walk ends on its own within ${DEADLINE_S} s and reaches review`, !hung && !!res && res.reachedReview === true, trace);
  check(`precondition: the portal refused the first ${REFUSALS} Next Steps on the place page and took the third`,
    JSON.stringify(state.nexts.filter((n) => n.step === 2).map((n) => n.taken)) === JSON.stringify([false, false, true]), trace);
  const pagesPlanned = calls.map((c) => c.page).filter((p, i, all) => p !== all[i - 1]);
  check("precondition: the place page was planned with no advance named, then twice under the notice — both search controls each time, never Work Notes",
    JSON.stringify(pagesPlanned.filter((p) => /^place/.test(p))) === JSON.stringify(["place", "place redo 1", "place redo 2"]) &&
    calls.filter((c) => /^place redo/.test(c.page)).every((c) => c.fills.length === 2), trace);
  check("precondition: BOTH refused clicks were kept as steps by the walk (its own Next Step finder read the page as moved), and the notice was read",
    events.filter((e) => e.type === "fallback_advance").length >= 2 && !evTypes.includes("fallback_advance_did_nothing") && !evTypes.includes("validation_blocked") &&
    events.some((e) => e.type === "portal_notice" && JSON.stringify(e.notices ?? "").includes(NOTICE)), `events=${JSON.stringify(evTypes)}`);
  check("precondition: the twin pages' alert region is not empty (a banner every page carries), and it was read",
    events.some((e) => e.type === "portal_notice" && JSON.stringify(e.notices ?? "").includes(BANNER)), `events=${JSON.stringify(events.filter((e) => e.type === "portal_notice"))}`);
  check("precondition: every write is recorded against its control's own id (what the sequence check reads)",
    steps.filter((s) => ["fill", "select", "check"].includes(String(s.action))).every((s) => !!idOf(s)), trace);

  // ---- MUST-PASS: one clean pass of the refused page --------------------------------------------
  const selects = steps.filter((s) => s.action === "select" && idOf(s) === "placeKind");
  const queries = steps.filter((s) => s.action === "fill" && idOf(s) === "placeQuery");
  const notes = steps.filter((s) => s.action === "fill" && idOf(s) === "workNotes");
  check("MUST-PASS: the place page's select is recorded ONCE", selects.length === 1, trace);
  check("MUST-PASS: its search box is recorded ONCE, and it is the last redo's write (the one the portal took)",
    queries.length === 1 && String(queries[0]?.value ?? "") === QUERIES[2], `${trace} | query values=${JSON.stringify(queries.map((q) => q.value))}`);
  check("MUST-PASS: Work Notes — written on the first attempt only, kept by the portal — is still recorded, before the redo's writes",
    notes.length === 1 && selects.length >= 1 && steps.indexOf(notes[0]) < steps.indexOf(selects[selects.length - 1]), trace);
  const EXPECTED = [
    "goto",
    "fill#projName", "fill#projSummary", "advance: Next Step",
    "fill#workNotes", "select#placeKind", "fill#placeQuery", "advance: Next Step",
    "fill#helperName", "advance: Next Step",
    "fill#helperName", "advance: Next Step",
    "FINAL",
  ];
  check("MUST-PASS: the recording is one pass of each page, in order, with ONE advance per page", JSON.stringify(lines) === JSON.stringify(EXPECTED), `expected=${JSON.stringify(EXPECTED)} | ${trace}`);
  // The backend's detector, on the steps up to the twin pages (3 and 4 are two pages that share one
  // form: what the detector makes of THOSE is not this fixture's question).
  const firstHelper = steps.findIndex((s) => idOf(s) === "helperName");
  const upToPlace = firstHelper >= 0 ? steps.slice(0, firstHelper) : steps;
  const objections = recipeSequenceProblems(upToPlace, { reachedReview: true, owedDocuments: [] }).filter((p) => p.refusesPromotion);
  check("MUST-PASS: the sequence check finds nothing to object to in the steps through the refused page",
    firstHelper > 0 && objections.length === 0, `${objections.map((p) => p.detail).join(" | ")} | ${trace}`);

  // ---- MUST-EXCLUDE: nothing else is dropped or moved ---------------------------------------------
  check("MUST-EXCLUDE: the page before it keeps its fills and its own same-label advance",
    JSON.stringify(lines.slice(0, 4)) === JSON.stringify(EXPECTED.slice(0, 4)), trace);
  const helperFills = steps.filter((s) => s.action === "fill" && idOf(s) === "helperName");
  check("MUST-EXCLUDE: two pages that share a form, an address, a title and a standing banner keep BOTH fills and BOTH advances (the page did change)",
    helperFills.length === 2 && helperFills.every((h) => isAdvance(steps[steps.indexOf(h) + 1] ?? ({} as RecipeStep))) &&
    JSON.stringify(state.nexts.filter((n) => n.step >= 3)) === JSON.stringify([{ step: 3, taken: true }, { step: 4, taken: true }]), trace);
  check("MUST: the advances recorded are exactly the ones the portal TOOK (four pages left, four advances)",
    steps.filter(isAdvance).length === state.nexts.filter((n) => n.taken).length && state.nexts.filter((n) => n.taken).length === 4, trace);
  const finals = steps.filter((s) => s.isFinalSubmit === true);
  check("MUST-EXCLUDE: the final submit is recorded once, still flagged, last — and was never clicked",
    finals.length === 1 && steps[steps.length - 1] === finals[0] && state.submits === 0, trace);
  console.log(`  (took ${tookS} s)`);
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} refused-advance-pass check(s) FAILED.`); process.exit(1); }
console.log("\nAll refused-advance-pass checks passed (real Chromium, real AutoLearnAdapter.learn).");
process.exit(0);
