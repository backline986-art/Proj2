// A WRITE THAT DID NOT APPLY IS NOT A RECORDED STEP, AND A BLANK THE RE-PLAN FILLED IS NOT REPORTED.
//
// Seen on a supervised learn of a permit wizard: the planner chose a value a required native
// <select> does not offer. The walk said so (select_value_not_offered), the read-back reported the
// select as not held, the page's one re-plan picked an offered value, and the review page showed
// it. Two things were then wrong:
//   (a) the recorded steps kept BOTH selects of that control on one page (the one that never
//       applied, then the one that did). A replay would select a value that is not offered, and
//       the shared sequence check rightly refuses two different writes to one control on a page;
//   (b) the run still ended "1 required field(s) are blank ... TYPED BUT NOT KEPT", and its
//       required misses still named the select the re-plan had filled.
//
// This page has that shape, plus the two neighbours of the same rule:
//   - "Kind of work *"   required native select: Addition / New / Replacement (the planner wants
//                        a value that is not in the list);
//   - "Building use"     optional native select with no placeholder (it always holds an option);
//                        the planner wants a value it does not offer;
//   - "Access contact *" required box the page takes back unless it reads as an e-mail address
//                        (a write that is typed and not kept);
//   - "Project name *"   a plain required box (the control: its step must stay).
//
//   [fixed]  the re-plan answers the select with an offered value and the box with one the page
//            keeps. MUST-PASS: one recorded write per control, holding what the page holds; no
//            required miss; no "blank" line in the hand-off. MUST-EXCLUDE: any step carrying a
//            value the page never took; any two-writes-one-control finding.
//   [never]  the re-plan cannot do better. MUST-PASS: the two required controls are still
//            reported blank and named, and no option is guessed. MUST-EXCLUDE: a recorded select
//            of a value the list never offered.
//
//   npx tsx portal-bot/src/adapters/unappliedWriteNotRecorded.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner, type LearnPlanRequest } from "./autoLearnAdapter";
import { recipeSequenceProblems } from "../../../shared/src/recipeSequence";
import type { ProjectRecord, RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.ENTRY_SETTLE_MS = "0";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// One address for both screens; state lives in sessionStorage so it survives the reload the page
// uses to move from the form to the review.
const APP = `<!doctype html><html><head><title>Permit Application</title></head><body style="font:14px sans-serif;padding:16px">
  <main id="main"></main>
  <script>
    const st = JSON.parse(sessionStorage.getItem("app") || '{"screen":"form","vals":{},"submits":0}');
    const save = () => sessionStorage.setItem("app", JSON.stringify(st));
    const main = document.getElementById("main");
    if (st.screen === "form") {
      main.innerHTML = '<h2>Project details</h2><p>Step 1 of 2. Describe the work.</p>' +
        '<div><label for="kind">Kind of work *</label><select id="kind" name="kind" required aria-required="true">' +
          '<option value="">--Select--</option><option value="A">Addition</option><option value="N">New</option><option value="R">Replacement</option></select></div>' +
        '<div><label for="use">Building use</label><select id="use" name="use">' +
          '<option value="D">Detached house</option><option value="X">Duplex</option></select></div>' +
        '<div><label for="contact">Access contact *</label><input id="contact" name="contact" required aria-required="true"></div>' +
        '<div><label for="pname">Project name *</label><input id="pname" name="pname" required aria-required="true"></div>' +
        '<button type="button" id="next">Next</button>';
      for (const id of ["kind", "use", "contact", "pname"]) {
        const el = document.getElementById(id);
        if (st.vals[id] !== undefined) el.value = st.vals[id];
        const keep = () => {
          // The page's own validation takes back an access contact that is not an e-mail address.
          if (id === "contact" && el.value && el.value.indexOf("@") < 0) el.value = "";
          st.vals[id] = el.value; save();
        };
        el.addEventListener("change", keep);
        el.addEventListener("blur", keep);
      }
      // This page lets an incomplete form through; nothing here validates.
      document.getElementById("next").addEventListener("click", () => { st.screen = "review"; save(); location.reload(); });
    } else {
      main.innerHTML = '<h2>Review</h2><p>Step 2 of 2. Review all information before you submit.</p>' +
        '<p id="shown">' + ["kind", "use", "contact", "pname"].map((k) => k + ": " + (st.vals[k] || "(blank)")).join(" / ") + '</p>' +
        '<button type="button" id="submit">Submit Application</button>';
      document.getElementById("submit").addEventListener("click", () => { st.submits++; save(); });
    }
  </script>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(APP); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const KIND = /^Kind of work/i;
const USE = /^Building use/i;
const CONTACT = /^Access contact/i;
const PNAME = /^Project name/i;
const NOT_OFFERED_KIND = "Alteration";
const NOT_OFFERED_USE = "Townhouse";
const NOT_KEPT_CONTACT = "ZZ Test Owner";
const KEPT_CONTACT = "zz.test.owner@example.test";
const PROJECT_NAME = "ZZ Test Project, 100 Test St";

type Mode = "fixed" | "never";
type Ev = Record<string, unknown>;
const idxOf = (req: LearnPlanRequest, re: RegExp): number => req.fields.findIndex((f) => re.test(String(f.label ?? "").trim()));
const noteOf = (s: RecipeStep): string => String(s.note ?? "");
const writes = (steps: RecipeStep[], re: RegExp): RecipeStep[] =>
  steps.filter((s) => (s.action === "fill" || s.action === "select") && re.test(noteOf(s)));

async function walk(mode: Mode): Promise<void> {
  console.log(`\n[${mode}]`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  ctx.setDefaultTimeout(8000);
  const page = await ctx.newPage();
  const hints: string[] = [];
  const planner: LearnPlanner = async (req) => {
    if (/review all information/i.test(req.bodyText)) {
      const submitIdx = req.fields.findIndex((f) => f.fieldType === "button" && /^submit application$/i.test(String(f.label ?? "").trim()));
      return { fills: [], atReview: true, ...(submitIdx >= 0 ? { finalSubmitSelectorIndex: submitIdx } : {}) };
    }
    const nextIdx = req.fields.findIndex((f) => f.fieldType === "button" && /^next$/i.test(String(f.label ?? "").trim()));
    const hint = String(req.recoveryHint ?? "");
    hints.push(hint);
    const told = /still blank/i.test(hint);
    // Told which required controls are blank, the planner answers them again: with what the page
    // will take ([fixed]) or with no better an answer ([never]).
    const answers: Array<[RegExp, string]> = !told
      ? [[KIND, NOT_OFFERED_KIND], [USE, NOT_OFFERED_USE], [CONTACT, NOT_KEPT_CONTACT], [PNAME, PROJECT_NAME]]
      : mode === "fixed"
        ? [[KIND, "New"], [CONTACT, KEPT_CONTACT]]
        : [[KIND, NOT_OFFERED_KIND], [CONTACT, "ZZ Test Owner Two"]];
    const fills = answers.map(([re, value]) => ({ selectorIndex: idxOf(req, re), value })).filter((f) => f.selectorIndex >= 0);
    return { fills, atReview: false, ...(nextIdx >= 0 ? { advanceSelectorIndex: nextIdx } : {}) };
  };
  await page.goto(`${base}/`);
  const adapter = new AutoLearnAdapter("Unapplied Write Smoke", planner, { maxPages: 6 });
  (adapter as unknown as { page: unknown }).page = page;
  const events: Ev[] = [];
  const holder = adapter as unknown as { debug?: { event: (e: Ev) => void } };
  if (holder.debug && typeof holder.debug.event === "function") {
    const orig = holder.debug.event.bind(holder.debug);
    holder.debug.event = (e) => { events.push(e); orig(e); };
  }
  let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
  try { r = await adapter.learn({} as never, {} as ProjectRecord); }
  catch (e) { check(`${mode}: the learn runs`, false, String(e).slice(0, 300)); }
  const app = await page.evaluate(() => JSON.parse(sessionStorage.getItem("app") || "{}")).catch(() => ({})) as {
    screen?: string; vals?: Record<string, string>; submits?: number;
  };
  await browser.close().catch(() => null);
  if (!r) return;
  const steps: RecipeStep[] = r.steps ?? [];
  const vals = app.vals ?? {};
  const misses = r.requiredFieldMisses ?? [];
  const message = String(r.message ?? "");
  const shownSteps = steps.map((s) => `${s.action}:${noteOf(s).slice(0, 30)}=${JSON.stringify(s.value ?? s.field ?? "")}${s.isFinalSubmit ? " FINAL" : ""}`);
  // What the run did, printed once per mode; each failing check then points at it.
  console.log(`  run: vals=${JSON.stringify(vals)}\n       steps=${JSON.stringify(shownSteps)}\n       misses=${JSON.stringify(misses)} hints=${JSON.stringify(hints.map((h) => h.slice(0, 40)))}\n` +
    `       events=${JSON.stringify(events.filter((e) => /select_value|unoffered|fills_did|required_|superseded|did_not_hold/.test(String(e.type))))}\n       message=${message.slice(0, 400)}`);
  const trace = "see the run line above";
  const problems = recipeSequenceProblems(steps);
  const kindWrites = writes(steps, KIND);
  const contactWrites = writes(steps, CONTACT);

  // The fixture is exercising the path it claims to.
  check(`${mode}: the walk reaches review`, r.reachedReview === true && app.screen === "review", trace);
  check(`${mode}: the walk said the select does not offer the value, with the list it does offer`,
    events.some((e) => e.type === "select_value_not_offered" && KIND.test(String(e.label ?? "")) && e.wanted === NOT_OFFERED_KIND
      && JSON.stringify(e.offered) === JSON.stringify(["Addition", "New", "Replacement"])), trace);
  check(`${mode}: the page was re-planned once for its required blanks, both named`,
    hints.filter((h) => /still blank/i.test(h)).length === 1 && hints.some((h) => /still blank/i.test(h) && /Kind of work/.test(h) && /Access contact/.test(h)), trace);
  // Safety: the review's submit is recorded for a person and never clicked.
  check(`${mode}: the final submit is recorded flagged and was not clicked`,
    steps.filter((s) => s.isFinalSubmit === true).length === 1 && (app.submits ?? 0) === 0, trace);
  // The control: a write that applied is recorded exactly as before.
  check(`${mode}: MUST-PASS the plain required box keeps its one recorded fill`,
    writes(steps, PNAME).length === 1 && writes(steps, PNAME)[0].value === PROJECT_NAME && vals.pname === PROJECT_NAME, trace);
  // A value the list never offered is never a step, fixed later or not, required or not.
  check(`${mode}: MUST-EXCLUDE no recorded step selects a value the required select never offered`,
    !steps.some((s) => s.value === NOT_OFFERED_KIND), trace);
  check(`${mode}: MUST-EXCLUDE no recorded step selects a value the optional select never offered`,
    writes(steps, USE).length === 0 && !steps.some((s) => s.value === NOT_OFFERED_USE), trace);
  check(`${mode}: the optional select still holds the option it had (nothing guessed)`, (vals.use ?? "D") === "D", trace);

  if (mode === "fixed") {
    check("fixed: MUST-PASS the page was left with the re-plan's answers", vals.kind === "N" && vals.contact === KEPT_CONTACT, trace);
    check("fixed: MUST-PASS the required select is recorded once, with the value that applied",
      kindWrites.length === 1 && kindWrites[0].action === "select" && kindWrites[0].value === "New", trace);
    check("fixed: MUST-PASS the box the page took back is recorded once, with the value it kept",
      contactWrites.length === 1 && contactWrites[0].value === KEPT_CONTACT, trace);
    check("fixed: MUST-EXCLUDE the value the page took back is not a recorded step", !steps.some((s) => s.value === NOT_KEPT_CONTACT), trace);
    check("fixed: MUST-EXCLUDE the shared sequence check finds no two writes to one control on a page",
      !problems.some((p) => p.kind === "conflicting_write"), JSON.stringify(problems.map((p) => p.detail)));
    check("fixed: MUST-EXCLUDE no required miss is reported for a page left complete", misses.length === 0, trace);
    check("fixed: MUST-EXCLUDE the hand-off does not say a field is blank or was not kept",
      !/required field\(s\) are blank|TYPED BUT NOT KEPT|NEVER FILLED/i.test(message), message);
  } else {
    check("never: MUST-PASS no option is guessed for the required select; the box is still empty", (vals.kind ?? "") === "" && (vals.contact ?? "") === "", trace);
    check("never: MUST-PASS the required select is still reported blank", misses.some((m) => KIND.test(m)), trace);
    check("never: MUST-PASS the box the page took back is still reported blank", misses.some((m) => CONTACT.test(m)), trace);
    check("never: MUST-PASS the hand-off still says required fields are blank and names both",
      /2 required field\(s\) are blank/i.test(message) && /Kind of work/.test(message) && /Access contact/.test(message), message);
    check("never: MUST-PASS the box that was typed and taken back is still said to be typed and not kept",
      /TYPED BUT NOT KEPT[^.]*Access contact/.test(message), message);
    check("never: MUST-EXCLUDE the required select has no recorded step at all", kindWrites.length === 0, trace);
  }
}

try {
  for (const m of (process.env.ONLY_MODES ? process.env.ONLY_MODES.split(",") : ["fixed", "never"]) as Mode[]) await walk(m);
} finally {
  server.close();
}
if (failures) { console.error(`\nunappliedWriteNotRecorded.dom.smoke: ${failures} FAILURE(S)`); process.exit(1); }
console.log("\nunappliedWriteNotRecorded.dom.smoke: PASS (real Chromium)");
process.exit(0);
