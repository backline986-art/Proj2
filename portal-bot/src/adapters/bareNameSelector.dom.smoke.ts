// dom-smoke-timeout: 1200
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
//   toExtractedField, is never a bare name, and its primary alone fills the box. The login
//   builder, the review digest's count and the learner's own builder read a saved bare name the
//   same way, and the resolution trail names it.
// MUST-PASS a step whose primary cannot be built (no strategy at all) fills via its fallback; a
//   malformed-css primary still does too; and when no level resolves, the trail says the
//   primary could not be built. A saved bare name that is a RADIO GROUP's lands on the recorded
//   #id option, never the group's first radio.
// MUST-KEEP { role: "button", name: "Next", exact: true } clicks the button NAMED Next, never the
//   decoy whose name ATTRIBUTE is "Next"; a { label } step fills as before; a saved bare radio-group
//   name with no option id ticks nothing at all.
// #229 REVIEW (each red at aa34445d, the first round of this fix):
//   MUST-EXCLUDE the gap-fill offers no control whose only identity is its name attribute — a
//     READY select whose question is only its title, an id-less name-only select, a label-less
//     checkbox with an id — and reports none missing; a labelled required select is still offered.
//   MUST-EXCLUDE an id-less, label-less checkbox is never recorded as page TEXT (its name): replayed,
//     it ticks nothing, never the checkbox whose <label> holds that word.
//   MUST-EXCLUDE a name attribute two controls share is not recorded as either one's address: two
//     contact blocks' "firstName" boxes take their #ids; two text-less name="cmd" buttons record no
//     name, and replaying the second never clicks the first.
//   MUST-EXCLUDE the name-attribute css matches no <meta name>.
//   MUST-PASS an unlabeled box whose name attribute is "OwnerSigns" is not read as the e-signature
//     box: replay types the bound contact, not the client's signer.
//
// Run: npx tsx portal-bot/src/adapters/bareNameSelector.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium, type Page } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeSelector, RecipeStep } from "../../../shared/src/types";
import { nameAttributeCss } from "../../../shared/src/recipeSelector";
import { RecipeAdapter } from "./recipeAdapter";
import { AutoLearnAdapter, EXTRACT_SEL, extractFieldsInPage, toExtractedField, type LearnPlanner, type RawField } from "./autoLearnAdapter";
import { buildLocator } from "./loginFlow";
import { countRecordedControl } from "../reviewDigest";
import { gapFillCurrentPage } from "../llmGapFill";

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

// The review's shapes: a checkbox known only by its name beside a labelled one holding that word,
// two blocks sharing one name attribute, two text-less buttons sharing one, a <meta> sharing a
// textarea's name, and an unlabeled box whose name attribute reads "OwnerSigns".
const LEARN = `<!doctype html><html><head><title>Applicant</title><meta name="description" content="Permit application"></head><body>
<form onsubmit="return false">
  <h1>Applicant preferences</h1>
  <label for="em">Email me marketing updates (I agree)</label><input type="checkbox" id="em" name="emailOptIn">
  <table><tr><td><input type="checkbox" name="agree"></td></tr></table>
  <div class="form-group row"><div class="col-md-4"><h3>Owner</h3></div><div class="col-md-8"><input id="ownerFirst" name="firstName"></div></div>
  <div class="form-group row"><div class="col-md-4"><h3>Contractor</h3></div><div class="col-md-8"><input id="contrFirst" name="firstName"></div></div>
  <div class="form-group row"><div class="col-md-4"><label class="control-label">Project description</label></div><div class="col-md-8"><textarea id="desc" name="description"></textarea></div></div>
  <div class="form-group row"><div class="col-md-4"><label class="control-label">Owner signs here</label></div><div class="col-md-8"><input id="sigq" name="OwnerSigns"></div></div>
  <button type="button" name="cmd" value="prev" class="ico" style="width:24px;height:24px" onclick="document.body.dataset.cmd='prev'"></button>
  <button type="button" name="cmd" value="next" class="ico" style="width:24px;height:24px" onclick="document.body.dataset.cmd='next'"></button>
</form></body></html>`;

// draftSubmitPins b_titleSelect's READY select, the Accela-shaped id-less name-only select, a
// label-less checkbox with an id, and one labelled required select the gap-fill must still offer.
const READY = "Are you ready to submit your application?";
const GAP = `<!doctype html><html><head><title>Part 1</title></head><body>
<form onsubmit="return false">
  <div><select id="readyS" name="readyS" title="${READY}" required><option value=""></option><option>Yes</option><option>No</option></select></div>
  <div class="row"><div class="q">Is the owner acting as the builder?</div><select name="ddlOwnerBuilder" required><option value=""></option><option>Yes</option><option>No</option></select></div>
  <table><tr><td><input type="checkbox" id="cbGrid" name="cbGrid" required></td></tr></table>
  <label for="roof">Roof type</label><select id="roof" name="roof" required><option value=""></option><option>Composition shingle</option><option>Metal</option></select>
</form></body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(String(req.url).startsWith("/learn") ? LEARN : String(req.url).startsWith("/gap") ? GAP : FORM);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const base = `${origin}/form`;
const learnUrl = `${origin}/learn`;

const recipe = (steps: RecipeStep[], url = base): PortalRecipe => ({
  id: "bare-name-229", scopeType: "ahj", profileKey: "id|city of star|", state: "ID", ahj: "City of Star", utility: "",
  portalPlatform: "fixture", portalUrl: url, status: "complete", version: 1, createdBy: "smoke", createdAt: "", updatedAt: "", notes: "",
  steps: [{ action: "goto", value: url, note: "open" } as RecipeStep, ...steps, { action: "stopForReview" } as RecipeStep],
} as unknown as PortalRecipe);
const fee = (selector: RecipeSelector): RecipeStep =>
  ({ action: "fill", phase: "fill", selector, field: "declaredValuation", note: "fee244341" }) as RecipeStep;

const browser = await chromium.launch();
const shimmed = async (): Promise<{ ctx: Awaited<ReturnType<typeof browser.newContext>>; page: Page }> => {
  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
  return { ctx, page: await ctx.newPage() };
};
type Run = { fee: string; work: string; clicked: string; occ1: boolean; occ2: boolean; ok: boolean; message: string; trail: string; resolution: string; healed: number };
const run = async (steps: RecipeStep[]): Promise<Run> => {
  const { ctx, page: pg } = await shimmed();
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

// A replay on the review's LEARN page; reads every control the review's cases watch.
type LearnRun = { em: boolean; agree: boolean; cmd: string; sig: string; ok: boolean; message: string; secs: number };
const runLearn = async (steps: RecipeStep[], values: Record<string, string> = {}): Promise<LearnRun> => {
  const { ctx, page: pg } = await shimmed();
  const adapter = new RecipeAdapter(recipe(steps, learnUrl), values, {}, { autoSubmit: false });
  (adapter as unknown as { page: unknown }).page = pg;
  const t0 = Date.now();
  const r = await adapter.fillApplication({} as ProjectRecord).catch((e) => ({ ok: false, message: String(e) }));
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  const read = await pg.evaluate(() => ({
    em: (document.getElementById("em") as HTMLInputElement).checked,
    agree: (document.querySelector('input[name="agree"]') as HTMLInputElement).checked,
    cmd: document.body.dataset.cmd || "",
    sig: (document.getElementById("sigq") as HTMLInputElement).value,
  }));
  await ctx.close();
  return { ...read, ok: !!(r as { ok?: boolean }).ok, message: String((r as { message?: string }).message ?? "").slice(0, 200), secs };
};
const readRaws = async (url: string): Promise<RawField[]> => {
  const { ctx, page: pg } = await shimmed();
  await pg.goto(url);
  const raws = (await pg.$$eval(EXTRACT_SEL, extractFieldsInPage as never)) as unknown as RawField[];
  await ctx.close();
  return raws;
};
const hasNoAddress = (s: RecipeSelector | undefined): boolean =>
  !!s && !s.text && !s.css && !s.label && !s.name && !s.placeholder && !s.role && !(s.fallbacks ?? []).length;

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
  const { ctx: lctx, page: lp } = await shimmed();
  await lp.goto(base);
  const raws = (await lp.$$eval(EXTRACT_SEL, extractFieldsInPage as never)) as unknown as RawField[];
  // A text-less, id-less button: its name ATTRIBUTE used to be written into the role+name slot,
  // where it reads as an accessible name it does not have.
  const btnRaw = raws.find((r) => r.fieldType === "button" && r.name === "btnPrint");
  const btnSel = btnRaw ? toExtractedField(btnRaw).selector : undefined;
  const btnHits = btnSel?.css ? await lp.locator(btnSel.css).evaluateAll((els) => els.map((e) => e.getAttribute("name"))) : [];
  // Every other builder reads a saved bare name as the attribute too: login, the review digest's
  // count, and the learner's own builder (#229 review: none of them was exercised).
  const loginCount = await (buildLocator(lp, { name: "fee244341" })?.count() ?? Promise.resolve(-1)).catch(() => -2);
  const digestCount = await countRecordedControl(lp, { name: "fee244341" }).catch(() => -2);
  let learnerCount = -1;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    learnerCount = await (AutoLearnAdapter.prototype as any)._buildLocator.call({}, lp, { name: "fee244341" }, { raw: true }).count();
  } catch { learnerCount = -2; }
  await lctx.close();
  console.log(`   learner recorded the text-less button: ${JSON.stringify(btnSel)}`);
  check("MUST-PASS a text-less, id-less button records its name ATTRIBUTE as css, never as { role, name }",
    !!btnSel && btnSel.css === nameAttributeCss("btnPrint") && !btnSel.role && !btnSel.name, JSON.stringify({ btnRaw, btnSel }));
  check("...and that css addresses exactly that button", JSON.stringify(btnHits) === JSON.stringify(["btnPrint"]), JSON.stringify(btnHits));
  check("MUST-PASS loginFlow.buildLocator reads a saved bare name as the name attribute (one box)", loginCount === 1, `count=${loginCount}`);
  check("MUST-PASS the review digest counts a saved bare name's control (one box)", digestCount === 1, `count=${digestCount}`);
  check("MUST-PASS the learner's own builder reads a saved bare name as the name attribute (one box)", learnerCount === 1, `count=${learnerCount}`);
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
  check("...and the resolution trail names the name attribute it used, not a cut-off css",
    /level 0 name-attr:"fee244341" ->/.test(learnedPrimary.resolution), show(learnedPrimary));
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

  // A must-pass, not a keep: on main the bare primary threw before the #occ2 fallback was tried.
  const radio = await run([{ action: "check", phase: "fill", selector: { name: "occ", fallbacks: [{ css: "#occ2" }] }, note: "occ" } as RecipeStep]);
  check("MUST-PASS a saved bare name that is a RADIO GROUP's lands on the recorded #id option (Tenant)",
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

  // ── #229 REVIEW: the gap-fill offers no control named only by its name attribute ─────────────
  // Main could not build the learner's bare { name }, so such a control was never offered, written
  // or reported missing. The planner here answers everything it is offered, the way an LLM may.
  {
    const { ctx, page: gp } = await shimmed();
    await gp.goto(`${origin}/gap`);
    const offered: string[] = [];
    let plannerCalls = 0;
    const planner: LearnPlanner = async (req) => {
      plannerCalls++;
      offered.push(...req.fields.map((f) => String(f.label ?? f.fieldType)));
      return { fills: req.fields.map((f, i) => ({ selectorIndex: i, value: f.fieldType === "checkbox" ? "true" : "Yes", field: "" })), atReview: false } as unknown as Awaited<ReturnType<LearnPlanner>>;
    };
    const out = await gapFillCurrentPage(gp, planner, { roofType: "Metal" });
    const after = await gp.evaluate(() => ({
      readyS: (document.getElementById("readyS") as HTMLSelectElement).value,
      owner: (document.querySelector('select[name="ddlOwnerBuilder"]') as HTMLSelectElement).value,
      cbGrid: (document.getElementById("cbGrid") as HTMLInputElement).checked,
    }));
    await ctx.close();
    const detail = JSON.stringify({ plannerCalls, offered, after, reportedMissing: out.reportedMissing, attempted: out.attempted });
    console.log(`   gap-fill: ${detail}`);
    check("MUST-KEEP the gap-fill still offers the LABELLED required select (the check is not vacuous)", offered.includes("Roof type"), detail);
    check("MUST-EXCLUDE it offers nothing whose only identity is a name attribute (READY title select, id-less select, label-less checkbox)",
      offered.every((l) => l === "Roof type"), detail);
    check("MUST-EXCLUDE the READY select (its question only in a title) is never answered", after.readyS === "", detail);
    check("MUST-EXCLUDE the id-less name-only select and the label-less checkbox are never written", after.owner === "" && after.cbGrid === false, detail);
    check("MUST-EXCLUDE none of them reaches the operator's \"add this to the project\" list",
      !out.reportedMissing.some((m) => /readyS|ddlOwnerBuilder|cbGrid/.test(m)), detail);
  }

  // ── #229 REVIEW: what the learner records for the shapes a name attribute cannot address ──────
  const lraws = await readRaws(learnUrl);
  const sel = (pred: (r: RawField) => boolean): RecipeSelector | undefined => {
    const r = lraws.find(pred);
    return r ? toExtractedField(r).selector : undefined;
  };
  const agreeRaw = lraws.find((r) => r.fieldType === "checkbox" && r.name === "agree");
  const agreeSel = sel((r) => r.fieldType === "checkbox" && r.name === "agree");
  console.log(`   learner recorded the id-less, label-less checkbox: ${JSON.stringify(agreeSel)} (raw ${JSON.stringify({ label: agreeRaw?.label, name: agreeRaw?.name })})`);
  check("MUST-EXCLUDE an id-less, label-less checkbox is never recorded as page TEXT (its label is only its name)",
    !!agreeSel && !agreeSel.text, JSON.stringify(agreeSel));
  check("...it keeps no address at all (the learner bails on it at once, as main did)", hasNoAddress(agreeSel), JSON.stringify(agreeSel));
  const agreeRun = await runLearn([{ action: "check", phase: "fill", selector: agreeSel ?? {}, note: agreeRaw?.label ?? "agree", fingerprint: { name: "agree" } } as unknown as RecipeStep]);
  check("MUST-EXCLUDE replayed, it ticks NOTHING — never the checkbox whose <label> holds \"agree\"",
    !agreeRun.em && !agreeRun.agree, JSON.stringify(agreeRun));
  check("...and the step fails loudly, fast (no usable selector), not reported as success",
    !agreeRun.ok && /no usable selector/i.test(agreeRun.message) && agreeRun.secs < 60, JSON.stringify(agreeRun));

  const ownerSel = sel((r) => r.id === "ownerFirst");
  const contrSel = sel((r) => r.id === "contrFirst");
  console.log(`   learner recorded the shared-name boxes: owner ${JSON.stringify(ownerSel)} contractor ${JSON.stringify(contrSel)}`);
  check("MUST-EXCLUDE a name attribute two boxes share is not either one's address: each takes its #id",
    ownerSel?.css === "#ownerFirst" && contrSel?.css === "#contrFirst", JSON.stringify({ ownerSel, contrSel }));
  const cmdSels = lraws.filter((r) => r.fieldType === "button" && r.name === "cmd").map((r) => toExtractedField(r).selector);
  console.log(`   learner recorded the two text-less name="cmd" buttons: ${JSON.stringify(cmdSels)}`);
  check("MUST-EXCLUDE two text-less buttons sharing name=\"cmd\" record no name address",
    cmdSels.length === 2 && cmdSels.every((s) => s.css !== nameAttributeCss("cmd") && !s.name), JSON.stringify(cmdSels));
  const cmdRun = await runLearn([{ action: "click", phase: "fill", selector: cmdSels[1] ?? {}, note: "cmd" } as RecipeStep]);
  check("...and replaying the SECOND button's recording never clicks the first", cmdRun.cmd !== "prev", JSON.stringify(cmdRun));

  {
    const { ctx, page: mp } = await shimmed();
    await mp.goto(learnUrl);
    const hits = await mp.locator(nameAttributeCss("description")).evaluateAll((els) => els.map((e) => e.tagName.toLowerCase()));
    await ctx.close();
    check("MUST-EXCLUDE the name-attribute css matches the textarea, never <meta name=\"description\">",
      JSON.stringify(hits) === JSON.stringify(["textarea"]), JSON.stringify(hits));
  }

  const sigSel = sel((r) => r.id === "sigq");
  console.log(`   learner recorded the unlabeled OwnerSigns box: ${JSON.stringify(sigSel)}`);
  const sigRun = await runLearn([{ action: "fill", phase: "fill", selector: sigSel ?? {}, field: "installerContactName", note: "OwnerSigns" } as RecipeStep],
    { installerContactName: "Casey Contact", authorizedSignerName: "Pat Signer" });
  check("MUST-PASS an unlabeled box named \"OwnerSigns\" is not the e-signature box: replay types the bound contact, never the signer",
    sigRun.sig === "Casey Contact", JSON.stringify({ sigSel, sigRun }));
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} bare-name selector check(s) FAILED.`); process.exit(1); }
console.log("\nAll bare-name selector checks passed (real Chromium).");
process.exit(0);
