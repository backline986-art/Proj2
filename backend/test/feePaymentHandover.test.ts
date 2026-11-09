// PAYMENT NEEDED (#576, acceptance items 1-3, backend half). A staging run that stops on a fee is
// ONE state, 'awaiting_payment', worded the same everywhere, with the fee read at the stop:
//
//   STATE      a fee_payment stop ends 'awaiting_payment' — a fee page AFTER the approved click
//              (which read 'submitted_unconfirmed') and a pay-to-file stop before it (which read
//              'paused_for_human') alike. The click is still a click: the duplicate guard keeps it.
//   WORDING    the run row, nextStep, the autopilot rail + Segment A blocker and the staff alert say
//              "Payment needed: $X on <portal>. Pay there…" — never MFA/CAPTCHA/challenge wording,
//              never "stage again"; an amount that was not read is said to be unread, never $0.
//   REFUSAL    staging that track is refused (409) while it waits — per-track and trackless — and
//              the browser never opens.
//   CARD       the track card carries the amount, the lines, the project-scoped screenshot route,
//              the track's own portal, the login on file, who pays, and "Open the saved
//              application" ONLY on the track's own portal host (rule 5).
//   WAY BACK   recording the filing on the track card (markTrackSubmitted) closes the waiting run.
//
// Driven through the REAL prepareSubmission with only the browser stubbed (_stageFixture).
// KILL TESTS: drop the fee_payment branch in derivePortalRunOutcome → STATE/WORDING fail (the run
// reads submitted_unconfirmed / paused_for_human); drop the awaiting-payment loop in
// prepareSubmission → REFUSAL fails; drop the host check in trackPaymentView → CARD fails.
//
// Run: npx tsx backend/test/feePaymentHandover.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupStageFixture, check, finish } from "./_stageFixture";

process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "fee-handover-test-key-not-a-real-secret";
const fx = await setupStageFixture("fee-payment-handover");
const { db, repo } = fx;
const fp = await import("../src/feePause");
const { computeNextStep } = await import("../src/nextStep");
const { getAutopilotState, segmentAOutcomeFromRun } = await import("../src/autopilot");
const { getSubmittalTracks, markTrackSubmitted } = await import("../src/submittalTracks");
const creds = await import("../src/portalCredentials");

const NOT_MFA = /\b(mfa|captcha|challenge|verification)\b/i;
const NOT_RESTAGE = /\b(stage again|re-?stage)\b/i;
const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-shot-"));
const SHOT = path.join(shotDir, "zzz-outcome-FEE-STOP.png");
fs.writeFileSync(SHOT, Buffer.from("89504e470d0a1a0a", "hex"));
const OWN_LINK = "https://permits.portland.example/apply/CapFees.aspx?capId=AB12";
const FOREIGN_LINK = "https://pay.elsewhere.example/checkout?id=AB12";

const feeResult = (o: { clicked: boolean; read: boolean; link?: string }) => ({
  portalName: "Portland permits", ok: false, finalSubmitClicked: o.clicked, finalSubmitClickedByAutomation: o.clicked,
  pauseReason: "fee_payment", outcomeShotPath: SHOT,
  feeStop: {
    read: o.read, totalUsd: o.read ? 412.5 : null,
    lines: o.read ? [{ label: "Electrical Permit Fee", amountUsd: 300, status: "invoiced", date: "" }, { label: "Plan Review Fee", amountUsd: 112.5, status: "invoiced", date: "" }] : [],
    unreadReason: o.read ? "" : "The review screen prints no fee.", where: o.clicked ? "fee_page" : "pay_to_file", shotPath: SHOT,
    pageLink: o.link ?? OWN_LINK, pageRef: "",
  },
  draftReference: { link: o.link ?? OWN_LINK, id: "" },
  steps: [{ ok: false, pauseReason: "fee_payment", message: "The approved final submit landed on a fee-payment page — automation never pays.", data: { finalSubmitClicked: o.clicked } }],
});

const rows = (pid: string) => db.query<Record<string, unknown>>("SELECT * FROM staff_notifications WHERE project_id = ? AND kind = 'run'", [pid]);
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 25)); };

fx.completeRecipe();

// ── pure ─────────────────────────────────────────────────────────────────────────────────────
await check("derivePortalRunOutcome: a fee stop is awaiting_payment, clicked or not; the click is still reported", () => {
  const after = repo.derivePortalRunOutcome(feeResult({ clicked: true, read: true }));
  assert.equal(after.status, "awaiting_payment");
  assert.equal(after.submissionStatus, "awaiting_payment");
  assert.equal(after.finalSubmitClicked, true, "the click is a fact the duplicate guard keeps");
  const before = repo.derivePortalRunOutcome(feeResult({ clicked: false, read: true }));
  assert.equal(before.status, "awaiting_payment");
  assert.equal(before.finalSubmitClicked, false);
  assert.equal(repo.derivePortalRunOutcome({ ok: false, finalSubmitClicked: true, steps: [] }).status, "submitted_unconfirmed", "an unconfirmed click with no fee is unchanged");
});
await check("the sentence: amount and portal; unread is said, never $0; no MFA, no 'stage again'", () => {
  const read = fp.paymentNeededForRun(feeResult({ clicked: true, read: true }));
  assert.match(read, /^Payment needed: \$412\.50 on Portland permits\. Pay there, then record the confirmation number\./);
  const unread = fp.paymentNeededForRun(feeResult({ clicked: false, read: false }));
  assert.match(unread, /^Payment needed on Portland permits \(the amount could not be read from the page; see the screenshot\)\./);
  for (const s of [read, unread, fp.paymentNeededForRun(null)]) {
    assert.doesNotMatch(s, /\$0(\.00)?\b/);
    assert.doesNotMatch(s, NOT_MFA, s);
    assert.doesNotMatch(s, NOT_RESTAGE, s);
  }
  assert.equal(fp.feeStopOf({ feeStop: { read: true, totalUsd: 0, lines: [] } })?.read, false, "a zero is unread, never a $0 fee");
});
await check("Segment A: an awaiting_payment run is a payment_needed blocker in the run's own words", () => {
  const sentence = fp.paymentNeededForRun(feeResult({ clicked: true, read: true }));
  const b = segmentAOutcomeFromRun({ status: "awaiting_payment", error_message: sentence, pause_reason: "fee_payment" });
  assert.equal(b?.code, "payment_needed");
  assert.equal(b?.detail, sentence);
});

// ── a fee page after the approved click, through the real writer ─────────────────────────────
const pid = fx.newProject();
creds.createPortalCredential(db, fx.client.id, {
  portalType: "accela", portalUrl: "https://permits.portland.example/apply",
  username: "permits@replaytrust.test", password: "not-a-real-secret", feeResponsibility: "card-on-file",
});
fx.stubRunner(async () => feeResult({ clicked: true, read: true }) as never);
await repo.prepareSubmission(db, pid, "combo").catch((e) => e);
await settle();
const run = fx.latestRun(pid)!;

await check("STATE: the run and its submission are awaiting_payment (not submitted_unconfirmed), the click stamped", () => {
  assert.equal(run.status, "awaiting_payment", JSON.stringify(run).slice(0, 300));
  assert.equal(run.pause_reason, "fee_payment");
  assert.equal(run.screenshots_path, SHOT, "the masked fee shot is the run's screenshot");
  const sub = db.get<Record<string, unknown>>("SELECT * FROM submissions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", [pid])!;
  assert.equal(sub.status, "awaiting_payment");
  assert.ok(sub.submitted_at, "submitted_at marks the click");
  assert.match(String(sub.notes), /Payment needed: \$412\.50/);
});
await check("WORDING: the run row and the project line say the payment, never MFA, never 'stage again'", () => {
  assert.match(String(run.error_message), /^Payment needed: \$412\.50 on /);
  const proj = db.get<Record<string, unknown>>("SELECT current_stage FROM projects WHERE id = ?", [pid])!;
  for (const s of [String(run.error_message), String(proj.current_stage)]) {
    assert.doesNotMatch(s, NOT_MFA, s);
    assert.doesNotMatch(s, NOT_RESTAGE, s);
  }
});
await check("WORDING: nextStep is payment_needed with the amount — not 'Ready to stage', not 'stage again'", () => {
  const step = computeNextStep(db, pid);
  assert.equal(step.key, "payment_needed", `${step.key}: ${step.headline}`);
  assert.match(step.headline, /Payment needed: \$412\.50/);
  assert.doesNotMatch(step.headline, NOT_MFA);
  assert.doesNotMatch(step.headline, NOT_RESTAGE);
  assert.equal(step.who, "me");
});
await check("WORDING: the autopilot rail says 'Payment needed' with the sentence as its blocker", () => {
  const s = getAutopilotState(db, pid);
  assert.equal(s.stage, "Payment needed");
  assert.equal(s.pauseReason, "fee_payment");
  assert.match(s.message, /^Payment needed: \$412\.50/);
  assert.deepEqual(s.blockers.map((b) => b.code), ["payment_needed"]);
  assert.doesNotMatch(s.message, NOT_MFA);
});
await check("ALERT: one staff alert naming the fee and its amount, in our words", () => {
  const mine = rows(pid);
  assert.equal(mine.length, 1, JSON.stringify(mine));
  assert.equal(mine[0].state, "awaiting_payment");
  assert.match(String(mine[0].subject), /^Action needed: combo permit payment needed \(fee \$412\.50\) — /);
  assert.match(String(mine[0].body), /Why: Payment needed: \$412\.50/);
  assert.doesNotMatch(String(mine[0].body), NOT_MFA);
  assert.doesNotMatch(String(mine[0].body), /verify on the portal/i, "no longer the fixed submitted_unconfirmed line");
});
await check("CARD: amount, lines, screenshot route under the project, own portal, login, who pays, the saved application", () => {
  const t = getSubmittalTracks(db, repo.getProjectDetail(db, pid).project).find((x) => x.type === "combo")!;
  assert.ok(t.payment, JSON.stringify(t).slice(0, 400));
  const p = t.payment!;
  assert.equal(t.statusLabel, "Payment needed");
  assert.equal(p.amountUsd, 412.5);
  assert.deepEqual(p.lines.map((l) => l.label), ["Electrical Permit Fee", "Plan Review Fee"]);
  assert.equal(p.screenshotUrl, `/api/projects/${pid}/portal-runs/${String(run.id)}/review-screenshot`);
  assert.equal(p.portalUrl, "https://permits.portland.example/apply");
  assert.equal(p.loginUsername, "permits@replaytrust.test");
  assert.equal(p.feeResponsibility, "card-on-file");
  assert.equal(p.applicationLink, OWN_LINK);
  assert.ok(!JSON.stringify(p).includes("not-a-real-secret"), "the stored secret never reaches the card");
});
await check("REFUSAL: staging the track again is refused in the payment's words, and nothing runs", async () => {
  let launched = 0;
  fx.stubRunner(async () => { launched++; return fx.failingStep("must not run"); });
  const runsBefore = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_runs WHERE project_id = ?", [pid])!.n;
  for (const track of ["combo", undefined] as const) {
    const err = await repo.prepareSubmission(db, pid, track as never).then(() => null, (e) => e) as { status?: number; message?: string } | null;
    assert.ok(err, `prepareSubmission(${track ?? "trackless"}) resolved while the track waits on payment`);
    assert.equal(err!.status, 409);
    assert.match(String(err!.message), /waiting on payment\. Payment needed: \$412\.50/);
    assert.doesNotMatch(String(err!.message), /already filed/);
  }
  assert.equal(launched, 0);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_runs WHERE project_id = ?", [pid])!.n, runsBefore);
});
await check("WAY BACK: recording the filing on the track card closes the waiting run and the payment card", () => {
  markTrackSubmitted(db, repo.getProjectDetail(db, pid).project, "combo", { applicationNumber: "BLD-26-04120", submittedBy: "fee test" });
  assert.equal(fx.latestRun(pid)!.status, "submitted");
  const t = getSubmittalTracks(db, repo.getProjectDetail(db, pid).project).find((x) => x.type === "combo")!;
  assert.equal(t.payment, undefined);
  assert.notEqual(computeNextStep(db, pid).key, "payment_needed");
});

// ── a pay-to-file stop with the amount unread, and a link on another host ─────────────────────
const pid2 = fx.newProject();
fx.stubRunner(async () => feeResult({ clicked: false, read: false, link: FOREIGN_LINK }) as never);
await repo.prepareSubmission(db, pid2, "combo").catch((e) => e);
await settle();
await check("pay-to-file, amount unread: awaiting_payment, nothing filed, the amount said to be unread", () => {
  const r = fx.latestRun(pid2)!;
  assert.equal(r.status, "awaiting_payment");
  assert.match(String(r.error_message), /could not be read/);
  assert.doesNotMatch(String(r.error_message), /\$0/);
  const sub = db.get<Record<string, unknown>>("SELECT * FROM submissions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", [pid2])!;
  assert.equal(sub.submitted_at, null, "no click, no submitted_at");
  const alert = rows(pid2)[0];
  assert.match(String(alert?.subject), /payment needed \(fee amount unread\)/);
});
await check("CARD rule 5: a page link on another host is never shown as 'Open the saved application'", () => {
  const t = getSubmittalTracks(db, repo.getProjectDetail(db, pid2).project).find((x) => x.type === "combo")!;
  assert.ok(t.payment);
  assert.equal(t.payment!.amountUsd, null);
  assert.equal(t.payment!.applicationLink, "");
  assert.match(t.payment!.unreadReason, /prints no fee/);
});

fs.rmSync(shotDir, { recursive: true, force: true });
finish("fee-payment handover");
