// THE LOOKUP-BUTTON PASS LEAVES A SECTION ALONE ONCE ITS SEARCH BOX HAS BEEN ANSWERED BY A TYPE-AHEAD PICK.
//
// A supervised learn of a permit portal's "location of work" page: the walk typed the job's address
// into a required search-as-you-type box and picked it from the list (correct). The lookup-button
// pass then read the same section as required-blank, named by its HEADING, and pressed its three
// helper buttons one after another. The first press "changed nothing", so the pass searched the
// section as a form: it typed the client's business name into the one visible box labelled "Search"
// — the box that held the pick. The portal refused the next step ("The search value did not match
// an address") and the page had to be done again.
//
// Two mis-reads, one consequence, each pinned on its own:
//   closeddialog   the "blank" was the required boxes of a CLOSED dialog (the page's own "Can't find
//                  address?" form, one of them disabled) — a form that is not open is not the
//                  section's hidden required validator;
//   enterpick      a pick the portal selects on Enter is shown OUTSIDE the box, which comes back
//                  empty and required: that box is answered, not blank;
//   listpick       the live shape (a list pick, the closed dialogs, three helper buttons);
//   pickplusblank  a section holding a pick AND a real required blank: its populate button may still
//                  be pressed, its search helper never, and nothing types into the answered box;
//   control        MUST STILL PRESS: no pick, a real required blank, a populate button that fills it
//                  (the closed dialog beside it changes nothing) — pressed once and recorded.
// SYNTHETIC data only. Helper presses are counted by the server (a GET per press) and by the value
// the page posts at Next, never only by the learner's own events.
//
//   npx tsx portal-bot/src/adapters/lookupAfterTypeaheadPick.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium, type Page } from "playwright";
import { AutoLearnAdapter, type LearnPlanner, type LearnResult } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const JOB = { street: "100 Test St", city: "Testville", state: "ZZ", zip: "99999" };
const PICK = "100 TEST ST, TESTVILLE";
const ROWS = ["98 TEST ST, TESTVILLE", PICK, "102 TEST ST, TESTVILLE"];
const COMPANY = "ZZ Test Solar Co";
const LOT = "LOT-0001";
const loose = (s: string): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const escHtml = (s: string): string => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

type Mode = "listpick" | "closeddialog" | "enterpick" | "pickplusblank" | "control";
const SHAPE: Record<Mode, { box: "list" | "enter" | "none"; dialogs: boolean; near: boolean; map: boolean; door: boolean; autofill: "" | "fills" | "nothing"; lot: "" | "text" | "select"; plain: boolean }> = {
  listpick: { box: "list", dialogs: true, near: true, map: true, door: true, autofill: "", lot: "", plain: false },
  closeddialog: { box: "none", dialogs: true, near: true, map: false, door: true, autofill: "", lot: "", plain: true },
  enterpick: { box: "enter", dialogs: false, near: true, map: false, door: false, autofill: "", lot: "", plain: false },
  pickplusblank: { box: "list", dialogs: false, near: true, map: false, door: false, autofill: "nothing", lot: "select", plain: false },
  control: { box: "none", dialogs: true, near: false, map: false, door: false, autofill: "fills", lot: "text", plain: true },
};

type Log = { hits: string[]; enters: string[]; nexts: Array<{ q: string; selected: string; lot: string; ok: boolean }> };
const logs: Partial<Record<Mode, Log>> = {};
const logOf = (mode: Mode): Log => (logs[mode] ??= { hits: [], enters: [], nexts: [] });

// ---- the replica ---------------------------------------------------------------------------------
// One heading for the whole form, so the heading-scoped "section" is the form itself: the helper
// buttons, the search box, the read-only "selected" box and the closed dialogs all sit in it.
const locPage = (mode: Mode, o: { selected?: string; error?: string; title?: string } = {}): string => {
  const s = SHAPE[mode];
  const sel = o.selected ?? "";
  const btn = (id: string, label: string): string => `<div class="row"><div class="btns"><div><input type="button" id="${id}" value="${escHtml(label)}"></div></div></div>`;
  return `<!doctype html><html><head><title>${o.title ?? "Permit Application | Synthetic Portal"}</title>
<style>body{font:14px sans-serif;margin:16px} .default-submit{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
 .errors{color:#b00} label{display:block;margin:2px 0 10px} input[type=text],textarea{width:420px}
 ul[role=listbox]{position:absolute;background:#fff;border:1px solid #ccc;list-style:none;margin:0;padding:0;width:440px}
 ul[role=listbox] li{padding:4px 8px;cursor:pointer}</style></head><body>
<h1>Synthetic Portal</h1>
${o.error ? `<div class="errors validation-summary-errors" role="alert"><ul><li>${escHtml(o.error)}</li></ul></div>` : ""}
<form method="post" action="/loc?mode=${mode}" id="appForm">
${s.box === "enter" ? `<input type="submit" name="bdefault" aria-hidden="true" tabindex="-1" class="default-submit" value="">` : ""}
<input type="hidden" name="selected" id="selected" value="${escHtml(sel)}">
<h2>Application - Location of Work</h2>
<p>Required information is indicated with an asterisk (*)</p>
${s.plain ? `<div class="field"><input id="projname" name="projname" type="text"><label for="projname">Project name:<span class="required">*</span></label></div>
<div class="field"><input id="sitestreet" name="sitestreet" type="text"><label for="sitestreet">Site street:<span class="required">*</span></label></div>` : ""}
${s.near ? btn("bNear", "Find locations near me") : ""}
${s.map ? btn("bMap", "Find location in map") : ""}
${s.dialogs ? `<dialog id="popupMap" class="popup"><button type="button" class="popupClose" title="Close" aria-label="close">x</button><div style="width:320px;height:160px">map</div></dialog>` : ""}
${s.box !== "none" ? `<div class="field"><div class="ta"><input id="locsearch" name="locsearch" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false"${s.box === "list" ? ` aria-controls="locsearch_list"` : ""} autocomplete="off"></div>
<label for="locsearch">Search for location:<span class="required">*</span></label></div>` : ""}
${s.door ? btn("bDoor", "Can't find address?") : ""}
${s.box !== "none" ? `<div class="field"><textarea id="uselocation" name="uselocation" readonly rows="2">${escHtml(sel)}</textarea>
<label for="uselocation">The location you have selected: <span class="required">*</span></label></div>
<table id="locations"><caption>Locations</caption><tr><th>Address</th></tr>${sel ? `<tr><td>${escHtml(sel)}</td></tr>` : ""}</table>` : ""}
${s.lot === "text" ? `<div class="field"><input id="lot" name="lot" type="text"><label for="lot">Lot Number:<span class="required">*</span></label></div>` : ""}
${s.lot === "select" ? `<div class="field"><select id="lot" name="lot"><option value="">--Select--</option><option>LOT-0001</option><option>LOT-0002</option></select><label for="lot">Lot Number:<span class="required">*</span></label></div>` : ""}
${s.autofill ? btn("bAuto", "Autofill lot") : ""}
${s.dialogs ? `<dialog id="popupNewLocation" class="popup"><button type="button" class="popupClose" title="Close" aria-label="close">x</button>
<p>Please enter the address or the lot number of the location.</p>
<fieldset><input id="lotNL" name="lotNL" type="text" required aria-required="true" disabled><label for="lotNL">New lot number<span class="required">*</span></label></fieldset>
<fieldset><input id="streetNL" name="streetNL" type="text" required aria-required="true"><label for="streetNL">New street address:<span class="required">*</span></label>
<input id="cityNL" name="cityNL" type="text" required aria-required="true"><label for="cityNL">New city:<span class="required">*</span></label></fieldset>
<button type="button" id="useLoc">Use This Location</button></dialog>` : ""}
<p><button type="submit" name="bnext" value="1" formnovalidate>Next Step</button></p>
</form>
${s.box === "list" ? `<ul id="locsearch_list" role="listbox" style="display:none"></ul>` : ""}
<script>
  function hit(b) { new Image().src = "/hit?mode=${mode}&b=" + b + "&t=" + Date.now(); }
  function on(id, fn) { var e = document.getElementById(id); if (e) e.addEventListener("click", fn); }
  on("bNear", function () { hit("near"); });
  on("bMap", function () { hit("map"); document.getElementById("popupMap").showModal(); });
  on("bDoor", function () { hit("door"); document.getElementById("popupNewLocation").showModal(); });
  on("bAuto", function () { hit("auto"); ${s.autofill === "fills" ? `document.getElementById("lot").value = ${JSON.stringify(LOT)};` : ""} });
  document.querySelectorAll(".popupClose").forEach(function (c) { c.addEventListener("click", function () { c.parentElement.close(); }); });
  ${s.box === "list" ? `(function () {
    var rows = ${JSON.stringify(ROWS)};
    var box = document.getElementById("locsearch"), list = document.getElementById("locsearch_list"), timer = null;
    function words(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean); }
    function close() { list.style.display = "none"; list.innerHTML = ""; box.setAttribute("aria-expanded", "false"); }
    box.addEventListener("input", function () {
      clearTimeout(timer);
      var q = box.value.trim();
      if (q.length < 2) { close(); return; }
      timer = setTimeout(function () {
        // Every row on the street is offered: the pick is the learner's choice among them.
        var hits = words(q).indexOf("test") >= 0 ? rows : [];
        list.innerHTML = "";
        hits.forEach(function (r) {
          var li = document.createElement("li"); li.setAttribute("role", "option"); li.textContent = r;
          li.addEventListener("mousedown", function (e) { e.preventDefault(); });
          li.addEventListener("click", function () {
            box.value = r; document.getElementById("uselocation").value = r; document.getElementById("selected").value = r; close();
          });
          list.appendChild(li);
        });
        var b = box.getBoundingClientRect();
        list.style.left = b.left + "px"; list.style.top = (b.bottom + window.scrollY) + "px";
        list.style.display = hits.length ? "block" : "none";
        box.setAttribute("aria-expanded", hits.length ? "true" : "false");
      }, 250);
    });
  })();` : ""}
</script></body></html>`;
};

const REVIEW = `<!doctype html><html><head><title>Review Application</title></head><body>
<h1>Review</h1><p>Review your application before you submit it.</p>
<button type="button" id="submit">Submit Application</button></body></html>`;

async function locPost(req: http.IncomingMessage, res: http.ServerResponse, mode: Mode): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const log = logOf(mode);
  const s = SHAPE[mode];
  const q = body.get("locsearch") || "";
  const selected = body.get("selected") || "";
  const bounce = (error: string, keep: string): void => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(locPage(mode, { selected: keep, error, title: "Submission Error - Permit Application | Synthetic Portal" }));
  };
  if (body.has("bnext")) {
    const lot = body.get("lot") || "";
    // What the portal checks at Next: the search box may hold nothing but the selected location.
    const boxOk = s.box === "none" ? true : s.box === "enter" ? !!selected && !q.trim() : !!selected && loose(q) === loose(selected);
    const plainOk = !s.plain || (!!body.get("projname") && !!body.get("sitestreet"));
    const lotOk = mode !== "control" || !!lot;
    const ok = boxOk && plainOk && lotOk;
    log.nexts.push({ q, selected, lot, ok });
    if (ok) { res.writeHead(303, { Location: `/review?mode=${mode}` }); res.end(); return; }
    // As live: a refused location comes back to be searched again (a list pick is gone; an Enter
    // selection is the server's own and stays).
    return bounce(!boxOk ? "The search value did not match an address" : !lotOk ? "Lot Number is required" : "Required information is missing", s.box === "enter" ? selected : "");
  }
  // Enter in the search box: the form's hidden default submit posts the search back.
  log.enters.push(q);
  if (s.box === "enter" && loose(q).includes(loose(`${JOB.street}, ${JOB.city}`))) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(locPage(mode, { selected: PICK }));
    return;
  }
  bounce("The search value did not match an address", selected);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  const mode = (u.searchParams.get("mode") || "listpick") as Mode;
  if (u.pathname === "/hit") { logOf(mode).hits.push(u.searchParams.get("b") || "?"); res.writeHead(204); return res.end(); }
  if (u.pathname === "/loc") {
    if (req.method === "POST") { void locPost(req, res, mode); return; }
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(locPage(mode));
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(REVIEW);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");

// ---- the walks -----------------------------------------------------------------------------------
// The planner stands in for the LLM: the job's street into the search box (or the plain street box),
// a project name, and Next. It never answers "Lot Number" and never asks for a helper button.
const planner: LearnPlanner = async (req) => {
  if (/review/i.test(req.pageTitle || "")) return { fills: [], atReview: true };
  const at = (re: RegExp): number => req.fields.findIndex((f) => re.test(String(f.label ?? "")));
  const fills: Array<{ selectorIndex: number; value: string; field?: string }> = [];
  const box = at(/^Search for location/);
  if (box >= 0) fills.push({ selectorIndex: box, value: JOB.street, field: "street" });
  const proj = at(/^Project name/);
  if (proj >= 0) fills.push({ selectorIndex: proj, value: "ZZ Test Project" });
  const street = at(/^Site street/);
  if (street >= 0) fills.push({ selectorIndex: street, value: JOB.street, field: "street" });
  const next = req.fields.findIndex((f) => f.label === "Next Step");
  return { fills, atReview: false, ...(next >= 0 ? { advanceSelectorIndex: next } : {}) };
};
// LOOKUP_PICK_MODES=listpick,control narrows a local run to the named cases (a kill check of one rule).
const ONLY = String(process.env.LOOKUP_PICK_MODES ?? "").split(",").map((m) => m.trim()).filter(Boolean);
const wanted = (mode: Mode): boolean => !ONLY.length || ONLY.includes(mode);
type Ev = Record<string, unknown>;
async function learnLoc(mode: Mode): Promise<{ result: LearnResult; page: Page; ms: number; events: Ev[] }> {
  const page = await ctx.newPage();
  const url = `${base}/loc?mode=${mode}`;
  await page.goto(url);
  const adapter = new AutoLearnAdapter(`Lookup after pick ${mode}`, planner, {
    maxPages: 4, siteIdentity: { city: JOB.city, zip: JOB.zip },
    contactIdentity: { companyName: COMPANY, firstName: "Permit", lastName: "Tech" }, siteContactIdentity: { lastName: "Owner" },
  });
  (adapter as unknown as { page: unknown }).page = page;
  const events: Ev[] = [];
  const t0 = Date.now();
  const noop = async (): Promise<void> => undefined;
  (adapter as unknown as { debug: unknown }).debug = {
    event: (e: Ev) => { events.push({ ...e, at: Date.now() - t0 }); },
    writeJson: () => undefined, capturePageHtml: noop, screenshot: noop, startTrace: noop, stopTrace: noop, finalize: noop,
    setScrubber: () => undefined, dir: "",
  };
  const result = await adapter.learn(
    { portalUrl: url } as never,
    { projectAddress: `${JOB.street}, ${JOB.city}, ${JOB.state}, ${JOB.zip}`, city: JOB.city, state: JOB.state, zip: JOB.zip, homeownerName: "ZZ Test Owner", permitType: "building" } as never,
  );
  return { result, page, ms: Date.now() - t0, events };
}
const ofType = (events: Ev[], type: string): Ev[] => events.filter((e) => e.type === type);
const lookupClicks = (r: LearnResult): string[] => r.steps.filter((s) => s.action === "click" && /^lookup:/.test(String(s.note ?? ""))).map((s) => String(s.note));
const say = (mode: Mode, r: { result: LearnResult; page: Page; ms: number; events: Ev[] }): string => {
  const log = logOf(mode);
  const detail = `hits=${JSON.stringify(log.hits)} nexts=${JSON.stringify(log.nexts)} enters=${log.enters.length} url=${r.page.url().replace(base, "")} stop=${String(r.result.stopReason)} lookupSteps=${JSON.stringify(lookupClicks(r.result))}`;
  console.log(`# ${mode}: ${r.ms} ms ${detail}`);
  console.log(`#   typeahead: ${JSON.stringify(ofType(r.events, "typeahead_fill").map((e) => `${String(e.outcome)}/${String(e.via ?? "")}`))} lookup events: ${JSON.stringify(r.events.filter((e) => /^lookup_/.test(String(e.type))).map((e) => ({ type: e.type, label: e.label, sections: e.sections, blanks: e.blanks, why: e.why }))).slice(0, 900)}`);
  console.log(`#   message: ${r.result.message.slice(0, 300)}`);
  if (process.env.LOOKUP_PICK_TIMELINE === "1") console.log(`#   timeline: ${r.events.map((e) => `${String(e.at)}:${String(e.type)}`).join(" ")}`);
  return detail;
};

// (1) THE LIVE SHAPE: a list pick, the closed dialogs, three helper buttons.
if (wanted("listpick")) {
  const mode: Mode = "listpick";
  const r = await learnLoc(mode);
  const log = logOf(mode);
  const detail = say(mode, r);
  check("(1) listpick: the type-ahead picked the job's address from the list (the case is not vacuous)",
    ofType(r.events, "typeahead_fill").some((e) => e.outcome === "picked" && e.via === "list"), detail);
  check("(1) MUST-EXCLUDE: none of the section's helper buttons is pressed after the pick (server-side count)",
    log.hits.length === 0, detail);
  check("(1) MUST-EXCLUDE: the answered search box is never typed over — Next posts the picked suggestion, never the business name",
    log.nexts.length >= 1 && loose(log.nexts[0].q) === loose(PICK) && !log.nexts.some((n) => loose(n.q).includes(loose(COMPANY))), detail);
  check("(1) MUST-PASS: the portal accepts the page the first time (one Next, no \"did not match\" bounce) and the walk reaches review",
    log.nexts.length === 1 && log.nexts[0].ok && /\/review/.test(r.page.url()) && !ofType(r.events, "portal_notice").length, detail);
  check("(1) ...no helper click is recorded as a step, and the section is not read as blank by its heading",
    lookupClicks(r.result).length === 0 && !ofType(r.events, "lookup_button_press").length
      && !ofType(r.events, "lookup_sections").some((e) => JSON.stringify(e.sections ?? "").includes('"blanks":["Application - Location of Work"]')), detail);
  await r.page.close();
}

// (2) RULE: the required boxes of a CLOSED dialog are not the section's blank (no type-ahead here).
if (wanted("closeddialog")) {
  const mode: Mode = "closeddialog";
  const r = await learnLoc(mode);
  const log = logOf(mode);
  const detail = say(mode, r);
  check("(2) closeddialog MUST-EXCLUDE: every visible required box is filled, so no helper button is pressed (the closed dialog's own required boxes are not this section's blank)",
    log.hits.length === 0 && !ofType(r.events, "lookup_button_press").length, detail);
  check("(2) ...and the walk advances once to review with nothing recorded for a helper",
    log.nexts.length === 1 && log.nexts[0].ok && /\/review/.test(r.page.url()) && lookupClicks(r.result).length === 0, detail);
  await r.page.close();
}

// (3) RULE: a box the portal selected for on Enter (shown outside it, the box empty) is answered.
if (wanted("enterpick")) {
  const mode: Mode = "enterpick";
  const r = await learnLoc(mode);
  const log = logOf(mode);
  const detail = say(mode, r);
  check("(3) enterpick: the portal selected the job's address on Enter (the case is not vacuous)",
    ofType(r.events, "typeahead_fill").some((e) => e.outcome === "picked" && e.via === "enter") && log.enters.length === 1, detail);
  check("(3) MUST-EXCLUDE: the emptied, required search box is not a blank — its helper button is not pressed",
    log.hits.length === 0 && !ofType(r.events, "lookup_button_press").length, detail);
  check("(3) MUST-EXCLUDE: nothing is typed into the answered box — Next posts it empty, once, and the walk reaches review",
    log.nexts.length === 1 && log.nexts[0].ok && !log.nexts[0].q.trim() && /\/review/.test(r.page.url()), detail);
  await r.page.close();
}

// (4) A pick AND a real blank in the same section: the populate button may be pressed; the search
//     helper is not; nothing types into the answered box.
if (wanted("pickplusblank")) {
  const mode: Mode = "pickplusblank";
  const r = await learnLoc(mode);
  const log = logOf(mode);
  const detail = say(mode, r);
  check("(4) pickplusblank MUST-PASS: the section's populate button is still pressed for its real required blank",
    log.hits.includes("auto"), detail);
  check("(4) MUST-EXCLUDE: the search helper of the answered box is never pressed",
    !log.hits.includes("near"), detail);
  check("(4) MUST-EXCLUDE: the press that changed nothing does not search the section through the answered box — Next posts the picked suggestion",
    log.nexts.length >= 1 && loose(log.nexts[0].q) === loose(PICK) && !log.nexts.some((n) => loose(n.q).includes(loose(COMPANY))), detail);
  await r.page.close();
}

// (5) CONTROL — the pass still does its job: a real required blank, a populate button that fills it.
if (wanted("control")) {
  const mode: Mode = "control";
  const r = await learnLoc(mode);
  const log = logOf(mode);
  const detail = say(mode, r);
  const clicks = r.result.steps.filter((s) => s.action === "click" && /^lookup: Autofill lot/.test(String(s.note ?? "")));
  check("(5) control MUST-PASS: the populate button of a really blank required box is pressed ONCE",
    log.hits.filter((h) => h === "auto").length === 1, detail);
  check("(5) ...recorded as a lookup click naming what it populated (never a typed value)",
    clicks.length === 1 && (clicks[0].populates ?? []).some((l) => /^Lot Number/.test(l)) && !r.result.steps.some((s) => s.value === LOT),
    `${detail} step=${JSON.stringify(clicks[0] ?? null)}`);
  check("(5) ...and the page advances once with the populated value",
    log.nexts.length === 1 && log.nexts[0].ok && log.nexts[0].lot === LOT && /\/review/.test(r.page.url()), detail);
  await r.page.close();
}

await browser.close();
server.close();
console.log(failures === 0 ? "lookupAfterTypeaheadPick.dom.smoke: PASS" : `lookupAfterTypeaheadPick.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
