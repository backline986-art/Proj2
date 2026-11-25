// THE WAY BACK TO THE JOB (#540): the intake acknowledgement asks the client to "reply with" what is
// still missing, so a Reply must come back through intake to the SAME project.
//
//   MUST PASS    — the acknowledgement carries Reply-To: intake+<the client's own tag>@<intake domain>
//                  and a Message-ID of ours naming the project, on the wire (buildMailOptions) too; a
//                  reply from a known sender with ONE attachment and no readable address (a bill
//                  photo) attaches to the original project through its In-Reply-To, or its
//                  References alone, and that reply's own acknowledgement carries the way back again.
//   MUST NOT     — the reply makes a new project or lands unsorted; a reference to ANOTHER client's
//                  project (rule 6), an archived project, or an id minted for another domain is
//                  followed; a reply whose plan set reads a different street is attached to the
//                  referenced job; a client with no tag gets a Reply-To that would land unsorted.
//
// Synthetic data only: example.test domains, made-up numbers. No network: the model read and the
// mail send are injected.
//   npx tsx backend/test/emailIntakeReplyTo.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTempDir } from "./_tmpdir";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "email-intake-reply-to-"));
process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
process.env.EMAIL_INTAKE_ADDRESS = "intake@keelix.example.test";
process.env.PUBLIC_BASE_URL = "https://keelix.example.test";
process.env.SMTP_FROM = "filings@keelix.example.test";
delete process.env.SMTP_HOST;
delete process.env.CLIENT_NOTIFICATIONS;
delete process.env.EMAIL_INTAKE_AUTO_REPLY;
delete process.env.EMAIL_INTAKE_REQUIRE_AUTH;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { processIntakeMessages, intakeReplyToAddress, answeredProjectIds } = await import("../src/emailIntake");
const { buildMailOptions } = await import("../src/clientNotifier");
const { PDFDocument, StandardFonts } = await import("pdf-lib");
const { default: MailComposer } = await import("nodemailer/lib/mail-composer/index.js");

let failures = 0;
const run = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack || err.message : String(err)}`); }
};

const db = await openDatabase();
const acme = createClient(db, { companyName: "Acme Synthetic Solar", businessEmail: "office@acme.example.test", intakeTag: "Acme" });
const rival = createClient(db, { companyName: "Rival Synthetic Solar", businessEmail: "office@rival.example.test", intakeTag: "rival" });
const untagged = createClient(db, { companyName: "Untagged Synthetic Solar", businessEmail: "office@untagged.example.test" });

async function pdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  lines.forEach((line, i) => page.drawText(line, { x: 40, y: 740 - i * 18, size: 11, font }));
  return Buffer.from(await doc.save());
}
const planAt = (street: string) => pdf(["PV-1 COVER SHEET", `Address: ${street}, Salem, OR 97301`, "Owner: Pat Example"]);
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
// Each bill photo differs by a trailing byte, so the "same file already on the project" check never hides a placement.
let photoSeq = 0;
const billPhoto = () => ({ filename: `bill-photo-${++photoSeq}.png`, content: Buffer.concat([PNG_1PX, Buffer.from([photoSeq])]) });

let msgSeq = 0;
async function message(opts: {
  from?: string; to?: string; subject?: string; inReplyTo?: string; references?: string;
  attachments: Array<{ filename: string; content: Buffer }>;
}): Promise<Buffer> {
  msgSeq++;
  return new MailComposer({
    from: opts.from ?? "office@acme.example.test",
    to: opts.to ?? "intake+acme@keelix.example.test",
    subject: opts.subject ?? `Job ${msgSeq}`,
    text: "See attached.",
    messageId: `<synthetic-${msgSeq}@acme.example.test>`,
    ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
    ...(opts.references ? { references: opts.references } : {}),
    attachments: opts.attachments,
  }).compile().build();
}

// The injected model read: the street from the plan set's text, nothing else.
const extract = async (t: { planText: string; utilityBillText: string; structuralLetterText: string }) => {
  const street = /Address: ([^,]+), ([^,]+), ([A-Z]{2}) (\d{5})/.exec(t.planText);
  return {
    provider: "claude" as const,
    fields: street ? {
      street: { value: street[1], confidence: 0.95 }, city: { value: street[2], confidence: 0.95 },
      state: { value: street[3], confidence: 0.95 }, zip: { value: street[4], confidence: 0.95 },
      owner: { value: "Pat Example", confidence: 0.9 },
    } : {},
    lowConfidenceFields: [],
    notes: "",
  } as never;
};

const outbox: Array<{ to: string; subject: string; headers?: { replyTo?: string; messageId?: string } }> = [];
const send = async (to: string, subject: string, _body: string, _html?: string, headers?: { replyTo?: string; messageId?: string }) => {
  outbox.push({ to, subject, headers });
};
const opts = { extract, send };
const projectCount = () => Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects")?.n ?? 0);
const intakeDocs = (projectId: string) =>
  db.query<{ original_filename: string }>("SELECT original_filename FROM project_documents WHERE project_id = ? AND source = 'email_intake'", [projectId]).map((d) => d.original_filename);
const MESSAGE_ID_RE = /^<intake-reply\.([0-9a-f-]{36})\.[0-9a-f]+@keelix\.example\.test>$/;

let projectId = "";
let ackId = "";

await run("the acknowledgement carries Reply-To intake+<client tag>@<intake domain> and a Message-ID naming the project", async () => {
  const result = await processIntakeMessages(db, [await message({ attachments: [{ filename: "Plan Set.pdf", content: await planAt("101 Synthetic Way") }] })], opts);
  assert.equal(result.created, 1);
  projectId = result.items[0].projectId!;
  const ack = outbox.at(-1)!;
  assert.equal(ack.to, "office@acme.example.test");
  assert.equal(ack.headers?.replyTo, "intake+acme@keelix.example.test");
  const m = MESSAGE_ID_RE.exec(ack.headers?.messageId ?? "");
  assert.ok(m, `Message-ID ${ack.headers?.messageId} is ours`);
  assert.equal(m![1], projectId);
  ackId = ack.headers!.messageId!;
});

await run("the headers reach the wire: buildMailOptions compiles a Reply-To and our Message-ID", async () => {
  const raw = (await new MailComposer(buildMailOptions("office@acme.example.test", "Received", "body", [], {
    replyTo: "intake+acme@keelix.example.test", messageId: ackId,
  })).compile().build()).toString("utf8");
  assert.match(raw, /^Reply-To: intake\+acme@keelix\.example\.test\r?$/m);
  assert.ok(raw.replace(/\r?\n[ \t]+/g, " ").includes(`Message-ID: ${ackId}`), "Message-ID kept (a long one is folded)");
  const plain = (await new MailComposer(buildMailOptions("x@acme.example.test", "s", "b")).compile().build()).toString("utf8");
  assert.doesNotMatch(plain, /^Reply-To:/m, "no Reply-To unless asked");
});

await run("a reply with one bill photo (no readable address) attaches to the original project through In-Reply-To", async () => {
  const before = projectCount();
  const photo = billPhoto();
  const result = await processIntakeMessages(db, [await message({ subject: "Re: Received", inReplyTo: ackId, references: ackId, attachments: [photo] })], opts);
  assert.equal(result.attached, 1, JSON.stringify(result.items.map((i) => [i.status, i.reason])));
  assert.equal(result.unsorted, 0);
  assert.equal(result.items[0].projectId, projectId);
  assert.equal(projectCount(), before, "no new project");
  assert.ok(intakeDocs(projectId).includes(photo.filename), "the photo is on the original project");
  const audit = db.get<{ detail_json: string }>("SELECT details AS detail_json FROM audit_logs WHERE project_id = ? AND action = 'project.files_attached_from_email' ORDER BY created_at DESC LIMIT 1", [projectId]);
  assert.match(String(audit?.detail_json), /"matchedBy":"reply"/);
  // That reply's own acknowledgement carries the way back again.
  const ack = outbox.at(-1)!;
  assert.equal(ack.headers?.replyTo, "intake+acme@keelix.example.test");
  assert.equal(MESSAGE_ID_RE.exec(ack.headers?.messageId ?? "")?.[1], projectId);
  assert.notEqual(ack.headers?.messageId, ackId, "every acknowledgement has its own id");
});

await run("References alone (no In-Reply-To) is enough, newest reference first", async () => {
  const photo = billPhoto();
  const result = await processIntakeMessages(db, [await message({ references: `<other@acme.example.test> ${ackId}`, attachments: [photo] })], opts);
  assert.equal(result.attached, 1);
  assert.equal(result.items[0].projectId, projectId);
});

await run("a reference to ANOTHER client's project is never followed (rule 6)", async () => {
  const rivalMade = await processIntakeMessages(db, [await message({ from: "office@rival.example.test", to: "intake+rival@keelix.example.test", attachments: [{ filename: "Plan Set.pdf", content: await planAt("202 Rival Road") }] })], opts);
  const rivalProject = rivalMade.items[0].projectId!;
  const rivalAck = outbox.at(-1)!.headers!.messageId!;
  assert.equal(outbox.at(-1)!.headers?.replyTo, "intake+rival@keelix.example.test");
  const photo = billPhoto();
  const result = await processIntakeMessages(db, [await message({ inReplyTo: rivalAck, attachments: [photo] })], opts);
  assert.equal(result.unsorted, 1);
  assert.equal(result.items[0].reason, "address_unreadable");
  assert.ok(!intakeDocs(rivalProject).includes(photo.filename));
  assert.ok(!intakeDocs(projectId).includes(photo.filename));
  void rival;
});

await run("an id minted for another domain, or an archived project, is not followed", async () => {
  const foreign = ackId.replace("@keelix.example.test", "@elsewhere.example.test");
  const r1 = await processIntakeMessages(db, [await message({ inReplyTo: foreign, attachments: [billPhoto()] })], opts);
  assert.equal(r1.unsorted, 1);
  assert.deepEqual(answeredProjectIds({ inReplyTo: foreign, references: undefined }), []);
  const made = await processIntakeMessages(db, [await message({ attachments: [{ filename: "Plan Set.pdf", content: await planAt("303 Archive Lane") }] })], opts);
  const archived = made.items[0].projectId!;
  const archivedAck = outbox.at(-1)!.headers!.messageId!;
  db.run("UPDATE projects SET archived_at = ? WHERE id = ?", [new Date().toISOString(), archived]);
  const r2 = await processIntakeMessages(db, [await message({ inReplyTo: archivedAck, attachments: [billPhoto()] })], opts);
  assert.equal(r2.unsorted, 1);
  assert.equal(r2.items[0].reason, "address_unreadable");
});

await run("a reply whose plan set reads a DIFFERENT street is a new job, not attached to the referenced one", async () => {
  const before = projectCount();
  const result = await processIntakeMessages(db, [await message({ inReplyTo: ackId, attachments: [{ filename: "Other Plan Set.pdf", content: await planAt("404 Different Drive") }] })], opts);
  assert.equal(result.created, 1);
  assert.notEqual(result.items[0].projectId, projectId);
  assert.equal(projectCount(), before + 1);
});

await run("a reply whose plan set reads the SAME street attaches to the referenced project", async () => {
  const result = await processIntakeMessages(db, [await message({ inReplyTo: ackId, attachments: [{ filename: "Plan Set rev B.pdf", content: await planAt("101 Synthetic Way") }] })], opts);
  assert.equal(result.attached, 1);
  assert.equal(result.items[0].projectId, projectId);
});

await run("a client with no tag gets no Reply-To (the bare intake address would land the reply unsorted)", () => {
  assert.equal(intakeReplyToAddress(db, untagged.id), null);
  assert.equal(intakeReplyToAddress(db, acme.id), "intake+acme@keelix.example.test");
  const saved = process.env.EMAIL_INTAKE_ADDRESS;
  delete process.env.EMAIL_INTAKE_ADDRESS;
  try { assert.equal(intakeReplyToAddress(db, acme.id), null); } finally { process.env.EMAIL_INTAKE_ADDRESS = saved; }
});

removeTempDir(scratch);
console.log(failures ? `\n${failures} failure(s)` : "\nemailIntakeReplyTo: all checks passed");
process.exit(failures ? 1 : 0);
