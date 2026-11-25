// THE APPROVAL SHEET'S AC CROSS-CHECK READS THE INVERTER'S RATED AC OUTPUT (review-audit draft 11).
//
// The sheet read invOutputW / pvMicroOutputW as kW (≤ 30) or W, but the parser writes the per-unit
// output CURRENT in amps there: a 1.6 A micro read as 1.6 kW and a 32 A string inverter as 0.03 kW,
// so the "AC mismatch" note was wrong on most jobs, both ways. It now reads them through the gate's
// own reader (sizesAgree.inverterAcFromPlan, the one city.elec.ac-size-mismatch uses). Pinned here
// (invented jobs, the stage fixture's scratch DB):
//   (M) 20 × 1.6 A micros at 240 V = 7.68 kW against an 8 kW AC size: no mismatch (it reported one).
//   (S) one 32 A string inverter at 240 V = 7.68 kW against 7.6 kW AC: no mismatch.
//   (X) a real disagreement is still named, with its arithmetic, on the sheet AND by the gate.
//   (V) a 208 V service is read as 208 V; with no voltage on the plan the row says "assumed".
//   (K) a battery job and a three-phase service claim no cross-check.
//   (W) still a read: total_changes() unchanged.
//
// KILL TEST: restore the old "≤ 30 is kW" reading → (M) and (S) fail.
//
// Run: npx tsx backend/test/approvalSheetAcSize.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("approval-sheet-ac-size");
const { db, repo } = fx;
const { buildApprovalSheet } = await import("../src/approvalSheet");
const { inverterAcFromPlan } = await import("../src/sizesAgree");

const project = (id: string) => repo.getProjectDetail(db, id).project;
const acRow = (id: string) => {
  const r = buildApprovalSheet(db, project(id), "nem").rows.find((x) => x.key === "acKw");
  assert.ok(r, "no acKw row");
  return r!;
};
const changes = () => db.get<{ n: number }>("SELECT total_changes() AS n")!.n;

const MICRO = { invModel: "", invQty: "", invOutputW: "", pvMicroModel: "Invented Micro 300", pvMicroQty: "20", pvMicroOutputW: "1.6" };
const STRING = { invModel: "Invented String 7.6", invQty: "1", invOutputW: "32" };

await check("(M) 20 × 1.6 A micros at 240 V (7.68 kW) against an 8 kW AC size: no mismatch", () => {
  const id = fx.newProject({ ...MICRO, acKw: "8", serviceVoltage: "120/240V" } as never);
  const before = changes();
  const r = acRow(id);
  assert.equal(changes(), before, "(W) the sheet wrote a row");
  assert.equal(r.check, "match", JSON.stringify(r));
  assert.match(r.checkNote ?? "", /about 7\.68 kW AC \(20 × 1\.6 A × 240 V\)/, r.checkNote);
});

await check("(S) one 32 A string inverter at 240 V (7.68 kW) against 7.6 kW AC: no mismatch", () => {
  const id = fx.newProject({ ...STRING, acKw: "7.6", serviceVoltage: "240" } as never);
  const r = acRow(id);
  assert.equal(r.check, "match", JSON.stringify(r));
  assert.match(r.checkNote ?? "", /1 × 32 A × 240 V/);
});

await check("(X) a real disagreement is named with its arithmetic", () => {
  const id = fx.newProject({ ...MICRO, acKw: "10", serviceVoltage: "240" } as never);
  const r = acRow(id);
  assert.equal(r.check, "mismatch", JSON.stringify(r));
  assert.match(r.checkNote ?? "", /add up to about 7\.68 kW AC \(20 × 1\.6 A × 240 V\), not 10 kW/, r.checkNote);
});

await check("(V) a 208 V service is 208 V; with no voltage on the plan the arithmetic says 'assumed'", () => {
  const read = (fields: Record<string, string>) => inverterAcFromPlan(
    { num: (k) => (fields[k] ? Number(fields[k]) : null), text: (k) => fields[k] ?? "" },
    { battery: false, existingSystem: false },
  );
  const at208 = read({ pvMicroOutputW: "1.6", pvMicroQty: "20", serviceVoltage: "120/208V" })!;
  assert.equal(Math.round(at208.kw * 1000), 6656);
  assert.equal(at208.voltageAssumed, false);
  const assumed = read({ pvMicroOutputW: "1.6", pvMicroQty: "20" })!;
  assert.equal(assumed.voltageAssumed, true);
  assert.match(assumed.how, /20 x 1\.6 A x 240 V \(assumed\)/);
  const watts = read({ invOutputW: "7600", invQty: "1" })!;
  assert.equal(watts.unit, "W");
  assert.equal(watts.kw, 7.6);
  const id = fx.newProject({ ...MICRO, acKw: "8", serviceVoltage: "" } as never);
  assert.match(acRow(id).checkNote ?? "", /240 V \(assumed\)/);
});

await check("(K) a battery job and a three-phase service claim no cross-check", () => {
  const read = (fields: Record<string, string>, battery = false) => inverterAcFromPlan(
    { num: (k) => (fields[k] ? Number(fields[k]) : null), text: (k) => fields[k] ?? "" },
    { battery, existingSystem: false },
  );
  assert.equal(read({ invOutputW: "32", invQty: "1" }, true), null);
  assert.equal(read({ invOutputW: "32", invQty: "1", serviceVoltage: "277/480V" }), null);
  assert.equal(read({ invOutputW: "32", invQty: "1", servicePhase: "3 phase" }), null);
  const id = fx.newProject({ ...STRING, acKw: "12", serviceVoltage: "120/208V 3 phase" } as never);
  const r = acRow(id);
  assert.notEqual(r.check, "mismatch", JSON.stringify(r));
  assert.notEqual(r.check, "match", JSON.stringify(r));
});

await check("(G) the gate's rule and the sheet agree on the same plan set (one reader)", () => {
  const agree = fx.newProject({ ...MICRO, acKw: "8", serviceVoltage: "240" } as never);
  const disagree = fx.newProject({ ...MICRO, acKw: "10", serviceVoltage: "240" } as never);
  const gateSays = (id: string) => repo.buildReviewerReportFor(db, project(id)).findings.some((f) => f.id === "city.elec.ac-size-mismatch");
  assert.equal(gateSays(agree), false, "the gate flags a size the sheet matches");
  assert.equal(gateSays(disagree), true, "the gate misses the size the sheet flags");
});

finish("approvalSheetAcSize");
