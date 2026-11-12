// A STEP-NAVIGATOR BUBBLE IS NEVER THE FINAL SUBMIT (#188). Live, 2026-11-12: step 1 of a 7-step
// AngularJS-Material wizard (md-steppers-header role="list", each step a
// button.md-stepper-indicator[role=listitem], the current one carrying the whole class token
// "md-active", step 7 titled "Review and Submit"). The planner said atReview with the "7" bubble as
// its final submit; nothing demoted it, the walk locked step 1 down as the review page and never
// added the location. And its navigate — the clickable "Add Location" card, a div[role=button] whose
// text runs on into a hidden "An address is required." — was clicked by a label lookup that found
// nothing (navigate_control_absent).
//
// A synthetic page of the same SHAPE (no portal name, no real data), driven through the real
// AutoLearnAdapter.learn() with a planner stub that names the "7" bubble as the final submit:
//
// MUST-PASS  tigardStep1 — step 1 active, a location card + a disabled select, Save Draft / Next.
//            The walk does NOT stop on step 1, never clicks a bubble, clicks the card through the
//            element it read, proceeds with Next, and stops at step 7 (review) with 0 filing POSTs.
//            planner_review_demoted_navigator is emitted for step 1; no recorded step is a bubble.
// MUST-STAY-REVIEW (each stops at review, clicks nothing past it, 0 filing POSTs):
//   step7Bubble   — step 7 ("Review and Submit") is the md-active step, a real Submit on the page,
//                   the planner names the bubble (a KNOWN GAP is printed, not failed: the bubble
//                   is still recorded as the final submit there, as on main — see the check).
//   step7Submit   — the same page, the planner names the real Submit (recorded, never clicked).
//   noFillable    — step 1 active, nothing to fill on the page, the planner names the bubble.
//   textReview    — step 1 active, a live box, but the page's own title says "Step 7: Review".
//   summaryContinue (adversarial review B1) — a real summary page ("APPLICATION SUMMARY", no review
//                   words outside the step bar), NO current-step marker anywhere, a live footer
//                   language <select> (readOnlyPageInPage false), and a "Continue" that FILES to a
//                   URL with no filing word. The planner names the bubble. A live box alone once
//                   demoted this page and the fallback advance clicked Continue: the POST must
//                   never arrive.
//
// Run: npx tsx portal-bot/src/adapters/stepperBubbleNotSubmit.dom.smoke.ts [variant,...]
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

type Variant = "tigardStep1" | "step7Bubble" | "step7Submit" | "noFillable" | "textReview" | "summaryContinue";
const TITLES = ["Locations", "Type", "Contacts", "More Info", "Attachments", "Signature", "Review and Submit"];
const SUBMIT = "/api/selfservice/permit/submit";
const DRAFT = "/api/selfservice/draft/save";
// summaryContinue's filing POST: no filing word in the URL, so only the walk itself keeps it from firing.
const APPLY = "/api/selfservice/permit/apply/12";

const page = (variant: Variant): string => `<!doctype html><html><head><title>Apply for Permit</title>
<style>
  .md-steppers-header { display: flex; gap: 8px; }
  .md-stepper-indicator { padding: 6px 10px; }
  .card { display: inline-block; border: 1px solid #999; padding: 12px; margin: 8px 0; }
  [hidden] { display: none !important; }
</style></head><body>
<div class="container" id="main-content">
<form id="applyPermitForm" role="form" novalidate>
  <h3 id="applyHeader">Apply for Permit - Residential Solar - Prescriptive</h3>
  <div id="stepper"></div>
  <div id="body"></div>
  <div class="md-step-actions"><div class="row permit-buttons-style">
    <div class="stepper-pull-left"><button type="button" id="draft">Save Draft</button></div>
    <div class="stepper-pull-right"><button type="button" id="next"></button></div>
  </div></div>
  <div id="err"></div>
</form>
</div>
${variant === "summaryContinue" ? `<footer><label for="lang">Language</label> <select id="lang"><option>English</option><option>Espanol</option></select></footer>` : ""}
<script>
var V = ${JSON.stringify(variant)};
var S = { step: (V === "step7Bubble" || V === "step7Submit") ? 7 : V === "summaryContinue" ? 2 : 1, applyPosts: 0, location: false, cardClicks: 0, bubbleClicks: 0, submitClicked: false, desc: "" };
window.__S = S;
var TITLES = ${JSON.stringify(TITLES)};
function stepper(){
  var h = '<div class="md-steppers-header-region"><md-steppers-header class="md-steppers-header md-steppers-horizontal" role="list">';
  for (var i = 0; i < TITLES.length; i++) {
    h += '<button type="button" class="md-stepper-indicator' + (i + 1 === S.step && V !== "summaryContinue" ? ' md-active' : '') + '" role="listitem" data-step="' + (i + 1) + '">\\n'
      + '  <div class="md-stepper-indicator-wrapper">\\n'
      + '    <div class="md-stepper-number"><span>' + (i + 1) + '</span></div>\\n'
      + '    <div class="md-stepper-title"><span>' + TITLES[i] + '</span>\\n      <small class="md-stepper-error-message" hidden></small></div>\\n'
      + '  </div>\\n</button>';
  }
  return h + '</md-steppers-header></div>';
}
function body(){
  if (S.step === 7 && V === "summaryContinue") {
    return '<h3 class="apply-steps-title">APPLICATION SUMMARY</h3>'
      + '<dl><dt>Location</dt><dd>1 Test St</dd><dt>Description</dt><dd>' + (S.desc || "Roof-mounted solar PV") + '</dd></dl>';
  }
  if (S.step === 7) {
    return '<h3 class="apply-steps-title">REVIEW AND SUBMIT</h3><p>Please review your application before submitting.</p>'
      + '<dl><dt>Location</dt><dd>1 Test St</dd><dt>Description</dt><dd>' + (S.desc || "Roof-mounted solar PV") + '</dd></dl>';
  }
  if (S.step === 2) {
    return '<h3 class="apply-steps-title">TYPE</h3><div><label for="desc">Description *</label> <textarea id="desc" required></textarea></div>';
  }
  if (V === "noFillable") return '<h3 class="apply-steps-title">LOCATIONS</h3><p>Locations are added by the city for this permit type.</p>';
  if (V === "textReview") {
    return '<div class="step-title">Step 7: Review</div><p>Check the details below.</p>'
      + '<div><label for="note">Notes for the reviewer</label> <input id="note" type="text"></div>';
  }
  var card = S.location
    ? '<div class="card location-card"><div>Location</div><div>1 Test St</div></div>'
    : '';
  return '<h3 class="apply-steps-title">LOCATIONS</h3>' + card
    + '<span id="card-AddNewAddress" class="btn card-hovercard span-card"><div class="card-header">'
    + '<div class="form-group"><select aria-label="Address Type" aria-readonly="true" id="addressTypeSelect" disabled><option>Billing</option><option selected>Location</option><option>Mailing</option></select></div></div>'
    + '<div role="button" tabindex="0" id="addLoc">'
    + '<div class="card-body" tabindex="0">\\n<div>Add</div>\\n<div>Location</div>\\n</div>'
    + '<div class="card-footer"><div class="row" aria-required="true">REQUIRED</div>'
    + '<input type="text" name="addressRequired" required tabindex="-1" hidden>'
    + '<div hidden>An address is required.</div></div></div></span>';
}
function render(){
  document.getElementById("stepper").innerHTML = stepper();
  document.getElementById("body").innerHTML = body();
  var next = document.getElementById("next");
  next.textContent = S.step === 7 ? (V === "summaryContinue" ? "Continue" : "Submit") : "Next";
  document.getElementById("err").textContent = "";
  var add = document.getElementById("addLoc");
  // The card keeps no id a selector could use: strip it once it is wired (the live card had none).
  if (add) { add.removeAttribute("id"); add.addEventListener("click", function(){ S.cardClicks++; S.location = true; render(); }); }
  Array.prototype.forEach.call(document.querySelectorAll(".md-stepper-indicator"), function(b){
    b.addEventListener("click", function(){ S.bubbleClicks++; S.step = Number(b.getAttribute("data-step")); render(); });
  });
}
document.getElementById("next").addEventListener("click", function(){
  if (S.step === 7 && V === "summaryContinue") { S.submitClicked = true; S.applyPosts++; fetch(${JSON.stringify(APPLY)}, { method: "POST", body: "x=1" }).catch(function(){}); return; }
  if (S.step === 7) { S.submitClicked = true; fetch(${JSON.stringify(SUBMIT)}, { method: "POST", body: "x=1" }).catch(function(){}); return; }
  if (S.step === 1 && V === "tigardStep1" && !S.location) { document.getElementById("err").textContent = "An address is required."; return; }
  if (S.step === 2) { var d = document.getElementById("desc"); S.desc = d ? d.value : ""; if (!S.desc.trim()) { document.getElementById("err").textContent = "Description is required."; return; } }
  fetch(${JSON.stringify(DRAFT)}, { method: "POST", body: "s=" + S.step }).then(function(){ S.step = S.step === 1 ? 2 : 7; render(); });
});
document.getElementById("draft").addEventListener("click", function(){ fetch(${JSON.stringify(DRAFT)}, { method: "POST", body: "draft=1" }); });
render();
</script></body></html>`;

const posts: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method !== "GET" && req.method !== "HEAD") { posts.push(url.pathname); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
  const v = (url.searchParams.get("v") || "tigardStep1") as Variant;
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page(v));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const norm = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
const isBubble = (l: string): boolean => /^[1-7]\s+(locations|type|contacts|more info|attachments|signature|review and submit)$/i.test(norm(l));
// What the planner was asked about, per call: does the page carry the card / a Submit?
const asked: Array<{ step: string; labels: string[] }> = [];
const mkPlanner = (variant: Variant): LearnPlanner => async (req) => {
  const labels = req.fields.map((f) => norm(f.label));
  asked.push({ step: /REVIEW AND SUBMIT/.test(req.bodyText) ? "7" : /\bTYPE\b/.test(req.bodyText) ? "2" : "1", labels });
  const idx = (re: RegExp, type?: string): number => req.fields.findIndex((f, i) => re.test(labels[i]) && (!type || f.fieldType === type));
  const bubble7 = req.fields.findIndex((f, i) => f.fieldType === "button" && /^7\s+review and submit$/i.test(labels[i]));
  const submit = idx(/^submit$/i, "button");
  const next = idx(/^next$/i, "button");
  const card = req.fields.findIndex((f, i) => f.fieldType !== "button" && /^add location\b/i.test(labels[i]));
  const desc = idx(/^description/i, "text");
  // The review step: step7Bubble's confused planner names the bubble; every other names the Submit.
  if (submit >= 0) return { fills: [], atReview: true, finalSubmitSelectorIndex: variant === "step7Bubble" && bubble7 >= 0 ? bubble7 : submit };
  if (desc >= 0) return { fills: [{ selectorIndex: desc, value: "Roof-mounted solar PV", field: "projectDescription" }], atReview: false, ...(next >= 0 ? { advanceSelectorIndex: next } : {}) };
  // Step 1 (the live failure): atReview, the "7" bubble as the final submit — and the card as the
  // navigate while no location is on the page, then Next.
  const location = /1 Test St/.test(req.bodyText);
  return {
    fills: [],
    atReview: true,
    ...(bubble7 >= 0 ? { finalSubmitSelectorIndex: bubble7 } : {}),
    ...(variant === "tigardStep1" && card >= 0 && !location ? { navigateSelectorIndex: card } : {}),
    ...(variant === "tigardStep1" && location && next >= 0 ? { advanceSelectorIndex: next } : {}),
  };
};

type St = { step?: number; location?: boolean; cardClicks?: number; bubbleClicks?: number; submitClicked?: boolean; applyPosts?: number; err?: string };
const readState = (pg: Page): Promise<St> => pg.evaluate(() => ({ ...(window as unknown as { __S: Record<string, unknown> }).__S }))
  .catch((e) => ({ err: String(e) })) as Promise<St>;

const ALL: Variant[] = ["tigardStep1", "step7Bubble", "step7Submit", "noFillable", "textReview", "summaryContinue"];
const which = (process.argv[2] ? process.argv[2].split(",") : ALL) as Variant[];
const browser = await chromium.launch();
try {
  for (const name of which) {
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(8000);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const pg = await ctx.newPage();
    const url = `${base}/apps/selfservice?v=${name}#/permit/apply/7`;
    await pg.goto(url);
    posts.length = 0;
    asked.length = 0;
    const adapter = new AutoLearnAdapter("Stepper Bubble", mkPlanner(name), { maxPages: 10, budgetMs: 240_000 });
    (adapter as unknown as { page: unknown }).page = pg;
    const events: Array<Record<string, unknown>> = [];
    const noop = async (): Promise<void> => undefined;
    (adapter as unknown as { debug: unknown }).debug = {
      event: (e: Record<string, unknown>) => { events.push(e); },
      writeJson: () => undefined, capturePageHtml: noop, screenshot: noop, startTrace: noop, stopTrace: noop, finalize: noop,
      setScrubber: () => undefined, dir: "",
    };
    let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
    let threw = "";
    const t0 = Date.now();
    try { r = await adapter.learn({ portalUrl: url } as never, { projectAddress: "1 Test St, Testville, OR 97000", city: "Testville", state: "OR", homeownerName: "Test Owner" } as never); }
    catch (e) { threw = String(e).slice(0, 200); }
    await pg.waitForTimeout(300);
    const st = await readState(pg);
    await ctx.close().catch(() => null);
    const filing = posts.filter((p) => p !== DRAFT);
    const steps = (r?.steps ?? []) as Array<{ action?: string; note?: string; isFinalSubmit?: boolean; selector?: unknown }>;
    const bubbleSteps = steps.filter((s) => s.action === "click" && isBubble(String(s.note ?? "").replace(/^[^:]*:\s*/, "").replace(/\s*\(recorded, NOT clicked\)$/, "")));
    const finals = steps.filter((s) => s.isFinalSubmit);
    const demoted = events.filter((e) => e.type === "planner_review_demoted_navigator");
    const absent = events.filter((e) => e.type === "navigate_control_absent");
    const tag = `${name}`;
    const msg = String(r?.message ?? threw).replace(/\s+/g, " ").slice(0, 240);
    const detail = `${Math.round((Date.now() - t0) / 1000)}s filingPOSTs=${filing.length} [${filing.join(",")}] state=${JSON.stringify(st)} ok=${String(r?.ok)} review=${String(r?.reachedReview)} stop=${String(r?.stopReason ?? r?.pauseReason)} `
      + `demoted=${JSON.stringify(demoted)} absent=${absent.length} steps=${JSON.stringify(steps.map((s) => `${s.action}:${norm(s.note).slice(0, 50)}${s.isFinalSubmit ? "[FINAL]" : ""}`))} asked=${JSON.stringify(asked.map((a) => a.step))} msg=${msg}`;
    console.log(`# ${tag}: ${detail}`);
    // Whatever the shape: nothing files, no bubble is clicked, no bubble is recorded at all.
    check(`${tag}: 0 filing requests reach the server, Submit never clicked`, filing.length === 0 && st.submitClicked !== true, detail);
    check(`${tag}: no step-navigator bubble is ever clicked`, st.bubbleClicks === 0, detail);
    if (name === "step7Bubble") {
      // KNOWN GAP, NOT FIXED HERE (#188 follow-up): on the REVIEW page the shared reading cuts only
      // the NARROW bars (semantic nav / tablist / a short <ol>/<ul>), and md-steppers-header
      // role="list" is neither, so the bubble is not navigator-only there and a planner that names
      // it still has it recorded as the final submit — as on main. It is never clicked by the learn
      // (checked above) and a bubble files nothing; widening the review-page cut is a change to the
      // shared reading and is left to its own issue.
      console.log(`  gap  - ${tag}: a planner naming the bubble on the review page still records it as the final submit (as on main): ${bubbleSteps.length} bubble step(s)`);
    } else {
      check(`${tag}: no step-navigator bubble is recorded (as a click or as the final submit)`, bubbleSteps.length === 0, detail);
    }
    if (name === "tigardStep1") {
      check(`MUST-PASS ${tag}: step 1 is not the review stop — planner_review_demoted_navigator on step 1, naming the "7" bubble`,
        demoted.length >= 1 && /^7\b/.test(norm(demoted[0].control)) && /review and submit/i.test(norm(demoted[0].control)), detail);
      const byElement = events.filter((e) => e.type === "click_by_element" && /^add location\b/i.test(norm(e.label)));
      check(`MUST-PASS ${tag}: the location card is clicked through the element it read (click_by_element, no navigate_control_absent), once`,
        st.location === true && st.cardClicks === 1 && absent.length === 0 && byElement.length === 1, `byElement=${byElement.length} ${detail}`);
      check(`MUST-PASS ${tag}: the walk proceeds with Next past step 1 and step 2 and stops at step 7 (review)`,
        st.step === 7 && r?.reachedReview === true && steps.some((s) => /^advance: Next/i.test(norm(s.note))), detail);
      check(`MUST-PASS ${tag}: the review stop records the real Submit as the one final submit`,
        finals.length === 1 && /final submit: Submit\b/.test(norm(finals[0].note)), detail);
    } else if (name === "summaryContinue") {
      check(`MUST-STAY-REVIEW ${tag}: the summary page (no current-step marker, a live footer select) is the review stop — no demotion, its filing "Continue" never clicked, the ${APPLY} POST never arrives`,
        r?.reachedReview === true && demoted.length === 0 && st.step === 7 && st.applyPosts === 0 && !posts.includes(APPLY)
          && !steps.some((s) => /^advance: Continue/i.test(norm(s.note))), `applyHits=${posts.filter((p) => p === APPLY).length} ${detail}`);
    } else {
      check(`MUST-STAY-REVIEW ${tag}: stops at review on the page it opened on, no demotion, nothing clicked past it`,
        r?.reachedReview === true && demoted.length === 0 && st.step === (name.startsWith("step7") ? 7 : 1)
          && !steps.some((s) => /^advance:/i.test(norm(s.note))) && st.cardClicks === 0, detail);
      if (name === "step7Submit") {
        check(`MUST-STAY-REVIEW ${tag}: the real Submit is recorded as the final submit (NOT clicked)`,
          finals.length === 1 && /final submit: Submit \(recorded, NOT clicked\)/.test(norm(finals[0].note)), detail);
      }
    }
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}
console.log(failures ? `\nFAIL - ${failures} check(s) failed` : "\nall stepper-bubble checks passed");
process.exit(failures ? 1 : 0);
