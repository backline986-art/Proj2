// THE PLAN ACTS ON THE PAGE IT WAS MADE FOR, AND A REQUIRED BLANK STOPS THE ADVANCE (#410).
//
// Live, PGE PowerClerk 2026-10-29: the learner scraped the Welcome page (wizard step 1), and before
// its plan was applied the live page had become Preparer Information (step 2). No click of
// Welcome's Next was recorded. The Welcome plan ("no fills, advance: Next") was then applied to the
// Preparer page: the required-field sweep named Name and Address blank on the very page it was about
// to leave, and the walk pressed Next anyway. PowerClerk refused the submit at the end ("Missing
// Required Fields: Preparer - Name, Address, Phone"); a portal that validates later would have
// taken the filing without its preparer.
//
// The only event in that window was the entry pass (application_entry_pass ok:false, ~33 s after
// the scrape: the 30 s settle, then the deep search). The deep search opens a collapsed menu and
// reloads "home" (the page it started on) between looks. On PowerClerk the page it started on is
// the project's own address, and opening it resumes the application at the next form: Welcome had
// been seen, so the reload opened Preparer. That is a page change nothing records.
//
// This fixture is that portal: a dashboard whose "New Net Metering Application" opens /app/1; the
// app resumes at the first form not yet seen (Welcome marks itself seen, so a reload opens
// Preparer); a navbar toggle in the header; Preparer asks for Name, Address, Phone (required) and
// lets the advance through (the portal validates only at submit); Review carries the submit.
//
//   A. entry   - the learner's own walk. MUST: the toggle is never clicked and /app/1 is never
//                reloaded once the application has been entered; Welcome's Next is a recorded step
//                before the first Preparer fill; Name, Address and Phone hold values at review.
//   B. moved   - the page changes UNDER THE PLANNER (the planner stub clicks Welcome's Next while
//                "thinking" — a page that moves on its own). MUST: the stale plan is not applied;
//                the Preparer page is re-planned and its required fields hold values; the move is
//                named in the review hand-off notes (no step can replay it).
//   C. blank   - the planner's first plan for Preparer leaves Name out. MUST: the walk re-plans the
//                page once, naming the blank (and only the blank), before it advances; Name holds
//                its value; one re-plan only.
//   D. stubborn - the re-plan cannot fill Name either. MUST: the walk advances after that one
//                re-plan (no loop), and Name is still reported as a required miss.
//   E. tile     - (#131, City of Star / iWorQ 2026-11-11) a home page of <a href> tiles whose
//                "Solar Permit" tile NAVIGATES to a second document: a textarea, a number box, a
//                consent checkbox, a signature-name box, a file input and a DISABLED Submit. The
//                type click used to fall through the iteration with the home page's inventory, so
//                the planner was handed 21 links, the live-DOM signature pass typed the signer on
//                a page never read, and the run said "filled 1 page(s)" with fills=0.
//                MUST: a second page in the trace, on the new path, with fill>0; the planner is
//                handed the form's fields (and not the signature box — the one-signer rule can
//                only strip it when the inventory holds it); the permit-type click is recorded
//                before the signer is typed; the typed fills hold.
//   F. tileNoFills - same portal, the planner fills nothing. MUST: the signer is still typed, but
//                the run does NOT report a filled page (filledSomething false, no "filled N"),
//                and its message says the recorded steps entered no form data.
//   G. lateSig  - (#131 risk 3) the form's signature box appears AFTER the page was read (the
//                planner stub adds it while "planning", as B moves the page). The live-DOM
//                signature pass finds a box the inventory does not hold. MUST: it does not type —
//                the page is re-read (the planner is asked twice for the same path, the second
//                time with the box present), and the signer is typed on that second look, bound
//                with no literal. Before (c), the pass typed by the live marks into a box no
//                inventory had seen — the City of Star failure without the tile.
//   H. sigOnlyReview - (#131 round 2, RULE 1) a run whose ONLY recorded fills are the bot's own
//                e-signature (a prefilled or continued flow: the signer page, then review), and
//                whose review page is a no-field summary whose prose names "Terms and Conditions"
//                beside an enabled Submit. "Has this run entered form data?" (the honesty question)
//                and "is the walk still before the application's first entry?" (the entry-
//                disclaimer door) are DIFFERENT questions: when the first answered the second, the
//                typed signer no longer counted as entry, the review page read as the entry
//                disclaimer, and c2a' converted the planner's final submit into an advance and
//                CLICKED it. MUST: Submit is never clicked; it is recorded as the final submit;
//                the run reaches review; no entry_disclaimer_pass_through event.
//
// Run: npx tsx portal-bot/src/adapters/learnerPageChanged.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner, type LearnPlanRequest } from "./autoLearnAdapter";
import type { ProjectRecord, RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.ENTRY_SETTLE_MS = "0";
process.env.AUTOLEARN_RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "learner-page-changed-smoke-"));

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const DASHBOARD = `<!doctype html><html><head><title>My Projects</title></head><body>
  <h1>My Projects</h1>
  <p>No projects yet.</p>
  <a href="/app/1" id="newapp">New Net Metering Application</a>
</body></html>`;

// The application shell: one address for every form, like PowerClerk's project page. State lives
// in sessionStorage so it survives the reloads the portal itself uses to move between forms.
const APP = `<!doctype html><html><head><title>Net Metering Application</title></head><body>
  <nav class="navbar"><button type="button" class="navbar-toggler" aria-label="Open navigation menu" id="burger">Menu</button>
    <div id="menu" hidden><a href="/">My Projects</a></div></nav>
  <main id="main"></main>
  <script>
    const st = JSON.parse(sessionStorage.getItem("app") || '{"resume":"welcome","loads":[],"vals":{},"burger":0}');
    const save = () => sessionStorage.setItem("app", JSON.stringify(st));
    document.getElementById("burger").addEventListener("click", () => {
      st.burger++; save();
      const m = document.getElementById("menu"); m.hidden = !m.hidden;
    });
    const step = st.resume;
    st.loads.push(step);
    // PowerClerk marks Welcome as seen when it is shown: opening the project again resumes at the
    // next form. A RELOAD HERE IS A PAGE CHANGE.
    if (step === "welcome") st.resume = "preparer";
    save();
    const main = document.getElementById("main");
    if (step === "welcome") {
      main.innerHTML = '<h2>Welcome</h2><p>Step 1 of 3. Read the program rules, then press Next.</p>' +
        '<label><input type="checkbox" id="guide"> Email me a copy of the program guide</label> ' +
        '<button type="button" id="next">Next</button>';
      document.getElementById("next").addEventListener("click", () => location.reload());
    } else if (step === "preparer") {
      main.innerHTML = '<h2>Preparer Information</h2><p>Step 2 of 3. The person or company preparing this application.</p>' +
        '<div><label for="pname">Name *</label><input id="pname" name="pname" required></div>' +
        '<div><label for="paddr">Address *</label><input id="paddr" name="paddr" required></div>' +
        '<div><label for="pphone">Phone *</label><input id="pphone" name="pphone" required></div>' +
        '<button type="button" id="next">Next</button>';
      for (const id of ["pname", "paddr", "pphone"]) {
        const el = document.getElementById(id);
        el.value = st.vals[id] || "";
        el.addEventListener("input", () => { st.vals[id] = el.value; save(); });
        el.addEventListener("change", () => { st.vals[id] = el.value; save(); });
      }
      // This portal lets an incomplete page through; it validates only at submit.
      document.getElementById("next").addEventListener("click", () => { st.resume = "review"; save(); location.reload(); });
    } else {
      main.innerHTML = '<h2>Review</h2><p>Step 3 of 3. Review all information before you submit.</p>' +
        '<p>Preparer: ' + [st.vals.pname, st.vals.paddr, st.vals.pphone].map((v) => v || "(blank)").join(" / ") + '</p>' +
        '<button type="button" id="submit">Submit Application</button>';
    }
  </script>
</body></html>`;

// E/F: the tile portal. A home of plain <a href> tiles (no entry vocabulary — the type tile IS
// the way in) and the permit form it navigates to. Nothing on either page is required, so the
// required sweep and the upload pass add no noise; the Submit stays disabled (the live portal's
// reCAPTCHA enables it), so the walk cannot reach review here.
const TILE_HOME = `<!doctype html><html><head><title>Citizen Portal</title></head><body>
  <h1>Citizen Portal</h1>
  <p>Choose a permit.</p>
  <a href="/new-permit/600/6881">Solar Permit</a>
  <a href="/new-permit/600/6882">Fence Permit</a>
  <a href="/new-permit/600/6883">Driveway Permit</a>
  <a href="/search-permits">Search Existing Permits</a>
</body></html>`;
const TILE_FORM = `<!doctype html><html><head><title>Solar Permit</title></head><body>
  <h1>Solar Permit</h1>
  <div><label for="desc">Description of Work</label><textarea id="desc" name="desc"></textarea></div>
  <div><label for="value">Total Project Value</label><input type="number" id="value" name="value"></div>
  <div><label><input type="checkbox" id="consent" name="consent"> I consent to electronic communications</label></div>
  <div><label for="signame">Signature Name</label><input type="text" id="signame" name="signame"></div>
  <div><label for="plans">Plans (PDF)</label><input type="file" id="plans" name="plans"></div>
  <button type="button" id="submit" disabled>Submit</button>
</body></html>`;

// G: the same form, its signature box revealed by the page itself when the option-less Permit Type
// select is opened. The walk's dropdown read opens it AFTER the page was read and the pre-pass
// identity check passed, and BEFORE the signature pass — the one window in which the live page
// can hold a signature box the inventory does not (a portal whose script reveals the box late).
const LATE_SIG_FORM = `<!doctype html><html><head><title>Solar Permit</title></head><body>
  <h1>Solar Permit</h1>
  <div><label for="desc">Description of Work</label><textarea id="desc" name="desc"></textarea></div>
  <div><label for="value">Total Project Value</label><input type="number" id="value" name="value"></div>
  <div><label for="ptype">Permit Type</label><select id="ptype" name="ptype"><option value=""></option></select></div>
  <div id="sig-slot"></div>
  <button type="button" id="submit" disabled>Submit</button>
  <script>
    const reveal = () => {
      const slot = document.getElementById("sig-slot");
      if (!slot.children.length) slot.innerHTML = '<label for="signame">Signature Name</label><input type="text" id="signame" name="signame">';
    };
    for (const ev of ["mousedown", "click", "focus"]) document.getElementById("ptype").addEventListener(ev, reveal);
  </script>
</body></html>`;

// H: the signer-only flow. The signature page carries nothing but the Signature Name box and
// Next; the review page is a no-field summary whose prose names the Terms and Conditions, with
// Back and an ENABLED Submit that marks the filing in sessionStorage. The planner names Submit as
// the final submit (atReview) — the walk must record it and never click it.
const SIGN_PAGE = `<!doctype html><html><head><title>Sign</title></head><body>
  <h1>Electronic Signature</h1>
  <p>Type your name below as consent to electronically sign this application.</p>
  <div><label for="signame">Signature Name</label><input type="text" id="signame" name="signame"></div>
  <button type="button" id="next" onclick="location.href='/sig-review'">Next</button>
</body></html>`;
const SIG_REVIEW_PAGE = `<!doctype html><html><head><title>Review</title></head><body>
  <h1>Review and Submit</h1>
  <p>Review your application below. By clicking Submit you agree to the Terms and Conditions of the program.</p>
  <table><tr><td>System size</td><td>7.2 kW</td></tr></table>
  <button type="button" id="back" onclick="history.back()">Back</button>
  <button type="button" id="submit" onclick="sessionStorage.setItem('submitted','1'); document.body.insertAdjacentHTML('beforeend','<p id=done>Application submitted.</p>')">Submit</button>
</body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  res.writeHead(200, { "content-type": "text/html" });
  if (u.pathname.startsWith("/portalhome")) { res.end(TILE_HOME); return; }
  if (u.pathname.startsWith("/new-permit/")) { res.end(TILE_FORM); return; }
  if (u.pathname.startsWith("/late-sig")) { res.end(LATE_SIG_FORM); return; }
  if (u.pathname.startsWith("/sig-sign")) { res.end(SIGN_PAGE); return; }
  if (u.pathname.startsWith("/sig-review")) { res.end(SIG_REVIEW_PAGE); return; }
  res.end(u.pathname.startsWith("/app/") ? APP : DASHBOARD);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

type Mode = "entry" | "moved" | "blank" | "stubborn" | "tile" | "tileNoFills" | "lateSig" | "sigOnlyReview";
const VALUES: Record<string, string> = { Name: "Test Solar Co", Address: "100 Example Way, Testville", Phone: "555-0100" };
const TILE_VALUES = { desc: "Roof-mounted solar PV, 7.2 kW DC", value: "21000" };
const SIGNER = "Dana Signer";
const idxOf = (req: LearnPlanRequest, re: RegExp): number =>
  req.fields.findIndex((f) => re.test(String(f.label ?? "").replace(/\*/g, "").trim()));

async function walk(mode: Mode): Promise<void> {
  console.log(`\n[${mode}]`);
  const tile = mode === "tile" || mode === "tileNoFills";
  const late = mode === "lateSig";
  const sigOnly = mode === "sigOnlyReview";
  const ctx = await chromium.launch().then((b) => b.newContext().then((c) => ({ b, c })));
  await ctx.c.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  ctx.c.setDefaultTimeout(8000);
  const page = await ctx.c.newPage();
  const calls: Array<{ page: string; hint: string }> = [];
  // E/F: every planner request as the fixture saw it — the page's url and the labels offered.
  const offered: Array<{ url: string; labels: string[]; isDashboard: boolean }> = [];
  let movedOnce = false;
  const planner: LearnPlanner = async (req) => {
    if (sigOnly) {
      offered.push({ url: String(req.url ?? ""), labels: req.fields.map((f) => String(f.label ?? "")), isDashboard: req.isDashboard === true });
      const idx = (re: RegExp): number => req.fields.findIndex((f) => f.fieldType === "button" && re.test(String(f.label ?? "").trim()));
      // The planner reads the review page as review and names its Submit as the final submit.
      if (/\/sig-review/.test(String(req.url ?? ""))) return { fills: [], atReview: true, finalSubmitSelectorIndex: idx(/^submit$/i) };
      return { fills: [], atReview: false, advanceSelectorIndex: idx(/^next$/i) };
    }
    if (late) {
      offered.push({ url: String(req.url ?? ""), labels: req.fields.map((f) => String(f.label ?? "")), isDashboard: req.isDashboard === true });
      const fills = [
        { selectorIndex: idxOf(req, /^description of work$/i), value: TILE_VALUES.desc },
        { selectorIndex: idxOf(req, /^total project value$/i), value: TILE_VALUES.value },
      ].filter((f) => f.selectorIndex >= 0);
      return { fills, atReview: false };
    }
    if (tile) {
      offered.push({ url: String(req.url ?? ""), labels: req.fields.map((f) => String(f.label ?? "")), isDashboard: req.isDashboard === true });
      if (mode === "tileNoFills") return { fills: [], atReview: false };
      const fills = [
        { selectorIndex: idxOf(req, /^description of work$/i), value: TILE_VALUES.desc },
        { selectorIndex: idxOf(req, /^total project value$/i), value: TILE_VALUES.value },
        { selectorIndex: idxOf(req, /consent to electronic/i), value: "true" },
      ].filter((f) => f.selectorIndex >= 0);
      return { fills, atReview: false };
    }
    const nextIdx = req.fields.findIndex((f) => f.fieldType === "button" && /^next$/i.test(String(f.label ?? "").trim()));
    const isPreparer = idxOf(req, /^name$/i) >= 0;
    const isReview = /review all information/i.test(req.bodyText);
    calls.push({ page: isReview ? "review" : isPreparer ? "preparer" : "welcome", hint: String(req.recoveryHint ?? "") });
    if (isReview) return { fills: [], atReview: true };
    if (!isPreparer) {
      // B: the page moves while the planner is working, before the plan comes back.
      if (mode === "moved" && !movedOnce) {
        movedOnce = true;
        await page.locator("#next").click();
        await page.waitForLoadState("domcontentloaded").catch(() => null);
        await page.waitForTimeout(500);
      }
      return { fills: [], atReview: false, ...(nextIdx >= 0 ? { advanceSelectorIndex: nextIdx } : {}) };
    }
    // C: the planner leaves Name out until it is TOLD the Name is a required blank (the page's own
    // reveal re-scan asks it again without saying so, and gets the same answer).
    const toldName = /still blank/i.test(String(req.recoveryHint ?? "")) && /\bName\b/.test(String(req.recoveryHint ?? ""));
    const wanted = mode === "blank" && !toldName ? ["Address", "Phone"]
      : mode === "stubborn" ? ["Address", "Phone"]
      : ["Name", "Address", "Phone"];
    const fills = wanted
      .map((label) => ({ selectorIndex: idxOf(req, new RegExp(`^${label}$`, "i")), value: VALUES[label] }))
      .filter((f) => f.selectorIndex >= 0);
    return { fills, atReview: false, ...(nextIdx >= 0 ? { advanceSelectorIndex: nextIdx } : {}) };
  };
  await page.goto(tile ? `${base}/portalhome` : late ? `${base}/late-sig` : sigOnly ? `${base}/sig-sign` : `${base}/`);
  // The tile portal has an e-signature box: the client record's signer (synthetic) is who the
  // bot may sign as; without one the signature pass pauses the run before anything to observe.
  const adapter = new AutoLearnAdapter("Page Changed Smoke", planner, { maxPages: 8, ...(tile || late || sigOnly ? { contactIdentity: { signerName: SIGNER, lastName: "Signer" } } : {}) });
  (adapter as unknown as { page: unknown }).page = page;
  const T0 = Date.now();
  let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
  try { r = await adapter.learn({} as never, {} as ProjectRecord); }
  catch (e) { check(`${mode}: the learn runs`, false, String(e).slice(0, 300)); }
  const app = await page.evaluate(() => JSON.parse(sessionStorage.getItem("app") || "{}")).catch(() => ({})) as {
    loads?: string[]; vals?: Record<string, string>; burger?: number; resume?: string;
  };
  // E/F: what the form holds when the walk ends (the page is still open).
  const form = await page.evaluate(() => {
    const v = (id: string): string => { const el = document.getElementById(id) as HTMLInputElement | null; return el ? (el.type === "checkbox" ? String(el.checked) : el.value) : "(absent)"; };
    return { path: location.pathname, desc: v("desc"), value: v("value"), consent: v("consent"), signame: v("signame") };
  }).catch(() => ({ path: "(unreadable)", desc: "", value: "", consent: "", signame: "" }));
  // H: did anything click the review page's Submit? The page marks a filing in sessionStorage.
  const submitted = await page.evaluate(() => sessionStorage.getItem("submitted")).catch(() => "(unreadable)");
  await ctx.b.close().catch(() => null);
  if (!r) return;
  const steps: RecipeStep[] = r.steps ?? [];
  if (sigOnly) {
    const noteOf = (s: RecipeStep): string => String(s.note ?? "");
    const runDir = (adapter as unknown as { debug: { dir: string } | null }).debug?.dir;
    const events = runDir ? fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type?: string; page?: number }) : [];
    const trace = `pageTrace=${JSON.stringify(r.pageTrace ?? [])} offered=${JSON.stringify(offered.map((o) => `${o.url.replace(base, "")}: ${o.labels.join("|").slice(0, 120)}`))} ` +
      `steps=${JSON.stringify(steps.map((s) => `${s.action}:${noteOf(s).slice(0, 50)}${s.isFinalSubmit ? " [isFinalSubmit]" : ""}`))} submitted=${String(submitted)} path=${form.path} ` +
      `reachedReview=${String(r.reachedReview)} ok=${String(r.ok)} events=${JSON.stringify(events.filter((e) => /entry_disclaimer|terminal|review|advance/.test(String(e.type))).map((e) => `${e.type}@p${e.page ?? "?"}`))} message=${String(r.message ?? "").slice(0, 240)}`;
    const sigAt = steps.findIndex((s) => s.action === "fill" && /^e-signature:/.test(noteOf(s)));
    const last = steps[steps.length - 1];
    check("sigOnlyReview: RULE 1 — the review page's Submit is never clicked (sessionStorage.submitted stays null)", submitted === null, trace);
    check("sigOnlyReview: MUST the Submit is recorded as the final submit, un-clicked, and the walk reaches review",
      !!last && last.isFinalSubmit === true && /submit/i.test(noteOf(last)) && r.reachedReview === true, trace);
    check("sigOnlyReview: no step clicks Submit as an advance", !steps.some((s) => s.action === "click" && !s.isFinalSubmit && /^advance: Submit/i.test(noteOf(s))), trace);
    check("sigOnlyReview: the review page is never read as the entry disclaimer", !events.some((e) => e.type === "entry_disclaimer_pass_through"), trace);
    check("sigOnlyReview: the signer was typed before review, bound to authorizedSignerName with no literal",
      sigAt >= 0 && steps[sigAt].field === "authorizedSignerName" && steps[sigAt].value === undefined && !JSON.stringify(steps).includes(SIGNER), trace);
    check("sigOnlyReview: the honesty answer still holds — the e-signature alone is not form data (filledSomething false)", r.filledSomething === false, trace);
    console.log(`  (took ${Math.round((Date.now() - T0) / 1000)} s)`);
    return;
  }
  if (late) {
    const noteOf = (s: RecipeStep): string => String(s.note ?? "");
    const trace = `pageTrace=${JSON.stringify(r.pageTrace ?? [])} offered=${JSON.stringify(offered.map((o) => `${o.url.replace(base, "")}: ${o.labels.join("|").slice(0, 160)}`))} ` +
      `steps=${JSON.stringify(steps.map((s) => `${s.action}:${noteOf(s).slice(0, 40)}`))} form=${JSON.stringify(form)} ok=${String(r.ok)} filledSomething=${String(r.filledSomething)} message=${String(r.message ?? "").slice(0, 300)}`;
    const sigAt = steps.findIndex((s) => s.action === "fill" && /^e-signature:/.test(noteOf(s)));
    // The run's own timeline (the debug bundle the smoke's AUTOLEARN_RUN_DIR holds) says whether
    // the signature pass refused the uninventoried box.
    const runDir = (adapter as unknown as { debug: { dir: string } | null }).debug?.dir;
    const events = runDir ? fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type?: string; page?: number }) : [];
    const stale = events.filter((e) => e.type === "signature_inventory_stale");
    check("lateSig: MUST the signature pass refuses a box the inventory never held, once, and the page is re-read (pageCount 2)",
      stale.length === 1 && stale[0].page === 1 && r.pageCount === 2, `${trace} staleEvents=${JSON.stringify(stale)}`);
    check("lateSig: the planner is handed the form's fields, never the signature box (held by the inventory after the re-read, so stripped)",
      offered.length >= 1 && offered.every((o) => /\/late-sig/.test(o.url) && o.labels.some((l) => /description of work/i.test(l)) && !o.labels.some((l) => /signature name/i.test(l))), trace);
    check("lateSig: the signer is typed on the second look, bound to authorizedSignerName with no literal",
      form.signame === SIGNER && sigAt >= 0 && steps[sigAt].field === "authorizedSignerName" && steps[sigAt].value === undefined && !JSON.stringify(steps).includes(SIGNER), trace);
    check("lateSig: the re-read is not a failure — the planner's fills hold and the run reports a filled page",
      form.desc === TILE_VALUES.desc && form.value === TILE_VALUES.value && r.filledSomething === true, trace);
    check("lateSig: nothing is clicked as a final submit", r.reachedReview !== true && !steps.some((s) => s.isFinalSubmit), trace);
    console.log(`  (took ${Math.round((Date.now() - T0) / 1000)} s)`);
    return;
  }
  if (tile) {
    const pageTrace = r.pageTrace ?? [];
    const noteOf = (s: RecipeStep): string => String(s.note ?? "");
    const trace = `pageTrace=${JSON.stringify(pageTrace)} offered=${JSON.stringify(offered.map((o) => `${o.url.replace(base, "")}${o.isDashboard ? " (dashboard)" : ""}: ${o.labels.join("|").slice(0, 160)}`))} ` +
      `steps=${JSON.stringify(steps.map((s) => `${s.action}:${noteOf(s).slice(0, 40)}`))} form=${JSON.stringify(form)} ok=${String(r.ok)} filledSomething=${String(r.filledSomething)} ` +
      `reachedReview=${String(r.reachedReview)} message=${String(r.message ?? "").slice(0, 300)}`;
    // The second page: the document the tile navigated to, read as its own page, with fields. The
    // home page is left on the type click BEFORE it is planned, so it has no breadcrumb of its own
    // (no planner call spent on a page the walk is leaving) — pageCount still counts it.
    const formPage = pageTrace.find((t) => /\/new-permit\/600\/6881\]/.test(t));
    const fillCount = Number(/\(fill=(\d+)/.exec(formPage ?? "")?.[1] ?? 0);
    check(`${mode}: MUST the permit form is a second page (pageCount 2) in the trace, on its own path, with fill>0`, (r.pageCount ?? 0) >= 2 && !!formPage && fillCount > 0, trace);
    check(`${mode}: the home page is not planned — the type click ends its iteration before the planner is asked`,
      offered.length >= 1 && offered.every((o) => /\/new-permit\/600\/6881/.test(o.url)), trace);
    const formCalls = offered.filter((o) => o.labels.some((l) => /description of work/i.test(l)));
    check(`${mode}: MUST the planner is handed the form's fields (the page the tile opened), not the home page's links`,
      formCalls.length >= 1 && formCalls.every((o) => /\/new-permit\/600\/6881/.test(o.url) && !o.isDashboard), trace);
    check(`${mode}: the planner is never offered the signature box (the inventory held it, so the one-signer rule could strip it)`,
      formCalls.length >= 1 && formCalls.every((o) => !o.labels.some((l) => /signature name/i.test(l))), trace);
    const typeAt = steps.findIndex((s) => s.action === "click" && /^permit type: Solar Permit/.test(noteOf(s)));
    const sigAt = steps.findIndex((s) => s.action === "fill" && /^e-signature:/.test(noteOf(s)));
    check(`${mode}: the permit-type click is a recorded step, before the signer is typed`, typeAt >= 0 && sigAt > typeAt, trace);
    check(`${mode}: the signer is typed into the form's signature box, bound to authorizedSignerName with no literal`,
      form.signame === SIGNER && sigAt >= 0 && steps[sigAt].field === "authorizedSignerName" && steps[sigAt].value === undefined && !JSON.stringify(steps).includes(SIGNER), trace);
    check(`${mode}: the walk does not reach review (the Submit is disabled) and nothing is clicked as a final submit`,
      r.reachedReview !== true && !steps.some((s) => s.isFinalSubmit), trace);
    if (mode === "tile") {
      check("tile: the planner's fills hold on the form", form.desc === TILE_VALUES.desc && form.value === TILE_VALUES.value, trace);
      check("tile: the run reports a filled page, once (the home page filled nothing)", r.filledSomething === true && /filled 1 of 2 page/.test(String(r.message ?? "")), trace);
    } else {
      check("tileNoFills: MUST a run whose only fills are the e-signature does not report a filled page",
        r.filledSomething === false && r.ok === false && !/filled \d+/.test(String(r.message ?? "")), trace);
      check("tileNoFills: the message says the recorded steps entered no form data (never \"no steps recorded\")",
        /none of (which|them) entered form data/i.test(String(r.message ?? "")) && !/no steps recorded/i.test(String(r.message ?? "")), trace);
    }
    console.log(`  (took ${Math.round((Date.now() - T0) / 1000)} s)`);
    return;
  }
  const vals = app.vals ?? {};
  const trace = `loads=${JSON.stringify(app.loads)} vals=${JSON.stringify(vals)} calls=${JSON.stringify(calls.map((c) => (c.hint ? `${c.page}: ${c.hint.slice(0, 90)}` : c.page)))} ` +
    `steps=${JSON.stringify(steps.map((s) => `${s.action}:${String(s.note ?? "").slice(0, 40)}`))} misses=${JSON.stringify(r.requiredFieldMisses ?? [])} ` +
    `message=${String(r.message ?? "").slice(0, 240)}`;
  check(`${mode}: the walk reaches review`, r.reachedReview === true && app.resume === "review", trace);
  if (mode !== "stubborn") {
    check(`${mode}: MUST-FILL the Preparer's Name, Address and Phone hold values at review`,
      vals.pname === VALUES.Name && vals.paddr === VALUES.Address && vals.pphone === VALUES.Phone, trace);
    check(`${mode}: no required miss reported`, (r.requiredFieldMisses ?? []).length === 0, trace);
  }
  if (mode === "entry") {
    check("entry: the menu toggle is never clicked inside the entered application", (app.burger ?? 0) === 0, trace);
    check("entry: the application page is loaded once per form (no reload by the entry pass)",
      JSON.stringify(app.loads) === JSON.stringify(["welcome", "preparer", "review"]), trace);
    const nextAt = steps.findIndex((s) => s.action === "click" && /next/i.test(String(s.note ?? "")));
    const firstFill = steps.findIndex((s) => s.action === "fill");
    check("entry: Welcome's Next is a recorded step, before the first Preparer fill", nextAt >= 0 && firstFill > nextAt, trace);
  }
  if (mode === "moved") {
    check("moved: the stale Welcome plan is never applied to Preparer (Preparer is planned)", calls.some((c) => c.page === "preparer"), trace);
    check("moved: the move is named in the review hand-off notes",
      (r.reviewHandoffNotes ?? []).some((n) => /moved from .*without a recorded step/i.test(n) && /Preparer Information/.test(n)),
      `notes=${JSON.stringify(r.reviewHandoffNotes ?? [])}`);
  }
  if (mode === "blank" || mode === "stubborn") {
    const prep = calls.filter((c) => c.page === "preparer");
    const told = prep.filter((c) => /still blank/i.test(c.hint));
    check(`${mode}: the page is re-planned exactly once, and the re-plan names the blank`,
      told.length === 1 && /\bName\b/.test(told[0].hint) && !/\bAddress\b|\bPhone\b/.test(told[0].hint) && !/\bName\b/.test(prep[0].hint), trace);
  }
  if (mode === "stubborn") {
    check("stubborn: the blank the re-plan could not fill is still reported", (r.requiredFieldMisses ?? []).some((m) => /^name\b/i.test(m)), trace);
    check("stubborn: what the planner did fill holds", vals.paddr === VALUES.Address && vals.pphone === VALUES.Phone, trace);
  }
  console.log(`  (took ${Math.round((Date.now() - T0) / 1000)} s)`);
}

try {
  for (const m of (process.env.ONLY_MODES ? process.env.ONLY_MODES.split(",") : ["entry", "moved", "blank", "stubborn", "tile", "tileNoFills", "lateSig", "sigOnlyReview"]) as Mode[]) await walk(m);
} finally {
  server.close();
  fs.rmSync(process.env.AUTOLEARN_RUN_DIR!, { recursive: true, force: true });
}
if (failures) { console.error(`\n${failures} learner page-changed check(s) FAILED.`); process.exit(1); }
console.log("\nAll learner page-changed checks passed (real Chromium).");
process.exit(0);
