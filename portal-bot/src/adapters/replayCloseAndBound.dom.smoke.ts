// #232 — A REPLAY'S CLOSING STEP SAYS WHERE IT STOPPED, AND A STEP WHOSE CONTROL IS NOT ON THE PAGE
// FAILS NAMED WITHIN A BOUND, in real Chromium through the REAL runner (stageWithRecipe: login ->
// open -> fill (replay) -> upload -> stopAtReview) and the REAL outcome (derivePortalRunOutcome).
//
// Live 2026-11-14 (six scratch replays, each stopped at review, nothing filed): every failed run
// closed with "Human review required ... The recipe staged Recipe: City of ... to the review screen"
// — Meridian's after ZERO steps (its entry goto was refused). Tigard's "Address Type" select (no
// element matched) spent 127 s of a 2-minute stall budget, Boise's "Building" click 170 s of 3, and
// both ended as a stall instead of as the step that could not find its control.
//
//   C  the closing step
//      MUST-PASS    a recipe that fails at step 0 (the Meridian shape: its entry goto leaves the
//                   recipe's portal and is refused) closes "STOPPED at step 1 of 2 ... before
//                   reaching the review screen", never "Human review required" / "staged ... to the
//                   review screen"; the run is 'failed' with the step's own reason.
//      MUST-PASS    a recipe that reaches its stopForReview keeps today's closing sentence and is
//                   awaiting_human_submit.
//   B  the bound (the production TARGET_APPEAR_MS, 15 s; the stall budget 90 s so a run without the
//      fix ends as a stall instead of running on for many minutes)
//      MUST-PASS    a click whose target never exists (Boise's shape) fails within the bound, named,
//                   at its own step, and the closing step says so.
//      MUST-PASS    a select whose target never exists (Tigard's shape) fails within the bound, named.
//      MUST-PASS    a fill (with a value) whose target never exists fails within the bound, named.
//      MUST-PASS    a recorded POLICY DEFAULT select whose question is not asked is SKIPPED (not failed)
//                   within the bound, named "not asked", and the run goes on.
//   K  what the bound must not take away. Each late control mounts AFTER its step has begun (past
//      the goto's own controls wait — a page whose next step types gets up to 12 s of it, so those
//      pages carry an input the wait is satisfied by), so the step's own wait for it is what lands
//      it: each case first checks the step took >= 4 s.
//      MUST-KEEP    a select whose options load ~2 s after the page lands still lands its value.
//      MUST-KEEP    a link that appears ~9 s after the page lands is still clicked.
//      MUST-KEEP    a select control that appears ~7 s after the page lands still lands its value.
//      MUST-KEEP    a POLICY DEFAULT select that mounts ~7 s after the page lands (PacifiCorp recipe
//                   32f3d2b2 step 117's exact step) is answered at its own step, never skipped as
//                   "not asked" (#232 review: the first cut skipped it on a first look).
//      MUST-KEEP    a run carried off its entry URL at the start (a login redirect, Coos Bay's shape)
//                   still goes back to that URL once and finds its control there.
//
//   npx tsx portal-bot/src/adapters/replayCloseAndBound.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { stageWithRecipe } from "../index";
import { derivePortalRunOutcome, extractStageFailureMessage } from "../../../backend/src/repository";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.AUTOLEARN_SAVE_SETTLE_MS = "1";
process.env.PORTAL_HEADLESS = "true";

let failures = 0;
let passes = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { passes++; console.log(`  ok   - ${label}`); }
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// The bound this smoke proves: RecipeAdapter.TARGET_APPEAR_MS. Written out, not read off the class,
// so a run with the fix removed fails on the defect (the step's elapsed time), not on an undefined.
const BOUND_MS = 15_000;
/** Slack over the bound for what a missing step legitimately does around its wait: the first
 *  resolution, the failure capture, the heal look. */
const SLACK_MS = 15_000;
const STALL_MS = 90_000;

// Every page carries a sign-out control: the account is signed in (login's positive signal), so the
// run goes straight to the recipe.
const shell = (title: string, body: string): string => `<!doctype html><html><head><title>${title}</title></head><body><header><a href="/logout">Sign Out</a></header>${body}</body></html>`;
const PAGES: Record<string, string> = {
  // A landing with no login and nothing the recipes below look for (Boise's dashboard / Tigard's
  // application assistant: the recorded control is simply not on it).
  "/start": shell("Permits", `<h1>Permits and Licensing</h1><p>Welcome. Choose a service below.</p>
<label for="q">Search applications</label> <input id="q" name="q"> <button id="go" type="button">Search</button>
<nav><span class="dropdown-toggle">Search</span><div class="dropdown-menu" style="display:none"><a href="/elsewhere">Building</a></div></nav>`),
  "/review": shell("Review", `<h1>Review and Submit</h1><p>Please review your application before you submit it. Verify every field below.</p>
<table><tr><th>Applicant</th><td>Fixture Applicant</td></tr><tr><th>Work</th><td>Residential solar PV</td></tr></table>
<button id="submit" type="button">Submit Application</button>`),
  // Options arrive ~2 s after the page lands (a cascade / an XHR-filled list).
  "/late-options": shell("Location", `<h1>Location</h1>
<label for="addressType">Address Type</label> <select id="addressType" name="addressType"><option value="">--Select--</option></select>
<script>setTimeout(function(){ var s = document.getElementById('addressType'); ['Location','Mailing'].forEach(function(t){ var o = document.createElement('option'); o.value = t; o.textContent = t; s.appendChild(o); }); }, 2000);</script>`),
  // The link renders ~9 s after the page lands (a client-rendered menu). The goto before a click
  // waits 3 s for controls, so the click step has begun well before the link exists.
  "/late-link": shell("Permits", `<h1>Permits and Licensing</h1><div id="menu"></div>
<script>setTimeout(function(){ document.getElementById('menu').innerHTML = '<a href="/form">Building</a>'; }, 9000);</script>`),
  "/form": shell("Building application", `<h1>Building application</h1><label for="desc">Description of work</label> <input id="desc" name="desc">`),
  // The select itself renders ~7 s after the page lands (an SPA section mounting). The reference box
  // satisfies the goto's controls wait at once, so the select step has begun before its control exists.
  "/late-select": shell("Location", `<h1>Location</h1><label for="ref">Reference</label> <input id="ref" name="ref"><div id="sec"></div>
<script>setTimeout(function(){ document.getElementById('sec').innerHTML = '<label for="addressType">Address Type</label> <select id="addressType" name="addressType"><option value="">--Select--</option><option value="Location">Location</option><option value="Mailing">Mailing</option></select>'; }, 7000);</script>`),
  // PacifiCorp's AC-disconnect policy question, mounting ~7 s after the page lands (a section the page
  // loads with its own request). Same reference box, same reason.
  "/policy-late": shell("Disconnect Requirements", `<h1>Disconnect Requirements</h1><label for="ref">Reference</label> <input id="ref" name="ref"><div id="sec"></div>
<script>setTimeout(function(){ document.getElementById('sec').innerHTML = '<label for="E44U32NXYNWGInput">Are the AC disconnect(s) for this installation within the states required distance?</label> <select id="E44U32NXYNWGInput" name="acDisc"><option value="">Please select...</option><option value="Yes">Yes</option><option value="No">No</option></select>'; }, 7000);</script>`),
  // The page the recipe's entry URL serves once the session is where it should be (Coos Bay's Apply).
  "/entry": shell("Applications", `<h1>Applications</h1><p>Start a new application.</p><a href="/form">Apply</a>`),
  // Where a login redirect lands instead: the signed-in home, with no Apply on it.
  "/home": shell("Home", `<h1>Home</h1><p>Welcome back. Your recent activity is below.</p>`),
};
/** The FIRST request for the recipe's entry URL is redirected home (a login redirect); later ones are served. */
let entryRequests = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/entry" && entryRequests++ === 0) {
    res.writeHead(302, { location: "/home" });
    res.end();
    return;
  }
  const html = PAGES[url.pathname];
  res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(html ?? shell("Not found", "<p>not found</p>"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const recipeOf = (steps: RecipeStep[], portalUrl = `${base}/start`): PortalRecipe => ({
  id: "replay-close-bound-smoke", scopeType: "ahj", profileKey: "id|fixtureville|", state: "ID", ahj: "City of Fixtureville", utility: "",
  portalPlatform: "fixture", portalUrl, status: "complete", version: 1,
  steps, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
});
const gotoStep = (p: string): RecipeStep => ({ action: "goto", value: `${base}${p}`, note: "entry url" });
const REVIEW: RecipeStep = { action: "stopForReview" };
// Boise's step 1 (live recipe 15d6d558): the application link the dashboard does not carry.
const CLICK_BUILDING: RecipeStep = { action: "click", selector: { role: "link", name: "Building", exact: true }, note: "navigate to application: Building" };
// Tigard's step 5 (live recipe 92c16d00): the Address Type select, label + css fallback + section.
const SELECT_ADDRESS_TYPE: RecipeStep = {
  action: "select", selector: { label: "Address Type", fallbacks: [{ css: "#addressTypeSelect" }] }, note: "Address Type", value: "Location",
  fingerprint: { id: "addressTypeSelect", name: "addressTypeSelect", ariaLabel: "Address Type", section: "1 Locations" },
} as RecipeStep;
const SELECT_LATE: RecipeStep = { action: "select", selector: { label: "Address Type", fallbacks: [{ css: "#addressType" }] }, note: "Address Type", value: "Location" };
const FILL_DESC: RecipeStep = { action: "fill", selector: { label: "Description of work", fallbacks: [{ css: "#desc" }] }, note: "Description of work", value: "Residential solar PV" };
// PacifiCorp recipe 32f3d2b2 step 117, exactly as recorded.
const POLICY_NOTE = "policy default: Are the AC disconnect(s) for this installation within the states required distan → Yes";
const POLICY_SELECT: RecipeStep = { action: "select", phase: "fill", selector: { css: "#E44U32NXYNWGInput" }, value: "Yes", note: POLICY_NOTE } as RecipeStep;
// Coos Bay's first real step: the Apply the entry URL carries and the redirected home does not.
const CLICK_APPLY: RecipeStep = { action: "click", selector: { role: "link", name: "Apply", exact: true }, note: "application entry: Apply" };

type Step = { ok?: boolean; message?: unknown; data?: Record<string, unknown> };
async function staged(name: string, steps: RecipeStep[], portalUrl?: string) {
  const t0 = Date.now();
  const r = await stageWithRecipe(recipeOf(steps, portalUrl), { id: `p-${name}` } as ProjectRecord, {}, {}, [], { headless: true, stallTimeoutMs: STALL_MS });
  const ms = Date.now() - t0;
  const all = (Array.isArray(r.steps) ? r.steps : []) as Step[];
  const fill = all[2] ?? {};
  const closing = all[all.length - 1] ?? {};
  const data = (fill.data ?? {}) as { trace?: Array<{ i: number; outcome: string }>; slowSteps?: Array<{ i: number; ms: number }>; fieldsVerified?: string[]; failedStepIndex?: number; replayStalled?: unknown; executed?: number; skipped?: string[]; driftWarnings?: string[] };
  const outcome = derivePortalRunOutcome(r);
  const out = {
    r, ms, outcome, data, fillMsg: String(fill.message ?? ""), closeMsg: String(closing.message ?? ""), closing,
    failure: extractStageFailureMessage(r),
    stepMs: (i: number): number => (data.slowSteps ?? []).find((s) => s.i === i)?.ms ?? 0,
    traceOf: (i: number): string => (data.trace ?? []).find((t) => t.i === i)?.outcome ?? "(not reached)",
  };
  console.log(`  [${name}] ok=${String(r.ok)} status=${outcome.status} ${ms} ms\n         fill:  ${out.fillMsg.replace(/\s+/g, " ").slice(0, 220)}\n         close: ${out.closeMsg.slice(0, 260)}`);
  return out;
}

console.log("\nC. the closing step says where the run stopped");
{
  // The Meridian shape: the entry goto leaves the recipe's portal (127.0.0.1 -> localhost) and is refused.
  const o = await staged("fails at step 0", [{ action: "goto", value: `http://localhost:${port}/start`, note: "entry url" }, REVIEW]);
  check("MUST-PASS the closing step says it STOPPED at step 1 of 2, before reaching the review screen, with the step's own reason",
    /the replay STOPPED at step 1 of 2 \("entry url"\) before reaching the review screen: .*goto leaves the recipe's portal/.test(o.closeMsg), o.closeMsg.slice(0, 400));
  check("MUST-PASS ...and never 'Human review required' / 'staged ... to the review screen' / 'click submit manually'",
    !/Human review required|staged .* to the review screen|click submit manually/i.test(o.closeMsg), o.closeMsg.slice(0, 400));
  check("MUST-PASS the run is 'failed' with the refused step's reason, nothing executed", o.outcome.status === "failed" && /goto leaves the recipe's portal/.test(o.failure) && o.traceOf(0) === "FAILED",
    `status=${o.outcome.status} trace0=${o.traceOf(0)} failure=${o.failure.slice(0, 200)}`);
}
{
  const o = await staged("reaches stopForReview", [gotoStep("/review"), REVIEW], `${base}/review`);
  check("MUST-PASS a run that reaches its stopForReview keeps today's sentence ('staged ... to the review screen') and is awaiting_human_submit",
    o.r.ok === true && o.outcome.status === "awaiting_human_submit" && /^Human review required\. .*The recipe staged .* to the review screen\./.test(o.closeMsg) && !/STOPPED at step/.test(o.closeMsg),
    `ok=${String(o.r.ok)} status=${o.outcome.status} ${o.closeMsg.slice(0, 300)}`);
}

console.log(`\nB. a step whose control is not on the page fails named within ${BOUND_MS / 1000} s (+${SLACK_MS / 1000} s slack)`);
{
  const o = await staged("click target never exists (Boise)", [gotoStep("/start"), CLICK_BUILDING, REVIEW]);
  const ms = o.stepMs(1);
  check(`MUST-PASS the click fails within the bound: step took ${ms} ms (>= ${BOUND_MS}, < ${BOUND_MS + SLACK_MS}), never a stall`,
    ms >= BOUND_MS && ms < BOUND_MS + SLACK_MS && !o.data.replayStalled && !/Replay stalled/.test(o.fillMsg), `step ms=${ms} run ms=${o.ms} ${o.fillMsg.slice(0, 200)}`);
  check("MUST-PASS ...named: the step, and that no control on the page matches what was recorded",
    /^Recipe step failed \(click — navigate to application: Building\): no control on this page matches "navigate to application: Building" \(recorded as role:link name:"Building"\) — waited 1\d s/.test(o.fillMsg)
      && o.data.failedStepIndex === 1 && o.traceOf(1) === "FAILED", o.fillMsg.slice(0, 300));
  check("MUST-PASS ...and the closing step says it STOPPED at step 2 of 3 before reaching the review screen",
    /the replay STOPPED at step 2 of 3 \("navigate to application: Building"\) before reaching the review screen: no control on this page matches/.test(o.closeMsg) && !/to the review screen\. Verify/.test(o.closeMsg), o.closeMsg.slice(0, 300));
}
{
  const o = await staged("select target never exists (Tigard)", [gotoStep("/start"), SELECT_ADDRESS_TYPE, REVIEW]);
  const ms = o.stepMs(1);
  check(`MUST-PASS the select fails within the bound: step took ${ms} ms (>= ${BOUND_MS}, < ${BOUND_MS + SLACK_MS}), never a stall`,
    ms >= BOUND_MS && ms < BOUND_MS + SLACK_MS && !o.data.replayStalled && !/Replay stalled/.test(o.fillMsg), `step ms=${ms} run ms=${o.ms} ${o.fillMsg.slice(0, 200)}`);
  check("MUST-PASS ...named, at its own step (FAILED, not SKIPPED)",
    /^Recipe step failed \(select — Address Type\): no control on this page matches "Address Type" \(recorded as label:"Address Type" \| css:#addressTypeSelect\)/.test(o.fillMsg)
      && o.data.failedStepIndex === 1 && o.traceOf(1) === "FAILED", `trace1=${o.traceOf(1)} ${o.fillMsg.slice(0, 300)}`);
}
{
  const o = await staged("fill target never exists", [gotoStep("/start"), FILL_DESC, REVIEW]);
  const ms = o.stepMs(1);
  check(`MUST-PASS the fill fails within the bound: step took ${ms} ms (>= ${BOUND_MS}, < ${BOUND_MS + SLACK_MS}), never a stall`,
    ms >= BOUND_MS && ms < BOUND_MS + SLACK_MS && !o.data.replayStalled && !/Replay stalled/.test(o.fillMsg), `step ms=${ms} run ms=${o.ms} ${o.fillMsg.slice(0, 200)}`);
  check("MUST-PASS ...named, at its own step",
    /^Recipe step failed \(fill — Description of work\): no control on this page matches "Description of work" \(recorded as label:"Description of work" \| css:#desc\)/.test(o.fillMsg)
      && o.data.failedStepIndex === 1 && o.traceOf(1) === "FAILED", `trace1=${o.traceOf(1)} ${o.fillMsg.slice(0, 300)}`);
}
{
  // A policy question the portal does not ask this project is not missing information: skipped, named.
  const o = await staged("policy select not asked", [gotoStep("/start"), POLICY_SELECT, REVIEW]);
  const ms = o.stepMs(1);
  const notAsked = (o.data.driftWarnings ?? []).some((w) => w.startsWith("policy question not asked for this project — skipped: policy default: Are the AC disconnect"));
  const skipped = (o.data.skipped ?? []).some((s) => s.startsWith("policy default: Are the AC disconnect"));
  check(`MUST-PASS the unasked policy select is SKIPPED within the bound (step ${ms} ms, < ${BOUND_MS + SLACK_MS}), named "not asked", and the run goes on`,
    ms < BOUND_MS + SLACK_MS && skipped && notAsked && !/Recipe step failed/.test(o.fillMsg) && !o.data.replayStalled && !/Replay stalled/.test(o.fillMsg),
    `step ms=${ms} skipped=${JSON.stringify(o.data.skipped)} notAsked=${String(notAsked)} ${o.fillMsg.slice(0, 200)}`);
}

// A clean run's data carries no trace: "executed 2" (the goto and the step) is the step done. These
// pages are not review pages, so the run then stops on them, named (the honest stop of runs-finish 3).
console.log("\nK. what the bound must not take away");
{
  const o = await staged("select options load after 2 s", [gotoStep("/late-options"), SELECT_LATE, REVIEW], `${base}/late-options`);
  check("MUST-KEEP the select still lands its value (executed, verified), no step failed",
    o.data.executed === 2 && (o.data.fieldsVerified ?? []).includes("Address Type") && !/Recipe step failed/.test(o.fillMsg) && !/STOPPED at step/.test(o.closeMsg),
    `executed=${String(o.data.executed)} verified=${JSON.stringify(o.data.fieldsVerified)} ${o.fillMsg.slice(0, 200)}`);
}
// The step >= 4 s is the precondition (slowSteps records nothing shorter): the control was not on the
// page when its step began, so the step's own wait for it is what landed it.
{
  const o = await staged("link appears after 9 s", [gotoStep("/late-link"), CLICK_BUILDING, REVIEW], `${base}/late-link`);
  check(`MUST-KEEP the late link is still clicked: the step waited for it (${o.stepMs(1)} ms >= 4000), executed, and the run ended on the page it opens`,
    o.stepMs(1) >= 4000 && o.data.executed === 2 && /STOPPED on "Building application"/.test(o.fillMsg) && !/Recipe step failed/.test(o.fillMsg) && !/STOPPED at step/.test(o.closeMsg),
    `step ms=${o.stepMs(1)} executed=${String(o.data.executed)} ${o.fillMsg.slice(0, 200)}`);
}
{
  const o = await staged("select control appears after 7 s", [gotoStep("/late-select"), SELECT_LATE, REVIEW], `${base}/late-select`);
  check(`MUST-KEEP the late select still lands its value: the step waited for it (${o.stepMs(1)} ms >= 4000), executed, verified, no step failed`,
    o.stepMs(1) >= 4000 && o.data.executed === 2 && (o.data.fieldsVerified ?? []).includes("Address Type") && !/Recipe step failed/.test(o.fillMsg) && !/STOPPED at step/.test(o.closeMsg),
    `step ms=${o.stepMs(1)} executed=${String(o.data.executed)} verified=${JSON.stringify(o.data.fieldsVerified)} ${o.fillMsg.slice(0, 200)}`);
}
{
  const o = await staged("policy select appears after 7 s", [gotoStep("/policy-late"), POLICY_SELECT, REVIEW], `${base}/policy-late`);
  const verified = (o.data.fieldsVerified ?? []).some((f) => f.startsWith("policy default: Are the AC disconnect"));
  const skipped = (o.data.skipped ?? []).some((s) => s.startsWith("policy default:"));
  const notAsked = (o.data.driftWarnings ?? []).some((w) => /policy question not asked|answered on the way out/.test(w));
  check(`MUST-KEEP the late policy question is answered AT ITS OWN STEP: the step waited for it (${o.stepMs(1)} ms >= 4000), verified, never skipped as "not asked"`,
    o.stepMs(1) >= 4000 && o.data.executed === 2 && verified && !skipped && !notAsked && o.traceOf(1) !== "SKIPPED" && !/Recipe step failed/.test(o.fillMsg),
    `step ms=${o.stepMs(1)} executed=${String(o.data.executed)} trace1=${o.traceOf(1)} verified=${JSON.stringify(o.data.fieldsVerified)} skipped=${JSON.stringify(o.data.skipped)} drift=${JSON.stringify(o.data.driftWarnings)}`);
}
{
  // The recipe's entry goto is redirected home the first time (a login redirect); its Apply is not
  // there. The one exception to "never reloaded and retried": back to the entry URL, once.
  const o = await staged("carried off the entry URL", [{ action: "goto", value: `${base}/entry`, note: "entry url" }, CLICK_APPLY, REVIEW]);
  const returned = (o.data.driftWarnings ?? []).some((w) => /rather than the recipe's entry URL — returned there before retrying/.test(w));
  check("MUST-KEEP a run carried off its entry URL at the start returns there once and clicks its control (executed, ended on the page it opens)",
    returned && o.data.executed === 2 && /STOPPED on "Building application"/.test(o.fillMsg) && !/Recipe step failed/.test(o.fillMsg) && !/STOPPED at step/.test(o.closeMsg),
    `returned=${String(returned)} entryRequests=${entryRequests} executed=${String(o.data.executed)} ${o.fillMsg.slice(0, 200)}`);
}

server.close();
console.log(`\nreplayCloseAndBound: ${passes} passed, ${failures} failed (of ${passes + failures} checks)`);
if (failures) { console.error(`replayCloseAndBound: ${failures} check(s) FAILED`); process.exit(1); }
console.log("replayCloseAndBound: all checks passed (real Chromium, the real runner)");
