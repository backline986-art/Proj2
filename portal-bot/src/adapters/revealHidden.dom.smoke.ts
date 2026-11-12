// PRESENT BUT SHUT, AS A RULE INSTEAD OF A FOURTH PATCH.
//
// Momentum's run says it plainly. Three consecutive pages, same URL, same counts:
//
//   p2 /submit-record fields=36(fill=2) adv=24 fills=1  hidden_field_skipped "Licenses & Permits"
//   p3 /submit-record fields=36(fill=2) adv=24 fills=1  hidden_field_skipped "Licenses & Permits"
//   p4 /submit-record fields=36(fill=2) adv=24 fills=1  hidden_field_skipped "Licenses & Permits"
//   budget_exhausted page 5
//
// It filled one field, skipped the gate because the gate was invisible, clicked advance, and
// the portal refused to move. Four pages of budget re-reading one URL.
//
// "Not visible, skip" is right for a decorative or dead input — a display:none date field
// once cost 137 seconds of Playwright waiting — and wrong for the common case, where
// invisible means nobody has opened the thing containing it. This is the fourth time that
// shape has needed a fix (Accela's unticked category, Momentum's collapsed nav, PermitTrax's
// closed dropdown, ComEd's drawer), so it is a rule now.
//
// The refusals matter as much as the reveals: opening containers indiscriminately is how a
// run starts clicking things nobody asked it to.
//   npx tsx portal-bot/src/adapters/revealHidden.dom.smoke.ts
import http from "node:http";
import { chromium } from "playwright";
import { planHiddenReveal, planLabelProxy } from "./revealHidden";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

const PAGES: Record<string, string> = {
  // Momentum's shape: the gate inside a collapsed panel with an aria-controls toggle.
  ariaControls: `<!doctype html><html><body>
    <button id="tog" aria-controls="panel" aria-expanded="false" style="width:200px;height:30px">Licenses &amp; Permits</button>
    <div id="panel" style="display:none">
      <select id="gate" data-al-hidden-target="1"><option>Solar</option></select>
    </div></body></html>`,
  details: `<!doctype html><html><body>
    <details><summary style="width:200px;height:20px">More</summary>
      <input id="gate" data-al-hidden-target="1" /></details></body></html>`,
  bsTarget: `<!doctype html><html><body>
    <a href="#sect" data-bs-target="#sect" style="width:150px;height:20px">Open section</a>
    <div id="sect" style="display:none"><input id="gate" data-al-hidden-target="1" /></div></body></html>`,
  precedingToggle: `<!doctype html><html><body>
    <button style="width:150px;height:24px">Show details</button>
    <div style="display:none"><input id="gate" data-al-hidden-target="1" /></div></body></html>`,
  // NOTHING opens this — a genuinely dead field. Must stay skipped.
  deadField: `<!doctype html><html><body>
    <p>Some text</p>
    <div style="display:none"><input id="gate" data-al-hidden-target="1" title="This is a hidden field." /></div>
    </body></html>`,
  // Visible field: nothing to do.
  visible: `<!doctype html><html><body>
    <input id="gate" data-al-hidden-target="1" style="width:120px;height:20px" /></body></html>`,
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGES[(req.url || "").replace(/^\/|\?.*$/g, "")] ?? "<!doctype html><html><body>none</body></html>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const context = await browser.newContext();
// tsx/esbuild wraps named functions with __name(); without this every page.evaluate throws.
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();

const planOn = async (key: string): Promise<{ opener: string; why: string }> => {
  await page.goto(`http://127.0.0.1:${port}/${key}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(80);
  return page.evaluate(planHiddenReveal);
};

const aria = await planOn("ariaControls");
check("THE REGRESSION: Momentum's shape — the gate's own aria-controls toggle is found",
  /aria-controls/.test(aria.opener), JSON.stringify(aria));
console.log(`   opener: ${aria.opener} | ${aria.why}`);

check("...and clicking what it tagged actually reveals the control", await (async () => {
  await page.locator("[data-al-reveal]").first().click();
  await page.evaluate(() => {
    const p = document.getElementById("panel");
    if (p) p.style.display = "block";           // what the portal's own handler would do
  });
  return page.locator("#gate").isVisible();
})());

check("a closed <details> is opened by its summary", /summary/.test((await planOn("details")).opener));
check("a data-bs-target/href toggle is found", /data-target|href/.test((await planOn("bsTarget")).opener));
check("a plain toggle before the hidden container is found", /preceding/.test((await planOn("precedingToggle")).opener));

// ---------------------------------------------------------------------------
// The refusals. Opening containers indiscriminately is how a run starts clicking
// things nobody asked it to — and the old skip existed for a real reason.
// ---------------------------------------------------------------------------
const dead = await planOn("deadField");
check("a genuinely dead hidden field finds no opener and stays skipped", dead.opener === "",
  `invented an opener: ${dead.opener}`);
check("...though it still reports WHY it was invisible", dead.why !== "", JSON.stringify(dead));

const vis = await planOn("visible");
check("a visible field is not a reveal candidate at all", vis.opener === "" && vis.why === "");

// ---------------------------------------------------------------------------
// THE INPUT IS HIDDEN ON PURPOSE AND THE LABEL IS ITS HANDLE.
//
// Momentum's record-type gate, from its own captured markup — nothing is closed at all:
//
//   <fieldset><legend>Pick a record type.</legend>
//     <input id="radio-license" class="input-radio" type="radio" name="radio-options">
//     <label for="radio-license">Licenses &amp; Permits</label>
//
// The NATIVE input is styled out of sight, which is the universal way to draw a custom
// radio, and the label is what a person clicks. planHiddenReveal correctly found no opener
// because there is no container to open — a different shape needing a different answer.
// ---------------------------------------------------------------------------
PAGES.styledRadio = `<!doctype html><html><body>
  <fieldset><legend>Pick a record type.</legend>
    <input id="radio-license" type="radio" name="radio-options" data-al-hidden-target="1"
           style="position:absolute;opacity:0;width:1px;height:1px" />
    <label for="radio-license" style="display:inline-block;width:180px;height:24px">Licenses &amp; Permits</label>
  </fieldset></body></html>`;
PAGES.wrappingLabel = `<!doctype html><html><body>
  <label style="display:inline-block;width:180px;height:24px">
    <input type="checkbox" data-al-hidden-target="1" style="position:absolute;opacity:0;width:1px;height:1px" />
    I agree</label></body></html>`;
PAGES.hiddenText = `<!doctype html><html><body>
  <input type="text" id="t" data-al-hidden-target="1" style="display:none" />
  <label for="t" style="display:inline-block;width:120px;height:20px">Permit Number</label></body></html>`;
PAGES.noLabel = `<!doctype html><html><body>
  <input type="radio" id="r" data-al-hidden-target="1" style="display:none" /></body></html>`;

// ---------------------------------------------------------------------------
// THE OUTERMOST HIDDEN ANCESTOR, NOT THE NEAREST.
//
// Momentum's annotated capture, reading outward from the radio:
//
//   HIDDEN div.field record-select-radio   <- nearest. Nothing opens this.
//   HIDDEN fieldset.record-select-radio
//   HIDDEN form
//   HIDDEN div.choose-type
//   HIDDEN section                         <- the boundary. THIS is what is closed.
//   shown  div
//   shown  div.step1.step-div
//
// The first version stopped at the nearest and hunted an opener for an inner wrapper, which
// is why it reported "no opener" on a page whose real container might well have one. A
// control that opens something is associated with the hidden/visible BOUNDARY, never with a
// div three levels inside it.
// ---------------------------------------------------------------------------
PAGES.nestedHidden = `<!doctype html><html><body>
  <div><button aria-controls="sect" style="width:150px;height:24px">Show step</button>
    <section id="sect" style="display:none">
      <div class="choose-type"><form><fieldset>
        <div class="field"><input id="gate" type="radio" data-al-hidden-target="1" /></div>
      </fieldset></form></div>
    </section></div></body></html>`;

const nested = await planOn("nestedHidden");
check("THE REGRESSION: the climb reaches the OUTERMOST hidden ancestor, not the first",
  /aria-controls/.test(nested.opener), JSON.stringify(nested));
check("...and names that container, so the log points at the right element",
  /section/.test(nested.why), nested.why);
console.log(`   ${nested.opener} | ${nested.why}`);

// ---------------------------------------------------------------------------
// A SKIP LINK IS NEVER AN OPENER, AND THE CLIMB STOPS AT THE BOUNDARY (#176).
//
// Owner-watched City of Meridian run (2026-11-12): the record-type list sat under a header toggle,
// but <main id="mainContent"> measured 0px tall (its children float) around a fully visible page.
// The climb read it as "hidden", walked through five visible ancestors to make it the container,
// and a[href="#mainContent"] — the page's "Skip to main content" link — was returned as the
// group's opener: record_type_group_header_no_effect, and the header rule never ran.
//
//   skipLinkMain   the live shape: the collapsed list behind a header, inside a 0px <main>, with a
//                  skip link to #main → the header toggle, never the skip link.
//   skipLinkOwnId  the belt alone: a skip link whose href is the hidden container's OWN id, a
//                  header before the container → still the header (a skip link opens nothing).
// ---------------------------------------------------------------------------
PAGES.skipLinkMain = `<!doctype html><html><body>
  <a class="skip-link" href="#main" aria-label="Skip to main content" style="display:inline-block;width:160px;height:20px">Skip to main content</a>
  <main id="main">
    <div style="float:left;width:300px">
      <h1>Select a Record Type</h1>
      <div class="group"><a href="javascript:void(0)" onclick="return false" style="display:inline-block;width:160px;height:20px">Residential Electrical</a></div>
      <div class="list" style="display:none"><input id="gate" type="radio" data-al-hidden-target="1" /></div>
    </div>
  </main>
  <div style="clear:both"></div></body></html>`;
PAGES.skipLinkOwnId = `<!doctype html><html><body>
  <a class="skip-link" href="#sect" style="display:inline-block;width:160px;height:20px">Skip to content</a>
  <div class="group"><button style="width:160px;height:24px">Residential Electrical</button></div>
  <div id="sect" style="display:none"><input id="gate" type="radio" data-al-hidden-target="1" /></div></body></html>`;

{
  await page.goto(`http://127.0.0.1:${port}/skipLinkMain`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(80);
  // The fixture must reproduce the live measurement, or it proves nothing about the climb.
  const mainHeight = await page.evaluate(() => document.getElementById("main")!.getBoundingClientRect().height);
  check("fixture: <main> around floated content measures 0px, as Meridian's did", mainHeight < 2, `height=${mainHeight}`);
  const plan = await page.evaluate(planHiddenReveal);
  console.log(`   skipLinkMain: ${plan.opener} | ${plan.why}`);
  check("THE REGRESSION (#176): the opener is the header toggle preceding the list, never the skip link",
    /preceding/.test(plan.opener) && /Residential Electrical/.test(plan.opener) && !/skip/i.test(plan.opener), JSON.stringify(plan));
  check("...and the container named is the list, not <main> (the climb stopped at the boundary)",
    /div\.list/.test(plan.why), plan.why);
}
{
  const plan = await planOn("skipLinkOwnId");
  console.log(`   skipLinkOwnId: ${plan.opener} | ${plan.why}`);
  check("a skip link whose href IS the container's id is still refused; the header before it is the opener",
    /preceding/.test(plan.opener) && !/skip/i.test(plan.opener), JSON.stringify(plan));
}
// The one other target a controls/target attribute may legitimately name: the container's DIRECT
// wrapper, when the container has no id and is the wrapper's only element.
PAGES.wrapperId = `<!doctype html><html><body>
  <button aria-controls="wrap" aria-expanded="false" style="width:160px;height:24px">Show options</button>
  <div id="wrap" style="min-height:12px;width:200px"><div style="display:none"><input id="gate" type="radio" data-al-hidden-target="1" /></div></div></body></html>`;
{
  const plan = await planOn("wrapperId");
  console.log(`   wrapperId: ${plan.opener} | ${plan.why}`);
  check("a toggle that controls the hidden container's direct wrapper (sole child) is accepted",
    /aria-controls/.test(plan.opener) && /Show options/.test(plan.opener), JSON.stringify(plan));
}

const proxyOn = async (key: string): Promise<string> => {
  await page.goto(`http://127.0.0.1:${port}/${key}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(80);
  return page.evaluate(planLabelProxy);
};

const styled = await proxyOn("styledRadio");
check("THE REGRESSION: Momentum's styled radio is reached through its label",
  styled === "Licenses & Permits", `got ${JSON.stringify(styled)}`);

check("...and clicking what it tagged actually checks the radio", await (async () => {
  await page.locator("[data-al-reveal]").first().click();
  return page.locator("#radio-license").isChecked();
})());

check("a WRAPPING label works too — not every portal uses for=", (await proxyOn("wrappingLabel")) === "I agree");

// The refusals.
check("a hidden TEXT input is not label-proxied — that is a different situation",
  (await proxyOn("hiddenText")) === "",
  "only radios and checkboxes are drawn this way");
check("a hidden radio with no visible label stays skipped", (await proxyOn("noLabel")) === "");

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} reveal-hidden check(s) FAILED.`); process.exit(1); }
console.log("\nAll reveal-hidden checks passed.");
process.exit(0);
