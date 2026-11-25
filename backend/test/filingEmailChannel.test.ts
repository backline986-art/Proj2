// THE EMAIL FILING CHANNEL (#667): a filing email is staged as a draft, and automation SENDS it only
// through the one final-submit gate (rule 1) — a named approval of THIS run, FILING_EMAIL_ALLOW_SEND=1
// (never PORTAL_ALLOW_FINAL_SUBMIT), a usable person-verified record, and no earlier send. One send per
// filing; nothing secret in the subject or body (rule 2); the record is a person's and a re-lookup
// never rewrites it (rule 3); the authority's reply threads back to the job.
//
// Every staging case drives the REAL prepareSubmission (the smoke's fixture, which clears every
// staging gate). SMTP is mocked (setFilingEmailSenderForTests): nothing is ever sent from a test.
//
// KILL TESTS (each fails a named check below):
//   K1 portalSafety.finalSubmitRefusals: drop the FILING_EMAIL_ALLOW_SEND check → (e) fails.
//   K2 drop runApprovalRefusals from the email branch → (c) (d) fail.
//   K3 drop recordProblems from the email branch, or make filingEmailRecordProblems lenient → (a) (b) fail.
//   K4 drop priorSendOnTrack / the atomic draft→sending claim → (h) fails.
//   K5 prepareSubmission: skip the email branch → (f) fails (the portal path runs instead).
//   K6 runEmailTracker: drop filingEmailReplyProject → (j) fails.
//
// Run: npx tsx backend/test/filingEmailChannel.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("filing-email");
const { db, repo } = fx;
const fe = await import("../src/filingEmail");
const ufl = await import("../src/utilityFilingLookup");
const safety = await import("../../shared/src/portalSafety");

const ADDRESS = "interconnections@utility-example.com";
const PAGE = "https://www.utility-example.com/solar/apply";
const QUOTE = `Email your completed application and attachments to ${ADDRESS}.`;
const ACCOUNT = "1234567890"; // the fixture's synthetic account / meter numbers
const METER = "987654321";

/** A SEEDED utility filing lookup for the fixture's utility (OR | PGE), as the lookup writes it. */
function seedUtilityLookup(): void {
  const saved = ufl.saveUtilityFilingLookup(db, {
    state: "OR", utility: "PGE", lookedUpAt: new Date().toISOString(),
    filing: { value: { name: "email", url: null }, sourceUrl: PAGE, quote: QUOTE, origin: "lookup" },
    program: { value: "net_metering", sourceUrl: PAGE, quote: "Net metering program", origin: "lookup" },
  } as never);
  assert.equal(saved.saved, true, `setup: the lookup row was not written (${saved.reason})`);
}
const nemAuthority = (projectId: string) => fe.authorityForTrack(repo.getProjectDetail(db, projectId).project, "nem")!;
const verifyEmail = (projectId: string) => {
  const r = fe.setFilingEmail(db, nemAuthority(projectId), { address: ADDRESS, sourceUrl: PAGE, quote: QUOTE }, "A. Person");
  assert.equal(r.saved, true, `setup: the filing email was not saved (${r.reason})`);
};

const sent: Array<{ to: string; subject: string; body: string; attachments: string[]; messageId: string }> = [];
let failNext = false;
fe.setFilingEmailSenderForTests(async (to, subject, body, attachments, opts) => {
  if (failNext) { failNext = false; throw new Error(`smtp 451 temporary failure for account ${ACCOUNT}`); }
  sent.push({ to, subject, body, attachments: attachments.map((a) => a.filename), messageId: opts.messageId });
});

/** Stage the NEM track, optionally as an Approve & auto-submit with this approval. */
async function stageNem(projectId: string, opts: { approvalId?: string | null; emailSwitch?: string | null; portalSwitch?: string | null } = {}) {
  const set = (k: string, v: string | null | undefined) => { if (v == null) delete process.env[k]; else process.env[k] = v; };
  set("FILING_EMAIL_ALLOW_SEND", opts.emailSwitch);
  set("PORTAL_ALLOW_FINAL_SUBMIT", opts.portalSwitch);
  fx.stubRunner(async () => { throw new Error("the portal path ran: an email-channel track must never open a portal"); });
  try {
    await repo.prepareSubmission(db, projectId, "nem", opts.approvalId !== undefined, undefined, opts.approvalId ?? null);
  } finally {
    delete process.env.FILING_EMAIL_ALLOW_SEND;
    delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  }
  return fe.listFilingEmailSends(db, projectId, "nem")[0];
}
const approve = (projectId: string, track = "nem") => repo.createRunApproval(db, { projectId, track, approver: "A. Person", approverUserId: null });
const submissionStatuses = (projectId: string) =>
  db.query<{ status: string }>("SELECT status FROM submissions WHERE project_id = ? AND permit_type = 'nem' ORDER BY created_at", [projectId]).map((r) => r.status);

// ── The record (pure) ──────────────────────────────────────────────────────────────────────────
const good = { address: ADDRESS, sourceUrl: PAGE, quote: QUOTE, verifiedBy: "A. Person", verifiedAt: new Date().toISOString() };

await check("(a) an unverified record, an address not in the quote, or an off-domain address is not usable", () => {
  assert.deepEqual(fe.filingEmailRecordProblems(good), []);
  assert.match(fe.filingEmailRecordProblems({ ...good, verifiedBy: "" }).join(" | "), /no named person verified/);
  assert.match(fe.filingEmailRecordProblems({ ...good, quote: "Email us your application at our usual address." }).join(" | "), /verbatim/);
  const offDomain = "apply@other-company.com";
  assert.match(fe.filingEmailRecordProblems({ ...good, address: offDomain, quote: `Send to ${offDomain} please` }).join(" | "), /neither a government domain/);
  const personal = "utilityclerk@gmail.com";
  assert.match(fe.filingEmailRecordProblems({ ...good, address: personal, quote: `Send to ${personal} please`, sourceUrl: "https://mail.gmail.com/x" }).join(" | "), /personal mailbox/);
  // A government address is usable from any page that quotes it (a city's .gov, a US locality's .us).
  for (const gov of ["permits@cityofexample.gov", "building@ci.example.or.us"]) {
    assert.deepEqual(fe.filingEmailRecordProblems({ ...good, address: gov, quote: `Submit applications to ${gov}.`, sourceUrl: "https://www.example-county.org/permits" }), [], gov);
  }
});

await check("(b) setFilingEmail refuses with no lookup row, refuses an unusable record, and a re-lookup never rewrites it (rule 3)", () => {
  const projectId = fx.newProject();
  const authority = nemAuthority(projectId);
  db.run("DELETE FROM utility_filing_lookups");
  assert.equal(fe.setFilingEmail(db, authority, { address: ADDRESS, sourceUrl: PAGE, quote: QUOTE }, "A. Person").saved, false);
  seedUtilityLookup();
  assert.equal(fe.setFilingEmail(db, authority, { address: ADDRESS, sourceUrl: PAGE, quote: "no address here at all" }, "A. Person").saved, false);
  assert.equal(fe.setFilingEmail(db, authority, { address: ADDRESS, sourceUrl: PAGE, quote: QUOTE }, "").saved, false, "a nameless verification was saved");
  verifyEmail(projectId);
  seedUtilityLookup(); // the lookup runs again over the (seeded) row and rewrites its payload
  const after = fe.readFilingEmail(db, authority).record;
  assert.equal(after?.address, ADDRESS, "a re-lookup erased the person's filing-email record");
  assert.equal(after?.verifiedBy, "A. Person");
});

// ── The gate (pure) ────────────────────────────────────────────────────────────────────────────
const ctx = { channel: "email" as const, envAllows: true, runApproval: { approver: "A. Person", runId: "run-1" }, runId: "run-1", recordProblems: [] as string[], priorSendOnTrack: false };
await check("(c)(d)(e) the email gate is the one final-submit gate: approval of THIS run, its own switch, a usable record, no prior send", () => {
  assert.equal(safety.mayClickFinalSubmit(ctx), true, "a fully approved send was refused — a gate nothing can pass is an outage");
  assert.equal(safety.mayClickFinalSubmit({ ...ctx, runApproval: null }), false);
  assert.equal(safety.mayClickFinalSubmit({ ...ctx, runApproval: { approver: "A. Person", runId: "run-2" } }), false, "an approval for another run sent");
  assert.equal(safety.mayClickFinalSubmit({ ...ctx, runApproval: { approver: " ", runId: "run-1" } }), false);
  assert.equal(safety.mayClickFinalSubmit({ ...ctx, envAllows: false }), false);
  assert.equal(safety.mayClickFinalSubmit({ ...ctx, recordProblems: ["unverified"] }), false);
  assert.equal(safety.mayClickFinalSubmit({ ...ctx, priorSendOnTrack: true }), false);
  assert.equal(safety.mayClickFinalSubmit({ ...ctx, relaxedSinceApproval: ["f1"] }), false);
  // #640: a blocker released by an override that was not in force at the approval stops the email
  // door too, exactly as it stops the portal door (automaticSubmitRefusals.overriddenSinceApproval).
  assert.equal(safety.mayClickFinalSubmit({ ...ctx, overriddenSinceApproval: ["f1"] }), false, "an override recorded after the approval let the email send");
  assert.match(safety.finalSubmitRefusals({ ...ctx, overriddenSinceApproval: ["f1"] }).join(" | "), /override not in force at the approval.*f1/);
  // Its OWN switch: PORTAL_ALLOW_FINAL_SUBMIT never turns email on, and the email switch is exactly "1".
  assert.equal(safety.filingEmailEnvAllows({ PORTAL_ALLOW_FINAL_SUBMIT: "1" }), false);
  assert.equal(safety.filingEmailEnvAllows({ FILING_EMAIL_ALLOW_SEND: "true" }), false);
  assert.equal(safety.filingEmailEnvAllows({ FILING_EMAIL_ALLOW_SEND: "1" }), true);
  // The portal door is unchanged by the channel field.
  assert.equal(safety.mayClickFinalSubmit({ envAllows: true, runApproval: { approver: "A", runId: "r" }, runId: "r", stepIsTerminalFlagged: true, recipeShapeValid: true }), true);
});

// ── Staging through the real prepareSubmission ────────────────────────────────────────────────
await check("(f) no approval → the email is staged as a DRAFT, nothing is sent, no portal opens", async () => {
  const projectId = fx.newProject();
  seedUtilityLookup();
  verifyEmail(projectId);
  const before = sent.length;
  const row = await stageNem(projectId, { emailSwitch: "1" });
  assert.ok(row, "no filing email was staged");
  assert.equal(row.status, "draft");
  assert.equal(sent.length, before, "a filing email was sent with no approval");
  assert.equal(row.recipient, ADDRESS);
  assert.ok(row.attachments.length > 0, "the draft lists no attachments");
  assert.deepEqual(submissionStatuses(projectId), ["awaiting_human_submit"]);
});

await check("(g) rule 2: no account or meter number in the subject, the body or the audit copy", async () => {
  const projectId = fx.newProject();
  const row = fe.listFilingEmailSends(db, projectId, "nem")[0] ?? await stageNem(projectId);
  for (const text of [row.subject, row.body, JSON.stringify(row.attachments)]) {
    assert.ok(!text.includes(ACCOUNT) && !text.includes(METER), `a secret reached the filing email: ${text.slice(0, 120)}`);
  }
  // And a secret smuggled into a template input is scrubbed.
  const project = repo.getProjectDetail(db, projectId).project;
  const c = fe.composeFilingEmail({ project, track: "nem", authorityName: "PGE", files: [], submitterName: `Solar Co acct ${ACCOUNT}`, refTag: "X" });
  assert.ok(!c.body.includes(ACCOUNT), "composeFilingEmail did not scrub the project's own account number");
});

await check("(c) an approval with the switch unset → draft only, the decline audited", async () => {
  const projectId = fx.newProject();
  const before = sent.length;
  const row = await stageNem(projectId, { approvalId: approve(projectId).id, portalSwitch: "1" });
  assert.equal(row.status, "draft");
  assert.equal(sent.length, before, "PORTAL_ALLOW_FINAL_SUBMIT turned the email door on");
  assert.match(row.refusals.join(" | "), /FILING_EMAIL_ALLOW_SEND is not 1/);
  assert.ok(fx.audits("filing_email.auto_send_declined").some((a) => a.project_id === projectId));
});

await check("(d) an approval minted for ANOTHER track is not this run's → draft only", async () => {
  const projectId = fx.newProject();
  const before = sent.length;
  const row = await stageNem(projectId, { approvalId: approve(projectId, "building").id, emailSwitch: "1" });
  assert.equal(row.status, "draft");
  assert.equal(sent.length, before);
  assert.match(row.refusals.join(" | "), /no named person approved this run/);
});

let sentProjectId = "";
await check("(e) MUST-PASS: approval of THIS run + FILING_EMAIL_ALLOW_SEND=1 + verified record → sent ONCE, recorded as the filing", async () => {
  const projectId = (sentProjectId = fx.newProject());
  const approval = approve(projectId);
  const before = sent.length;
  const row = await stageNem(projectId, { approvalId: approval.id, emailSwitch: "1" });
  assert.equal(row.status, "sent", `not sent: ${row.refusals.join(" | ")}`);
  assert.equal(sent.length, before + 1);
  const mail = sent[sent.length - 1];
  assert.equal(mail.to, ADDRESS);
  assert.equal(mail.messageId, row.messageId);
  assert.match(mail.messageId, new RegExp(`^<filing\\.${projectId}\\.`));
  assert.deepEqual(mail.attachments, row.attachments.map((a) => a.filename));
  assert.equal(row.runId, approval.id, "the send is not recorded against the approved run");
  const sub = db.get<{ status: string; submitted_by: string }>("SELECT status, submitted_by FROM submissions WHERE project_id = ? AND permit_type = 'nem' ORDER BY created_at DESC LIMIT 1", [projectId]);
  assert.equal(sub?.status, "submitted");
  assert.match(String(sub?.submitted_by), /approved by A\. Person/);
});

await check("(h) one send per filing: a second approved run on a sent track never sends; a failed send is never retried", async () => {
  const before = sent.length;
  await stageNem(sentProjectId, { approvalId: approve(sentProjectId).id, emailSwitch: "1" }).catch(() => null); // the duplicate guard may refuse outright
  assert.equal(sent.length, before, "a second approved run re-sent a filed track");

  const projectId = fx.newProject();
  failNext = true;
  const failed = await stageNem(projectId, { approvalId: approve(projectId).id, emailSwitch: "1" });
  assert.equal(failed.status, "failed");
  assert.ok(!failed.detail.includes(ACCOUNT), "the failure detail carries a secret");
  assert.deepEqual(submissionStatuses(projectId), ["awaiting_human_submit"], "a failed send was recorded as a filing");
  const retry = await stageNem(projectId, { approvalId: approve(projectId).id, emailSwitch: "1" });
  assert.equal(retry.status, "draft");
  assert.match(retry.refusals.join(" | "), /already on record/);
  assert.equal(sent.length, before, "a failed send was retried automatically");
});

await check("(i) the draft downloads as an .eml with our Message-ID; a sent one is never handed out again", async () => {
  const projectId = fx.newProject();
  const row = await stageNem(projectId);
  const eml = await fe.filingEmailDraftEml(db, repo.getProjectDetail(db, projectId).project, row.id);
  const text = eml.content.toString("utf8");
  assert.match(text, /X-Unsent: 1/);
  assert.ok(text.includes(row.messageId), "the .eml lost our Message-ID");
  assert.ok(text.includes(ADDRESS));
  const sentRow = fe.listFilingEmailSends(db, sentProjectId, "nem").find((r) => r.status === "sent")!;
  await assert.rejects(() => fe.filingEmailDraftEml(db, repo.getProjectDetail(db, sentProjectId).project, sentRow.id), /already sent/);
});

await check("(j) the authority's reply (In-Reply-To our Message-ID) is filed on that project's NEM track", async () => {
  const row = fe.listFilingEmailSends(db, sentProjectId, "nem").find((r) => r.status === "sent")!;
  const project = repo.getProjectDetail(db, sentProjectId).project;
  const otherOrg = fe.filingEmailReplyProject(db, { threadRefs: row.messageId, subject: "" }, { orgId: "org-elsewhere" });
  assert.equal(otherOrg, null, "a reply was placed on a project outside the source's org (rule 6)");
  const mbox = [
    "From interconnections@utility-example.com Mon Nov 09 10:00:00 2026",
    "From: Interconnection Desk <interconnections@utility-example.com>",
    "To: filings@installer.test",
    "Subject: RE: your application",
    "Date: Mon, 09 Nov 2026 10:00:00 +0000",
    `Message-ID: <reply-1@utility-example.com>`,
    `In-Reply-To: ${row.messageId}`,
    `References: ${row.messageId}`,
    "",
    "Thank you. We received your application. It is under review. Application number INT-55821.",
    "",
  ].join("\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "filing-reply-"));
  const file = path.join(dir, "reply.mbox");
  fs.writeFileSync(file, mbox);
  const result = await repo.runEmailTracker(db, { filePath: file, orgId: String(project.orgId || "org-default") });
  const match = result.matches.find((m) => m.projectId === sentProjectId);
  assert.ok(match, `the reply was not filed on the project (matches: ${result.projectMatches}, unmatched: ${result.unmatchedMessages})`);
  assert.match(String(match.matchReason ?? ""), /reply to our filing email/);
});

fe.setFilingEmailSenderForTests(null);
finish("filingEmailChannel");
