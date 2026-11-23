// THE HAND RECORDER RECORDS WHAT THE PERSON DID, WHATEVER THE PAGE IS BUILT FROM (#280).
//
// A supervised hand recording lost the person's click on a chooser TILE (a card that is neither a
// button nor a link, with a click handler that navigates): the saved recipe went from the entry link
// straight to "Next", so every replay looked for "Next" on the chooser page. The same session showed
// three more gaps. This smoke drives the REAL recorder (armRecorder: the binding, the shared safety
// predicates and the in-page capture) in real Chromium on TWO differently built synthetic sites:
//
//   site A  server-rendered pages. Tiles are <div> cards with an onclick property and a pointer
//           cursor; the click navigates to a new document after a 700 ms delay. Uploads are
//           <label for> + <input type=file>. The submit opens a confirmation in a fixed-position layer (no ARIA).
//   site B  a single-page app. Tiles are <li> items under ONE delegated listener (no onclick, no
//           cursor, no tabindex); the click is a history.pushState route change and a re-render.
//           Uploads are a heading above a "Choose File" face, and a requirement table row. The
//           submit is an <input type=submit> that opens a <dialog>.
//
// MUST (each site):
//   A. the tile click is a click step, in its place, named by the tile's visible text, and its
//      recorded selector resolves on a FRESH load through the replay's own locator builder: clicking
//      it brings the form. A stray click on plain text records nothing. A non-control that only
//      toggles a checkbox is the checkbox's step, never a second click.
//   B. nothing is captured and nothing is printed after stop() ("save").
//   C. each upload carries its slot's visible label in `slot`; a chosen file that is one of the job's
//      documents (name and size, from a stubbed API) names its document type without a question; only
//      the unmatched one is asked, with the slot's name in the question; a label the browser never
//      paints is not a slot name; the chosen file's name is in no step and no printed line.
//   D. the confirmation click after the blocked final submit is not a step: exactly one blocked
//      marker, naming the submit control, and after finalize the recipe ends stopForReview, marker.
//
// KILL (recordRecipe.ts restored to the extraction-only source): A tile, B, C slot/type/question and
// D all go red; the guards (stray click, toggle, existing click/fill steps) stay green.
//
// Run: npx tsx portal-bot/src/recordRecipeTile.dom.smoke.ts
import "./smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { armRecorder, askUploadDocTypes, createRecorderSink, fetchJobDocuments, finalizeRecordedSteps, guessUploadDocType } from "./recordRecipe";
import { buildLocator } from "./adapters/loginFlow";
import type { RecipeStep } from "../../shared/src/types";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>ZZ synthetic</title></head><body>${body}</body></html>`;

// ---- site A: server-rendered, div cards with an onclick property -------------------------------
const A_START = page(`<h1>ZZ Test Office</h1><a href="/a/choose">Start an application</a>`);
const A_CHOOSE = page(`<style>.card{cursor:pointer;border:1px solid #888;padding:24px;margin:12px;width:320px}</style>
  <h1>What are you applying for?</h1><p id="blurb">Pick the kind of request you are making today.</p>
  <div class="cards"><div class="card"><h3>Rooftop array request</h3><p class="d">For panels fixed to a house roof</p></div><div class="card"><h3>Fence request</h3><p class="d">For a new boundary fence</p></div><div class="card" aria-label="Open the cashier"><h3>Pay the fee now</h3><p class="d">Card payments only</p></div></div>
  <script>var cs=document.querySelectorAll('.card');
    cs[0].onclick=function(){setTimeout(function(){location.href='/a/form';},700);};
    cs[1].onclick=function(){location.href='/a/other';};
    cs[2].onclick=function(){location.href='/a/other';};</script>`);
const A_FORM = page(`<h1>Rooftop array request</h1>
  <form onsubmit="return false">
    <p><label for="own">Owner name</label><input id="own" name="own"></p>
    <p class="up"><label for="f1">Sheets from the designer</label><input type="file" id="f1" name="f1"></p>
    <p class="up"><label for="f2">Owner letter</label><input type="file" id="f2" name="f2"></p>
    <button type="button" id="send">Submit application</button>
  </form>
  <div id="dlg" class="veil" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4)" hidden><p>Send this application now?</p><button type="button" id="yes">Yes</button><button type="button" id="no">No</button></div>
  <div id="done" hidden><p>Request received.</p><button type="button" id="again">Print a copy</button><input id="late" name="late"></div>
  <script>document.getElementById('send').onclick=function(){document.getElementById('dlg').hidden=false;};
    document.getElementById('yes').onclick=function(){document.getElementById('dlg').hidden=true;document.getElementById('done').hidden=false;};</script>`);

// ---- site B: single-page app, li tiles under one delegated listener ------------------------------
const B_SHELL = page(`<style>#kinds{list-style:none;padding:0}#kinds li{border:1px solid #888;margin:8px;padding:16px;width:340px}#kinds span{display:block}</style>
  <div id="app"></div>
  <script>
  var app=document.getElementById('app');
  function chooser(){
    app.innerHTML='<h2>Choose a request</h2><p id="blurb">Each request below opens its own form.</p>'
      +'<ul id="kinds"><li data-k="ground"><span class="t">Ground array request</span><span class="d">For panels on a frame in the yard</span></li>'
      +'<li data-k="shed"><span class="t">Shed request</span><span class="d">For a small garden shed</span></li></ul>';
    document.getElementById('kinds').addEventListener('click',function(e){var li=e.target.closest('li');if(!li)return;history.pushState({},'','/b/apply-'+li.getAttribute('data-k'));render();});
  }
  function form(){
    app.innerHTML='<h2>Ground array request</h2><form id="fm">'
      +'<p><label>Owner name <input name="own"></label></p>'
      +'<div id="tog">Battery included</div><input type="checkbox" id="bat" name="bat" style="position:absolute;opacity:0"><p id="batnote" hidden>Battery details are asked later.</p>'
      +'<section><h4>Sheet for the reviewer</h4><div><label for="u1" class="btn">Choose File</label><input type="file" id="u1"></div></section>'
      +'<table><tbody><tr><td>Neighbour statement</td><td>Pending</td></tr><tr><td colspan="2"><input type="file" name="u2"></td></tr></tbody></table>'
      +'<section><label for="u3" style="display:none">Unseen wording</label><div><input type="file" id="u3"></div></section>'
      +'<p><input type="submit" value="Submit application"></p></form>'
      +'<dialog id="dlg"><p>File this request?</p><button type="button" id="yes">Confirm</button></dialog>'
      +'<div id="done" hidden><p>Request received.</p><button type="button" id="again">Print a copy</button><input id="late" name="late"></div>';
    document.getElementById('tog').addEventListener('click',function(){var b=document.getElementById('bat');b.checked=!b.checked;document.getElementById('batnote').hidden=!b.checked;b.dispatchEvent(new Event('change',{bubbles:true}));});
    document.getElementById('fm').addEventListener('submit',function(e){e.preventDefault();document.getElementById('dlg').showModal();});
    document.getElementById('yes').addEventListener('click',function(){document.getElementById('dlg').close();document.getElementById('done').hidden=false;});
  }
  function render(){ if(/apply-/.test(location.pathname)) form(); else chooser(); }
  window.addEventListener('popstate',render); render();
  </script>`);

// ---- the job's documents, as the API lists them (type, name, size: never contents) ---------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zz-recorder-tile-"));
const file = (name: string, bytes: number): string => { const p = path.join(tmp, name); fs.writeFileSync(p, Buffer.alloc(bytes, 0x20)); return p; };
const DRAWINGS = file("zz-drawings.pdf", 2311);
const SHEET = file("zz-sheet.pdf", 1207);
const LETTER = file("zz-letter.pdf", 913);
const JOB_DOCUMENTS = [
  { id: "d1", docType: "plan_set", originalFilename: "zz-drawings.pdf", sizeBytes: 2311 },
  { id: "d2", docType: "site_plan", originalFilename: "zz-sheet.pdf", sizeBytes: 1207 },
  // Same NAME as the letter the person picks, another size: not the same file, so no match.
  { id: "d3", docType: "utility_bill", originalFilename: "zz-letter.pdf", sizeBytes: 914 },
];

const PAGES: Record<string, string> = { "/a/start": A_START, "/a/choose": A_CHOOSE, "/a/form": A_FORM, "/a/other": page("<h1>Fence request</h1>") };
let documentCalls = 0;
const server = http.createServer((q, r) => {
  const url = String(q.url ?? "").split("?")[0];
  if (url === "/api/projects/zz-job/documents") { documentCalls++; r.writeHead(200, { "Content-Type": "application/json" }); r.end(JSON.stringify({ documents: JOB_DOCUMENTS })); return; }
  if (url.startsWith("/api/")) { r.writeHead(404, { "Content-Type": "application/json" }); r.end("{}"); return; }
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(url.startsWith("/b") ? B_SHELL : PAGES[url] ?? page("nf"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch();
const mk = async () => {
  const ctx = await browser.newContext();
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  return ctx;
};

interface Site {
  name: string;
  /** Where the recording starts, and (when the chooser is a later page) how to reach it. */
  start: string;
  toChooser: (p: Page) => Promise<void>;
  chooserUrl: string;
  /** The entry click that precedes the tile in the recording ("" when the chooser is the first page). */
  entryNote: string;
  clickTile: (p: Page) => Promise<void>;
  tileTitle: string;
  tileWords: RegExp;
  formReady: string;
  beforeUploads: (p: Page) => Promise<void>;
  uploads: Array<{ input: string; file: string; slot: string | null; docType: string }>;
  askedSlot: string;
  submit: string;
  submitWords: RegExp;
  confirm: string;
}

const SITES: Site[] = [
  {
    name: "A (server pages, div cards, delayed navigation, fixed-layer confirmation)",
    start: "/a/start",
    toChooser: async (p) => { await p.click("text=Start an application"); await p.waitForURL(/\/a\/choose/); },
    chooserUrl: "/a/choose",
    entryNote: "Start an application",
    // The card's own PADDING: not the title, not the description.
    clickTile: async (p) => { await p.locator(".card").first().click({ position: { x: 6, y: 6 } }); await p.waitForURL(/\/a\/form/, { timeout: 8000 }); },
    tileTitle: "Rooftop array request",
    tileWords: /Rooftop array request/,
    formReady: "#own",
    beforeUploads: async () => undefined,
    uploads: [
      { input: "#f1", file: DRAWINGS, slot: "Sheets from the designer", docType: "plan_set" },
      { input: "#f2", file: LETTER, slot: "Owner letter", docType: "" },
    ],
    askedSlot: "Owner letter",
    submit: "#send",
    submitWords: /Submit application/,
    confirm: "#yes",
  },
  {
    name: "B (single-page app, li tiles, delegated listener, route change, <dialog>)",
    start: "/b",
    toChooser: async () => undefined,
    chooserUrl: "/b",
    entryNote: "",
    // The tile's DESCRIPTION line, not its title.
    clickTile: async (p) => { await p.click("#kinds li[data-k=ground] .d"); await p.waitForSelector("#fm"); },
    tileTitle: "Ground array request",
    tileWords: /Ground array request/,
    formReady: "input[name=own]",
    beforeUploads: async (p) => { await p.click("#tog"); await p.waitForTimeout(250); },
    uploads: [
      { input: "#u1", file: SHEET, slot: "Sheet for the reviewer", docType: "site_plan" },
      { input: "input[name=u2]", file: LETTER, slot: "Neighbour statement", docType: "" },
      { input: "#u3", file: DRAWINGS, slot: null, docType: "plan_set" },
    ],
    askedSlot: "Neighbour statement",
    submit: "input[type=submit]",
    submitWords: /Submit application/,
    confirm: "#yes",
  },
];

const isMarker = (s: RecipeStep | undefined): boolean => !!s && s.action === "click" && (!s.selector || Object.keys(s.selector).length === 0);
const show = (steps: RecipeStep[]): string => JSON.stringify(steps.map((s) => ({ a: s.action, sel: s.selector, note: s.note, slot: s.slot, docType: s.docType, fin: s.isFinalSubmit })));

try {
  const jobDocuments = await fetchJobDocuments(base, "zz-job", {});
  check("the job's documents are read from the API once (type, name, size)", documentCalls === 1 && jobDocuments.length === 3, `calls=${documentCalls} got=${JSON.stringify(jobDocuments)}`);
  // The fixture's slot names say nothing the learner's label table reads: a document type below can
  // only have come from matching the chosen file to the job's documents.
  for (const s of SITES) for (const u of s.uploads) if (u.slot) check(`fixture: the slot label "${u.slot}" names no document type on its own`, guessUploadDocType(u.slot) === "");

  for (const site of SITES) {
    console.log(`\n[site ${site.name}]`);
    const ctx = await mk();
    const p = await ctx.newPage();
    const lines: string[] = [];
    const session = await armRecorder(p, { bindField: () => undefined, startsFresh: true, log: (l) => lines.push(l), jobDocuments });
    const steps = session.steps;
    await p.goto(`${base}${site.start}`, { waitUntil: "domcontentloaded" });
    await site.toChooser(p);
    await p.waitForSelector("#blurb");
    // A stray click on plain text.
    await p.click("#blurb");
    await p.waitForTimeout(400);
    const beforeTile = steps.length;
    check("a stray click on plain text records nothing", beforeTile === (site.entryNote ? 1 : 0), show(steps));
    await site.clickTile(p);
    await p.waitForSelector(site.formReady);
    await p.waitForTimeout(300);

    // ---- A ----
    const tile = steps[beforeTile];
    check("A: the tile click is recorded as a click step, right after what came before it",
      steps.length === beforeTile + 1 && !!tile && tile.action === "click" && !isMarker(tile), show(steps));
    check("A: the step is named by the text the person read on the tile", !!tile && site.tileWords.test(String(tile.note ?? "")), show(steps));
    check("A: one printed line for the tile click", lines.filter((l) => /captured click/.test(l)).length === beforeTile + (tile ? 1 : 0) && !!tile, lines.join(" | "));
    if (tile && tile.selector && Object.keys(tile.selector).length) {
      const fresh = await mk();
      const fp = await fresh.newPage();
      await fp.goto(`${base}${site.chooserUrl}`, { waitUntil: "domcontentloaded" });
      await fp.waitForSelector("#blurb");
      const loc = buildLocator(fp, tile.selector);
      const clicked = loc ? await loc.click({ timeout: 4000 }).then(() => true).catch(() => false) : false;
      const formCame = clicked && await fp.waitForSelector(site.formReady, { timeout: 6000 }).then(() => true).catch(() => false);
      check("A: the recorded selector resolves on a fresh load and the click brings the form", formCame, JSON.stringify(tile.selector));
      await fresh.close();
    } else check("A: the recorded selector resolves on a fresh load and the click brings the form", false, "no tile step to replay");

    // ---- the form ----
    await p.fill(site.formReady, "ZZ Test Owner");
    await p.locator(site.formReady).blur();
    await site.beforeUploads(p);
    for (const u of site.uploads) { await p.setInputFiles(u.input, u.file); await p.waitForTimeout(150); }
    await p.waitForTimeout(200);
    if (site.name.startsWith("B")) {
      const checks = steps.filter((s) => s.action === "check");
      check("A: a non-control that only toggles a checkbox is the checkbox's step, never a second click",
        checks.length === 1 && !steps.some((s) => s.action === "click" && /Battery included/.test(String(s.note ?? ""))), show(steps));
    }

    // ---- C ----
    const ups = steps.filter((s) => s.action === "upload");
    check(`C: ${site.uploads.length} upload steps`, ups.length === site.uploads.length, show(steps));
    site.uploads.forEach((u, i) => {
      const s = ups[i];
      if (u.slot) check(`C: upload ${i + 1} carries its slot's visible label "${u.slot}"`, !!s && s.slot === u.slot, show(ups));
      else check(`C: upload ${i + 1} has no slot name (its only label is never painted)`, !!s && !s.slot && !/Unseen wording/.test(JSON.stringify(s.slot ?? "")), show(ups));
      check(`C: upload ${i + 1} document type is ${u.docType ? `"${u.docType}", from the job's own document` : "unknown (the file is not one of the job's)"}`, !!s && String(s.docType ?? "") === u.docType, show(ups));
    });
    check("C: the chosen file's name is in no step and no printed line", !/zz-(drawings|sheet|letter)/i.test(JSON.stringify(steps) + lines.join("\n")), show(steps));

    // ---- D ----
    await p.click(site.submit);
    await p.waitForSelector(site.confirm, { state: "visible" });
    await p.waitForTimeout(200);
    const marker = steps[steps.length - 1];
    check("D: the submit click is the blocked final-submit marker (targetless, flagged, naming the control)",
      isMarker(marker) && marker.isFinalSubmit === true && /^BLOCKED/.test(String(marker.note)) && site.submitWords.test(String(marker.note)), show(steps));
    const beforeConfirm = steps.length;
    const linesBeforeConfirm = lines.filter((l) => /captured/.test(l)).length;
    await p.click(site.confirm);
    await p.waitForSelector("#done", { state: "visible" });
    await p.waitForTimeout(300);
    check("D: the confirmation click after the blocked submit is not a step", steps.length === beforeConfirm, show(steps.slice(beforeConfirm - 1)));
    check("D: and it prints no \"captured\" line", lines.filter((l) => /captured/.test(l)).length === linesBeforeConfirm, lines.slice(-3).join(" | "));

    // ---- B ----
    session.stop();
    const atSave = steps.length;
    const linesAtSave = lines.length;
    await p.click("#again");
    await p.fill("#late", "ZZ after save");
    await p.locator("#late").blur();
    await p.waitForTimeout(400);
    check("B: nothing is captured after save", steps.length === atSave, show(steps.slice(atSave)));
    check("B: nothing is printed after save", lines.length === linesAtSave, lines.slice(linesAtSave).join(" | "));

    // ---- the saved shape ----
    const closed = finalizeRecordedSteps(steps);
    const n = closed.length;
    check("D: the recipe ends stopForReview then the one blocked final-submit marker",
      n >= 2 && closed[n - 2].action === "stopForReview" && isMarker(closed[n - 1]) && closed[n - 1].isFinalSubmit === true
      && closed.filter((s) => isMarker(s)).length === 1 && closed.filter((s) => s.isFinalSubmit === true).length === 1, show(closed));
    check("D: no step after the tile's is a replayable click (nothing of the submit can replay)",
      !closed.slice(beforeTile + 1).some((s) => s.action === "click" && !isMarker(s)), show(closed));
    const questions: string[] = [];
    await askUploadDocTypes(closed, async (q) => { questions.push(q); return ""; });
    check(`C: only the unmatched upload is asked about, by its slot's name ("${site.askedSlot}")`,
      questions.length === 1 && questions[0].includes(`"${site.askedSlot}"`) && !/an upload slot/.test(questions[0]), JSON.stringify(questions));
    await ctx.close();
  }

  console.log("\n[safety: a tile is asked the same question as a button]");
  {
    // A tile whose accessible name is harmless ("Open the cashier") and whose FACE reads "Pay the
    // fee now": it navigates, so it is recorded — as the blocked placeholder, never a replayable click.
    const ctx = await mk();
    const p = await ctx.newPage();
    const session = await armRecorder(p, { bindField: () => undefined, startsFresh: true, log: () => undefined });
    await p.goto(`${base}/a/choose`, { waitUntil: "domcontentloaded" });
    await p.locator(".card").nth(2).click({ position: { x: 6, y: 6 } });
    await p.waitForURL(/\/a\/other/);
    await p.waitForTimeout(300);
    const s = session.steps;
    check("a pay-worded tile that navigates is a blocked placeholder: no selector, optional, not a final submit",
      s.length === 1 && isMarker(s[0]) && s[0].optional === true && s[0].isFinalSubmit !== true && /^BLOCKED/.test(String(s[0].note)), show(s));
    await ctx.close();
  }
  {
    // The rule after a blocked final submit is about the recording's shape, not the confirmation's
    // words: a "No" in the dialog is not a step either, and a submit-worded "Yes, submit" there adds
    // no second marker. A click that is NOT in a dialog is recorded as it always was.
    const steps: RecipeStep[] = [];
    const sink = createRecorderSink(steps, () => undefined, { startsFresh: true });
    sink({ kind: "fill", selector: { role: "textbox", name: "Owner name" }, value: "ZZ Test Owner", label: "Owner name" });
    sink({ kind: "click", selector: { role: "button", name: "Submit application" }, label: "Submit application" });
    sink({ kind: "click", selector: { role: "button", name: "No" }, label: "No", inDialog: true });
    sink({ kind: "click", selector: { role: "button", name: "Submit application" }, label: "Submit application", inDialog: true });
    check("after the blocked final submit: neither a \"No\" nor a submit-worded confirmation in its dialog adds a step or a second marker",
      steps.length === 2 && isMarker(steps[1]) && steps[1].isFinalSubmit === true, show(steps));
    sink({ kind: "click", selector: { role: "button", name: "Next" }, label: "Next" });
    check("a click outside any dialog is recorded as before (the rule needs the dialog)",
      steps.length === 3 && steps[2].action === "click" && !isMarker(steps[2]), show(steps));
    const plain: RecipeStep[] = [];
    const plainSink = createRecorderSink(plain, () => undefined, { startsFresh: true });
    plainSink({ kind: "click", selector: { role: "button", name: "Start" }, label: "Start" });
    plainSink({ kind: "click", selector: { role: "button", name: "Agree" }, label: "Agree", inDialog: true });
    check("a dialog click that follows an ordinary step is recorded as before (the rule needs the blocked final submit)",
      plain.length === 2 && plain.every((s) => s.action === "click" && !isMarker(s)), show(plain));
    // A page cannot name a document type: only the Node-side match of the job's documents can.
    const up: RecipeStep[] = [];
    createRecorderSink(up, () => undefined)({ kind: "upload", selector: { css: "#x" }, label: "", fileName: "zz-drawings.pdf", fileSize: 2311, ...({ docType: "plan_set", matchedDocType: "plan_set" } as object) });
    check("an upload names no document type unless the recorder matched the file to the job's documents", up.length === 1 && up[0].docType === "", show(up));
  }
} finally {
  await browser.close();
  server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp files only */ }
}

console.log(failures === 0 ? "\nrecordRecipeTile.dom.smoke: all checks passed" : `\nrecordRecipeTile.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
