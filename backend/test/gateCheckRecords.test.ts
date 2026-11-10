// THE GATE SAYS WHAT IT CHECKED, AND WHICH TIER ITS RULE CAME FROM (review-audit draft 07).
//
// A measured rule reported only a violation, so "the 120 % screen ran: 40 A + 200 A = 240 A <= 240 A"
// and "the screen was skipped: no bus rating" read the same — nothing. And the tier of the value a
// rule compared against (seeded, official #683, person-verified) was printed only in some messages.
// Pinned here (invented jobs, the stage fixture's scratch DB):
//   (P) a measured rule that ran and passed leaves a PASS record with its arithmetic;
//   (N) one that could not run leaves a "Not checked: <input> is not on the plans." callout;
//   (V) a violation is still the violation, and no pass is claimed beside it;
//   (S) records are display only: never a warning or blocker, never in the correction notice, never
//       an item to acknowledge on the approval sheet; the gate's blockers and warnings are unchanged;
//   (B) a finding measured against jurisdiction data carries ruleBasis, worded per #683: official is
//       "from <host>" and never "verified"; seeded says "not verified"; a person's verification names them;
//   (A) the approval sheet lists the records of THIS filing, and writes nothing;
//   (D) the dashboard groups them by category, collapsed, escaped.
//
// KILL TESTS: drop the busbar passRecord → (P) fails; let the correction notice keep check records →
// (S) fails; word an official basis "verified" → (B) fails.
//
// Run: npx tsx backend/test/gateCheckRecords.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("gate-check-records");
const { db, repo } = fx;
const { buildApprovalSheet } = await import("../src/approvalSheet");
const { readCorrectionNotice } = await import("../src/correctionNotice");
const { ruleBasisLabel, makeRuleBasis, weakestRuleBasis } = await import("../../shared/src/ruleBasis");
const { fieldRuleBasis } = await import("../src/designCriteria");
const { isCheckRecord } = await import("../src/checkRecords");

const project = (id: string) => repo.getProjectDetail(db, id).project;
const report = (id: string) => repo.buildReviewerReportFor(db, project(id));
const byId = (id: string, fid: string) => report(id).findings.find((f) => f.id === fid);
const changes = () => db.get<{ n: number }>("SELECT total_changes() AS n")!.n;

// The fixture: 200 A bus, 200 A main, 40 A PV breaker on a load-side breaker → 240 A <= 240 A.
const clean = fx.newProject();
// No bus rating anywhere: not on the parsed fields, not in the calc text.
const noBus = fx.newProject({ busRating: "", electricalCalcText: "NEC 690.12 rapid shutdown shown." });
// 200 + 60 = 260 A > 240 A: the violation.
const over = fx.newProject({ pvBreaker: "60" });

await check("(P) the busbar screen that ran and passed leaves a pass record with its arithmetic", () => {
  const rec = byId(clean, "city.elec.sizing-busbar-120.pass");
  assert.ok(rec, JSON.stringify(report(clean).findings.map((f) => f.id)));
  assert.equal(rec!.severity, "pass");
  assert.equal(rec!.checkOutcome, "passed");
  assert.match(rec!.message, /240 A, within 120 % of the 200 A/);
  assert.equal(rec!.ruleBasis?.tier, "model_code");
  assert.match(rec!.ruleBasis!.label, /^model code \(NEC/);
  assert.equal(byId(clean, "city.elec.sizing-busbar-120"), undefined, "a passing screen raised the violation");
  // The DC cross-check: 20 x 430 W = 8.60 kW against 8.6 kW.
  assert.match(byId(clean, "city.elec.dc-size-mismatch.pass")?.message ?? "", /20 x 430 W = 8\.60 kW DC/);
});

await check("(N) a screen that could not run says which input is not on the plans", () => {
  const rec = byId(noBus, "city.elec.sizing-busbar-120.not-checked");
  assert.ok(rec, JSON.stringify(report(noBus).findings.map((f) => f.id)));
  assert.equal(rec!.severity, "callout");
  assert.equal(rec!.checkOutcome, "not_checked");
  assert.match(rec!.message, /^Not checked: the busbar rating is not on the plans\.$/);
  assert.equal(byId(noBus, "city.elec.sizing-busbar-120.pass"), undefined);
});

await check("(V) a violation is still raised, and no pass is claimed beside it", () => {
  const v = byId(over, "city.elec.sizing-busbar-120");
  assert.ok(v && (v.severity === "warning" || v.severity === "blocker"), JSON.stringify(v));
  assert.equal(v!.checkOutcome, undefined);
  assert.equal(byId(over, "city.elec.sizing-busbar-120.pass"), undefined);
});

await check("(S) check records are display only: no warning or blocker, not in the correction notice, nothing to acknowledge", () => {
  for (const id of [clean, noBus, over]) {
    const r = report(id);
    const records = r.findings.filter(isCheckRecord);
    assert.ok(records.length > 0, "no check records at all");
    for (const f of records) {
      assert.ok(f.severity === "pass" || f.severity === "callout", `${f.id} is a ${f.severity}`);
      assert.equal(f.installerCallout, false, `${f.id} is an installer callout`);
      assert.ok(/\.(pass|not-checked)$/.test(f.id), f.id);
    }
    const notice = readCorrectionNotice(db, id);
    assert.ok(!notice.items.some((i) => /\.(pass|not-checked)$/.test(i.findingId)), `a check record is in the correction notice: ${notice.items.map((i) => i.findingId)}`);
    for (const track of ["nem", "building", "electrical"] as const) {
      const acks = repo.requiredAcknowledgementItems(db, project(id), track).map((i) => i.id);
      assert.ok(!acks.some((a) => /\.(pass|not-checked)$/.test(a)), `a check record needs a tick: ${acks}`);
    }
  }
  // The gate's own counts read blockers and warnings only: the busbar violation job holds exactly
  // the warnings it held, with or without records beside it.
  const r = report(over);
  const corrections = r.findings.filter((f) => f.severity === "blocker" || f.severity === "warning");
  assert.ok(corrections.every((f) => !isCheckRecord(f)));
});

await check("(B) the rule basis in #683's words: official is 'from <host>' and never verified; seeded and verified say so", () => {
  const official = makeRuleBasis("official", "Utah state-level code profile", "https://le.utah.gov/xcode/Title15A/15A-3.html");
  assert.equal(official.label, "from le.utah.gov");
  assert.ok(!/verified/i.test(official.label), "MUST-EXCLUDE: an official value worded as verified");
  assert.equal(ruleBasisLabel({ tier: "seeded", source: "x", sourceUrl: "" }), "seeded, not verified");
  assert.equal(ruleBasisLabel({ tier: "verified", source: "x", sourceUrl: "", verifiedBy: "Pat Reviewer" }), "person-verified by Pat Reviewer");
  assert.equal(ruleBasisLabel({ tier: "verified", source: "x", sourceUrl: "", verifiedBy: "pat@example.test" }), "person-verified", "an email address printed as a name");
  assert.equal(weakestRuleBasis([official, makeRuleBasis("verified", "y", "", "Pat")])!.tier, "official");
  // A layered profile field read on the authority's own page.
  const ctx = {
    state: "UT", verified: false, designCriteria: {},
    profile: { ahj: "", state: "UT", citations: [], fieldSources: { "designCriteria.groundSnowLoadPsf": { ahj: "", state: "UT", confidence: "official", officialSource: { host: "le.utah.gov", sourceUrl: "https://le.utah.gov/x", fetchedAt: "2026-11-01T00:00:00Z" } } } },
  };
  const b = fieldRuleBasis(ctx as never, "designCriteria.groundSnowLoadPsf");
  assert.equal(b.tier, "official");
  assert.equal(b.label, "from le.utah.gov");
  // The fixture's real measured warning (25 psf < Oregon's 36 psf) carries its basis.
  const snow = byId(clean, "city.struct.ground-snow-below-state-minimum");
  assert.ok(snow?.ruleBasis, JSON.stringify(snow));
  assert.ok(["seeded", "official", "verified"].includes(snow!.ruleBasis!.tier));
  assert.match(snow!.ruleBasis!.source, /code profile/);
});

await check("(A) the approval sheet lists this filing's check records (electrical on the NEM sheet), and writes nothing", () => {
  const before = changes();
  const sheet = buildApprovalSheet(db, project(clean), "nem");
  assert.equal(changes(), before, "(W) the sheet wrote a row");
  const busbar = sheet.checks.find((c) => c.id === "city.elec.sizing-busbar-120.pass");
  assert.ok(busbar, JSON.stringify(sheet.checks.map((c) => c.id)));
  assert.equal(busbar!.outcome, "passed");
  assert.match(busbar!.basis, /^model code/);
  assert.ok(!sheet.checks.some((c) => c.category === "structural"), "a structural check on the NEM sheet");
  assert.ok(!sheet.openItems.some((i) => /\.(pass|not-checked)$/.test(i.id)), "a check record is an open item");
});

await check("(D) the dashboard groups check records by category, collapsed, and escapes them", () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const dashboard = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
  const lift = (name: string): string => {
    const m = new RegExp(`^function ${name}\\(|^const ${name} = `, "m").exec(dashboard);
    if (!m) throw new Error(`dashboard.js: could not find ${name}`);
    let i = m[0].startsWith("const") ? m.index + m[0].length : dashboard.indexOf("{", dashboard.indexOf(")", m.index));
    let depth = 0;
    for (; i < dashboard.length; i++) {
      const ch = dashboard[i];
      if (ch === "{" || ch === "[" || ch === "(") depth++;
      else if (ch === "}" || ch === "]" || ch === ")") { depth--; if (depth === 0) { i++; break; } }
    }
    return dashboard.slice(m.index, i) + (m[0].startsWith("const") ? ";" : "");
  };
  const render = new Function(`${["esc", "humanize", "CHECK_CATEGORY_LABEL", "checkRecordsHtml"].map(lift).join("\n\n")}\nreturn checkRecordsHtml;`)() as (l: unknown[], o?: unknown) => string;
  const html = render([
    { id: "a.pass", outcome: "passed", category: "electrical", title: "Busbar", text: "40 A + 200 A = 240 A <= 240 A", basis: "model code (NEC 2023 705.12(B)(3)(2))" },
    { id: "b.not-checked", outcome: "not_checked", category: "structural", title: "Snow <img src=x onerror=alert(1)>", text: "Not checked: the design ground snow load (Pg) is not on the plans.", basis: "from le.utah.gov" },
  ], { heading: "Measured checks" });
  assert.match(html, /<details data-check-group="Electrical"[^>]*><summary>Electrical: 1 passed<\/summary>/);
  assert.match(html, /Structural: 0 passed, 1 not checked/);
  assert.ok(!/<details[^>]*\bopen\b/.test(html), "a group is open by default");
  assert.ok(!html.includes("<img src=x"), "MUST-EXCLUDE: an unescaped title");
  assert.match(html, /Rule basis: from le\.utah\.gov/);
});

finish("gateCheckRecords");
