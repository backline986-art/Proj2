// APPROVE & AUTO-SUBMIT NEVER FILES A MEASURED VIOLATION NOBODY ACKNOWLEDGED (review-audit draft 01).
//
// A job whose own one-line breaks the 705.12 busbar allowance (200 A bus, 200 A main, 60 A PV breaker =
// 260 A > 240 A) reads city.elec.sizing-busbar-120 as a WARNING when only the parser read the numbers,
// and only reviewer BLOCKERS held Stage or Approve: the approval sheet showed no warning, and an
// approved run filed it. Pinned here (invented jobs, the stage fixture's scratch DB, no portal):
//   (S) THE SHEET lists this filing's open items, scoped by the one predicate: the busbar warning on
//       the electrical and utility sheets (an electrical finding holds the NEM filing too), never on
//       the building sheet; the fixture's 25 psf ground-snow warning (structural) on the building
//       sheet, never on the NEM sheet. Measured items carry needsAcknowledgement and come first; the
//       sheet carries the shipped plan set's id + sha256. Rule 2: no secret in any item.
//   (A) THE APPROVE ROUTE'S CHECK (approvalAcknowledgementRefusals): no ticks → refused, naming the
//       item; the ticks the sheet offers → clean; a stale hash → "changed since"; a tick for another
//       plan set → refused.
//   (R) THE RUN: an approval with no acknowledgement of the busbar warning → the run stops at review
//       with that reason (never a click); with the ticks → allowed; ticks given, then the plan set
//       replaced → stops at review.
//   (E) THE EMAIL DOOR reads the same reason (portalSafety.finalSubmitRefusals, channel email).
//   (D) THE DASHBOARD: each item to acknowledge is a tick box carrying its id + hash, escaped.
//
// KILL TESTS: drop the unacknowledgedSinceApproval push in automaticSubmitRefusals → (R1) fails; drop
// the scope filter in reviewerItems → (S2) fails; skip the plan-set comparison → (A4)(R3) fail.
//
// Run: npx tsx backend/test/approvalAcknowledgements.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./_isolate";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("approval-acknowledgements");
const { db, repo } = fx;
// The fixture AHJ's filing door, verified by a named person: the gate refuses a run on an unverified door
// (automaticSubmitRefusals filingDoor; filingDoorGate.test pins that), and these runs are about other checks.
fx.verifyDoor();
const { buildApprovalSheet } = await import("../src/approvalSheet");
const { planSetBinding, acknowledgementProblems } = await import("../src/approvalReviewItems");
const docs = await import("../src/projectDocuments");
const { finalSubmitRefusals } = await import("../../shared/src/portalSafety");

const BUSBAR = "city.elec.sizing-busbar-120";
const SNOW = "city.struct.ground-snow-below-state-minimum";
const busbarJob = () => fx.newProject({ pvBreaker: "60" } as never);
const projectOf = (id: string) => repo.getProjectDetail(db, id).project;
const sheet = (id: string, track: "nem" | "building" | "electrical") => buildApprovalSheet(db, projectOf(id), track);
const ids = (s: ReturnType<typeof sheet>, onlyAck = false) => s.openItems.filter((i) => !onlyAck || i.needsAcknowledgement).map((i) => i.id);

await check("(S0) premise: the busbar job's gate reads the 705.12 violation as a measured WARNING (no blocker holds it)", () => {
  const f = repo.reviewerGateReportFor(db, projectOf(busbarJob())).findings.find((x) => x.id === BUSBAR);
  assert.ok(f, "the fixture job with a 60 A PV breaker produced no busbar finding");
  assert.equal(f!.severity, "warning");
});

await check("(S1) the electrical and the utility sheets list the busbar warning to acknowledge, first, with its AHJ sentence", () => {
  const id = busbarJob();
  for (const track of ["electrical", "nem"] as const) {
    const s = sheet(id, track);
    const item = s.openItems.find((i) => i.id === BUSBAR);
    assert.ok(item, `${track}: no busbar item in ${JSON.stringify(ids(s))}`);
    assert.equal(item!.needsAcknowledgement, true);
    assert.equal(item!.measured, true);
    assert.ok(item!.text.length > 20, "the AHJ-facing sentence is missing");
    assert.ok(item!.contentHash.length === 64);
    const firstOther = s.openItems.findIndex((i) => !i.needsAcknowledgement);
    assert.ok(firstOther === -1 || s.openItems.findIndex((i) => i.id === BUSBAR) < firstOther, "the item to acknowledge is not listed first");
  }
});

await check("(S2) scope: the building sheet never asks for the busbar tick; the NEM sheet never shows the structural snow warning", () => {
  const id = busbarJob();
  assert.ok(!ids(sheet(id, "building")).includes(BUSBAR), "the building permit was asked to acknowledge an electrical finding");
  assert.ok(ids(sheet(id, "building"), true).includes(SNOW), "the building sheet does not ask for the ground-snow tick");
  assert.ok(!ids(sheet(id, "nem")).includes(SNOW), "MUST-EXCLUDE: a permit-track warning on the NEM sheet");
});

await check("(S3) the sheet carries the shipped plan set's id + sha256, and lists the gate's other warnings (no tick)", () => {
  const id = busbarJob();
  const s = sheet(id, "building");
  assert.deepEqual(s.planSet, planSetBinding(db, id));
  assert.ok(s.planSet && s.planSet.documentId && /^[0-9a-f]{64}$/.test(s.planSet.sha256));
  assert.ok(s.openItems.some((i) => i.kind === "gate_warning" && !i.needsAcknowledgement), JSON.stringify(s.openItems.map((i) => i.key)));
  assert.ok(s.openItems.some((i) => i.kind === "reviewer_warning" && !i.needsAcknowledgement), "the unmeasured reviewer warnings are not listed");
  const text = JSON.stringify(s.openItems);
  for (const secret of ["1234567890", "987654321"]) assert.ok(!text.includes(secret), `an item carried ${secret}`);
});

await check("(A) the approve route's check: no ticks refused; the sheet's ticks clean; a stale hash or another plan set refused", () => {
  const id = busbarJob();
  const p = projectOf(id);
  const none = repo.approvalAcknowledgementRefusals(db, p, "electrical", undefined);
  assert.ok(none.problems.some((x) => /not acknowledged: .*busbar|not acknowledged: .*120/i.test(x)), JSON.stringify(none.problems));
  const s = sheet(id, "electrical");
  const ticks = { planSet: s.planSet, items: s.openItems.filter((i) => i.needsAcknowledgement).map((i) => ({ id: i.id, contentHash: i.contentHash })) };
  const ok = repo.approvalAcknowledgementRefusals(db, p, "electrical", ticks);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.acknowledgements?.items, ticks.items, "the recorded acknowledgements are not what was ticked");
  const stale = repo.approvalAcknowledgementRefusals(db, p, "electrical", { ...ticks, items: ticks.items.map((i) => ({ ...i, contentHash: "0".repeat(64) })) });
  assert.ok(stale.problems.some((x) => /changed since it was acknowledged/.test(x)), JSON.stringify(stale.problems));
  const other = repo.approvalAcknowledgementRefusals(db, p, "electrical", { ...ticks, planSet: { documentId: "another", sha256: "f".repeat(64) } });
  assert.ok(other.problems.some((x) => /plan set was replaced/.test(x)), JSON.stringify(other.problems));
  // Nothing to acknowledge → nothing refused, whatever was (not) sent.
  assert.deepEqual(acknowledgementProblems([], null, null), []);
});

// ── (R) the run, through the real prepareSubmission (browser stubbed) ──────────────────────────
type Seen = { autoSubmit?: boolean };
async function approvedRun(projectId: string, acknowledgements: ReturnType<typeof fx.acknowledgeAll> | null, beforeRun?: () => void) {
  const approval = repo.createRunApproval(db, { projectId, track: "permit", approver: "A. Person", approverUserId: null, acknowledgements });
  beforeRun?.();
  process.env.PORTAL_ALLOW_FINAL_SUBMIT = "1";
  let seen: Seen = {};
  fx.stubRunner(async (_r, _p, _f, _d, _files, options) => {
    seen = { autoSubmit: options?.autoSubmit };
    return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "staged" }] };
  });
  try {
    await repo.prepareSubmission(db, projectId, undefined, true, undefined, approval.id);
  } finally {
    delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  }
  const declined = fx.audits("portal.auto_submit_declined").filter((a) => a.project_id === projectId)
    .flatMap((a) => (JSON.parse(a.details).reasons as string[]));
  return { seen, declined };
}
fx.completeRecipe();

await check("(R1) MUST-EXCLUDE: an approval that did not acknowledge the measured busbar violation stops at review, saying why", async () => {
  const id = busbarJob();
  const { seen, declined } = await approvedRun(id, null);
  assert.equal(seen.autoSubmit, false, "an unacknowledged measured violation was handed to the bot for a click");
  assert.ok(declined.some((r) => /does not cover this filing's open review items/.test(r) && /busbar|120/i.test(r)), JSON.stringify(declined));
});

await check("(R2) MUST-PASS: with every item ticked against this plan set, the approved run is allowed (a gate nothing passes is an outage)", async () => {
  const id = busbarJob();
  const { seen, declined } = await approvedRun(id, fx.acknowledgeAll(id, null));
  assert.equal(seen.autoSubmit, true, `the acknowledged run was refused: ${JSON.stringify(declined)}`);
});

await check("(R3) a plan set replaced after the ticks voids them: the run stops at review", async () => {
  const id = busbarJob();
  const acks = fx.acknowledgeAll(id, null);
  const { seen, declined } = await approvedRun(id, acks, () => {
    docs.saveProjectDocument(db, id, {
      docType: "plan_set", filename: "plan-set-rev2.pdf", contentType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n% revised plan set\n", "utf8"), source: "upload",
    });
  });
  assert.notDeepEqual(planSetBinding(db, id), acks.planSet, "setup: the plan set did not change");
  assert.equal(seen.autoSubmit, false, "ticks given against the old plan set let the new one file");
  assert.ok(declined.some((r) => /plan set was replaced/.test(r)), JSON.stringify(declined));
});

await check("(E) the email door reads the same stop", () => {
  const ctx = {
    channel: "email" as const, envAllows: true, runApproval: { approver: "A. Person", runId: "r1" }, runId: "r1",
    recordProblems: [], priorSendOnTrack: false,
  };
  assert.deepEqual(finalSubmitRefusals(ctx), [], "setup: the email context is not otherwise clean");
  const out = finalSubmitRefusals({ ...ctx, unacknowledgedSinceApproval: ["not acknowledged: Busbar"] });
  assert.ok(out.some((r) => /does not cover this filing's open review items/.test(r)), JSON.stringify(out));
});

// ── (D) the dashboard renders a tick box per item to acknowledge ────────────────────────────────
const dashboard = fs.readFileSync(path.join(REPO, "frontend", "dashboard.js"), "utf8").replace(/\r\n/g, "\n");
const liftFn = (name: string): string => {
  const m = new RegExp(`^function ${name}\\(`, "m").exec(dashboard);
  if (!m) throw new Error(`dashboard.js: no ${name}`);
  let i = dashboard.indexOf("{", dashboard.indexOf(")", m.index)), depth = 0;
  for (; i < dashboard.length; i++) {
    const ch = dashboard[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return dashboard.slice(m.index, i);
};
await check("(D) each item to acknowledge is a tick box carrying its id and hash; every value escaped", () => {
  const s = sheet(busbarJob(), "electrical");
  s.openItems[0].title = "<img src=x onerror=alert(1)>";
  const html = new Function(`${liftFn("esc")}\n${liftFn("approvalOpenItemsHtml")}\nreturn approvalOpenItemsHtml;`)()(s) as string;
  const boxes = html.match(/data-approval-ack="/g) ?? [];
  assert.equal(boxes.length, s.openItems.filter((i) => i.needsAcknowledgement).length);
  assert.match(html, new RegExp(`data-approval-ack="${BUSBAR.replace(/\./g, "\\.")}" data-approval-ack-hash="[0-9a-f]{64}"`));
  assert.ok(!html.includes("<img src=x"), "MUST-EXCLUDE: an unescaped title");
});

finish("approvalAcknowledgements");
