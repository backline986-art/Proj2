// THE FINAL PAGE THAT READS AS REVIEW STILL GETS ITS ATTACHMENTS — ATTACH-ONLY (#383, hard rule 1).
//
// Live on PacifiCorp's PowerClerk NEM (2026-10-21): the attachments live on the LAST page, the
// one that also carries the review text, the terms box and Submit. The learner read it as review
// and logged upload_skipped_on_review, so "Upload a photo of meter where system will be
// interconnected" was never filled, though the project held the meter photo.
//
// The fix lets the upload pass run on such a page before the stop at review, attach-only: a
// native file input whose label names a document we hold, set directly. Nothing is clicked, no
// substitute document is filed, and the run still stops at review, naming what it left empty.
//
// A replica final page: review text, the terms box, a Submit that would POST /SubmitApplication,
// a required meter-photo file input whose change uploads (POST /UploadAttachment, as PowerClerk's
// uploader does), and a required "Browse" widget whose click would POST /BrowseClicked.
//
//   [A] the project holds the meter photo: it is attached (the ONLY non-GET that reaches the
//       server is the upload), the Browse widget is never clicked and is named in the hand-off,
//       nothing is submitted, and the run stops at review.
//   [B] the project holds NO meter photo (only the plan set): nothing is attached — the plan set
//       is never substituted — no non-GET reaches the server, the meter-photo slot is named in
//       the hand-off, and the run stops at review.
//   [C] (#140) an iWorQ-shaped final page whose required slots are named only by their HEADING
//       ("Bid", "Plans"; the input's own label is the "Choose File" button face) — the plan set
//       goes into "Plans" and its description box, "Bid" is reported missing by name, nothing
//       lands in "Bid" or the optional "Other Files", nothing reaches the server.
//   [D] the slot-label reader alone: a heading is a slot's label only when no other upload control
//       sits between them; a picker with no heading of its own keeps its old label.
//
// Run: npx tsx portal-bot/src/adapters/reviewPageUpload.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { AutoLearnAdapter, tagUploadControls, type LearnPlanner } from "./autoLearnAdapter";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// The walk reaches the final page from a form page, as the live run did (a review screen is a
// summary of what was ENTERED, so a page met before any entry is never read as one).
const P1 = `<h1>Step 1: Applicant</h1><form action="/final" method="get">
  <label for="a">Contact Name</label><input id="a" name="a">
  <button type="submit">Next</button></form>`;

const FINAL = `<h1>Review and Submit</h1>
  <p>Please review your application below before submitting. Once submitted, it cannot be changed.</p>
  <h3>Attachments</h3>
  <div class="form-group">
    <label for="meter" class="control-label">Upload a photo of meter where system will be interconnected *</label>
    <input id="meter" type="file" required>
  </div>
  <div class="form-group">
    <label class="control-label">Single-line diagram *</label>
    <button type="button" id="browse" onclick="fetch('/BrowseClicked', {method:'POST', body:'x=1'}).catch(function(){});">Browse</button>
  </div>
  <div class="form-group">
    <label for="terms">I agree to the terms and conditions</label><input id="terms" type="checkbox">
  </div>
  <button type="button" id="submit" onclick="fetch('/SubmitApplication', {method:'POST', body:'x=1'}).catch(function(){});">Submit Application</button>
  <script>
    document.getElementById("meter").addEventListener("change", function (ev) {
      var fd = new FormData();
      fd.append("file", ev.target.files[0]);
      fetch("/UploadAttachment", { method: "POST", body: fd }).catch(function(){});
    });
  </script>`;

// [C] (#140) AN iWorQ-SHAPED FINAL PAGE: each required document is a slot NAMED BY ITS HEADING.
// The label bound to the file input is the button face ("Choose File"); the document word ("Bid",
// "Plans") is the <h3> above it, with a "(File Types: .pdf)" note between; a description textarea
// sits beside each input; "Other Files" is an optional multi-file input. Synthetic, shaped on the
// City of Star watched learn of 2026-11-11 (attached:0 missing:2 — both slots read "Choose File").
const P1C = P1.replace('action="/final"', 'action="/star"');
const slotHtml = (n: number, heading: string) => `
      <div class="mr-4"><h3 class="application-item">${heading}</h3> <div class="mb-2">&nbsp;&nbsp;(File Types:   .pdf   ):</div>
        <div class="form-group file-upload-widget"><label for="newfile_uploads_9_${n}" class="btn btn-primary btn-change">Choose File</label>
          <p class="display-filename m-0"></p>
          <input name="newfile_uploads[]" id="newfile_uploads_9_${n}" type="file" accept="  .pdf   " required="required" class="hidden required" style="display:none">
          <textarea name="newfile_upload_description[]" aria-label="Description of the ${heading}" id="uploadDescription_9_${n}" placeholder="Description of the ${heading}" class="form-control mt-1"></textarea>
        </div></div>`;
const STAR = `<h1>Solar Permit or Panel Application</h1>
  <p>Please review your application below before submitting.</p>
  <div class="row"><div class="col-sm-12"><div class="col text-left">A copy of the bid is required for solar applications.</div></div></div>
  <div class="row"><div class="col"><h2><strong>Required Files for Solar Permit or Panel Application</strong></h2>
    <i>If submitted without file(s) listed below or with the wrong file type, application will not be accepted.</i>
    <div class="cell"><div class="d-flex flex-wrap cell-inner">${slotHtml(0, "Bid")}${slotHtml(1, "Plans")}
    </div></div></div></div>
  <div class="row"><div class="col"><div class="cell"><div class="cell-inner"><h3 class="text-center">Other Files</h3>
    <div class="form-group"><span>Files</span> <br><label for="newfile_uploads_9" class="btn btn-primary">Choose Files</label>
      <input name="newfile_uploads[]" id="newfile_uploads_9" type="file" multiple="multiple" class="managed hidden" style="display:none"></div></div></div></div></div>
  <div id="upload-warning"><i>*The required uploads were not found</i></div>
  <button id="submit-webform" type="button" onclick="fetch('/SubmitApplication', {method:'POST', body:'x=1'}).catch(function(){});">Submit</button>`;

const posts: string[] = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method !== "GET" && req.method !== "HEAD") {
    posts.push(`${req.method} ${url.pathname}`);
    req.resume();
    req.on("end", () => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); });
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  const body = url.pathname === "/final" ? FINAL : url.pathname === "/star" ? STAR : url.pathname === "/p1c" ? P1C : P1;
  res.end(`<!doctype html><html><head><title>${url.pathname === "/star" || url.pathname === "/p1c" ? "iWorQ replica" : "PowerClerk replica"}</title></head><body>${body}</body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zz-review-upload-"));
const meterPhoto = path.join(dir, "ZZTEST-meter-photo.jpg");
fs.writeFileSync(meterPhoto, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]));
const planSet = path.join(dir, "ZZTEST-plan-set.pdf");
fs.writeFileSync(planSet, "%PDF-1.4\n% placeholder\n");

// Page 1: fill the text box and advance by Next. The final page: declare review, fill nothing
// (the review stop is the planner's; the upload pass is the learner's own).
const planner: LearnPlanner = async (req) => {
  const atReview = req.fields.some((f) => f.fieldType === "file" || /submit application/i.test(String(f.label ?? "")));
  if (atReview) return { fills: [], atReview: true };
  const fills = req.fields.map((f, i) => ({ f, i })).filter((x) => x.f.fieldType === "text").map((x) => ({ selectorIndex: x.i, value: "ZZ Test" }));
  const next = req.fields.findIndex((f) => f.fieldType === "button" && /^next$/i.test(String(f.label ?? "").trim()));
  return { fills, atReview: false, ...(next >= 0 ? { advanceSelectorIndex: next } : {}) };
};

const browser = await chromium.launch();
try {
  for (const which of ["A", "B"] as const) {
    console.log(which === "A" ? "\n[A] the project holds the meter photo" : "\n[B] the project holds no meter photo (plan set only)");
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(8000);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    await page.goto(`${base}/p1`);
    posts.length = 0;
    const docsByType: Record<string, string> = which === "A" ? { meter_photo: meterPhoto, plan_set: planSet } : { plan_set: planSet };
    const adapter = new AutoLearnAdapter("PowerClerk Replica", planner, { maxPages: 4, docsByType });
    const events: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).page = page;
    const holder = adapter as unknown as { debug?: { event: (e: Record<string, unknown>) => void } };
    if (holder.debug && typeof holder.debug.event === "function") {
      const orig = holder.debug.event.bind(holder.debug);
      holder.debug.event = (e) => { events.push(e); orig(e); };
    } else holder.debug = { event: (e) => { events.push(e); } };
    let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
    let threw = "";
    try {
      r = await adapter.learn({ portalUrl: `${base}/p1` } as never,
        { projectAddress: "1 Test St, Springfield, IL, 62701", city: "Springfield", state: "IL", zip: "62701", homeownerName: "T" } as never);
    } catch (e) { threw = String(e).slice(0, 200); }
    // Let any late request land before reading what reached the server.
    await new Promise((res) => setTimeout(res, 800));
    const inputHolds = await page.evaluate(() => (document.getElementById("meter") as HTMLInputElement | null)?.files?.length ?? 0).catch(() => -1);
    await ctx.close().catch(() => null);
    const msg = String(r?.message ?? threw);
    const uploads = (r?.steps ?? []).filter((s) => s.action === "upload");
    const missing = r?.missingRequiredDocs ?? [];

    check("premise: the upload pass ran on the review page, attach-only",
      events.some((e) => e.type === "upload_phase_start" && e.attachOnly === true), JSON.stringify(events.filter((e) => /^upload/.test(String(e.type)))));
    check("nothing was submitted: no POST /SubmitApplication, no step recorded or clicked as the final submit",
      !posts.some((p) => p.endsWith("/SubmitApplication")) && !(r?.steps ?? []).some((s) => s.isFinalSubmit === true && /final submit: .*\(clicked/i.test(String(s.note ?? ""))),
      `posts=[${posts.join(",")}]`);
    check("the custom Browse widget was never clicked (no POST /BrowseClicked)", !posts.some((p) => p.endsWith("/BrowseClicked")), `posts=[${posts.join(",")}]`);
    check("the run stopped at review", r?.reachedReview === true && /reached the review screen/.test(msg), `reachedReview=${r?.reachedReview} ${msg.slice(0, 300)}`);
    check("the hand-off names the Browse slot it left for a person",
      missing.some((m) => /single-line diagram/i.test(m)) && /single-line diagram/i.test(msg), `missing=${JSON.stringify(missing)}`);
    if (which === "A") {
      check("[A] the meter photo was attached and recorded as an upload step",
        inputHolds === 1 && uploads.length === 1 && uploads[0].docType === "meter_photo", `inputHolds=${inputHolds} uploads=${JSON.stringify(uploads)}`);
      check("[A] the ONLY non-GET that reached the server is the upload itself",
        posts.length === 1 && posts[0] === "POST /UploadAttachment", `posts=[${posts.join(",")}]`);
      check("[A] the meter-photo slot is not reported empty", !missing.some((m) => /photo of meter/i.test(m)), JSON.stringify(missing));
    } else {
      check("[B] nothing was attached — the plan set was never substituted into the meter-photo slot",
        inputHolds === 0 && uploads.length === 0, `inputHolds=${inputHolds} uploads=${JSON.stringify(uploads)}`);
      check("[B] no non-GET reached the server", posts.length === 0, `posts=[${posts.join(",")}]`);
      check("[B] the hand-off names the empty meter-photo slot",
        missing.some((m) => /photo of meter/i.test(m)) && /photo of meter/i.test(msg), `missing=${JSON.stringify(missing)} ${msg.slice(0, 300)}`);
    }
  }

  // ---- [C] iWorQ: slots named by their heading (#140) ----
  console.log("\n[C] iWorQ-shaped page: required slots headed \"Bid\" and \"Plans\"; the job holds only the plan set");
  {
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(8000);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    await page.goto(`${base}/p1c`);
    posts.length = 0;
    const adapter = new AutoLearnAdapter("iWorQ Replica", planner, { maxPages: 4, docsByType: { plan_set: planSet } });
    const events: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).page = page;
    const holder = adapter as unknown as { debug?: { event: (e: Record<string, unknown>) => void } };
    if (holder.debug && typeof holder.debug.event === "function") {
      const orig = holder.debug.event.bind(holder.debug);
      holder.debug.event = (e) => { events.push(e); orig(e); };
    } else holder.debug = { event: (e) => { events.push(e); } };
    let r: Awaited<ReturnType<AutoLearnAdapter["learn"]>> | null = null;
    let threw = "";
    try {
      r = await adapter.learn({ portalUrl: `${base}/p1c` } as never,
        { projectAddress: "1 Test St, Springfield, IL, 62701", city: "Springfield", state: "IL", zip: "62701", homeownerName: "T" } as never);
    } catch (e) { threw = String(e).slice(0, 200); }
    await new Promise((res) => setTimeout(res, 800));
    const held = await page.evaluate(() => {
      const n = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.files?.length ?? -1;
      const v = (id: string) => (document.getElementById(id) as HTMLTextAreaElement | null)?.value ?? null;
      return { bid: n("newfile_uploads_9_0"), plans: n("newfile_uploads_9_1"), other: n("newfile_uploads_9"), bidDesc: v("uploadDescription_9_0"), plansDesc: v("uploadDescription_9_1") };
    }).catch(() => null);
    await ctx.close().catch(() => null);
    const msg = String(r?.message ?? threw);
    const uploads = (r?.steps ?? []).filter((s) => s.action === "upload");
    const descSteps = (r?.steps ?? []).filter((s) => s.action === "fill" && /^upload description/i.test(String(s.note ?? "")));
    const missing = r?.missingRequiredDocs ?? [];
    check("[C] premise: the upload pass ran on the review page, attach-only",
      events.some((e) => e.type === "upload_phase_start" && e.attachOnly === true), JSON.stringify(events.filter((e) => /^upload/.test(String(e.type)))));
    check("[C] the plan set went into the slot headed \"Plans\" — and only there",
      held?.plans === 1 && held?.bid === 0 && held?.other === 0, `held=${JSON.stringify(held)}`);
    check("[C] exactly one upload step, the plan set, recorded under the slot's heading",
      uploads.length === 1 && uploads[0].docType === "plan_set" && /:\s*Plans$/.test(String(uploads[0].note ?? "")), JSON.stringify(uploads));
    check("[C] the \"Description of the Plans\" box got the document's kind, and the fill is recorded for replay",
      held?.plansDesc === "Plan set" && descSteps.length === 1 && descSteps[0].value === "Plan set"
        && /uploadDescription_9_1/.test(String(descSteps[0].selector?.css ?? "")), `held=${JSON.stringify(held)} steps=${JSON.stringify(descSteps)}`);
    check("[C] the Bid slot and its description are untouched", held?.bidDesc === "", `held=${JSON.stringify(held)}`);
    check("[C] \"Bid\" is reported missing BY NAME, in the result and the run's message — never as \"Choose File\"",
      missing.some((m) => /^bid\b/i.test(m)) && /\bBid\b/.test(msg) && !missing.some((m) => /choose file/i.test(m)),
      `missing=${JSON.stringify(missing)} msg=${msg.slice(0, 300)}`);
    check("[C] the optional \"Other Files\" slot is neither filled nor reported", !missing.some((m) => /other files/i.test(m)), JSON.stringify(missing));
    check("[C] nothing reached the server (no submit, no upload POST)", posts.length === 0, `posts=[${posts.join(",")}]`);
    check("[C] the run stopped at review", r?.reachedReview === true && /reached the review screen/.test(msg), `reachedReview=${r?.reachedReview} ${msg.slice(0, 300)}`);
  }

  // ---- [D] the slot-label reader on its own: heading-owned, heading shared across slots, no heading ----
  console.log("\n[D] tagUploadControls reads a slot's heading only when the heading is that slot's own");
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    await page.setContent(`<div><h3>Plans</h3><div><label for="a" class="btn">Choose File</label><input type="file" id="a"></div></div>
      <section><h4>Attachments</h4>
        <div><label for="b" class="btn">Choose File</label><input type="file" id="b"></div>
        <div><label for="c" class="btn">Choose File</label><input type="file" id="c"></div></section>
      <div><div><label for="d" class="btn">Browse</label><input type="file" id="d"></div></div>`);
    const slots = await page.evaluate(tagUploadControls);
    await ctx.close().catch(() => null);
    const labels = slots.map((s) => s.label);
    check("[D] a picker face under its own heading reads as the heading", labels[0] === "Plans", JSON.stringify(labels));
    check("[D] a heading two slots share goes to the first; the second keeps its face", labels[1] === "Attachments" && labels[2] === "Choose File", JSON.stringify(labels));
    check("[D] a picker with no heading of its own keeps its old label", labels[3] === "Browse", JSON.stringify(labels));
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (failures) { console.error(`\n${failures} review-page-upload check(s) FAILED.`); process.exit(1); }
console.log("\nAll review-page-upload checks passed (real Chromium).");
process.exit(0);
