// A PER-RENDER ID IS NOT AN IDENTITY: A SHIFTED COUNTER MUST NOT MOVE A WRITE INTO THE NEIGHBOUR (#234).
//
// The 2026-11-14 recipe audit replayed PGE's applicant steps 15/17-21 (shiftRedirect.audit.mts) on
// main's engine against the contact block with its render counter moved. The steps are recorded as
// {placeholder "Last", fallbacks [#pcInputBase11, data-test-role]} with a fingerprint {id
// pcInputBase11, ariaLabel "Last", section "Applicant (PGE Customer)"}; pcInputBaseN is a render
// counter, and one learn saw the same control as pcInputBase8 and pcInputBase79.
//   shift 0   correct.
//   shift -1  #pcInputBase11 now names Company in the SAME fieldset; reanchorIfWrongControl took
//             section agreement alone as licence to redirect, wrote the surname into Company and
//             read it back verified; City then went into State (a select) and the step threw.
//   shift +1  (Ameren's one-off numbering) #pcInputBase11 names the "Existing contact" select.
//   restart   #pcInputBase11 names the CO-APPLICANT's Last; disambiguateByRecordedIdentity let the
//             stale id choose between the two "Last" boxes and the surname went silently there.
//   ph-1      shift -1 with Company named by its placeholder alone (no label for the re-anchor to
//             read), so only the counter classifier can refuse it.
//   lb-1      shift -1 with every box named through aria-labelledby (the same: no label read).
//
// MUST-PASS: at every shift the six values land in the applicant's own boxes, Company and the
//   co-applicant stay empty, nothing is written into "the recorded control", and the run is clean.
// MUST-KEEP (HEAD == origin/main): every shape the earlier rounds' reviewers showed main gets right.
//   MF5 itself ('E-mail:' vs 'Email Address:') and its relabelled / renamed-legend / counter-id /
//   nameless / long-legend / hint-named variants still redirect to the owner's box with main's
//   "written there" warning; the h1-only page, the unsectioned page, the label-vs-aria-label pair,
//   the sub-headed pair, the aria-labelledby pair and a counter that agrees on its own label AND the
//   section keep main's write and main's report exactly.
// Synthetic page and values only (shapes copied from the recipe, never its data).
//
// Run: npx tsx portal-bot/src/adapters/volatileIdRedirect.dom.smoke.ts
import "../smokeArtifactDirs";
import http from "node:http";
import { chromium } from "playwright";
import type { PortalRecipe, ProjectRecord, RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const SECTION = "Applicant (PGE Customer)";
const CO = "Co-Applicant (if applicable)";
// One contact block, PowerClerk's shape: the heading labels are unassociated, the accessible
// names are aria-label/placeholder, every box but First/Address carries a render-counter id.
// `companyByPlaceholder`: the Company box named by its placeholder alone, as PacifiCorp's recorded
// Company step shows real PowerClerk Company boxes are. `heading`: the block sectioned by a panel
// heading (<div class="section"><h2>) instead of a fieldset legend.
const block = (legend: string, stable: string, n: (k: number) => string, companyByPlaceholder = false, heading = false): string => `
  ${heading ? `<div class="section"><h2>${legend}</h2>` : `<fieldset><legend>${legend}</legend>`}
    <select id="${n(0)}" aria-label="Existing contact to use for this contact"><option value="">New Contact</option></select>
    <div class="lbl">Name</div>
    <input id="${stable}First" placeholder="First">
    <input id="${n(1)}" placeholder="Last" aria-label="Last">
    <div class="lbl">Company</div><input id="${n(2)}" placeholder="Company"${companyByPlaceholder ? "" : ` aria-label="Company"`}>
    <div class="lbl">Title</div><input id="${n(3)}" placeholder="Title" aria-label="Title">
    <div class="lbl">Address</div><input id="${stable}Address" placeholder="Street">
    <input id="${n(4)}" placeholder="City" aria-label="City">
    <select id="${n(5)}" aria-label="State"><option value="">Select...</option><option value="OR">OR</option><option value="WA">WA</option></select>
    <input id="${n(6)}" placeholder="Zip Code" aria-label="Zip Code">
    <input id="${n(7)}" placeholder="Email">
    <label for="${n(8)}">Phone</label><input id="${n(8)}" placeholder="(###) ###-####">
  ${heading ? "</div>" : "</fieldset>"}`;
// The same block with every box named through aria-labelledby (a <span> beside it), no placeholder,
// no aria-label, no label element: the shape a portal on React/Angular often renders. The
// re-anchor's own label reader sees no name on either box here.
const blockLabelledBy = (legend: string, stable: string, n: (k: number) => string): string => {
  const lb = (key: string, text: string): string => `<span id="${stable}-${key}">${text}</span>`;
  const by = (key: string): string => `aria-labelledby="${stable}-${key}"`;
  return `
  <fieldset><legend>${legend}</legend>
    ${lb("ec", "Existing contact to use for this contact")}<select id="${n(0)}" ${by("ec")}><option value="">New Contact</option></select>
    ${lb("fi", "First")}<input id="${stable}First" ${by("fi")}>
    ${lb("la", "Last")}<input id="${n(1)}" ${by("la")}>
    ${lb("co", "Company")}<input id="${n(2)}" ${by("co")}>
    ${lb("ti", "Title")}<input id="${n(3)}" ${by("ti")}>
    ${lb("st", "Street")}<input id="${stable}Address" ${by("st")}>
    ${lb("ci", "City")}<input id="${n(4)}" ${by("ci")}>
    ${lb("sa", "State")}<select id="${n(5)}" ${by("sa")}><option value="">Select...</option><option value="OR">OR</option><option value="WA">WA</option></select>
    ${lb("zi", "Zip Code")}<input id="${n(6)}" ${by("zi")}>
  </fieldset>`;
};
// A legend longer than the learner's 80-character cut (sectionFor keeps 80), worded so the cut lands
// on a space, as a real recording of it would.
const LONG_LEGEND = "Is the interconnection customer requesting net metering under the State's rule? If yes, provide the meter details below.";
const LONG_RECORDED = LONG_LEGEND.replace(/\s+/g, " ").trim().slice(0, 80);
const page = (body: string, title = "<h1>Fixture Customer Information</h1>"): string =>
  `<!doctype html><html><body>${title}<form onsubmit="return false">${body}</form></body></html>`;
// MF5's two blocks: the applicant's email box (prefilled with the installer's address, which the
// label resolves onto) and the owner's, under `ownerLegend`, named `ownerLabel` (none: no label).
const mf5Page = (appId: string, ownerId: string, ownerLabel: string | null, ownerLegend = "Property Owner"): string => page(`
    <fieldset><legend>Applicant</legend>
      <label for="${appId}">E-mail:</label><input id="${appId}" value="installer@example.test">
    </fieldset>
    <fieldset><legend>${ownerLegend}</legend>
      ${ownerLabel === null ? "" : `<label for="${ownerId}">${ownerLabel}</label>`}<input id="${ownerId}">
    </fieldset>`);

// The recorded learn numbered the applicant's block from 10. `shift` moves that counter; "restart"
// gives the co-applicant the counter the applicant had at the learn.
const pageFor = (mode: string): string => {
  const pc = (base: number) => (k: number) => `pcInputBase${base + k}`;
  switch (mode) {
    // "lb-1": both PGE blocks named through aria-labelledby, counter shifted by one.
    case "lb-1": return page(`${blockLabelledBy(SECTION, "Q7XK2LM9P0AA", pc(9))}${blockLabelledBy(CO, "R4TN8WE3Z1BB", pc(18))}`, "<h1>PGE Customer Information</h1>");
    // MF5 (accela/relabelled): the owner's "E-mail:" became "Email Address:", so the label resolves
    // onto the applicant's box; the recorded stable id is the owner's.
    case "mf5": return mf5Page("ApplicantEdit_txtEmail", "OwnerEdit_txtEmail", "Email Address:");
    // MF5 with the owner's box relabelled "Contact Address" (its label no longer agrees; only the
    // recorded section does), on counter ids and on stable ids.
    case "mf5-counter": return mf5Page("pcInputBase12", "pcInputBase31", "Contact Address");
    case "mf5-stable": return mf5Page("ApplicantEdit_txtEmail", "OwnerEdit_txtEmail", "Contact Address");
    // MF5 on counter ids with the owner's box carrying no label at all.
    case "mf5-counter-nameless": return mf5Page("pcInputBase12", "pcInputBase31", null);
    // MF5 with the owner's legend renamed (the label still agrees), stable and counter ids.
    case "mf5-legend-renamed": return mf5Page("ApplicantEdit_txtEmail", "OwnerEdit_txtEmail", "Email Address:", "Owner Information");
    case "counter-legend-renamed": return mf5Page("pcInputBase12", "pcInputBase31", "Email Address:", "Owner Information");
    // MF5 with the owner's block under a legend over 80 characters.
    case "long-legend": return mf5Page("ApplicantEdit_txtEmail", "OwnerEdit_txtEmail", "Email Address:", LONG_LEGEND);
    // MF5 under panel headings, the owner's box under a sub-heading of its own.
    case "mf5-subheading": return page(`
      <h2>Applicant</h2><div><label for="ApplicantEdit_txtEmail">E-mail:</label><input id="ApplicantEdit_txtEmail" value="installer@example.test"></div>
      <h2>Property Owner</h2><h4>Contact details</h4><div><label for="OwnerEdit_txtEmail">Email Address:</label><input id="OwnerEdit_txtEmail"></div>`);
    // MF5 where the only heading is a title carrying a record number that changed since the learn.
    case "mf5-dynamic-title": return page(`
      <div><label for="ApplicantEdit_txtEmail">E-mail:</label><input id="ApplicantEdit_txtEmail" value="installer@example.test"></div>
      <div><label for="OwnerEdit_txtEmail">Email Address:</label><input id="OwnerEdit_txtEmail"></div>`, "<h1>Application ZZ00-00712 - Contacts</h1>");
    // Review of the minimal round: both boxes under ONE recorded legend, stable ids; the recorded
    // owner box was relabelled "Contact Address" and the label resolves onto its prefilled sibling.
    case "same-legend-stable": return page(`
    <fieldset><legend>Property Owner</legend>
      <label for="Owner_txtAltEmail">E-mail:</label><input id="Owner_txtAltEmail" value="installer@example.test">
      <label for="OwnerEdit_txtEmail">Contact Address</label><input id="OwnerEdit_txtEmail">
    </fieldset>`);
    // MF5 with the owner's boxes named only by a placeholder mask and a title tooltip.
    case "hints": return page(`
    <fieldset><legend>Applicant</legend>
      <label for="A_txtInstallDate">Installation Date</label><input id="A_txtInstallDate" value="01/01/2026">
      <label for="A_txtValuation">Job Value</label><input id="A_txtValuation" value="11111">
    </fieldset>
    <fieldset><legend>Property Owner</legend>
      <div>Install Date</div><input id="O_txtInstallDate" placeholder="MM/DD/YYYY">
      <div>Valuation</div><input id="O_txtValuation" title="Enter the total contract price in dollars">
    </fieldset>`);
    // One page heading over a labelled box and a nameless one.
    case "h1-only": return page(`
      <label for="A_txtEmail">E-mail:</label><input id="A_txtEmail">
      <input id="O_txtEmail">`, "<h1>Contact Information</h1>");
    // No legend, no heading anywhere.
    case "unsectioned": return page(`
      <label for="A_txtEmail">E-mail:</label><input id="A_txtEmail" value="installer@example.test">
      <input id="O_txtEmail">`, "");
    // Two boxes labelled "Phone" in one fieldset; the recorded one also carries an aria-label.
    case "dup-aria-vs-label": return page(`
    <fieldset><legend>Applicant</legend>
      <label for="pcInputBase9">Phone</label><input id="pcInputBase9">
      <label for="pcInputBase10">Phone</label><input id="pcInputBase10" aria-label="Alternate phone">
    </fieldset>`);
    // Two "Phone" boxes under one heading, the recorded one under a sub-heading of its own.
    case "dup-subheading": return page(`
      <h2>Property Owner</h2><div><label for="pcInputBase20">Phone</label><input id="pcInputBase20"></div>
      <h4>Alternate contact</h4><div><label for="pcInputBase21">Phone</label><input id="pcInputBase21"></div>`);
    // Two "Phone" boxes, no fieldsets: one named through aria-labelledby (the recorded one).
    case "lb-phone": return page(`
      <span id="lA">Phone</span><input id="pcInputBase9" aria-labelledby="lA" placeholder="(###) ###-####">
      <label for="pcInputBase30">Phone</label><input id="pcInputBase30">`);
    // Two "Phone" boxes in one fieldset: the step's own selector names the first, its recorded
    // (unshifted) counter the second, which agrees on its own label and on the section.
    case "counter-tie": return page(`
    <fieldset><legend>${SECTION}</legend>
      <label for="pcInputBase17">Phone</label><input id="pcInputBase17">
      <label for="pcInputBase18">Phone</label><input id="pcInputBase18">
    </fieldset>`);
    default: break;
  }
  // "ph-1": shift -1 with both Company boxes named by placeholder alone. "h-1": shift -1 with both
  // blocks sectioned by panel headings instead of legends.
  const byPlaceholder = mode === "ph-1";
  const byHeading = mode === "h-1";
  const shift = byPlaceholder || byHeading ? -1 : Number(mode);
  const [app, co] = mode === "restart" ? [pc(19), pc(10)] : [pc(10 + shift), pc(19 + shift)];
  return page(`${block(SECTION, "Q7XK2LM9P0AA", app, byPlaceholder, byHeading)}
    ${block(CO, "R4TN8WE3Z1BB", co, byPlaceholder, byHeading)}`, "<h1>PGE Customer Information</h1>");
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  res.writeHead(200, { "content-type": "text/html" });
  res.end(pageFor(url.pathname.slice(1) || "0"));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const fp = (id: string, extra: Record<string, string> = {}) => ({ fingerprint: { id, ...extra, section: SECTION } });
// PGE steps 15 and 17-21, shape verbatim from the recipe.
const STEPS: RecipeStep[] = [
  { action: "fill", phase: "fill", selector: { placeholder: "Last", fallbacks: [{ css: "#pcInputBase11" }, { css: "[data-test-role=\"contact-last-element\"]" }] }, note: "Last", ...fp("pcInputBase11", { placeholder: "Last", ariaLabel: "Last" }), field: "homeownerLastName" },
  { action: "fill", phase: "fill", selector: { placeholder: "City", fallbacks: [{ css: "#pcInputBase14" }, { css: "[data-test-role=\"contact-city-element\"]" }] }, note: "City", ...fp("pcInputBase14", { placeholder: "City", ariaLabel: "City" }), field: "city" },
  { action: "select", phase: "fill", selector: { label: "State", fallbacks: [{ css: "#pcInputBase15" }, { css: "[data-test-role=\"state-select\"]" }] }, note: "State", ...fp("pcInputBase15", { ariaLabel: "State" }), field: "state" },
  { action: "fill", phase: "fill", selector: { placeholder: "Zip Code", fallbacks: [{ css: "#pcInputBase16" }, { css: "[data-test-role=\"contact-zip-element\"]" }] }, note: "Zip Code", ...fp("pcInputBase16", { placeholder: "Zip Code", ariaLabel: "Zip Code" }), field: "zip" },
  { action: "fill", phase: "fill", selector: { placeholder: "Email", fallbacks: [{ css: "#pcInputBase17" }, { css: "[data-test-role=\"contact-email-element\"]" }] }, note: "Email", ...fp("pcInputBase17", { placeholder: "Email" }), field: "homeownerEmail" },
  { action: "fill", phase: "fill", selector: { label: "Phone", fallbacks: [{ css: "#pcInputBase18" }, { css: "[data-test-role=\"contact-phone-element\"]" }] }, note: "Phone", ...fp("pcInputBase18", { placeholder: "(###) ###-####" }), field: "homeownerPhone" },
] as unknown as RecipeStep[];
const VALUES = { homeownerLastName: "Testsurname", city: "Springfield", state: "OR", zip: "97000", homeownerEmail: "owner@example.test", homeownerPhone: "5035550100",
  homeownerFirstName: "Testfirst", fixtureInstallDate: "02/02/2026", fixtureJobValue: "25000" };
const PHONE = /5035550100|\(503\) 555-0100/;
const recipe = (mode: string, steps: RecipeStep[]): PortalRecipe => ({
  id: "volatile-id-redirect", scopeType: "utility", profileKey: "or||fixture", state: "OR", ahj: "", utility: "Fixture Utility",
  portalPlatform: "fixture", portalUrl: `${base}/${mode}`, status: "complete", version: 1, createdBy: "s", createdAt: "", updatedAt: "", notes: "",
  steps: [{ action: "goto", value: `${base}/${mode}`, note: "open" } as RecipeStep, ...steps, { action: "stopForReview" } as RecipeStep],
} as unknown as PortalRecipe);
// A one-step recipe: fill `field` through `selector`, recorded with `fingerprint`.
const one = (selector: Record<string, unknown>, note: string, field: string, fingerprint: Record<string, string>): RecipeStep[] =>
  [{ action: "fill", phase: "fill", selector, note, field, fingerprint } as unknown as RecipeStep];

type Box = { id: string; section: string; key: string; v: string };
const browser = await chromium.launch();
try {
  const run = async (mode: string, steps: RecipeStep[] = STEPS) => {
    const ctx = await browser.newContext();
    await ctx.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    const pg = await ctx.newPage();
    const adapter = new RecipeAdapter(recipe(mode, steps), VALUES, {}, {} as never);
    (adapter as unknown as { page: unknown }).page = pg;
    const r = await adapter.fillApplication({} as ProjectRecord).catch((e) => ({ ok: false, message: String(e), data: {} }));
    const boxes = await pg.evaluate(() => Array.from(document.querySelectorAll("input, select")).map((el) => ({
      id: el.id,
      section: (el.closest("fieldset")?.querySelector("legend")?.textContent || el.closest(".section")?.querySelector("h2")?.textContent || "").trim(),
      key: (document.querySelector(`label[for="${el.id}"]`)?.textContent || "").trim() || el.getAttribute("aria-label")
        || (document.getElementById(el.getAttribute("aria-labelledby") || "-")?.textContent || "").trim() || el.getAttribute("placeholder") || el.id,
      v: (el as HTMLInputElement).value,
    }))) as Box[];
    const a = adapter as unknown as { driftWarnings: string[]; agingNotes: string[]; fieldsVerified: string[] };
    await ctx.close();
    const box = (section: string, key: string) => boxes.find((b) => b.section === section && b.key === key)?.v ?? "<absent>";
    const byId = (id: string) => boxes.find((b) => b.id === id)?.v ?? "<absent>";
    return { r, box, byId, boxes, warnings: a.driftWarnings.join(" | "), notes: a.agingNotes.join(" | "), verified: a.fieldsVerified ?? [] };
  };
  const filled = (b: Box[]) => b.filter((x) => x.v && !/^(New Contact|)$/.test(x.v)).map((x) => `${(x.section || "-").slice(0, 5)}:${x.key}=${x.v}`).join(", ");
  const show = (tag: string, o: Awaited<ReturnType<typeof run>>): void => {
    console.log(`  [${tag}] boxes: ${filled(o.boxes)} | verified: ${o.verified.join(", ")}\n           drift: ${o.warnings || "(none)"}\n           aging: ${o.notes.slice(0, 400) || "(none)"}`);
  };
  const reached = (o: Awaited<ReturnType<typeof run>>) => (o.r as { ok?: boolean }).ok === true;
  const why = (o: Awaited<ReturnType<typeof run>>) => `${(o.r as { message?: string }).message?.slice(0, 300)}`;

  // ---- The defect: PGE's applicant block with the render counter moved. ----
  // +1 is Ameren's shape: its learns differ by one when the "Existing contact" select renders, and
  // then the recorded #pcInputBase11 names that select. Shift 0 and the heading-sectioned -1 are
  // controls main already gets right (MUST-KEEP).
  for (const mode of ["0", "-1", "1", "restart", "ph-1", "h-1"]) {
    const o = await run(mode);
    const where = mode === "ph-1" ? "shift -1, Company by placeholder" : mode === "h-1" ? "shift -1, heading-sectioned" : `shift ${mode}`;
    const must = mode === "0" || mode === "h-1" ? "MUST-KEEP" : "MUST-PASS";
    show(where, o);
    check(`${must} ${where}: the run reaches review`, reached(o), why(o));
    check(`${must} ${where}: the surname is in the applicant's Last`, o.box(SECTION, "Last") === VALUES.homeownerLastName, filled(o.boxes));
    check(`${must} ${where}: the applicant's Company is untouched`, o.box(SECTION, "Company") === "", filled(o.boxes));
    check(`${must} ${where}: City/State/Zip/Email/Phone are the applicant's`,
      o.box(SECTION, "City") === VALUES.city && o.box(SECTION, "State") === VALUES.state && o.box(SECTION, "Zip Code") === VALUES.zip
        && o.box(SECTION, "Email") === VALUES.homeownerEmail && PHONE.test(o.box(SECTION, "Phone")), filled(o.boxes));
    check(`${must} ${where}: the co-applicant's block is untouched (the surname is never verified there)`,
      o.boxes.filter((b) => b.section === CO).every((b) => !b.v || b.v === "New Contact"), filled(o.boxes));
    check(`${must} ${where}: nothing was written into a fingerprinted neighbour`, !/recorded control #pcInputBase/.test(o.warnings), o.warnings.slice(0, 300));
    // A moved counter is a fact about the recipe, not a defect in today's filing.
    check(`${must} ${where}: the replay is clean (no driftWarnings)`, o.warnings === "", o.warnings.slice(0, 300));
  }

  // MUST-PASS lb-1: the same defect on a block named through aria-labelledby, shift -1. The label
  // locator and the binding pick the applicant's Last; #pcInputBase11 names the applicant's Company,
  // which the re-anchor's reader sees as nameless, so only the counter classifier refuses it. Main
  // wrote the surname into Company, then City into State (a select) and threw. Last and City only:
  // the page-drift precheck reads labels with the learner's scan, which does not read
  // aria-labelledby, so a segment of three or more such labels stops before any step.
  {
    const lbSteps = STEPS.slice(0, 2).map((s) => {
      const sel = s.selector as { placeholder?: string; label?: string; fallbacks?: unknown[] };
      const fpr = (s as { fingerprint: { id: string; section: string } }).fingerprint;
      return { ...s, selector: { label: sel.label || sel.placeholder, fallbacks: sel.fallbacks }, fingerprint: { id: fpr.id, section: fpr.section } };
    }) as unknown as RecipeStep[];
    const o = await run("lb-1", lbSteps);
    show("lb-1", o);
    check("MUST-PASS lb-1: the run reaches review", reached(o), why(o));
    check("MUST-PASS lb-1: the surname and city are in the applicant's own boxes, Company and State untouched",
      o.box(SECTION, "Last") === VALUES.homeownerLastName && o.box(SECTION, "City") === VALUES.city
        && o.box(SECTION, "Company") === "" && o.box(SECTION, "State") === "", filled(o.boxes));
    check("MUST-PASS lb-1: nothing was written into a fingerprinted neighbour, the co-applicant untouched, no driftWarnings",
      o.warnings === "" && o.boxes.filter((b) => b.section === CO).every((b) => !b.v || b.v === "New Contact"), `${filled(o.boxes)} drift: ${o.warnings.slice(0, 300)}`);
  }

  // ---- MUST-KEEP: MF5 and its variants still redirect, exactly as on main. ----
  // Each: the label resolves onto the applicant's box (prefilled with the installer's address); the
  // recorded control is the owner's. Main writes the owner's box and says so ("written there").
  const mf5Cases: Array<{ mode: string; owner: string; app: string; section: string; why: string }> = [
    { mode: "mf5", owner: "OwnerEdit_txtEmail", app: "ApplicantEdit_txtEmail", section: "Property Owner", why: "'E-mail:' vs 'Email Address:' (label agrees)" },
    { mode: "mf5-counter", owner: "pcInputBase31", app: "pcInputBase12", section: "Property Owner", why: "owner relabelled 'Contact Address', counter ids (section agrees)" },
    { mode: "mf5-stable", owner: "OwnerEdit_txtEmail", app: "ApplicantEdit_txtEmail", section: "Property Owner", why: "owner relabelled 'Contact Address', stable ids (section agrees)" },
    { mode: "mf5-counter-nameless", owner: "pcInputBase31", app: "pcInputBase12", section: "Property Owner", why: "owner box with no label, counter ids (section agrees)" },
    { mode: "mf5-legend-renamed", owner: "OwnerEdit_txtEmail", app: "ApplicantEdit_txtEmail", section: "Property Owner", why: "owner legend renamed, stable ids (label agrees)" },
    { mode: "counter-legend-renamed", owner: "pcInputBase31", app: "pcInputBase12", section: "Property Owner", why: "owner legend renamed, counter ids (label agrees)" },
    { mode: "long-legend", owner: "OwnerEdit_txtEmail", app: "ApplicantEdit_txtEmail", section: LONG_RECORDED, why: "owner legend over 80 characters" },
    { mode: "mf5-subheading", owner: "OwnerEdit_txtEmail", app: "ApplicantEdit_txtEmail", section: "Property Owner", why: "panel headings, owner under a sub-heading (label agrees)" },
    { mode: "mf5-dynamic-title", owner: "OwnerEdit_txtEmail", app: "ApplicantEdit_txtEmail", section: "Application ZZ00-00685 - Contacts", why: "title-only page whose record number changed (label agrees)" },
    { mode: "same-legend-stable", owner: "OwnerEdit_txtEmail", app: "Owner_txtAltEmail", section: "Property Owner", why: "review of the minimal round: one legend, stable ids, owner relabelled 'Contact Address'" },
  ];
  for (const c of mf5Cases) {
    const o = await run(c.mode, one({ label: "E-mail:" }, "E-mail:", "homeownerEmail", { id: c.owner, section: c.section }));
    show(c.mode, o);
    check(`MUST-KEEP ${c.mode} (${c.why}): the owner's box takes the write, the installer's address is kept`,
      o.byId(c.owner) === VALUES.homeownerEmail && o.byId(c.app) === "installer@example.test", filled(o.boxes));
    check(`MUST-KEEP ${c.mode}: reported as main reports it ("written there")`,
      new RegExp(`recorded control #${c.owner}[^|]*written there`).test(o.warnings), `drift: ${o.warnings.slice(0, 300)}`);
  }
  // MF5 with the owner's boxes named only by a placeholder mask and a title tooltip.
  {
    const o = await run("hints", [
      ...one({ label: "Installation Date" }, "Installation Date", "fixtureInstallDate", { id: "O_txtInstallDate", placeholder: "MM/DD/YYYY", section: "Property Owner" }),
      ...one({ label: "Job Value" }, "Job Value", "fixtureJobValue", { id: "O_txtValuation", section: "Property Owner" }),
    ]);
    show("hints", o);
    check("MUST-KEEP hints: a placeholder mask and a title tooltip do not veto the MF5 redirect",
      o.byId("O_txtInstallDate") === VALUES.fixtureInstallDate && o.byId("A_txtInstallDate") === "01/01/2026"
        && o.byId("O_txtValuation") === VALUES.fixtureJobValue && o.byId("A_txtValuation") === "11111", filled(o.boxes));
  }

  // ---- MUST-KEEP: shapes main gets right with no redirect. ----
  // One page heading over a labelled box and a nameless one: the heading is not a fieldset legend,
  // so nothing redirects; the labelled box takes the write, silently, as on main.
  {
    const o = await run("h1-only", one({ label: "E-mail:" }, "E-mail:", "homeownerEmail", { id: "O_txtEmail", section: "Contact Information" }));
    show("h1-only", o);
    check("MUST-KEEP h1-only: the labelled box takes the write, the nameless one stays empty, no driftWarning",
      o.byId("A_txtEmail") === VALUES.homeownerEmail && o.byId("O_txtEmail") === "" && o.warnings === "", `${filled(o.boxes)} drift: ${o.warnings.slice(0, 300)}`);
  }
  // No legend, no heading: main's write and main's (silent) report.
  {
    const o = await run("unsectioned", one({ label: "E-mail:" }, "E-mail:", "homeownerEmail", { id: "O_txtEmail", section: "Property Owner" }));
    show("unsectioned", o);
    check("MUST-KEEP unsectioned: no section on either box, so the write and the report are main's (no move, no new warning)",
      o.byId("A_txtEmail") === VALUES.homeownerEmail && o.byId("O_txtEmail") === "" && o.warnings === "", `${filled(o.boxes)} drift: ${o.warnings.slice(0, 300)}`);
  }
  // Two "Phone" boxes in one fieldset; the recorded one also carries a different aria-label. The
  // recorded (unshifted) counter picks it, as on main.
  {
    const o = await run("dup-aria-vs-label", one({ label: "Phone", fallbacks: [{ css: "#pcInputBase10" }] }, "Phone", "homeownerPhone", { id: "pcInputBase10", section: "Applicant" }));
    show("dup-aria-vs-label", o);
    check("MUST-KEEP dup-aria-vs-label: the recorded box (label 'Phone', aria-label 'Alternate phone') takes the write, no driftWarning",
      PHONE.test(o.byId("pcInputBase10")) && o.byId("pcInputBase9") === "" && o.warnings === "", `${filled(o.boxes)} drift: ${o.warnings.slice(0, 300)}`);
  }
  // Two "Phone" boxes under one heading, the recorded one under a sub-heading: its counter picks it.
  {
    const o = await run("dup-subheading", one({ label: "Phone", fallbacks: [{ css: "#pcInputBase21" }] }, "Phone", "homeownerPhone", { id: "pcInputBase21", section: "Property Owner" }));
    show("dup-subheading", o);
    check("MUST-KEEP dup-subheading: the recorded counter still picks the sub-headed 'Phone', no driftWarning",
      PHONE.test(o.byId("pcInputBase21")) && o.byId("pcInputBase20") === "" && o.warnings === "", `${filled(o.boxes)} drift: ${o.warnings.slice(0, 300)}`);
  }
  // Two equally named "Phone" boxes (one through aria-labelledby), no section, counter unshifted.
  {
    const o = await run("lb-phone", one({ label: "Phone", fallbacks: [{ css: "#pcInputBase9" }] }, "Phone", "homeownerPhone", { id: "pcInputBase9" }));
    show("lb-phone", o);
    check("MUST-KEEP lb-phone: the recorded counter still picks between two equally named boxes",
      PHONE.test(o.byId("pcInputBase9")) && o.byId("pcInputBase30") === "", filled(o.boxes));
  }
  // A stable recorded id in its own section whose box is nameless: it still re-anchors (MF5's
  // co-applicant twin: the selector's ordinal resolves onto the applicant's First).
  {
    const o = await run("0", one({ placeholder: "First", nth: 0 }, "First", "homeownerFirstName", { id: "R4TN8WE3Z1BBFirst", placeholder: "First", section: CO }));
    show("stable-kept", o);
    check("MUST-KEEP stable-kept: a stable fingerprinted id in its recorded section still takes the write, reported as main reports it",
      o.box(CO, "First") === VALUES.homeownerFirstName && o.box(SECTION, "First") === "" && /recorded control #R4TN8WE3Z1BBFirst[^|]*written there/.test(o.warnings),
      `${filled(o.boxes)} drift: ${o.warnings.slice(0, 300)}`);
  }
  // A counter that agrees with the recording on its OWN label AND the section still re-anchors: two
  // "Phone" boxes in one fieldset, the step's selector naming the first, its unshifted counter the
  // second. Nothing tells the two apart but the counter, so main's tie-break stands.
  {
    const o = await run("counter-tie", one({ css: "#pcInputBase17" }, "Phone", "homeownerPhone", { id: "pcInputBase18", section: SECTION }));
    show("counter-tie", o);
    check("MUST-KEEP counter-tie: a counter that agrees on its own label and the section still takes the write, reported as main reports it",
      PHONE.test(o.byId("pcInputBase18")) && o.byId("pcInputBase17") === "" && /recorded control #pcInputBase18[^|]*written there/.test(o.warnings),
      `${filled(o.boxes)} drift: ${o.warnings.slice(0, 300)}`);
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
}
if (failures) { console.error(`\n${failures} volatile-id redirect check(s) FAILED.`); process.exit(1); }
console.log("\nAll volatile-id redirect checks passed (real Chromium).");
process.exit(0);
