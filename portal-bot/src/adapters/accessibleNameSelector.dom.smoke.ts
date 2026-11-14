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
// by the #id; one that finds nothing goes behind it; with no id the miss is reported, never guessed.
//   npx tsx portal-bot/src/adapters/accessibleNameSelector.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, RecipeSelector, RecipeStep } from "../../../shared/src/types";
import * as AL from "./autoLearnAdapter";
import { AutoLearnAdapter, EXTRACT_SEL, extractFieldsInPage, toExtractedField, type ExtractedField, type RawField } from "./autoLearnAdapter";
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
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
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
const replayResolves = async (sel: RecipeSelector): Promise<string> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loc: any = await (replay as unknown as { resolveLocator: (s: RecipeSelector) => Promise<unknown> }).resolveLocator(sel).catch(() => null);
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
type Pin = (p: Page, f: ExtractedField) => Promise<{ selector: RecipeSelector; repinned?: string; missed?: boolean }>;
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
    const rec = (await pin(page, f)).selector;
    check("a role+name that finds NOTHING: the #id leads and the name is kept behind it",
      rec.css === "#start-blocks" && (rec.fallbacks ?? [])[0]?.name === f.selector.name && (await replayResolves(rec)) === `${raw.fx}#start-blocks`,
      `harvested ${show(f)} -> recorded ${JSON.stringify(rec)}`);
  }
}
{
  const raw = await rawFor((r) => r.fieldType === "button" && !r.id && r.href === "#/permit/apply/98/0/0");
  const f = raw ? toExtractedField(raw) : null;
  if (!raw || !f) check("the scan reads the id-less ::after link", false, "not harvested");
  else {
    const r = await pin(page, f);
    check("with NO id to lead with, the selector stands and the miss is reported (never a guess)",
      r.missed === true && JSON.stringify(r.selector) === JSON.stringify(f.selector), JSON.stringify(r));
  }
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
}

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
if (failures) { console.error(`\n${failures} accessible-name selector check(s) FAILED.`); process.exit(1); }
console.log("\nAll accessible-name selector checks passed (real Chromium).");
process.exit(0);
