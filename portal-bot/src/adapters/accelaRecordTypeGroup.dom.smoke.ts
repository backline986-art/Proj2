// A RECORD TYPE INSIDE A COLLAPSED GROUP IS OPENED BY ITS OWN HEADER, NEVER LEFT UNSELECTED (#174).
//
// Watched City of Meridian learn (Accela Citizen Access, 2026-11-12): the "Select Permit Type" page
// lists collapsed GROUPS — a header <a onclick="ToggleRecordTypeList(this)"><img alt="Expand"><span>
// Residential Electrical</span></a> followed by <div class="ServiceItemList" style="display:none">
// with the record-type radios — and the category CHECKBOXES (cbListGroup_*) exist but sit in a hidden
// filter panel. The pass chose the right radio (the person-verified "Residential Electrical Solar
// Array", #166), tried only a category checkbox, failed check() on the hidden one, failed check() on
// the hidden radio, bailed to the planner, which pressed Continue Application with nothing selected:
// "You have not selected a record type." — through two recovery attempts, then the job failed.
//
// This drives the REAL AutoLearnAdapter.learn() (and the REAL RecipeAdapter for the replay) against a
// local CapType page shaped like Meridian's:
//   grouped   three collapsed groups opened by <a onclick> headers, the target radio hidden in the
//             second, the hidden filter-panel checkboxes present → the header is clicked BY TEXT, the
//             radio ticked, steps recorded by label (group, then type), record_type_group_opened
//             {via:"header"}, Continue pressed only after the tick (the server sees the pick).
//   nogroup   the target's list is hidden and NOTHING on the page opens it → the named stop
//             (stopReason record_type_closed_group), no Continue click, the planner never asked.
//   lazy      the groups are EMPTY until opened (Anne Arundel's shape) and a "Residential" group is
//             also offered → the expansion pass opens the group whose header is a PREFIX of the
//             verified type ("Residential Electrical"), not the word-preference "Residential".
//   checkbox  CHINO's shape: VISIBLE category checkboxes above hidden lists, no header toggles → the
//             second path still ticks the category (via:"checkbox") and the radio.
//   replay    the grouped recipe replayed on a page whose groups are REORDERED (the recorded ids
//             name another group) → the group is opened by label and the right radio ticked.
//
// And WITHOUT a verified type (#176 — the owner-watched rerun, where Meridian's row was only seeded):
//   A1 classfirst  the grouped page, "Commercial Electrical Solar Array" listed BEFORE "Residential
//                  Electrical Solar Array", a residential job, the type on file seeded → the
//                  Residential one is chosen (record_type_class_decision names it), recorded as a
//                  plain "record type:" step — the seeded value never steered (hard rule 3).
//   A2 otherclass  only the Commercial solar type offered (plus a Residential Building group) → the
//                  walk stops NAMED (stopReason record_type_unsettled), nothing ticked, Continue not
//                  pressed, the planner never asked.
//   A3 lazy        the empty groups with NO type on file → the expansion opens "Residential
//                  Electrical" (this job's class AND discipline), never the bare "Residential".
//   B1 skiplink    the grouped page inside a 0px-tall <main id="mainContent"> with a "Skip to main
//                  content" link to it → the opener is the header toggle, never the skip link; no
//                  record_type_group_header_no_effect, no expansion retry.
//
//   MUST PASS    - grouped, nogroup, lazy and replay go red with the #174 changes removed (the
//                  learner's header path, the named stop, the prefix preference, the replay route);
//                  A1/A2/A3 go red with the #176 class rule removed from the pass / expansion, B1 with
//                  the #176 revealHidden changes removed.
//   MUST EXCLUDE - checkbox keeps passing: the category-checkbox path is untouched when its box is
//                  visible.
//
//   npx tsx portal-bot/src/adapters/accelaRecordTypeGroup.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { LearnTargetRecordType, PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { AutoLearnAdapter, type LearnPlanner, type LearnPlanRequest } from "./autoLearnAdapter";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const TARGET = "Residential Electrical Solar Array";
const GROUP = "Residential Electrical";
const PX = "ctl00_PlaceHolderMain_capTypeListControl_rptPermitTypeGroup";
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

type Shape = "grouped" | "nogroup" | "lazy" | "checkbox" | "otherclass" | "skiplink";
interface Group { name: string; types: string[] }
// The Commercial group FIRST, as Accela tenants list them — its solar type is the one DOM order took.
const OTHER_CLASS = "Commercial Electrical Solar Array";
const GROUPS: Group[] = [
  { name: "Commercial", types: ["Commercial Addition", OTHER_CLASS] },
  { name: GROUP, types: ["Residential Electrical Floor Heat", TARGET, "Residential electrical service reactivation/upgrade"] },
  { name: "Residential Building", types: ["Residential Building Addition", "Residential Building Deck"] },
];
const RESIDENTIAL_WORD_GROUP: Group = { name: "Residential", types: ["Residential Fence"] };

function radios(gi: number, types: string[]): string {
  return types.map((t, j) => {
    const id = `${PX}_ctl0${gi}_rptPermitTypeCont_ctl0${j}_permitType`;
    return `<span class="aca_checkbox aca_checkbox_fontsize"><input id="${id}" type="radio" name="ctl00$PlaceHolderMain$capTypeListControl$rptPermitTypeGroup$ctl0${gi}$rptPermitTypeCont$ctl0${j}$capTypeGroup" onclick="SelectNode(this);" title="${t}" value=""><label for="${id}">${t}</label></span><br>`;
  }).join("\n");
}

/** One group. `header`: a clickable header (Meridian) or a plain caption (nothing opens the list).
 *  `lazy`: the list is empty until the header is clicked. */
function group(gi: number, g: Group, opts: { header: "toggle" | "caption"; lazy: boolean }): string {
  const head = opts.header === "toggle"
    ? `<a href="javascript:void(0)" onclick="ToggleRecordTypeList(this); return false;" class="NotShowLoading"><img class="ACA_NoBorder" src="${GIF}" width="9" height="9" alt="Expand"> <span id="${PX}_ctl0${gi}_lblGroupName" class="ACA_Title_Color">${g.name}</span></a>`
    : `<span class="ACA_Title_Color">${g.name}</span>`;
  return `<div class="ServiceListContainer ACA_Link_Text ACA_HyperLink" style="display: inline">
    <div id="${PX}_ctl0${gi}_GroupName" class="ServiceListGroupName">${head}</div>
    <div style="display: none;" class="ServiceItemList" data-types="${encodeURIComponent(JSON.stringify(g.types))}" data-gi="${gi}">
      ${opts.lazy ? "" : radios(gi, g.types)}
    </div>
  </div>`;
}

function filterPanel(groups: Group[], visible: boolean): string {
  const rows = groups.map((g, i) => {
    const id = `ctl00_PlaceHolderMain_recordTypeFilterSelection_cbListGroup_${i}`;
    return `<tr><td><input id="${id}" type="checkbox" class="recordTypeFilterSelection" data-group="${g.name}" onchange="CategoryToggled(this);"><label for="${id}">${g.name}</label></td></tr>`;
  }).join("");
  return `<div class="group_filter_selection" style="display:${visible ? "block" : "none"}"><table summary="Record Type Group Filter"><caption>Record Type Group Filter</caption><tbody>${rows}</tbody></table></div>`;
}

/** The CapType page for one shape. `order` rotates the groups (the replay leg) so a recorded id names
 *  another group; `err` renders the portal's own refusal line. */
function capTypePage(shape: Shape, order: "normal" | "rotated", err: boolean): string {
  // otherclass (#176 A2): the Residential ELECTRICAL group is gone — only the Commercial solar type and
  // a Residential Building group (so the page still reads as a record-type page) are offered.
  let groups = shape === "lazy" ? [...GROUPS, RESIDENTIAL_WORD_GROUP] : shape === "otherclass" ? [GROUPS[0], GROUPS[2]] : [...GROUPS];
  if (order === "rotated") groups = [groups[2], groups[0], groups[1]];
  const body = groups.map((g, gi) => group(gi, g, {
    header: shape === "checkbox" || (shape === "nogroup" && g.name === GROUP) ? "caption" : "toggle",
    lazy: shape === "lazy",
  })).join("\n");
  const content = `<h1>Select a Record Type</h1>
  <p>Choose one of the following available record types. For assistance or to apply for a record type not listed below please contact us.</p>
  ${err ? `<div id="ctl00_PlaceHolderMain_lblMessage" class="ACA_ErrorMsg" style="color:#b00">You have not selected a record type.</div>` : ""}
  ${filterPanel(groups, shape === "checkbox")}
  <div id="capTypeList" class="ACA_RightItem"><div class="servicelist"><div id="ctl00_PlaceHolderMain_capTypeListControl_updatePanel">
  ${body}
  </div></div></div>
  <div id="ctl00_PlaceHolderMain_btnContinue_container"><div class="ACA_Continue ACA_LgButton_FontSize ACA_Button_Text"><a id="ctl00_PlaceHolderMain_btnContinue" accesskey="3" class="ACA_FLeft" title="Continue Application »" href="javascript:void(0)" onclick="return doContinue();"><span>Continue Application »</span></a></div></div>`;
  // skiplink (#176 B1): Meridian's page chrome — a visually-hidden "Skip to main content" link to
  // <main id="mainContent">, whose children FLOAT so the landmark itself measures 0px tall.
  const framed = shape === "skiplink"
    ? `<a class="skip-link" href="#mainContent" aria-label="Skip to main content" style="position:absolute;left:-9999px">Skip to main content</a>
  <main id="mainContent"><div style="float:left;width:720px">${content}</div></main><div style="clear:both"></div>`
    : content;
  return `<!doctype html><html><head><title>Accela Citizen Access</title></head><body style="font:14px sans-serif;padding:16px">
  ${framed}
  <script>
    function SelectNode(r) {}
    function fillList(list) {
      if (list.children.length) return;
      var types = JSON.parse(decodeURIComponent(list.getAttribute("data-types")));
      var gi = list.getAttribute("data-gi");
      var html = "";
      for (var j = 0; j < types.length; j++) {
        var id = "${PX}_ctl0" + gi + "_rptPermitTypeCont_ctl0" + j + "_permitType";
        html += '<span class="aca_checkbox"><input id="' + id + '" type="radio" name="g' + gi + '" title="' + types[j] + '" value=""><label for="' + id + '">' + types[j] + '</label></span><br>';
      }
      list.innerHTML = html;
    }
    function ToggleRecordTypeList(a) {
      var list = a.parentElement.nextElementSibling;
      var open = list.style.display !== "none";
      list.style.display = open ? "none" : "block";
      a.querySelector("img").alt = open ? "Expand" : "Collapse";
      if (!open) fillList(list);
    }
    function CategoryToggled(cb) {
      var name = cb.getAttribute("data-group");
      var lists = document.querySelectorAll(".ServiceItemList");
      for (var i = 0; i < lists.length; i++) {
        var cap = lists[i].previousElementSibling.textContent.replace(/\\s+/g, " ").trim();
        if (cap === name) lists[i].style.display = cb.checked ? "block" : "none";
      }
    }
    function doContinue() {
      var r = document.querySelector('input[type=radio]:checked');
      var q = location.search.replace(/[?&]err=1/, "");
      if (r) location.href = "/MERIDIANTEST/Cap/CapDetail.aspx?picked=" + encodeURIComponent(r.title);
      else location.href = location.pathname + q + (q ? "&" : "?") + "err=1";
      return false;
    }
  </script>
</body></html>`;
}

const detailPage = `<!doctype html><html><head><title>Accela Citizen Access</title></head><body style="font:14px sans-serif;padding:16px">
  <h1>Step 1: Detail Information</h1>
  <label for="ctl00_PlaceHolderMain_txtJob">Job Value</label><input id="ctl00_PlaceHolderMain_txtJob" type="text">
  <div id="ctl00_PlaceHolderMain_btnContinue_container"><a id="ctl00_PlaceHolderMain_btnContinue" href="javascript:void(0)"><span>Continue Application »</span></a></div>
</body></html>`;

/** Every request the fixture served: the Continue click reaches here as CapDetail?picked=… or as
 *  CapType…&err=1 ("You have not selected a record type."). */
const hits: string[] = [];
const server = http.createServer((q, r) => {
  const url = new URL(String(q.url ?? "/"), "http://127.0.0.1");
  hits.push(url.pathname + url.search);
  r.writeHead(200, { "Content-Type": "text/html" });
  if (/CapDetail/i.test(url.pathname)) { r.end(detailPage); return; }
  const shape = (url.searchParams.get("shape") || "grouped") as Shape;
  const order = url.searchParams.get("order") === "rotated" ? "rotated" : "normal";
  r.end(capTypePage(shape, order, url.searchParams.get("err") === "1"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const capTypeUrl = (shape: Shape, order: "normal" | "rotated" = "normal"): string =>
  `http://127.0.0.1:${port}/MERIDIANTEST/Cap/CapType.aspx?shape=${shape}${order === "rotated" ? "&order=rotated" : ""}`;

const browser = await chromium.launch();

interface Run {
  steps: RecipeStep[];
  events: Array<Record<string, unknown>>;
  requests: LearnPlanRequest[];
  result: Record<string, unknown>;
  hits: string[];
  finalUrl: string;
}

const PROJECT = { projectAddress: "1 Test St, Meridianville, ID, 83600", city: "Meridianville", state: "ID", zip: "83600", homeownerName: "T", permitType: "electrical" } as never;

/** One learn on the page, with a planner that does what the live one did: on the record-type page it
 *  presses Continue Application; on the detail page it declares review. */
async function learnOn(shape: Shape, target: LearnTargetRecordType | null): Promise<Run> {
  const url = capTypeUrl(shape);
  const from = hits.length;
  const ctx = await browser.newContext();
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page: Page = await ctx.newPage();
  await page.goto(url);
  const requests: LearnPlanRequest[] = [];
  const planner: LearnPlanner = async (req) => {
    requests.push(req);
    if (/CapDetail/i.test(req.url)) return { fills: [], atReview: true };
    const cont = req.fields.findIndex((f) => /Continue Application/i.test(String(f.label ?? "")));
    return { fills: [], atReview: false, ...(cont >= 0 ? { advanceSelectorIndex: cont } : {}) };
  };
  const adapter = new AutoLearnAdapter("CapType Group Test", planner, { maxPages: 4, targetRecordType: target });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).page = page;
  const events: Array<Record<string, unknown>> = [];
  const holder = adapter as unknown as { debug?: { event: (e: Record<string, unknown>) => void } };
  if (holder.debug && typeof holder.debug.event === "function") {
    const orig = holder.debug.event.bind(holder.debug);
    holder.debug.event = (e) => { events.push(e); orig(e); };
  } else {
    holder.debug = { event: (e) => { events.push(e); } };
  }
  const result = await adapter.learn({ portalUrl: url } as never, PROJECT) as unknown as Record<string, unknown>;
  const finalUrl = page.url();
  await ctx.close();
  return { steps: (result.steps as RecipeStep[]) ?? [], events, requests, result, hits: hits.slice(from + 1), finalUrl };
}

const note = (s: RecipeStep): string => String(s.note ?? "");
const picked = (r: Run): string[] => r.hits.filter((h) => /CapDetail/i.test(h)).map((h) => decodeURIComponent(h.replace(/^.*picked=/, "")));
const refusals = (r: Run): number => r.hits.filter((h) => /err=1/.test(h)).length;
const groupEvents = (r: Run): Array<Record<string, unknown>> => r.events.filter((e) => e.type === "record_type_group_opened");

// ── grouped: Meridian's shape ─────────────────────────────────────────────────────────────────────
let groupedSteps: RecipeStep[] = [];
{
  const r = await learnOn("grouped", { value: TARGET, verified: true });
  groupedSteps = r.steps;
  console.log(`   grouped: hits=${JSON.stringify(r.hits)} notes=${JSON.stringify(r.steps.map(note))} events=${JSON.stringify(groupEvents(r))}`);
  const ge = groupEvents(r);
  check("grouped: ONE record_type_group_opened {group, forType, via:\"header\"}",
    ge.length === 1 && ge[0].group === GROUP && ge[0].forType === TARGET && ge[0].via === "header", JSON.stringify(ge));
  const gi = r.steps.findIndex((s) => s.action === "click" && note(s) === `record type group: ${GROUP}`);
  const ti = r.steps.findIndex((s) => s.action === "check" && note(s) === `record type (verified): ${TARGET}`);
  const ci = r.steps.findIndex((s) => note(s) === "record type: continue");
  check("grouped: the group step is recorded BY LABEL (click, note \"record type group: Residential Electrical\")", gi >= 0, JSON.stringify(r.steps.map(note)));
  check("grouped: its selector names the header by role + text (exact), with a css fallback",
    gi >= 0 && r.steps[gi].selector?.role === "link" && r.steps[gi].selector?.exact === true
      && /^(Expand )?Residential Electrical$/.test(String(r.steps[gi].selector?.name ?? ""))
      && (r.steps[gi].selector?.fallbacks ?? []).some((f) => !!f.css),
    JSON.stringify(gi >= 0 ? r.steps[gi].selector : null));
  check("grouped: the record type is ticked and recorded by label after the group (group < type < continue)",
    ti >= 0 && ci >= 0 && gi < ti && ti < ci && String(r.steps[ti].selector?.label ?? "") === TARGET, JSON.stringify({ gi, ti, ci, sel: r.steps[ti]?.selector }));
  check("grouped: Continue was pressed ONLY after the tick — the server saw the pick and never the refusal",
    picked(r).length === 1 && picked(r)[0] === TARGET && refusals(r) === 0, JSON.stringify(r.hits));
  check("grouped: the hidden filter-panel checkbox was not ticked (no \"record type category:\" step)",
    !r.steps.some((s) => /^record type category:/.test(note(s))), JSON.stringify(r.steps.map(note)));
  check("grouped: the planner was never asked about the record-type page",
    !r.requests.some((q) => /CapType/i.test(q.url)), JSON.stringify(r.requests.map((q) => q.url)));
  check("grouped: no record_type_bail, no closed-group stop", !r.events.some((e) => e.type === "record_type_bail" || e.type === "record_type_closed_group"), JSON.stringify(r.events.filter((e) => /^record_type_/.test(String(e.type)))));
}

// ── nogroup: the target's list is hidden and nothing opens it ────────────────────────────────────
{
  const r = await learnOn("nogroup", { value: TARGET, verified: true });
  console.log(`   nogroup: hits=${JSON.stringify(r.hits)} ok=${String(r.result.ok)} stop=${String(r.result.stopReason)} msg=${String(r.result.message).slice(0, 300)}`);
  check("nogroup: the walk stops NAMED (stopReason record_type_closed_group, ok:false)",
    r.result.ok === false && r.result.stopReason === "record_type_closed_group", JSON.stringify({ ok: r.result.ok, stop: r.result.stopReason }));
  check("nogroup: the message names the type and says the group would not open",
    String(r.result.message).includes(`the record type "${TARGET}" is in a closed group this page would not open:`), String(r.result.message).slice(0, 300));
  check("nogroup: Continue was NOT pressed — no detail page, no \"You have not selected a record type.\" round trip, no continue step",
    picked(r).length === 0 && refusals(r) === 0 && !r.steps.some((s) => note(s) === "record type: continue"), JSON.stringify(r.hits));
  check("nogroup: the planner was never asked (no recovery loop)", r.requests.length === 0, JSON.stringify(r.requests.map((q) => q.url)));
  check("nogroup: event record_type_closed_group {label, group}", r.events.some((e) => e.type === "record_type_closed_group" && e.label === TARGET), JSON.stringify(r.events.filter((e) => /^record_type_/.test(String(e.type)))));
  check("nogroup: nothing was ticked (no record-type step recorded)", !r.steps.some((s) => s.action === "check"), JSON.stringify(r.steps.map(note)));
}

// ── lazy: empty groups, the header that is a PREFIX of the verified type wins ────────────────────
{
  const r = await learnOn("lazy", { value: TARGET, verified: true });
  console.log(`   lazy: hits=${JSON.stringify(r.hits)} notes=${JSON.stringify(r.steps.map(note))} events=${JSON.stringify(groupEvents(r))}`);
  console.log(`   lazy: ok=${String(r.result.ok)} stop=${String(r.result.stopReason)} msg=${String(r.result.message).slice(0, 400)}`);
  console.log(`   lazy: event types=${JSON.stringify(r.events.map((e) => `${String(e.type)}${e.why ? `(${String(e.why).slice(0, 60)})` : ""}${e.expanded !== undefined ? `(expanded=${String(e.expanded)})` : ""}`))}`);
  const groupNotes = r.steps.filter((s) => /^record type group:/.test(note(s))).map(note);
  check("lazy: the expansion opened \"Residential Electrical\" (the prefix of the verified type), not the word-preference \"Residential\"",
    groupNotes[0] === `record type group: ${GROUP}` && !groupNotes.includes("record type group: Residential"), JSON.stringify(groupNotes));
  check("lazy: no legacy \"accela: expand record-type category\" note (one note, one replay route)",
    !r.steps.some((s) => /expand record-type category/.test(note(s))), JSON.stringify(r.steps.map(note)));
  check("lazy: the radio was then ticked by label and Continue pressed after it",
    r.steps.some((s) => s.action === "check" && note(s) === `record type (verified): ${TARGET}`) && picked(r)[0] === TARGET && refusals(r) === 0, JSON.stringify(r.hits));
}

// ── checkbox: CHINO's shape — the category-checkbox path still works when the box is visible ─────
{
  const r = await learnOn("checkbox", { value: TARGET, verified: true });
  console.log(`   checkbox: hits=${JSON.stringify(r.hits)} notes=${JSON.stringify(r.steps.map(note))} events=${JSON.stringify(groupEvents(r))}`);
  const ge = groupEvents(r);
  check("MUST EXCLUDE checkbox: record_type_group_opened {via:\"checkbox\"} for the visible category",
    ge.length === 1 && ge[0].group === GROUP && ge[0].via === "checkbox", JSON.stringify(ge));
  check("MUST EXCLUDE checkbox: the category check step is recorded, then the type, then Continue after the tick",
    r.steps.some((s) => s.action === "check" && note(s) === `record type category: ${GROUP}`)
      && r.steps.some((s) => s.action === "check" && note(s) === `record type (verified): ${TARGET}`)
      && picked(r)[0] === TARGET && refusals(r) === 0,
    JSON.stringify({ notes: r.steps.map(note), hits: r.hits }));
}

// ── #176 A1 classfirst: the grouped page, the type on file only SEEDED, Commercial listed first ───
// The seeded value is the WRONG one on purpose (a lookup that read the Commercial type): if it steered
// the pick, the Commercial type would be filed. Hard rule 3 says a seeded row is the planner's hint only.
{
  const r = await learnOn("grouped", { value: OTHER_CLASS, verified: false });
  const decisions = r.events.filter((e) => e.type === "record_type_class_decision");
  console.log(`   A1 classfirst: hits=${JSON.stringify(r.hits)} notes=${JSON.stringify(r.steps.map(note))} decisions=${JSON.stringify(decisions)}`);
  check("A1: the RESIDENTIAL solar type is the one picked and filed, not the Commercial one listed first",
    picked(r).length === 1 && picked(r)[0] === TARGET && refusals(r) === 0, JSON.stringify(r.hits));
  check("A1: event record_type_class_decision {jobClass:\"residential\", decision:\"matched\", label} names the class decision",
    decisions.length === 1 && decisions[0].jobClass === "residential" && decisions[0].decision === "matched" && decisions[0].label === TARGET
      && (decisions[0].candidates as string[]).includes(TARGET),
    JSON.stringify(decisions));
  check("A1: the Commercial group was never opened (one record_type_group_opened, for Residential Electrical)",
    groupEvents(r).length === 1 && groupEvents(r)[0].group === GROUP && groupEvents(r)[0].forType === TARGET, JSON.stringify(groupEvents(r)));
  check("A1 (hard rule 3): recorded as a plain \"record type:\" step — the seeded value did not steer, no record_type_verified_pick",
    r.steps.some((s) => s.action === "check" && note(s) === `record type: ${TARGET}`)
      && !r.steps.some((s) => /\(verified\)/.test(note(s)))
      && !r.events.some((e) => e.type === "record_type_verified_pick"),
    JSON.stringify(r.steps.map(note)));
  check("A1: no refusal, no stop (ok, planner reached the detail page only)",
    !r.events.some((e) => e.type === "record_type_refused_for_class" || e.type === "record_type_unsettled_stop") && r.result.stopReason !== "record_type_unsettled",
    JSON.stringify({ stop: r.result.stopReason, events: r.events.filter((e) => /^record_type_/.test(String(e.type))) }));
}

// ── #176 A2 otherclass: only the other class's solar type is offered ─────────────────────────────
{
  const r = await learnOn("otherclass", { value: TARGET, verified: false });
  const decisions = r.events.filter((e) => e.type === "record_type_class_decision");
  console.log(`   A2 otherclass: hits=${JSON.stringify(r.hits)} ok=${String(r.result.ok)} stop=${String(r.result.stopReason)} msg=${String(r.result.message).slice(0, 300)} decisions=${JSON.stringify(decisions)}`);
  check("A2: the walk stops NAMED (stopReason record_type_unsettled, ok:false)",
    r.result.ok === false && r.result.stopReason === "record_type_unsettled", JSON.stringify({ ok: r.result.ok, stop: r.result.stopReason }));
  check("A2: the message says only the other class's type is offered for this residential job, and names it",
    String(r.result.message).includes(`only the other class's record type is offered for this residential job: ${OTHER_CLASS}`), String(r.result.message).slice(0, 300));
  check("A2: nothing ticked, Continue NOT pressed (no detail page, no portal refusal, no check step)",
    picked(r).length === 0 && refusals(r) === 0 && !r.steps.some((s) => s.action === "check" || note(s) === "record type: continue"), JSON.stringify({ hits: r.hits, notes: r.steps.map(note) }));
  check("A2: the planner was never asked", r.requests.length === 0, JSON.stringify(r.requests.map((q) => q.url)));
  check("A2: event record_type_class_decision {decision:\"other_class\"} names the Commercial type as what was passed over",
    decisions.some((e) => e.decision === "other_class" && (e.candidates as string[]).includes(OTHER_CLASS)), JSON.stringify(decisions));
  check("A2: the Residential BUILDING group was not opened for an electrical job (no record_type_group_opened)",
    groupEvents(r).length === 0, JSON.stringify(groupEvents(r)));
}

// ── #176 A3 lazy, NO type on file: the expansion opens the class+discipline group ───────────────
{
  const r = await learnOn("lazy", null);
  const groupNotes = r.steps.filter((s) => /^record type group:/.test(note(s))).map(note);
  console.log(`   A3 lazy/none: hits=${JSON.stringify(r.hits)} notes=${JSON.stringify(r.steps.map(note))} events=${JSON.stringify(groupEvents(r))}`);
  check("A3: the FIRST group opened is \"Residential Electrical\" (this job's class AND discipline), never the bare \"Residential\"",
    groupNotes[0] === `record type group: ${GROUP}` && !groupNotes.includes("record type group: Residential"), JSON.stringify(groupNotes));
  check("A3: the solar type in it was then ticked (plain \"record type:\" step) and filed",
    r.steps.some((s) => s.action === "check" && note(s) === `record type: ${TARGET}`) && picked(r)[0] === TARGET && refusals(r) === 0, JSON.stringify(r.hits));
}

// ── #176 B1 skiplink: a 0px <main> with a "Skip to main content" link around the grouped page ────
{
  {
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    await pg.goto(capTypeUrl("skiplink"));
    const h = await pg.evaluate(() => document.getElementById("mainContent")!.getBoundingClientRect().height);
    await ctx.close();
    check("B1 fixture: <main id=\"mainContent\"> measures 0px around the visible page, as Meridian's did", h < 2, `height=${h}`);
  }
  const r = await learnOn("skiplink", { value: TARGET, verified: true });
  const headerEvents = r.events.filter((e) => /^record_type_group_header_/.test(String(e.type)));
  console.log(`   B1 skiplink: hits=${JSON.stringify(r.hits)} notes=${JSON.stringify(r.steps.map(note))} header=${JSON.stringify(headerEvents)}`);
  check("B1: the opener is the group's header toggle (record_type_group_header_clicked), never the skip link",
    headerEvents.length === 1 && headerEvents[0].type === "record_type_group_header_clicked" && headerEvents[0].group === GROUP
      && !/skip/i.test(String(headerEvents[0].opener)) && /preceding/.test(String(headerEvents[0].opener)),
    JSON.stringify(headerEvents));
  check("B1: no record_type_group_header_no_effect, no expansion retry",
    !r.events.some((e) => e.type === "record_type_group_header_no_effect" || e.type === "record_type_group_expanded_for_retry"),
    JSON.stringify(r.events.filter((e) => /^record_type_/.test(String(e.type)))));
  check("B1: the verified type was ticked after the group and filed; Continue only after the tick",
    picked(r).length === 1 && picked(r)[0] === TARGET && refusals(r) === 0, JSON.stringify(r.hits));
}

// ── replay: the grouped recipe on a page whose groups are REORDERED ──────────────────────────────
{
  const from = hits.length;
  const steps = [...groupedSteps.filter((s) => !s.isFinalSubmit && note(s) !== "record type: continue"), { action: "stopForReview" } as RecipeStep];
  const recipe = {
    id: "aca-group", scopeType: "ahj", profileKey: "id|meridianville|", state: "ID", ahj: "Meridianville", utility: "",
    portalPlatform: "accela", portalUrl: capTypeUrl("grouped", "rotated"), status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
    steps,
  } as unknown as PortalRecipe;
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(8000);
  await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const page = await ctx.newPage();
  await page.goto(capTypeUrl("grouped", "rotated"));
  const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = page;
  let res: { ok: boolean; message: string; data?: Record<string, unknown> } | null = null;
  try { res = await adapter.fillApplication({} as ProjectRecord); } catch (e) { res = { ok: false, message: `threw ${String(e).slice(0, 300)}` }; }
  const state = await page.evaluate(() => {
    const checked = document.querySelector("input[type=radio]:checked") as HTMLInputElement | null;
    const open = Array.from(document.querySelectorAll(".ServiceItemList")).filter((l) => (l as HTMLElement).style.display !== "none")
      .map((l) => (l.previousElementSibling?.textContent || "").replace(/\s+/g, " ").trim());
    return { checked: checked?.title || "", open };
  }).catch(() => ({ checked: "", open: [] as string[] }));
  const warnings = ((adapter as unknown as { driftWarnings: string[] }).driftWarnings ?? []).filter((w) => /record type group/.test(w));
  await ctx.close().catch(() => null);
  console.log(`   replay: ok=${String(res?.ok)} msg=${String(res?.message).slice(0, 200)} state=${JSON.stringify(state)} warnings=${JSON.stringify(warnings)} hits=${JSON.stringify(hits.slice(from + 1))}`);
  check("replay: the group was opened BY LABEL on the reordered page (only \"Residential Electrical\" is open)",
    state.open.length === 1 && state.open[0] === GROUP, JSON.stringify(state));
  check("replay: the verified record type is the one ticked", state.checked === TARGET, JSON.stringify(state));
  check("replay: the group step says so (drift warning: opened by label, positional fallback refused)",
    warnings.some((w) => /opened by label/.test(w)), JSON.stringify(warnings));
  check("replay: nothing was filed from the fixture (no detail page reached — the recipe stops at review)",
    !hits.slice(from + 1).some((h) => /CapDetail/i.test(h)), JSON.stringify(hits.slice(from + 1)));
}

await browser.close();
server.close();
console.log(failures === 0 ? "accelaRecordTypeGroup.dom.smoke: PASS" : `accelaRecordTypeGroup.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
