// AN UPLOAD SLOT IS KNOWN BY THE NAME A PERSON SEES — NEVER BY TEXT THE PAGE DOES NOT SHOW.
//
// Seen on a supervised learn of a permit portal's "upload files" page: four upload slots, each with a
// visible name in a requirement row ("Other / Miscellaneous", "Agreements…", "Electrical Plans") and
// one more under a section legend. Every slot was read as the page's script-off fallback sentence,
// markup and all — "<p>Please Enable Javascript to Upload Files</p>" — so no slot named plans, the
// plan set went into the FIRST slot (the catch-all) and the recorded step's note carried the markup.
//
// The shape, reproduced here with neutral names:
//   - each slot's file input sits inside an upload widget: input < button shell < widget < bare div <
//     widget root < input box < cell < row. The widget root also holds a <noscript> fallback; with
//     scripting on, a <noscript>'s content is ONE RAW TEXT NODE (tags included).
//   - the slot's name is the first cell of the row TWO rows above the control. The row between them
//     ("Extended Description:") is display:none, and the name row holds a closed <dialog> repeating
//     the name under "Additional Information".
//   - the label bound to the widget root comes AFTER the control and names no document ("Select a new
//     document for this requirement:"); a hidden description row follows and shows once a file is in.
//
//   [A] the reader alone on that page: MUST-PASS each slot's heading is the visible name, plain text;
//       MUST-EXCLUDE the fallback sentence, any markup, the hidden row's caption, the dialog's text.
//   [B] the learner's own walk: the plan set goes into the slot that names plans, and only there; the
//       step's `slot` and note are plain text; nothing is filed in the catch-all; nothing is submitted.
//   [C] the reader's other paths and its limits:
//       - the fallback shares the control's nearest container (the own-label read's text fallback);
//       - a heading element that holds a <style>; a heading element that is hidden;
//       - a name hidden TOGETHER with its control still names it (a collapsed section);
//       - a visually-hidden (clipped) name still names its slot — only display:none is "not shown";
//       - a second picker under one shared title stays un-headed, however its wrappers nest.
//
// Run: npx tsx portal-bot/src/adapters/uploadSlotShownHeading.dom.smoke.ts
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

const FALLBACK = "<noscript><p>Please Enable Javascript to Upload Files</p></noscript>";
const NAMES = { other: "Other / Miscellaneous", forms: "Agreements, Forms &amp; Checklists", plans: "Electrical Plans" };
const FORMS_TEXT = "Agreements, Forms & Checklists";

// The upload widget as its script leaves it: a hidden drop area, the button shell holding the face
// and the transparent file input, a hidden "processing" note, the list of picked files.
const widget = (id: string) => `<div><div class="zz-widget">
    <div class="zz-drop-area" style="display:none"><span>Drop File(s) Here</span></div>
    <div class="zz-pick" style="position:relative;overflow:hidden;direction:ltr">
      <div class="zz-pick-text">Browse..</div>
      <input title="file input" multiple type="file" name="zzfile" data-zz="${id}" style="position:absolute;right:0;top:0;margin:0;padding:0;cursor:pointer;opacity:0;height:100%">
    </div>
    <span class="zz-processing" style="display:none"><span>Processing dropped files...</span></span>
    <ul class="zz-picked"></ul>
  </div></div>`;

const reqRows = (n: number, key: string, name: string, extended: string) => `
  <tr class="zz-title" aria-expanded="true" role="button">
    <td><span class="zz-chevron"></span> <span class="zz-name">${name}</span>
      <button id="info-${n}" type="button"><img alt="Click here to see additional information about ${name}" title="Additional Information - ${name}"></button>
      <dialog id="more-${n}"><button title="Close" type="button" aria-label="close"></button>
        <h2>${name}</h2><p>Additional Information</p>
        <fieldset><div><p>No Additional Information Available.</p></div></fieldset></dialog>
    </td>
    <td class="zz-status"><span>Pending</span></td>
    <td class="zz-status"><span></span></td>
  </tr>
  <tr class="zz-extended" style="display:none"><td colspan="1">Extended Description:</td><td colspan="2">${extended}</td></tr>
  <tr id="pick-row-${n}" class="zz-upload"><td colspan="3">
    <div class="zz-input-box">
      <div id="picker-${n}" aria-labelledby="l-picker-${n}">${FALLBACK}${widget(key)}</div>
      <label id="l-picker-${n}" for="picker-${n}">Select a new document for this requirement:</label>
    </div></td></tr>
  <tr id="why-row-${n}" class="zz-upload" style="display:none"><td colspan="3">
    <div class="zz-input-box"><textarea id="why-${n}" rows="4"></textarea>
      <label for="why-${n}">Provide a short description of this set of documents:</label></div></td></tr>`;

const FILES = `<h1>Application - Upload Files</h1>
  <form id="zz-form" onsubmit="return false">
  <p>Once you have picked the files you want to upload, click the "Next Step" button at the bottom of the page.</p>
  <fieldset><legend aria-expanded="true" role="button" tabindex="0"><h3><span class="zz-chevron"></span>Current Submittal</h3></legend>
    <div>
      <h4>Submittal #<span>1) Application Submittal</span></h4>
      <table><tbody>
        <tr><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Date Verified</th></tr>
        ${reqRows(0, "other", NAMES.other, "")}
        ${reqRows(1, "forms", NAMES.forms, "<b>For commercial work:</b> submittal checklist, scope of work forms, energy forms.")}
        ${reqRows(2, "plans", NAMES.plans, "")}
      </tbody></table>
    </div></fieldset>
  <fieldset><legend aria-expanded="true" role="button" tabindex="0"><h3><span class="zz-chevron"></span>Upload Additional Documents</h3></legend>
    <div>
      <div class="zz-input-box">
        <div id="picker-extra" aria-labelledby="l-picker-extra">${FALLBACK}${widget("extra")}</div>
        <label id="l-picker-extra" for="picker-extra">Select any documents you wish to provide:</label>
      </div>
      <div class="zz-input-box"><textarea id="why-extra" rows="4"></textarea>
        <label for="why-extra">Provide a short description of this set of documents:</label></div>
    </div></fieldset>
  <button type="button" id="back">Previous Step</button> <button type="button" id="next">Next Step</button>
  </form>
  <script>
    // A picked file shows the slot's description row, as the widget's script does.
    Array.prototype.forEach.call(document.querySelectorAll('input[type="file"]'), function (el) {
      el.addEventListener("change", function () {
        var row = el.closest("tr");
        var why = row && row.nextElementSibling;
        if (why && /^why-row-/.test(why.id)) why.style.display = "";
      });
    });
    // The page as the walk LEAVES it, kept for the smoke across the navigation Next Step makes.
    document.getElementById("next").addEventListener("click", function () {
      var held = {};
      Array.prototype.forEach.call(document.querySelectorAll('input[type="file"]'), function (el) { held[el.getAttribute("data-zz")] = el.files ? el.files.length : -1; });
      sessionStorage.setItem("zzHeld", JSON.stringify(held));
      location.href = "/review";
    });
  </script>`;

const P1 = `<h1>Step 1: Applicant</h1><form action="/files" method="get">
  <label for="a">Contact Name</label><input id="a" name="a">
  <button type="submit">Next</button></form>`;
const REVIEW = `<h1>Review and Submit</h1>
  <p>Please review your application below before submitting. Once submitted, it cannot be changed.</p>
  <button type="button" id="submit" onclick="fetch('/SubmitApplication', {method:'POST', body:'x=1'}).catch(function(){});">Submit Application</button>`;

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
  const body = url.pathname === "/files" ? FILES : url.pathname === "/review" ? REVIEW : P1;
  res.end(`<!doctype html><html><head><title>Fixture permit portal</title></head><body>${body}</body></html>`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zz-slot-heading-"));
const planSet = path.join(dir, "ZZTEST-plan-set.pdf");
fs.writeFileSync(planSet, "%PDF-1.4\n% placeholder\n");

// What no slot name, step or event may ever carry: markup, the fallback sentence, text of the
// hidden row, of the closed dialog, of the hidden drop area.
const NEVER = /[<>]|javascript|extended description|additional information|drop file|for commercial/i;

const browser = await chromium.launch();
try {
  // ---- [A] the reader alone, on the page as served ----
  console.log("\n[A] the slot reader on the upload page: four slots, each named in a row or legend a person sees");
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    await page.goto(`${base}/files`);
    const premise = await page.evaluate(() => {
      const ns = document.querySelector("#picker-2 noscript");
      const row = document.querySelector("tr.zz-extended");
      const dlg = document.querySelector("#more-2");
      return {
        fallbackText: ns ? ns.textContent || "" : "",
        fallbackHasElements: ns ? ns.children.length : -1,
        hiddenRow: row ? getComputedStyle(row).display : "",
        closedDialog: dlg ? getComputedStyle(dlg).display : "",
      };
    });
    const slots = await page.evaluate(tagUploadControls);
    await ctx.close().catch(() => null);
    const detail = JSON.stringify(slots);
    check("[A] premise: the script-off fallback is one raw text node, tags included, and the caption row and the dialog are not rendered",
      /<p>Please Enable Javascript to Upload Files<\/p>/.test(premise.fallbackText) && premise.fallbackHasElements === 0
        && premise.hiddenRow === "none" && premise.closedDialog === "none", JSON.stringify(premise));
    check("[A] premise: four upload slots, all native inputs", slots.length === 4 && slots.every((s) => s.kind === "input"), detail);
    check("[A] MUST-PASS each requirement slot is headed by its row's visible name",
      slots[0]?.heading === "Other / Miscellaneous" && slots[1]?.heading === FORMS_TEXT && slots[2]?.heading === "Electrical Plans", detail);
    check("[A] MUST-PASS the slot under the section legend is headed by the legend", slots[3]?.heading === "Upload Additional Documents", detail);
    check("[A] MUST-PASS the label is the same plain text (it is what the step's note records)",
      slots.length === 4 && slots.every((s) => s.label === s.heading), detail);
    check("[A] MUST-PASS a status word in the name's row marks the slot tracked; the legend's slot is not",
      slots[0]?.required === true && slots[1]?.required === true && slots[2]?.required === true && slots[3]?.required === false, detail);
    check("[A] MUST-EXCLUDE no slot carries markup, the fallback sentence, the hidden caption or the dialog's text",
      slots.length === 4 && !slots.some((s) => NEVER.test(`${s.label} ${s.heading ?? ""}`)), detail);
  }

  // ---- [B] the learner's walk ----
  console.log("\n[B] the learner's walk over that page: the job holds only the plan set");
  {
    const ctx = await browser.newContext();
    ctx.setDefaultTimeout(8000);
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    await page.goto(`${base}/p1`);
    posts.length = 0;
    // Page 1: fill the text box and advance. The upload page is a form page (fill nothing, advance
    // by Next Step); only the page that says Submit Application is review.
    const planner: LearnPlanner = async (req) => {
      if (req.fields.some((f) => /submit application/i.test(String(f.label ?? "")))) return { fills: [], atReview: true };
      const fills = req.fields.map((f, i) => ({ f, i })).filter((x) => x.f.fieldType === "text" && /contact name/i.test(String(x.f.label ?? ""))).map((x) => ({ selectorIndex: x.i, value: "ZZ Test Owner" }));
      const next = req.fields.findIndex((f) => f.fieldType === "button" && /^next( step)?$/i.test(String(f.label ?? "").trim()));
      return { fills, atReview: false, ...(next >= 0 ? { advanceSelectorIndex: next } : {}) };
    };
    const adapter = new AutoLearnAdapter("Fixture Permit Portal", planner, { maxPages: 5, docsByType: { plan_set: planSet }, uploadMode: "combined" });
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
        { projectAddress: "100 Test St, Testville, ZZ, 00000", city: "Testville", state: "ZZ", zip: "00000", homeownerName: "ZZ Test Owner" } as never);
    } catch (e) { threw = String(e).slice(0, 200); }
    await new Promise((res) => setTimeout(res, 800));
    const h = await page.evaluate(() => JSON.parse(sessionStorage.getItem("zzHeld") || "null") as Record<string, number> | null).catch(() => null);
    await ctx.close().catch(() => null);
    const msg = String(r?.message ?? threw);
    const uploads = (r?.steps ?? []).filter((s) => s.action === "upload");
    const missing = r?.missingRequiredDocs ?? [];
    const uploadEvents = events.filter((e) => /^upload/.test(String(e.type)));
    const uploadEventsText = JSON.stringify(uploadEvents);
    const headed = events.find((e) => e.type === "upload_slots_headed");
    check("[B] premise: the upload pass ran on the upload page as a form page (not attach-only)",
      events.some((e) => e.type === "upload_phase_start" && e.page === 2 && e.attachOnly === undefined), uploadEventsText);
    check("[B] MUST-PASS the slots were reported by the names a person sees, plans offered",
      !!headed && /^Other \/ Miscellaneous \(required\) \| Agreements, Forms & Checklists \(required\) \| Electrical Plans \(required\) \| Upload Additional Documents$/.test(String(headed.headings ?? ""))
        && headed.plansOffered === true, uploadEventsText);
    check("[B] MUST-PASS the plan set went into the slot that names plans — and only there",
      h?.plans === 1 && h?.other === 0 && h?.forms === 0 && h?.extra === 0, `held=${JSON.stringify(h)}`);
    check("[B] MUST-PASS exactly one upload step: the plan set, its slot and note in plain text",
      uploads.length === 1 && uploads[0].docType === "plan_set" && uploads[0].slot === "Electrical Plans"
        && uploads[0].note === "upload plan_set: Electrical Plans" && uploads[0].selector?.css === '[data-al-upl="f2"]', JSON.stringify(uploads));
    check("[B] MUST-EXCLUDE the catch-all slots took nothing: the first slot on the page and the extra area are empty",
      h?.other === 0 && h?.extra === 0 && !uploads.some((s) => /other|misc|additional/i.test(`${s.slot ?? ""} ${s.note ?? ""}`)), `held=${JSON.stringify(h)} ${JSON.stringify(uploads)}`);
    check("[B] MUST-EXCLUDE no upload step and no upload event carries markup, the fallback sentence or unrendered text",
      !uploads.some((s) => NEVER.test(`${s.slot ?? ""} ${s.note ?? ""}`)) && !uploadEvents.some((e) => NEVER.test(`${e.headings ?? ""} ${e.heading ?? ""} ${e.label ?? ""}`)),
      `${JSON.stringify(uploads)} ${uploadEventsText}`);
    check("[B] the requirements left empty are named by their visible names — and the plans slot is not among them",
      missing.includes("Other / Miscellaneous") && missing.includes(FORMS_TEXT) && !missing.some((m) => /plans/i.test(m)) && !missing.some((m) => NEVER.test(m)),
      `missing=${JSON.stringify(missing)}`);
    check("[B] nothing was submitted; the run stopped at review",
      !posts.some((p) => p.endsWith("/SubmitApplication")) && r?.reachedReview === true, `posts=[${posts.join(",")}] reachedReview=${r?.reachedReview} ${msg.slice(0, 200)}`);
  }

  // ---- [C] the reader's other paths, and its limits ----
  console.log("\n[C] the slot reader's other paths, and what must not change");
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const page = await ctx.newPage();
    const read = async (html: string) => { await page.setContent(html); return page.evaluate(tagUploadControls); };

    const own = await read(`<div class="zz-box">${FALLBACK}Roof Photos <input type="file"></div>`);
    check("[C] MUST-PASS a fallback sharing the control's own container is not part of its label",
      own.length === 1 && own[0].label === "Roof Photos" && own[0].heading === "Roof Photos", JSON.stringify(own));

    const styled = await read(`<div><h3>Site Plan<style>.zz-x{color:red}</style></h3>
      <div><label for="s" class="btn">Choose File</label><input type="file" id="s"></div></div>`);
    check("[C] MUST-PASS a heading element's name stops at its text: a <style> inside it is not read",
      styled.length === 1 && styled[0].heading === "Site Plan", JSON.stringify(styled));

    const unseen = await read(`<div><h3 hidden>Withdrawn Requirement</h3>
      <div><label for="q" class="btn">Choose File</label><input type="file" id="q"></div></div>`);
    check("[C] MUST-EXCLUDE a heading element the page does not show names nothing: the slot keeps its face",
      unseen.length === 1 && unseen[0].heading === undefined && unseen[0].label === "Choose File", JSON.stringify(unseen));

    const together = await read(`<div style="display:none"><table><tbody>
      <tr><td>Structural Letter</td><td>Pending</td></tr>
      <tr><td><div>Select a new document for this requirement: <input type="file"></div></td></tr></tbody></table></div>`);
    check("[C] MUST-PASS a name hidden TOGETHER with its control (a collapsed section) still names it",
      together.length === 1 && together[0].heading === "Structural Letter" && together[0].required === true, JSON.stringify(together));

    const clipped = await read(`<table><tbody>
      <tr><td><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Meter Photo</span></td><td>Pending</td></tr>
      <tr><td><div>Select a new document for this requirement: <input type="file"></div></td></tr></tbody></table>`);
    check("[C] MUST-PASS a visually-hidden (clipped) name still names its slot",
      clipped.length === 1 && clipped[0].heading === "Meter Photo", JSON.stringify(clipped));

    const shared = await read(`<section><h3>Supporting Files</h3>
      <div><div><div><input type="file" id="r1"></div></div></div>
      <div><div><div><input type="file" id="r2"></div></div></div></section>`);
    check("[C] MUST-EXCLUDE a second picker under one shared title stays un-headed, however its wrappers nest",
      shared.length === 2 && shared[0].heading === "Supporting Files" && shared[1].heading === undefined, JSON.stringify(shared));

    // Seven levels, each with something beside it (an empty element): the reach is six such levels.
    const level = (inner: string) => `<div><i></i>${inner}</div>`;
    const deep = await read(`<div><p>Step 3 of 5</p>${level(level(level(level(level(level(level('<button type="button">Browse</button>')))))))}</div>`);
    check("[C] MUST-EXCLUDE a lone picker is not named by text more than six branching levels up the page",
      deep.length === 1 && deep[0].heading === undefined && deep[0].label === "Browse", JSON.stringify(deep));
    await ctx.close().catch(() => null);
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (failures) { console.error(`\n${failures} upload-slot-heading check(s) FAILED.`); process.exit(1); }
console.log("\nAll upload-slot-heading check(s) passed (real Chromium).");
