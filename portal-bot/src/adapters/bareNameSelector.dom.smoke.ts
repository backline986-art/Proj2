// A BARE `name` IS THE CONTROL'S NAME ATTRIBUTE, AND A LEVEL THAT CANNOT BE BUILT IS SKIPPED (#229).
//
// Live, City of Star (iWorQ) scratch replay 2026-11-14, stopped at review, nothing filed: the
// learner recorded the valuation box `<input type="number" id="fee244341" name="fee244341">`,
// whose "* Enter Total Project Value*:" label is not tied to it, as
// `{ name: "fee244341", fallbacks: [{ css: "#fee244341" }] }`. Replay read `name` only beside a
// role, threw "Recipe step has no usable selector." for the bare one, and — the primary being
// built outside the level loop — failed step 8 without trying the #id.
//
// MUST-PASS a saved bare-name step fills the number box (with its #id fallback, and alone), as
//   recorded — not by a self-heal, which patches the recipe and drops auto-submit trust.
// MUST-PASS the learner's shape for that box, read off the page by the REAL extractor and
//   toExtractedField, is never a bare name, and its primary alone fills the box.
// MUST-PASS a step whose primary cannot be built (no strategy at all) fills via its fallback; a
//   malformed-css primary still does too; and when no level resolves, the trail says the
//   primary could not be built.
// MUST-KEEP { role: "button", name: "Next", exact: true } clicks the button NAMED Next, never the
//   decoy whose name ATTRIBUTE is "Next"; a { label } step fills as before; a saved bare name that
//   is a RADIO GROUP's name lands on the recorded #id option, never the group's first radio, and
//   with no option id it ticks nothing at all.
//
// Run: npx tsx portal-bot/src/adapters/bareNameSelector.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeSelector, RecipeStep } from "../../../shared/src/types";
import { nameAttributeCss } from "../../../shared/src/recipeSelector";
import { RecipeAdapter } from "./recipeAdapter";
import { EXTRACT_SEL, extractFieldsInPage, toExtractedField, type RawField } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const VALUATION = "22300";
const WORK = "Install 8.92 kW roof-mounted PV";
// iWorQ's shape: a bootstrap row whose label sits in another column, never tied to the input.
const FORM = `<!doctype html><html><head><title>Solar Permit or Panel Application</title></head><body>
<form onsubmit="return false">
  <section id="p1">
    <h2>Property Information</h2>
    <div class="form-group row">
      <div class="col-md-4"><label for="field267055">Description of Work:</label></div>
      <div class="col-md-8"><textarea id="field267055" name="field267055" class="form-control"></textarea></div>
    </div>
    <div class="form-group row">
      <div class="col-md-4"><label class="control-label"><span class="text-danger">*</span> Enter Total Project Value*:</label></div>
      <div class="col-md-8"><input type="number" value="0" required id="fee244341" name="fee244341" step="any" class="form-control"></div>
    </div>
    <div class="form-group row">
      <div class="col-md-12">Occupancy
        <input type="radio" name="occ" id="occ1" value="Owner">
        <input type="radio" name="occ" id="occ2" value="Tenant">
      </div>
    </div>
    <button type="button" name="Next" id="decoy" onclick="document.body.dataset.clicked='decoy'">Previous</button>
    <button type="button" name="btnPrint" class="btn" style="width:32px;height:24px" onclick="document.body.dataset.printed='1'"></button>
    <button type="button" id="go" onclick="document.body.dataset.clicked='next';document.getElementById('p1').hidden=true;document.getElementById('p2').hidden=false">Next</button>
  </section>
  <section id="p2" hidden><h2>Review</h2><p>Review your application.</p></section>
</form></body></html>`;

const server = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(FORM); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/form`;

const recipe = (steps: RecipeStep[]): PortalRecipe => ({
  id: "bare-name-229", scopeType: "ahj", profileKey: "id|city of star|", state: "ID", ahj: "City of Star", utility: "",
  portalPlatform: "fixture", portalUrl: base, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps: [{ action: "goto", value: base, note: "open" } as RecipeStep, ...steps, { action: "stopForReview" } as RecipeStep],
} as unknown as PortalRecipe);
const fee = (selector: RecipeSelector): RecipeStep =>
  ({ action: "fill", phase: "fill", selector, field: "declaredValuation", note: "fee244341" }) as RecipeStep;

const browser = await chromium.launch();
type Run = { fee: string; work: string; clicked: string; occ1: boolean; occ2: boolean; ok: boolean; message: string; trail: string; resolution: string; healed: number };
const run = async (steps: RecipeStep[]): Promise<Run> => {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const pg = await ctx.newPage();
  const adapter = new RecipeAdapter(recipe(steps), { declaredValuation: VALUATION, workDescription: WORK }, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = pg;
  const r = await adapter.fillApplication({} as ProjectRecord).catch((e) => ({ ok: false, message: String(e) }));
  const read = await pg.evaluate(() => ({
    fee: (document.getElementById("fee244341") as HTMLInputElement).value,
    work: (document.getElementById("field267055") as HTMLTextAreaElement).value,
    clicked: document.body.dataset.clicked || "",
    occ1: (document.getElementById("occ1") as HTMLInputElement).checked,
    occ2: (document.getElementById("occ2") as HTMLInputElement).checked,
  }));
  const trail = (adapter as unknown as { driftWarnings: string[] }).driftWarnings.join(" | ");
  // The last resolution's own trail (resolveTrail): kept for every step, reported on a select miss.
  const resolution = (adapter as unknown as { resolveTrail: string[] }).resolveTrail.join(" | ");
  // A self-heal patches the recipe and drops auto-submit trust: a step that resolves as recorded needs none.
  const healed = (adapter as unknown as { healedSteps: unknown[] }).healedSteps.length;
  await ctx.close();
  return { ...read, ok: !!(r as { ok?: boolean }).ok, message: String((r as { message?: string }).message ?? ""), trail, resolution, healed };
};
const show = (r: Run): string => JSON.stringify({ fee: r.fee, ok: r.ok, healed: r.healed, message: r.message.slice(0, 160), trail: r.trail.slice(0, 300), resolution: r.resolution.slice(0, 300) });

try {
  // ── MUST-PASS: the saved recipe, exactly as Star's step 8 was recorded ───────────────────────
  const saved = await run([fee({ name: "fee244341", fallbacks: [{ css: "#fee244341" }] })]);
  check("MUST-PASS saved { name, fallbacks:[#id] } (Star step 8): the valuation lands in the number box",
    saved.fee === VALUATION && saved.healed === 0, show(saved));
  check("...and the step did not fail with \"no usable selector\"", !/no usable selector/i.test(`${saved.message} ${saved.trail}`), show(saved));

  // Without the #id fallback the bare name has to be READ. Skipping to a fallback cannot save it;
  // a self-heal by the note's label can (it re-anchors by label), but a heal patches the recipe
  // and drops auto-submit trust, so the step must land as recorded, with no heal.
  const bare = await run([fee({ name: "fee244341" })]);
  check("MUST-PASS saved bare { name } with NO fallback: read as the name attribute, the box is filled",
    bare.fee === VALUATION, show(bare));
  check("...as recorded, not by a self-heal around an unreadable selector", bare.healed === 0, show(bare));

  // ── MUST-PASS: the learner's new shape, read off this page by the real extractor ─────────────
  const lctx = await browser.newContext();
  await lctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  const lp: Page = await lctx.newPage();
  await lp.goto(base);
  const raws = (await lp.$$eval(EXTRACT_SEL, extractFieldsInPage as never)) as unknown as RawField[];
  // A text-less, id-less button: its name ATTRIBUTE used to be written into the role+name slot,
  // where it reads as an accessible name it does not have.
  const btnRaw = raws.find((r) => r.fieldType === "button" && r.name === "btnPrint");
  const btnSel = btnRaw ? toExtractedField(btnRaw).selector : undefined;
  const btnHits = btnSel?.css ? await lp.locator(btnSel.css).evaluateAll((els) => els.map((e) => e.getAttribute("name"))) : [];
  await lctx.close();
  console.log(`   learner recorded the text-less button: ${JSON.stringify(btnSel)}`);
  check("MUST-PASS a text-less, id-less button records its name ATTRIBUTE as css, never as { role, name }",
    !!btnSel && btnSel.css === nameAttributeCss("btnPrint") && !btnSel.role && !btnSel.name, JSON.stringify({ btnRaw, btnSel }));
  check("...and that css addresses exactly that button", JSON.stringify(btnHits) === JSON.stringify(["btnPrint"]), JSON.stringify(btnHits));
  const raw = raws.find((r) => r.id === "fee244341");
  const learned = raw ? toExtractedField(raw).selector : undefined;
  console.log(`   learner recorded: ${JSON.stringify(learned)} (raw label ${JSON.stringify(raw?.label)})`);
  check("the extractor reads the box with no tied label (label = its name attribute) — the live shape", raw?.label === "fee244341", JSON.stringify(raw));
  check("MUST-PASS the learner no longer writes a bare `name` (it means an accessible name beside a role)",
    !!learned && !(learned.name && !learned.role), JSON.stringify(learned));
  check("MUST-PASS ...it writes the name attribute through the one builder, and keeps the #id fallback",
    learned?.css === nameAttributeCss("fee244341") && !!learned?.fallbacks?.some((f) => f.css === "#fee244341"), JSON.stringify(learned));
  const learnedPrimary = await run([fee({ ...(learned ?? {}), fallbacks: undefined })]);
  check("MUST-PASS the learner's primary ALONE (fallbacks stripped) fills the box on replay, no heal",
    learnedPrimary.fee === VALUATION && learnedPrimary.healed === 0, show(learnedPrimary));
  const learnedFull = await run([fee(learned ?? {})]);
  check("MUST-PASS the learner's whole selector fills the box on replay", learnedFull.fee === VALUATION, show(learnedFull));

  // ── MUST-PASS: a primary that cannot be built falls to its fallbacks ─────────────────────────
  const unbuilt = await run([fee({ fallbacks: [{ css: "#fee244341" }] })]);
  check("MUST-PASS a primary with no usable strategy (locator() throws) still fills via its #id fallback",
    unbuilt.fee === VALUATION && unbuilt.healed === 0, show(unbuilt));
  const malformed = await run([fee({ css: "#fee244341[[", fallbacks: [{ css: "#fee244341" }] })]);
  check("MUST-PASS a malformed-css primary still fills via its fallback", malformed.fee === VALUATION, show(malformed));
  // Its note names nothing on the page either, so self-heal (which anchors on the note) cannot
  // rescue it: this is the step that genuinely has nowhere to go.
  const nowhere = await run([{ ...fee({ fallbacks: [{ css: "#no-such-box" }] }), note: "absent control" } as RecipeStep]);
  check("MUST-PASS no level resolves: the step fails and the box is untouched", !nowhere.ok && nowhere.fee === "0", show(nowhere));
  check("...and the resolution trail says the primary could not be built (not only that nothing matched)",
    /level 0 .*cannot be built \(Recipe step has no usable selector/.test(nowhere.resolution), show(nowhere));

  // ── MUST-KEEP ────────────────────────────────────────────────────────────────────────────────
  const next = await run([{ action: "click", phase: "fill", selector: { role: "button", name: "Next", exact: true }, note: "advance: Next" } as RecipeStep]);
  check("MUST-KEEP { role:button, name:Next, exact } clicks the button NAMED Next", next.clicked === "next", JSON.stringify({ clicked: next.clicked, ok: next.ok, message: next.message.slice(0, 160) }));
  check("...never the decoy whose name ATTRIBUTE is \"Next\"", next.clicked !== "decoy", next.clicked);

  const label = await run([{ action: "fill", phase: "fill", selector: { label: "Description of Work:", fallbacks: [{ css: "#field267055" }] }, field: "workDescription", note: "Description of Work:" } as RecipeStep]);
  check("MUST-KEEP a { label } step fills its box as before", label.work === WORK, JSON.stringify({ work: label.work, ok: label.ok, message: label.message.slice(0, 160) }));

  const radio = await run([{ action: "check", phase: "fill", selector: { name: "occ", fallbacks: [{ css: "#occ2" }] }, note: "occ" } as RecipeStep]);
  check("MUST-KEEP a saved bare name that is a RADIO GROUP's lands on the recorded #id option (Tenant)",
    radio.occ2 === true, JSON.stringify({ occ1: radio.occ1, occ2: radio.occ2, ok: radio.ok, message: radio.message.slice(0, 160) }));
  check("...never the group's first radio (a group's name is not the option's identity)", radio.occ1 === false, JSON.stringify({ occ1: radio.occ1, occ2: radio.occ2 }));
  // With no option id to disambiguate, reading the group's name as an address would tick the
  // first radio — an answer nobody recorded. It must resolve nothing, as it did before (#229).
  const groupOnly = await run([{ action: "check", phase: "fill", selector: { name: "occ" }, note: "occ" } as RecipeStep]);
  check("MUST-KEEP a saved bare RADIO-GROUP name with no option id ticks no option (never a guessed first radio)",
    groupOnly.occ1 === false && groupOnly.occ2 === false, JSON.stringify({ occ1: groupOnly.occ1, occ2: groupOnly.occ2, ok: groupOnly.ok, message: groupOnly.message.slice(0, 160) }));

  // ── The builder's quoting: a name carrying a quote and a backslash still addresses its control ─
  const qctx = await browser.newContext();
  const qp = await qctx.newPage();
  await qp.setContent(`<input id="q" name='ctl00$Main$a"b\\c'><input type="radio" name="grp" id="r1"><input name="grp" id="t1">`);
  const quoted = await qp.locator(nameAttributeCss('ctl00$Main$a"b\\c')).count();
  const grp = await qp.locator(nameAttributeCss("grp")).evaluateAll((els) => els.map((e) => e.id));
  await qctx.close();
  check("nameAttributeCss quotes `\"` and `\\` (ASP.NET `$` needs nothing): exactly one match", quoted === 1, `count=${quoted}`);
  check("nameAttributeCss never matches a radio sharing the name", JSON.stringify(grp) === JSON.stringify(["t1"]), JSON.stringify(grp));
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} bare-name selector check(s) FAILED.`); process.exit(1); }
console.log("\nAll bare-name selector checks passed (real Chromium).");
process.exit(0);
