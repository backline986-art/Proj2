// A ROLE SELECTOR MATCHES THE ACCESSIBLE NAME, NOT THE TEXT ON THE CONTROL'S FACE (#228).
//
// Live, City of Tigard (Tyler EnerGov), 2026-11-14, scratch replay, nothing filed. Each record
// type in the application assistant's results is
//   <a id="apply-btn-ResidentialRenewableEnergy-Prescriptive" role="link"
//      aria-label="Apply Residential Renewable Energy - Prescriptive">Apply</a>
// rendered twice (the second copy inside an ng-hide, aria-hidden container). The learner named the
// step by the FACE text: { role: "link", name: "Apply", exact: true, fallbacks: [#apply-btn-…] }.
// getByRole matches the accessible name — the aria-label — so that selector never matched the record
// type at all. It matched exactly ONE control: the top menu's "Apply" tab (#link-Menu-Apply, whose
// sidebar twin is hidden), step 1's own target. The replay accepted that visible, enabled single match
// at level 0, never asked the id fallback, reported the click ok, and waited out the stall watchdog on
// the next step of an application that never opened.
//
// Drives the REAL scan (extractFieldsInPage), the REAL selector builder (toExtractedField) and the
// REAL replay resolver (RecipeAdapter.resolveLocator) on a synthetic page of that shape, and checks
// that each recorded selector resolves to the element that was read. MUST-KEEP: a plain button, a
// Material-icon button (ligature + aria-label), #556's aria-hidden icon wrapper, a submit input, a
// labelledby name, and the off-limits test still seeing a pay word on a control's face.
//
// THE RECORD-TIME CHECK (clickSelectorForElement): names the scan cannot read — CSS ::after content,
// spacing between block children — are caught by asking getByRole itself, before the click is
// recorded, whether the role+name finds the stamped element. A name that finds a namesake is replaced
// by the #id. A name that finds nothing stands as harvested and is reported: the replay's name rescue
// reads the top-level name, which is what still reaches Cityworks' user menu when its counter id moves.
// With no id the miss is reported, never guessed.
//
// THE REPLAY'S FACE TIE-BREAK: two id-less links sharing one aria-label replay onto the one whose face
// the step recorded (shownText), and the face never locates a control on its own (the name rescue
// with Tigard's face "Apply" finds the menu tab). And the live timing: the record type renders ~116 ms
// after the assistant's Search, so one check resolves the recorded step at once and clicks it.
//   npx tsx portal-bot/src/adapters/accessibleNameSelector.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, RecipeSelector, RecipeStep } from "../../../shared/src/types";
import * as AL from "./autoLearnAdapter";
import { AutoLearnAdapter, EXTRACT_SEL, extractFieldsInPage, toExtractedField, type ExtractedField, type LearnPlanner, type RawField } from "./autoLearnAdapter";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const RECORD_TYPE = (id: string, name: string, href: string, hidden: boolean): string =>
  `<div ng-show="${hidden ? "!" : ""}vm.isCollapsed" class="apply-btn-align${hidden ? " ng-hide" : ""}" aria-hidden="${hidden}">`
  + `<a id="${id}" class="btn btn-primary" tabindex="0" role="link" aria-label="Apply ${name}" href="${href}">\n      Apply\n    </a></div>`;

const PAGE = `<!doctype html><html><head><style>
  .ng-hide { display: none !important; }
  .material-icons { font-family: sans-serif; }
  .sfx::after { content: " Solar Permit"; }
</style></head><body>
  <!-- Tigard's top menu: the "Apply" tab, plus its twin in a hidden sidebar (same id). -->
  <div id="sidebarMenu" style="display:none"><a id="link-Menu-Apply" class="mainMenuNav-a" href="/apps/selfservice/home#/applicationAssistant">Apply</a></div>
  <ul class="mainMenu"><li><a id="link-Menu-Apply" class="mainMenuNav-a" href="/apps/selfservice/home#/applicationAssistant">Apply</a></li></ul>

  <!-- The assistant's results: each record type's Apply button, twice, one copy ng-hide. -->
  <div class="results">
    <div class="result-row"><span>Residential Renewable Energy - Prescriptive</span>
      ${RECORD_TYPE("apply-btn-ResidentialRenewableEnergy-Prescriptive", "Residential Renewable Energy - Prescriptive", "#/permit/apply/94/0/0", false)}
      ${RECORD_TYPE("apply-btn-ResidentialRenewableEnergy-Prescriptive", "Residential Renewable Energy - Prescriptive", "#/permit/apply/94/0/0", true)}
    </div>
    <div class="result-row"><span>Residential Electrical</span>
      ${RECORD_TYPE("apply-btn-ResidentialElectrical", "Residential Electrical", "#/permit/apply/95/0/0", false)}
      ${RECORD_TYPE("apply-btn-ResidentialElectrical", "Residential Electrical", "#/permit/apply/95/0/0", true)}
    </div>
  </div>

  <!-- MUST-KEEP shapes. -->
  <button id="btn-next">Next</button>
  <button id="btn-new" aria-label="New Application"><i class="material-icons">add</i></button>
  <button id="btn-cat"><div aria-hidden="true"><i class="material-icons">folder</i></div> Building Permits</button>
  <input type="submit" id="btn-search" name="btnSearch" value="Search">
  <span id="lbl-begin">Begin Solar Application</span>
  <button id="btn-begin" aria-labelledby="lbl-begin">Go</button>
  <span id="lbl-noid">Start Electrical Application</span>
  <button name="btnGoElectrical" aria-labelledby="lbl-noid">Go</button>
  <button id="btn-pay" aria-label="Continue to the next step">Pay Fees</button>

  <!-- RECORD-TIME CHECK: names the scan cannot read, so only asking getByRole itself catches them.
       CSS content is in the accessible name ("Apply Solar Permit"); the scan reads "Apply" — the menu
       tab's name. Block children are spaced in it ("Start Roof Mount"); the scan reads "StartRoof Mount". -->
  <a id="apply-sfx" class="sfx" href="#/permit/apply/96/0/0">Apply</a>
  <a id="start-blocks" href="#/permit/apply/97/0/0"><div>Start</div><div>Roof Mount</div></a>
  <a class="sfx nid" href="#/permit/apply/98/0/0">Apply</a>

  <!-- Cityworks' user-menu trigger, as captured (fixtures/cityworks-case-create.html): a counter id and
       role="menubutton", which is no ARIA role, so getByRole finds nothing by its name "User". -->
  <button data-cw-id="btnUserMenu" id="CW-UI-MENU-1000000000000001-trigger" class="user-menu icon-button" aria-label="User"
    aria-controls="CW-UI-MENU-1000000000000001" aria-expanded="false" aria-haspopup="true" role="menubutton"
    style="width:32px;height:32px"><i aria-hidden="true" class="cw-icon cw-icon-user md-24 md-light"></i></button>

  <!-- Two id-less links sharing one generic aria-label, with different faces. -->
  <div class="pager"><a class="btn" href="#pager-cancel" aria-label="link">Cancel</a> <a class="btn btn-primary" href="#pager-next" aria-label="link">Next</a></div>
</body></html>`;

// The live timing: the assistant's results (both copies of each record type) render ~116 ms after its
// Search is clicked. Every link click is recorded and kept from navigating.
const RESULT_ROWS = `<div class="result-row"><span>Residential Renewable Energy - Prescriptive</span>`
  + RECORD_TYPE("apply-btn-ResidentialRenewableEnergy-Prescriptive", "Residential Renewable Energy - Prescriptive", "#/permit/apply/94/0/0", false)
  + RECORD_TYPE("apply-btn-ResidentialRenewableEnergy-Prescriptive", "Residential Renewable Energy - Prescriptive", "#/permit/apply/94/0/0", true)
  + `</div>`;
const DELAYED = `<!doctype html><html><head><style>.ng-hide { display: none !important; }</style></head><body>
  <div id="sidebarMenu" style="display:none"><a id="link-Menu-Apply" class="mainMenuNav-a" href="/apps/selfservice/home#/applicationAssistant">Apply</a></div>
  <ul class="mainMenu"><li><a id="link-Menu-Apply" class="mainMenuNav-a" href="/apps/selfservice/home#/applicationAssistant">Apply</a></li></ul>
  <input id="assistant-q" type="text" value="solar"> <button id="assistant-search" type="button">Search</button>
  <div class="results" id="results"></div>
  <script>
    window.__clicked = [];
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a") : null;
      if (a) { e.preventDefault(); window.__clicked.push(a.id); }
    }, true);
    document.getElementById("assistant-search").addEventListener("click", function () {
      setTimeout(function () { document.getElementById("results").innerHTML = ${JSON.stringify(RESULT_ROWS)}; }, 116);
    });
  </script>
</body></html>`;

// A LEARN WALK through the advance door: the real advance's accessible name carries CSS content
// ("Continue to Step 2") the scan does not read, and a disabled "Continue" (still in every role query)
// is its namesake. The recorded advance step must lead with #btn-adv.
const WALK1 = `<!doctype html><html><head><style>.sfx2::after { content: " to Step 2"; }</style></head>
<body style="font:14px sans-serif;padding:16px">
  <h2>Applicant</h2>
  <label for="owner">Owner Name</label><input id="owner" type="text">
  <button type="button" id="btn-adv" class="sfx2" onclick="location.href='/walk2'">Continue</button>
  <button type="button" disabled>Continue</button>
</body></html>`;
const WALK2 = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
  <h2>Review</h2><p>Review your application before you submit it.</p>
</body></html>`;

const server = http.createServer((q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  const u = String(q.url ?? "");
  r.end(/delayed/.test(u) ? DELAYED : /walk2/.test(u) ? WALK2 : /walk/.test(u) ? WALK1 : PAGE);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
await page.goto(url);

// The learner's own harvest: the scan stamps each element data-al-fx, so "the element that was read"
// is known exactly, even where two copies share an id.
const raws = (await page.$$eval(EXTRACT_SEL, extractFieldsInPage)) as RawField[];
const visibleFx = async (fx: string | undefined): Promise<boolean> =>
  !!fx && await page.locator(`[data-al-fx="${fx}"]`).isVisible().catch(() => false);
/** The raw for the VISIBLE element matching `pick` — the copy a person (and the learner's click) saw. */
const rawFor = async (pick: (r: RawField) => boolean): Promise<RawField | undefined> => {
  for (const r of raws.filter(pick)) if (await visibleFx(r.fx)) return r;
  return undefined;
};

// The replay's own resolution of a recorded selector: RecipeAdapter.resolveLocator, level by level.
const recipe = {
  id: "an228", scopeType: "ahj", profileKey: "or|city of tigard|x", state: "OR", ahj: "City of Tigard", utility: "",
  portalPlatform: "energov", portalUrl: url, status: "complete", version: 1, steps: [] as RecipeStep[],
  createdBy: "test", createdAt: "", updatedAt: "", notes: "", discipline: "",
} as unknown as PortalRecipe;
const replay = new RecipeAdapter(recipe, {}, {}, { autoSubmit: false });
(replay as unknown as { page: Page }).page = page;
/** RecipeAdapter.resolveLocator as a replayed click step reaches it: executeStep names the step it is
 *  resolving, which is what lets a selector matching several controls choose by what it recorded. */
const resolveAsStep = async (sel: RecipeSelector): Promise<unknown> => {
  const r = replay as unknown as { resolvingStep: RecipeStep | null; resolveLocator: (s: RecipeSelector) => Promise<unknown> };
  r.resolvingStep = { action: "click", phase: "fill", selector: sel, note: "" };
  try { return await r.resolveLocator(sel); } finally { r.resolvingStep = null; }
};
const replayResolves = async (sel: RecipeSelector): Promise<string> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loc: any = await resolveAsStep(sel).catch(() => null);
  if (!loc || (await loc.count().catch(() => 0)) === 0) return "(nothing)";
  return await loc.first().evaluate((e: Element) => `${e.getAttribute("data-al-fx") || "?"}#${e.id || ""}`).catch(() => "(unreadable)") as string;
};
/** What the PRIMARY (level 0) role+name selector alone matches: the stamps of every element. */
const primaryMatches = async (sel: RecipeSelector): Promise<string[]> => {
  if (!sel.role || !sel.name) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return page.getByRole(sel.role as any, { name: sel.name, exact: sel.exact ?? false })
    .evaluateAll((els) => els.map((e) => `${e.getAttribute("data-al-fx") || "?"}#${e.id || ""}`));
};
const show = (f: ExtractedField): string => JSON.stringify(f.selector);

// ---- THE TIGARD CASE -------------------------------------------------------------------------
const rtRaw = await rawFor((r) => r.id === "apply-btn-ResidentialRenewableEnergy-Prescriptive");
const menuRaw = await rawFor((r) => r.id === "link-Menu-Apply");
check("the scan reads the visible record-type link and the visible menu tab", !!rtRaw && !!menuRaw,
  `record type ${JSON.stringify(rtRaw?.fx)}, menu ${JSON.stringify(menuRaw?.fx)}`);
if (rtRaw && menuRaw) {
  const rt = toExtractedField(rtRaw);
  const menu = toExtractedField(menuRaw);
  console.log(`   record type: ${show(rt)}\n   menu tab:    ${show(menu)}`);
  const want = `${rtRaw.fx}#apply-btn-ResidentialRenewableEnergy-Prescriptive`;
  const prim = await primaryMatches(rt.selector);
  check("THE REGRESSION: the record type's role+name selector matches exactly the record-type link, never the menu tab",
    prim.length === 1 && prim[0] === want,
    `getByRole(${JSON.stringify(rt.selector.role)}, { name: ${JSON.stringify(rt.selector.name)} }) matched ${JSON.stringify(prim)} — the menu tab is ${menuRaw.fx}#link-Menu-Apply`);
  const got = await replayResolves(rt.selector);
  check("...and the REPLAY's resolution of the recorded selector lands on the record type, not on step 1's menu tab",
    got === want, `resolveLocator landed on ${got}, wanted ${want}`);
  check("...the menu tab's own selector still resolves to the menu tab (step 1 is untouched)",
    (await replayResolves(menu.selector)) === `${menuRaw.fx}#link-Menu-Apply`, `got ${await replayResolves(menu.selector)}`);
  check("...the LABEL is unchanged (a recorded label is a matching key)",
    rt.label === "Apply Residential Renewable Energy - Prescriptive", `label ${JSON.stringify(rt.label)}`);
  check("...and the face words ride along for the safety haystacks, never as the name",
    rt.selector.shownText === "Apply" && rt.selector.name !== "Apply", show(rt));
}
const rt2Raw = await rawFor((r) => r.id === "apply-btn-ResidentialElectrical");
if (rt2Raw) {
  const rt2 = toExtractedField(rt2Raw);
  const got = await replayResolves(rt2.selector);
  check("a second record type's selector resolves to ITS link, not the first record type's or the menu's",
    got === `${rt2Raw.fx}#apply-btn-ResidentialElectrical`, `${show(rt2)} -> ${got}`);
} else check("the scan reads the second record type", false, "");

// ---- MUST-KEEP -------------------------------------------------------------------------------
const keep = async (what: string, pick: (r: RawField) => boolean, expectName: string | null): Promise<void> => {
  const raw = await rawFor(pick);
  if (!raw) { check(`${what}: read by the scan`, false, "not harvested"); return; }
  const f = toExtractedField(raw);
  const want = `${raw.fx}#${raw.id ?? ""}`;
  const got = await replayResolves(f.selector);
  const nameOk = expectName === null ? !f.selector.name : f.selector.name === expectName;
  check(`${what}: named ${expectName === null ? "by no role name" : JSON.stringify(expectName)} and the replay resolves it`,
    nameOk && got === want, `${show(f)} -> ${got}, wanted ${want}`);
};
await keep("a plain <button>Next</button>", (r) => r.id === "btn-next", "Next");
await keep("a Material-icon button (ligature + aria-label)", (r) => r.id === "btn-new", "New Application");
await keep("#556: an aria-hidden icon wrapper is not in the name", (r) => r.id === "btn-cat", "Building Permits");
await keep("an <input type=submit value=Search> (its #id, as before)", (r) => r.id === "btn-search", null);
await keep("a button named by aria-labelledby", (r) => r.id === "btn-begin", "Begin Solar Application");
{
  const raw = await rawFor((r) => r.fieldType === "button" && !r.id && r.name === "btnGoElectrical");
  const f = raw ? toExtractedField(raw) : null;
  const got = f ? await replayResolves(f.selector) : "(not read)";
  check("a labelledby button with NO id (no fallback to rescue it) resolves by its name",
    !!raw && f?.selector.name === "Start Electrical Application" && got === `${raw.fx}#`, `${f ? show(f) : "not harvested"} -> ${got}`);
}
{
  const raw = await rawFor((r) => r.id === "btn-pay");
  const f = raw ? toExtractedField(raw) : null;
  // The learner's off-limits test (the one its click doors ask), on the field as harvested.
  const offLimits = f ? (AutoLearnAdapter.prototype as unknown as { isOffLimitsButton: (x: ExtractedField) => boolean }).isOffLimitsButton.call({}, f) : false;
  check("a control whose FACE reads \"Pay Fees\" is still off limits under an aria-label that does not",
    offLimits, f ? show(f) : "not harvested");
}

// ---- RECORD-TIME CHECK (clickSelectorForElement) ---------------------------------------------
// What the learner records for a click, through the adapter's own wrapper (the one its navigate,
// advance, fallback-advance, verified-record-type and manual-entry doors call). A learner without the
// check records the harvested selector as it is — which is what a missing export stands for here.
type Pin = (p: Page, f: ExtractedField) => Promise<{ selector: RecipeSelector; repinned?: string; missed?: string | boolean }>;
const pin: Pin = (AL as unknown as { clickSelectorForElement?: Pin }).clickSelectorForElement
  ?? (async (_p, f) => ({ selector: f.selector }));
const events: Array<Record<string, unknown>> = [];
const recordedVia = async (f: ExtractedField): Promise<RecipeSelector> => {
  const wrap = (AutoLearnAdapter.prototype as unknown as { recordedClickSelector?: (x: ExtractedField) => Promise<RecipeSelector> }).recordedClickSelector;
  return wrap ? wrap.call({ page, debug: { event: (e: Record<string, unknown>) => events.push(e) } }, f) : f.selector;
};
{
  const raw = await rawFor((r) => r.id === "apply-sfx");
  const f = raw ? toExtractedField(raw) : null;
  if (!raw || !f) check("the scan reads the ::after link", false, "not harvested");
  else {
    const harvestedHits = await primaryMatches(f.selector);
    console.log(`   ::after link harvested as ${show(f)} — its name finds ${JSON.stringify(harvestedHits)}`);
    const rec = await recordedVia(f);
    const got = await replayResolves(rec);
    check("A NAME THE SCAN CANNOT READ: the recorded click leads with the #id when its role+name finds a NAMESAKE (the menu tab)",
      rec.css === "#apply-sfx" && !rec.name && got === `${raw.fx}#apply-sfx`,
      `recorded ${JSON.stringify(rec)} -> replay landed on ${got}`);
    check("...and the namesake-finding role+name is dropped, not kept as a fallback the replay would reach",
      !(rec.fallbacks ?? []).some((fb) => fb.role && fb.name === f.selector.name), JSON.stringify(rec));
    check("...and the re-pin is named in the debug bundle",
      events.some((e) => e.type === "click_selector_repinned" && /another control/.test(String(e.why))), JSON.stringify(events));
  }
}
{
  const raw = await rawFor((r) => r.id === "start-blocks");
  const f = raw ? toExtractedField(raw) : null;
  if (!raw || !f) check("the scan reads the block-children link", false, "not harvested");
  else {
    const r = await pin(page, f);
    events.length = 0;
    await recordedVia(f);
    check("a role+name that finds NOTHING stands as harvested, never moved behind the #id (the replay's name rescue reads the top-level name)",
      r.missed === "nothing" && !r.repinned && JSON.stringify(r.selector) === JSON.stringify(f.selector)
        && (await replayResolves(r.selector)) === `${raw.fx}#start-blocks`,
      `harvested ${show(f)} -> ${JSON.stringify(r)}`);
    check("...and the miss is named in the debug bundle",
      events.some((e) => e.type === "click_selector_misses_element" && /finds nothing/.test(String(e.why))), JSON.stringify(events));
  }
}
{
  // Review of #228, on real Cityworks markup: re-pinned behind its #id, this control was lost the moment
  // the portal's counter moved (the name rescue had no top-level name to search by; ~70 s, then fail).
  const CW = "CW-UI-MENU-1000000000000001-trigger";
  const MOVED = "CW-UI-MENU-1000000000000003-trigger";
  const raw = await rawFor((r) => r.id === CW);
  const f = raw ? toExtractedField(raw) : null;
  if (!raw || !f) check("the scan reads Cityworks' user-menu trigger", false, "not harvested");
  else {
    const rec = await recordedVia(f);
    const before = await replayResolves(rec);
    await page.evaluate(([from, to]) => { const el = document.getElementById(from); if (el) el.id = to; }, [CW, MOVED]);
    const after = await replayResolves(rec);
    await page.evaluate(([from, to]) => { const el = document.getElementById(from); if (el) el.id = to; }, [MOVED, CW]);
    check("Cityworks' role=\"menubutton\" trigger is recorded as harvested, so when its counter id moves the replay still clicks it by its name",
      !!rec.role && rec.name === "User" && after === `${raw.fx}#${MOVED}`,
      `harvested ${show(f)} -> recorded ${JSON.stringify(rec)}; replay before the move -> ${before}, after -> ${after}`);
  }
}
{
  const raw = await rawFor((r) => r.fieldType === "button" && !r.id && r.href === "#/permit/apply/98/0/0");
  const f = raw ? toExtractedField(raw) : null;
  if (!raw || !f) check("the scan reads the id-less ::after link", false, "not harvested");
  else {
    const r = await pin(page, f);
    check("with NO id to lead with, the selector stands and the miss is reported (never a guess)",
      r.missed === "namesake" && JSON.stringify(r.selector) === JSON.stringify(f.selector), JSON.stringify(r));
  }
}

// ---- THE REPLAY'S FACE TIE-BREAK ----------------------------------------------------------------
{
  const raw = await rawFor((r) => r.fieldType === "button" && !r.id && r.href === "#pager-next");
  const f = raw ? toExtractedField(raw) : null;
  if (!raw || !f) check("the scan reads the pager's Next link", false, "not harvested");
  else {
    const rec = await recordedVia(f);
    const got = await replayResolves(rec);
    check("TWO ID-LESS LINKS SHARING ONE aria-label (faces \"Cancel\" and \"Next\"): the step recorded on Next replays onto Next, its face choosing between the name's own matches",
      got === `${raw.fx}#`, `recorded ${JSON.stringify(rec)} -> replay landed on ${got}`);
  }
}
{
  // Why the face never LOCATES a control: the replay's name rescue, asked for Tigard's face "Apply",
  // finds the top menu's tab, the exact #228 misclick. shownText chooses among a selector's matches only.
  const hit = await (replay as unknown as { findEnabledControlByName: (w: string) => Promise<unknown> }).findEnabledControlByName("Apply");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const landed = hit ? await (hit as any).evaluate((e: Element) => `${e.id}`).catch(() => "?") : "(nothing)";
  check("MUST-KEEP: the name rescue asked for the face \"Apply\" finds the menu tab, so the face is never a locating name",
    landed === "link-Menu-Apply", `rescue landed on ${landed}`);
}

// ---- THE LIVE TIMING: the record type renders ~116 ms after Search -------------------------------
if (rtRaw) {
  const rt = toExtractedField(rtRaw);
  const dpage = await context.newPage();
  await dpage.goto(`${url}delayed`);
  const holder = replay as unknown as { page: Page };
  holder.page = dpage;
  let err = "";
  try {
    await dpage.click("#assistant-search");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loc: any = await resolveAsStep(rt.selector);
    await loc.click({ timeout: 5000 });
  } catch (e) { err = e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : String(e); }
  const clicked = await dpage.evaluate(() => (window as unknown as { __clicked?: string[] }).__clicked ?? []);
  holder.page = page;
  await dpage.close();
  check("DELAYED RENDER: resolved the moment Search is clicked, the recorded record-type step clicks the record type, never the menu tab",
    JSON.stringify(clicked) === JSON.stringify(["apply-btn-ResidentialRenewableEnergy-Prescriptive"]),
    `recorded ${show(rt)} -> clicked ${JSON.stringify(clicked)}${err ? ` (${err})` : ""}`);
}
{
  // MUST-KEEP: a selector that already finds its element is recorded exactly as harvested.
  const sound: Array<[string, (r: RawField) => boolean]> = [
    ["the Tigard record type", (r) => r.id === "apply-btn-ResidentialRenewableEnergy-Prescriptive"],
    ["the menu tab", (r) => r.id === "link-Menu-Apply"],
    ["a plain Next", (r) => r.id === "btn-next"],
    ["#556's Building Permits", (r) => r.id === "btn-cat"],
  ];
  for (const [what, pick] of sound) {
    const raw = await rawFor(pick);
    const f = raw ? toExtractedField(raw) : null;
    const r = f ? await pin(page, f) : null;
    check(`${what}: a selector that finds its own element is recorded unchanged`,
      !!f && !!r && !r.repinned && !r.missed && JSON.stringify(r.selector) === JSON.stringify(f.selector), JSON.stringify(r));
  }
  // A HIDDEN control is in no role query, whatever its name: the hidden sidebar's "Apply" twin (a
  // menu-nested link the walk reaches by its href) keeps the name the replay's closed-menu reveal
  // searches by — never re-pinned to an #id that also finds the visible tab.
  let hiddenTwin: RawField | undefined;
  for (const r of raws.filter((x) => x.id === "link-Menu-Apply")) if (!(await visibleFx(r.fx))) hiddenTwin = r;
  const ht = hiddenTwin ? toExtractedField(hiddenTwin) : null;
  const hr = ht ? await pin(page, ht) : null;
  check("a HIDDEN control (the sidebar's menu twin) keeps its harvested selector, name and all",
    !!ht && !!hr && !hr.repinned && JSON.stringify(hr.selector) === JSON.stringify(ht.selector), JSON.stringify(hr));
}

// ---- THE WIRING: real learn walks record their advance through the check --------------------------
// Two doors: the planner names the advance (advanceSelectorIndex), or it names none and the walk's
// fallback advance finds it. Each door must ask the check before it records the step.
for (const door of ["planner-named advance", "fallback advance"] as const) {
  const wctx = await browser.newContext();
  await wctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
  const wpage = await wctx.newPage();
  await wpage.goto(`${url}walk`);
  let asked = 0;
  const planner: LearnPlanner = async (req) => {
    asked++;
    if (asked > 1) return { fills: [], atReview: true };
    const owner = req.fields.findIndex((f) => String(f.label ?? "") === "Owner Name");
    const adv = req.fields.findIndex((f) => (f.selector?.fallbacks ?? []).some((fb) => fb.css === "#btn-adv"));
    return {
      fills: owner >= 0 ? [{ selectorIndex: owner, value: "T" }] : [],
      atReview: false,
      ...(door === "planner-named advance" && adv >= 0 ? { advanceSelectorIndex: adv } : {}),
    };
  };
  const adapter = new AutoLearnAdapter("Accessible Name Walk", planner, { maxPages: 2 });
  (adapter as unknown as { page: Page }).page = wpage;
  let steps: RecipeStep[] = [];
  let err = "";
  try {
    const res = await adapter.learn(
      { portalUrl: `${url}walk` } as never,
      { projectAddress: "1 Test St, Tigard, OR, 97223", city: "Tigard", state: "OR", zip: "97223", homeownerName: "T" } as never,
    ) as unknown as { steps?: RecipeStep[] };
    steps = res.steps ?? [];
  } catch (e) { err = e instanceof Error ? e.message.slice(0, 160) : String(e); }
  const reached = wpage.url();
  await wctx.close();
  const adv = steps.filter((s) => s.action === "click" && /^advance\b/i.test(String(s.note ?? "")));
  check(`THE WIRING (${door}): a walk records the advance whose name finds a disabled namesake by its #id, with the namesake's name dropped`,
    adv.length === 1 && adv[0].selector?.css === "#btn-adv" && !adv[0].selector?.name
      && !(adv[0].selector?.fallbacks ?? []).some((fb) => fb.role && fb.name === "Continue")
      && /walk2/.test(reached),
    `advance steps ${JSON.stringify(adv)}; walk reached ${reached}${err ? `; learn threw: ${err}` : ""}`);
}

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} accessible-name selector check(s) FAILED.`); process.exit(1); }
console.log("\nAll accessible-name selector checks passed (real Chromium).");
process.exit(0);
