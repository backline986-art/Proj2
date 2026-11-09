// UNSORTED EMAILED JOBS: FILE UNDER CLIENT, RETRY, AND THE ALERT (#541).
//
//   MUST PASS    — a message that lands unsorted raises ONE staff alert (sender domain, day, reason in
//                  our words; never the subject, a file name or the mailbox); "File under client …"
//                  re-runs the pipeline with the chosen client and files it, the person's name on the
//                  audit; "Retry" re-runs a failed message; a sender only the person vouched for gets
//                  a DRAFT reply, never a sent one.
//   MUST NOT     — filing skips a check the person was not shown (a DMARC fail behind a missing tag
//                  lands unsorted again with that reason); a client in another org, or a row outside
//                  the caller's org, is anything but a 404; a placed or dismissed message is processed
//                  again (by the poll or by a second file / retry); two concurrent files make two
//                  projects; a re-run raises a second alert.
//
// Synthetic data only: example.test domains, made-up numbers. No network: the model read and the
// mail send are injected.
//   npx tsx backend/test/emailIntakeRerun.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "email-intake-rerun-"));
process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
process.env.EMAIL_INTAKE_ADDRESS = "intake@keelix.example.test";
process.env.PUBLIC_BASE_URL = "https://keelix.example.test";
for (const k of ["SMTP_HOST", "SMTP_FROM", "CLIENT_NOTIFICATIONS", "EMAIL_INTAKE_AUTO_REPLY", "EMAIL_INTAKE_REQUIRE_AUTH", "ANTHROPIC_API_KEY", "STAFF_ALERT_TO", "STAFF_ALERT_WEBHOOK_URL"]) delete process.env[k];

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { processIntakeMessages, listEmailIntake, fileEmailIntake, retryEmailIntake, dismissEmailIntake } = await import("../src/emailIntake");
const { unsortedIntakeAlert } = await import("../src/staffAlerts");
const { backendDataDir } = await import("../src/statePaths");
const { PDFDocument, StandardFonts } = await import("pdf-lib");
const { default: MailComposer } = await import("nodemailer/lib/mail-composer/index.js");

let failures = 0;
const run = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack || err.message : String(err)}`); }
};
const status = (code: number) => (e: unknown) => (e as { status?: number }).status === code;

const db = await openDatabase();
const ORG_B = "org-rerun-b";
db.run("INSERT INTO orgs (id, name, edition, created_at) VALUES (?, ?, 'full', ?)", [ORG_B, ORG_B, new Date().toISOString()]);

const acme = createClient(db, { companyName: "Acme Synthetic Solar", businessEmail: "office@acme.example.test", intakeTag: "acme" });
const other = createClient(db, { companyName: "Other Synthetic Solar", businessEmail: "office@other.example.test", intakeTag: "other" });
const orgBClient = createClient(db, { companyName: "Org B Synthetic Solar", businessEmail: "office@orgb.example.test", intakeTag: "bee" }, ORG_B);

async function pdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  lines.forEach((line, i) => page.drawText(line, { x: 40, y: 740 - i * 18, size: 11, font }));
  return Buffer.from(await doc.save());
}
let street = 500;
const planFor = async () => pdf(["SOLAR PHOTOVOLTAIC SYSTEM", `Address: ${++street} Synthetic Way, Salem, OR 97301`]);

let msgSeq = 0;
async function message(opts: { from?: string; to?: string; subject?: string; headers?: Record<string, string>; attachments?: Array<{ filename: string; content: Buffer }> }): Promise<Buffer> {
  msgSeq++;
  return new MailComposer({
    from: opts.from ?? "office@acme.example.test",
    to: opts.to ?? "intake+acme@keelix.example.test",
    subject: opts.subject ?? `Secret Homeowner Job ${msgSeq}`,
    text: "Plan set attached.",
    messageId: `<rerun-${msgSeq}@acme.example.test>`,
    headers: opts.headers ?? {},
    attachments: opts.attachments ?? [],
  }).compile().build();
}

let gate: Promise<void> | null = null;
let throwOnce = false;
const extract = async (t: { planText: string }) => {
  if (gate) await gate;
  if (throwOnce) { throwOnce = false; throw new Error("synthetic model outage"); }
  const m = /Address: ([^,]+), ([^,]+), ([A-Z]{2}) (\d{5})/.exec(t.planText);
  return {
    provider: "claude",
    fields: m ? {
      street: { value: m[1], confidence: 0.95 }, city: { value: m[2], confidence: 0.95 },
      state: { value: m[3], confidence: 0.95 }, zip: { value: m[4], confidence: 0.95 },
    } : {},
    lowConfidenceFields: [],
    notes: "",
  } as never;
};
const outbox: Array<{ to: string; subject: string }> = [];
const send = async (to: string, subject: string) => { outbox.push({ to, subject }); };
const opts = { extract, send };

const alerts = () => db.query<Record<string, unknown>>("SELECT * FROM staff_notifications WHERE kind = 'unsorted_intake' ORDER BY created_at, rowid");
const projectsFor = (clientId: string) => db.query<Record<string, unknown>>("SELECT * FROM projects WHERE client_id = ?", [clientId]);
const audits = (action: string) => db.query<Record<string, unknown>>("SELECT * FROM audit_logs WHERE action = ? ORDER BY rowid", [action]);
const intakeRow = (rowId: string) => db.get<Record<string, unknown>>("SELECT * FROM email_intake_messages WHERE id = ?", [rowId])!;
const keptDir = (rowId: string) => path.join(backendDataDir(), "email-intake", rowId);

async function landUnsorted(raw: Buffer, reason: string) {
  const r = await processIntakeMessages(db, [raw], opts);
  assert.equal(r.unsorted, 1, JSON.stringify(r));
  assert.equal(r.items[0].reason, reason);
  return r.items[0];
}

// ── the alert ────────────────────────────────────────────────────────────────────────────────

let unknownTagRaw: Buffer;
let unknownTagId = "";
await run("an unsorted message raises one staff alert: domain, day, reason — never subject, file name or mailbox", async () => {
  const before = alerts().length;
  unknownTagRaw = await message({ to: "intake+nosuchtag@keelix.example.test", subject: "Job for Pat Homeowner", attachments: [{ filename: "pat-homeowner-plans.pdf", content: await planFor() }] });
  const item = await landUnsorted(unknownTagRaw, "unknown_tag");
  unknownTagId = item.id;
  const rows = alerts();
  assert.equal(rows.length, before + 1, "no alert for an unsorted message");
  const a = rows[rows.length - 1];
  assert.equal(a.ref, item.id);
  assert.equal(a.org_id, DEFAULT_ORG_ID);
  assert.equal(a.project_id, null);
  const text = `${a.subject}\n${a.body}`;
  assert.match(text, /acme\.example\.test/);
  assert.match(text, /no client has the intake tag/);
  for (const leak of ["Pat Homeowner", "pat-homeowner-plans", "office@", "nosuchtag"]) assert.ok(!text.includes(leak), `the alert carries "${leak}"`);
  assert.equal(item.canFile, true);
  assert.equal(item.canRetry, false);
});

await run("the alert builder is fixed words plus the domain; an unknown reason still says nothing of the message", () => {
  const mail = unsortedIntakeAlert({ domain: "acme.example.test", day: "2026-11-09", reason: "made_up", files: 2 });
  assert.match(mail.body, /intake could not place it/);
  assert.match(mail.body, /File under client, Retry, or Dismiss/);
});

await run("a message with nothing attached (ignored) raises no alert", async () => {
  const before = alerts().length;
  const r = await processIntakeMessages(db, [await message({ to: "intake@keelix.example.test" })], opts);
  assert.equal(r.unsorted, 0);
  assert.equal(alerts().length, before);
});

// ── file under client ────────────────────────────────────────────────────────────────────────

await run("File under client files an unknown-tag message under the chosen client, audited with the person's name", async () => {
  const sentBefore = outbox.length;
  const view = await fileEmailIntake(db, unknownTagId, acme.id, DEFAULT_ORG_ID, "pm@keelix.example.test", opts);
  assert.equal(view.status, "created", JSON.stringify(view));
  assert.ok(view.projectId);
  assert.equal(view.clientId, acme.id);
  assert.equal(view.canFile, false);
  const project = db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", [view.projectId])!;
  assert.equal(project.client_id, acme.id);
  assert.equal(project.org_id, DEFAULT_ORG_ID);
  const docs = db.query<Record<string, unknown>>("SELECT doc_type, uploaded_by FROM project_documents WHERE project_id = ? AND source = 'email_intake'", [view.projectId]);
  assert.deepEqual(docs.map((d) => d.doc_type), ["plan_set"]);
  const filed = audits("email_intake.filed").find((a) => String(a.details ?? "").includes(unknownTagId) || a.project_id === view.projectId);
  assert.ok(filed, "no email_intake.filed audit");
  assert.equal(filed!.actor_name, "pm@keelix.example.test");
  const created = audits("project.created_from_email").find((a) => a.project_id === view.projectId)!;
  assert.equal(created.actor_name, "pm@keelix.example.test", "the project audit does not name the person");
  assert.ok(!fs.existsSync(keptDir(unknownTagId)), "the kept files (and raw message) outlived the placement");
  // A known sender (the client's own address): the reply goes as it would for a tagged message.
  assert.equal(outbox.length, sentBefore + 1);
  assert.equal(outbox[outbox.length - 1].to, "office@acme.example.test");
  assert.ok(!listEmailIntake(db, DEFAULT_ORG_ID).unsorted.some((i) => i.id === unknownTagId));
});

await run("a placed message is never processed again: not by a second file, a retry, or the next poll", async () => {
  const projects = projectsFor(acme.id).length;
  await assert.rejects(fileEmailIntake(db, unknownTagId, acme.id, DEFAULT_ORG_ID, "pm", opts), status(409));
  await assert.rejects(retryEmailIntake(db, unknownTagId, DEFAULT_ORG_ID, "pm", opts), status(409));
  const r = await processIntakeMessages(db, [unknownTagRaw], opts);
  assert.equal(r.skippedDuplicates, 1);
  assert.equal(projectsFor(acme.id).length, projects);
});

await run("an unknown sender filed under the client is placed, and its reply is a DRAFT, never sent", async () => {
  const item = await landUnsorted(await message({ from: "stranger@elsewhere.example.test", attachments: [{ filename: "p.pdf", content: await planFor() }] }), "unknown_sender");
  const sentBefore = outbox.length;
  const view = await fileEmailIntake(db, item.id, acme.id, DEFAULT_ORG_ID, "pm", opts);
  assert.equal(view.status, "created", JSON.stringify(view));
  assert.equal(view.replyStatus, "draft");
  assert.equal(outbox.length, sentBefore, "a reply was sent to a sender only a person vouched for");
  const comm = db.get<Record<string, unknown>>("SELECT * FROM communications WHERE project_id = ?", [view.projectId])!;
  assert.equal(comm.delivery_status, "draft");
  assert.match(String(comm.delivery_detail), /draft for a person to send/);
});

await run("filing does not skip a check the person was not shown: a DMARC fail behind a missing tag lands unsorted again", async () => {
  const failing = { "Authentication-Results": "mx.example.test; spf=fail; dmarc=fail (p=reject) header.from=acme.example.test" };
  const item = await landUnsorted(await message({ to: "intake@keelix.example.test", headers: failing, attachments: [{ filename: "p.pdf", content: await planFor() }] }), "no_tag");
  const alertsBefore = alerts().length;
  const projects = projectsFor(acme.id).length;
  const first = await fileEmailIntake(db, item.id, acme.id, DEFAULT_ORG_ID, "pm", opts);
  assert.equal(first.status, "unsorted");
  assert.equal(first.reason, "sender_not_authenticated");
  assert.equal(first.canFile, true);
  assert.equal(projectsFor(acme.id).length, projects, "a DMARC fail was filed without the person seeing it");
  assert.equal(alerts().length, alertsBefore, "a person's own re-run raised another alert");
  // Now the person has seen the reason and files it again: placed, reply kept as a draft.
  const sentBefore = outbox.length;
  const second = await fileEmailIntake(db, item.id, acme.id, DEFAULT_ORG_ID, "pm", opts);
  assert.equal(second.status, "created", JSON.stringify(second));
  assert.equal(outbox.length, sentBefore, "a reply was sent to an address that failed authentication");
});

await run("a plan set licensed to another client is filed only under the client the person chose", async () => {
  const before = projectsFor(other.id).length;
  const rival = async (t: { planText: string }) => ({ ...(await extract(t) as object), clientResolution: { decision: "auto_assign", clientId: other.id } }) as never;
  const raw = await message({ attachments: [{ filename: "p.pdf", content: await planFor() }] });
  const r = await processIntakeMessages(db, [raw], { ...opts, extract: rival });
  assert.equal(r.items[0].reason, "plan_set_names_another_client");
  const view = await fileEmailIntake(db, r.items[0].id, acme.id, DEFAULT_ORG_ID, "pm", { ...opts, extract: rival });
  assert.equal(view.status, "created", JSON.stringify(view));
  assert.equal(view.clientId, acme.id);
  assert.equal(projectsFor(other.id).length, before);
});

await run("rule 6: another org's client or a row outside the caller's org is a 404; nothing changes", async () => {
  const item = await landUnsorted(await message({ to: "intake+nosuchtag@keelix.example.test", attachments: [{ filename: "p.pdf", content: await planFor() }] }), "unknown_tag");
  await assert.rejects(fileEmailIntake(db, item.id, orgBClient.id, DEFAULT_ORG_ID, "pm", opts), status(404));
  await assert.rejects(fileEmailIntake(db, item.id, orgBClient.id, null, "superadmin", opts), status(404), "a superadmin filed a message across orgs");
  await assert.rejects(fileEmailIntake(db, item.id, acme.id, ORG_B, "pm", opts), status(404));
  await assert.rejects(retryEmailIntake(db, item.id, ORG_B, "pm", opts), status(404));
  await assert.rejects(fileEmailIntake(db, item.id, "no-such-client", DEFAULT_ORG_ID, "pm", opts), status(404));
  assert.equal(intakeRow(item.id).status, "unsorted");
  assert.equal(projectsFor(orgBClient.id).length, 0);
});

await run("a dismissed message is never processed again", async () => {
  const item = await landUnsorted(await message({ to: "intake+nosuchtag@keelix.example.test", attachments: [{ filename: "p.pdf", content: await planFor() }] }), "unknown_tag");
  dismissEmailIntake(db, item.id, DEFAULT_ORG_ID, "pm");
  await assert.rejects(fileEmailIntake(db, item.id, acme.id, DEFAULT_ORG_ID, "pm", opts), status(409));
  assert.equal(intakeRow(item.id).status, "dismissed");
});

await run("what choosing a client cannot fix is not offered: address_unreadable is canFile false and a 409", async () => {
  const item = await landUnsorted(await message({ attachments: [{ filename: "scan.pdf", content: await pdf(["no address here"]) }] }), "address_unreadable");
  assert.equal(item.canFile, false);
  await assert.rejects(fileEmailIntake(db, item.id, acme.id, DEFAULT_ORG_ID, "pm", opts), status(409));
});

await run("a row from before the raw message was kept is a 409 (download and use the Parser), never a guess", async () => {
  const item = await landUnsorted(await message({ to: "intake+nosuchtag@keelix.example.test", attachments: [{ filename: "p.pdf", content: await planFor() }] }), "unknown_tag");
  fs.rmSync(path.join(keptDir(item.id), "message.eml"));
  assert.equal(listEmailIntake(db, DEFAULT_ORG_ID).unsorted.find((i) => i.id === item.id)?.canFile, false);
  await assert.rejects(fileEmailIntake(db, item.id, acme.id, DEFAULT_ORG_ID, "pm", opts), status(409));
});

await run("two files of the same message at once make one project, not two", async () => {
  const item = await landUnsorted(await message({ to: "intake+nosuchtag@keelix.example.test", attachments: [{ filename: "p.pdf", content: await planFor() }] }), "unknown_tag");
  const before = projectsFor(acme.id).length;
  let release!: () => void;
  gate = new Promise((r) => { release = r; });
  const a = fileEmailIntake(db, item.id, acme.id, DEFAULT_ORG_ID, "pm-a", opts);
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(fileEmailIntake(db, item.id, acme.id, DEFAULT_ORG_ID, "pm-b", opts), status(409));
  release(); gate = null;
  assert.equal((await a).status, "created");
  assert.equal(projectsFor(acme.id).length, before + 1);
});

// ── retry ────────────────────────────────────────────────────────────────────────────────────

await run("a message that failed partway is unsorted 'failed' with an alert, and Retry files it as the poll would have", async () => {
  const alertsBefore = alerts().length;
  throwOnce = true;
  const r = await processIntakeMessages(db, [await message({ attachments: [{ filename: "p.pdf", content: await planFor() }] })], opts);
  assert.equal(r.items[0]?.reason, "failed", JSON.stringify(r));
  const item = r.items[0];
  assert.equal(item.canRetry, true);
  assert.equal(item.canFile, false);
  assert.equal(alerts().length, alertsBefore + 1, "a failed message raised no alert");
  await assert.rejects(fileEmailIntake(db, item.id, acme.id, DEFAULT_ORG_ID, "pm", opts), status(409));
  const view = await retryEmailIntake(db, item.id, DEFAULT_ORG_ID, "pm@keelix.example.test", opts);
  assert.equal(view.status, "created", JSON.stringify(view));
  assert.equal(view.clientId, acme.id);
  assert.ok(audits("email_intake.retried").some((a) => a.actor_name === "pm@keelix.example.test"));
  await assert.rejects(retryEmailIntake(db, item.id, DEFAULT_ORG_ID, "pm", opts), status(409));
});

await run("Retry is only for a failed message; a retry that fails again stays unsorted 'failed'", async () => {
  const notFailed = await landUnsorted(await message({ to: "intake+nosuchtag@keelix.example.test", attachments: [{ filename: "p.pdf", content: await planFor() }] }), "unknown_tag");
  await assert.rejects(retryEmailIntake(db, notFailed.id, DEFAULT_ORG_ID, "pm", opts), status(409));
  throwOnce = true;
  const r = await processIntakeMessages(db, [await message({ attachments: [{ filename: "p.pdf", content: await planFor() }] })], opts);
  throwOnce = true;
  const again = await retryEmailIntake(db, r.items[0].id, DEFAULT_ORG_ID, "pm", opts);
  assert.equal(again.status, "unsorted");
  assert.equal(again.reason, "failed");
  assert.equal(again.canRetry, true, "a second failure lost the kept message");
});

console.log(failures ? `\n${failures} failure(s)` : "\nemailIntakeRerun: all checks passed");
process.exit(failures ? 1 : 0);
