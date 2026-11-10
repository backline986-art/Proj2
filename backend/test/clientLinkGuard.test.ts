// NO DEAD LINK REACHES A CLIENT (go-live readiness, owner 2026-11-10; backend/src/clientLinkGuard.ts).
//
// When PUBLIC_BASE_URL is unset or points at a machine a client cannot reach (localhost, 127.0.0.1, a
// private address, a LAN-only name), every client send path REFUSES: the message is kept as a CRM draft
// whose delivery_detail says why (CLIENT_LINK_REFUSAL_PREFIX), and nothing reaches the mail server.
// With a public base the same message goes out exactly as before (the guard only adds stops).
//
//   (a) the predicate: every dead base refused, public-shaped bases (and the reserved test names the
//       suites use) allowed; a dead link in the body refuses even with a good base.
//   (b) each client send path, mock mail only (a local SMTP listener on 127.0.0.1, or the path's own
//       injected sender): the status update, the backlog re-send, the request links, the email-intake
//       reply, the installer handoff and the invoice. For each: refused on a localhost base with nothing
//       mailed and the reason on the row; sent with a public base (proves the guard is what stopped it).
//   (c) the invoice builds no link from PUBLIC_BASE_URL, so a dead base alone does not hold it; a dead
//       link in its own text does.
// Synthetic data only: invented names in state ZZ, .test domains, made-up numbers.
//   npx tsx backend/test/clientLinkGuard.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "client-link-guard-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.SESSION_ENCRYPTION_KEY = "client-link-guard-test-key-not-a-real-secret";
for (const k of ["BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE", "PERMIT_PROCESS_LOOKUP"]) process.env[k] = "off";
for (const k of ["CLIENT_NOTIFICATIONS", "SMTP_HOST", "SMTP_FROM", "SMTP_USER", "ANTHROPIC_API_KEY", "EMAIL_INTAKE_AUTO_REPLY", "EMAIL_INTAKE_REQUIRE_AUTH", "CLIENT_REQUEST_AUTO_SEND", "PUBLIC_BASE_URL"]) delete process.env[k];

const GOOD_BASE = "https://keelix.example.test";
const DEAD_BASE = "http://localhost:4173";

// ── a local SMTP listener: records each message's recipient and raw DATA (no network leaves the box) ──
const mails: Array<{ to: string; data: string }> = [];
const smtp = net.createServer((sock) => {
  let buf = ""; let inData = false; let to = ""; let data = "";
  sock.write("220 test ESMTP\r\n");
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    for (;;) {
      if (inData) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        data += buf.slice(0, end); buf = buf.slice(end + 5); inData = false;
        mails.push({ to, data }); sock.write("250 queued\r\n");
        continue;
      }
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") sock.write("250-test\r\n250 OK\r\n");
      else if (cmd === "RCPT") { to = (line.match(/<([^>]*)>/) ?? [])[1] ?? ""; sock.write("250 OK\r\n"); }
      else if (cmd === "DATA") { inData = true; data = ""; sock.write("354 go\r\n"); }
      else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); return; }
      else sock.write("250 OK\r\n");
    }
  });
  sock.on("error", () => { /* client hung up */ });
});
await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", () => resolve()));
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = String((smtp.address() as net.AddressInfo).port);
process.env.SMTP_FROM = "filings@keelix.example.test";

const guard = await import("../src/clientLinkGuard");
const { openDatabase } = await import("../src/db");
const { createClient, updateClient } = await import("../src/clients");
const R = await import("../src/repository");
const notifier = await import("../src/clientNotifier");
const { addCommunication } = await import("../src/crm");
const { autoSendClientRequests } = await import("../src/clientRequestLinks");
const { WAITING_ON_BILL_ISSUE_TYPE } = await import("../src/qc");
const { setPortalQuestionSource } = await import("../src/intakeRequests");
const { processIntakeMessages } = await import("../src/emailIntake");
const { sendInstallerHandoff } = await import("../src/installerHandoff");
const invoices = await import("../src/clientInvoices");
const { PDFDocument, StandardFonts } = await import("pdf-lib");
const { default: MailComposer } = await import("nodemailer/lib/mail-composer/index.js");

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};
const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));
type Row = Record<string, unknown>;
const db = await openDatabase();
const PREFIX = guard.CLIENT_LINK_REFUSAL_PREFIX;

// ── (a) the predicate ──────────────────────────────────────────────────────────────────────────
await check("(a) every dead base is refused, with a reason a person can act on", () => {
  for (const base of [
    "", "   ", "localhost", "not a url", DEAD_BASE, "http://localhost", "https://LOCALHOST:8443", "http://127.0.0.1:4173", "http://127.8.9.10",
    "http://0.0.0.0:4173", "http://10.1.2.3", "http://172.16.0.9", "http://192.168.1.20:4173", "http://169.254.169.254", "http://100.64.1.1",
    "http://[::1]:4173", "http://[fe80::1]", "http://[fd00::5]", "http://[::ffff:127.0.0.1]", "http://keelixbox:4173", "https://app.localhost",
    "https://box.local", "https://app.internal", "https://server.lan", "https://office.home.arpa", "https://app.corp", "ftp://keelix.example.test",
    "https://user:pw@keelix.example.test",
  ]) {
    const why = guard.publicBaseUrlProblem({ PUBLIC_BASE_URL: base });
    assert.ok(why && why.startsWith("PUBLIC_BASE_URL"), `${JSON.stringify(base)} was allowed`);
  }
  assert.match(guard.publicBaseUrlProblem({})!, /not set/);
});

await check("(a) public-shaped bases are allowed, and only the origin is ever shown", () => {
  for (const base of [GOOD_BASE, "https://app.keelix-zz.com", "https://keelix-zz.com:8443/", "http://203.0.113.7", "https://[2001:db8::1]", "https://portal.example.invalid"]) {
    assert.equal(guard.publicBaseUrlProblem({ PUBLIC_BASE_URL: base }), null, `${base} was refused`);
  }
  assert.equal(guard.publicBaseOrigin({ PUBLIC_BASE_URL: "https://keelix-zz.com/some/path?token=abc" }), "https://keelix-zz.com");
  assert.equal(guard.publicBaseOrigin({ PUBLIC_BASE_URL: "nonsense" }), "");
});

await check("(a) a dead link in the body refuses even with a good base; public links and mailto do not", () => {
  const env = { PUBLIC_BASE_URL: GOOD_BASE };
  assert.equal(guard.clientLinkRefusal({ body: `See ${GOOD_BASE}/status?token=x and https://permits.fernhollow-zz.gov/a. Reply to mailto:a@b.test` }, env), null);
  const r = guard.clientLinkRefusal({ body: "Live status page (no login needed): http://localhost:4173/status?token=abc" }, env);
  assert.ok(r?.startsWith(PREFIX) && /localhost/.test(r!), String(r));
  assert.ok(guard.clientLinkRefusal({ body: "ok", html: '<a href="http://192.168.0.4/portal?token=1">x</a>' }, env)?.startsWith(PREFIX));
  // carriesLink false: the base alone does not refuse; a dead link in the text still does.
  assert.equal(guard.clientLinkRefusal({ body: "Invoice total $10", carriesLink: false }, {}), null);
  assert.ok(guard.clientLinkRefusal({ body: "Pay at http://127.0.0.1:4173/pay", carriesLink: false }, {})?.startsWith(PREFIX));
  assert.ok(guard.clientLinkRefusal({ body: "x" }, {})?.startsWith(PREFIX), "carriesLink defaults to true");
});

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────
let seq = 0;
function makeClient(tag?: string) {
  seq++;
  const c = createClient(db, { companyName: `Guard Synthetic Solar ${seq}`, ccbLicenseNumber: `77${seq}001`, businessEmail: `office@guard${seq}.example.test`, ...(tag ? { intakeTag: tag } : {}) });
  updateClient(db, c.id, { updatesInbox: `updates@guard${seq}.example.test` } as never);
  return { ...c, inbox: `updates@guard${seq}.example.test` };
}
function makeProject(clientId: string, extra: Record<string, unknown> = {}): string {
  return R.createProject(db, {
    clientId, owner: `Guard Owner ${++seq}`, street: `${200 + seq} Synthetic Way`, city: "Fernhollow", state: "ZZ", zip: "99999",
    ahj: "City of Fernhollow", utility: "Brightwater Valley Electric", dcKw: "7", acKw: "5", ...extra,
  } as never).project.id as string;
}
const commsFor = (projectId: string): Row[] => db.query<Row>("SELECT * FROM communications WHERE project_id = ? ORDER BY created_at, rowid", [projectId]);
const mailedTo = (to: string): number => mails.filter((m) => m.to === to).length;
const assertRefused = (row: Row | undefined, label: string): void => {
  assert.ok(row, `${label}: no communication row`);
  assert.equal(row!.delivery_status, "draft", `${label}: ${row!.delivery_status} ${row!.delivery_detail}`);
  assert.ok(String(row!.delivery_detail).startsWith(PREFIX), `${label}: detail ${row!.delivery_detail}`);
};

// ── (b) the status update ──────────────────────────────────────────────────────────────────────
await check("(b) status update: a localhost base keeps it a draft with the reason; nothing is mailed", async () => {
  process.env.PUBLIC_BASE_URL = DEAD_BASE;
  const c = makeClient();
  const pid = makeProject(c.id);
  await notifier.notifyClientOfStatusChange(db, R.getProjectDetail(db, pid).project, { outcome: "issued", statusLabel: "Issued", targetType: "permit" });
  await settle();
  assertRefused(commsFor(pid).at(-1), "status update");
  assert.equal(mailedTo(c.inbox), 0, "a dead link was mailed");
});

await check("(b) status update: the same send with a public base is mailed (the guard is what stopped it)", async () => {
  process.env.PUBLIC_BASE_URL = GOOD_BASE;
  const c = makeClient();
  const pid = makeProject(c.id);
  await notifier.notifyClientOfStatusChange(db, R.getProjectDetail(db, pid).project, { outcome: "issued", statusLabel: "Issued", targetType: "permit" });
  await settle();
  assert.equal(commsFor(pid).at(-1)?.delivery_status, "sent", JSON.stringify(commsFor(pid).at(-1)));
  assert.equal(mailedTo(c.inbox), 1);
});

// ── (b) the backlog re-send ────────────────────────────────────────────────────────────────────
await check("(b) re-send: a stranded message is not re-sent on a dead base, and stays a draft with the reason", async () => {
  const c = makeClient();
  const pid = makeProject(c.id);
  const draftBody = `Hello.\nLive status page (no login needed): ${DEAD_BASE}/status?token=old\n`;
  const comm = addCommunication(db, { projectId: pid, direction: "outbound", channel: "email", subject: "Permit issued", body: draftBody, loggedBy: "client-notifier (automated)", deliveryStatus: "draft", deliveryDetail: "SMTP was unset", recipient: c.inbox });
  process.env.PUBLIC_BASE_URL = "http://192.168.1.20:4173";
  const r = await notifier.resendCommunication(db, { id: comm.id, projectId: pid, recipient: c.inbox, subject: "Permit issued", body: draftBody });
  assert.equal(r.delivered, false);
  assert.ok(r.detail.startsWith(PREFIX), r.detail);
  assertRefused(db.get<Row>("SELECT * FROM communications WHERE id = ?", [comm.id])!, "re-send");
  assert.equal(mailedTo(c.inbox), 0);
  process.env.PUBLIC_BASE_URL = GOOD_BASE;
  const ok = await notifier.resendCommunication(db, { id: comm.id, projectId: pid, recipient: c.inbox, subject: "Permit issued", body: draftBody });
  assert.equal(ok.delivered, true, ok.detail);
  assert.equal(mailedTo(c.inbox), 1);
  assert.ok(mails.at(-1)!.data.includes("keelix.example.test/status?token="), "the link was rebuilt from the public base");
});

// ── (b) the request links ──────────────────────────────────────────────────────────────────────
setPortalQuestionSource(() => []);
const requestOutbox: Array<{ to: string; body: string }> = [];
const requestSend = async (to: string, _subject: string, body: string): Promise<void> => { requestOutbox.push({ to, body }); };
function billWait(projectId: string): void {
  db.run("UPDATE projects SET status = 'ready_to_stage', interconnection_method = 'Net metering' WHERE id = ?", [projectId]);
  const now = new Date().toISOString();
  db.run("INSERT OR IGNORE INTO human_review_items (id, project_id, issue_type, field_name, status, created_at, updated_at) VALUES (?, ?, ?, 'accountNumber', 'pending', ?, ?)",
    [`hri-${projectId}`, projectId, WAITING_ON_BILL_ISSUE_TYPE, now, now]);
}
await check("(b) request links: a base on a LAN-only name keeps the intake link a draft with the reason (the old check passed it)", async () => {
  process.env.PUBLIC_BASE_URL = "http://keelixbox:4173";
  const c = makeClient();
  const pid = makeProject(c.id);
  billWait(pid);
  const out = await autoSendClientRequests(db, pid, { nemPortalUrl: () => "", send: requestSend });
  assert.deepEqual(out.sent, [{ kind: "intake", status: "draft" }], JSON.stringify(out));
  assertRefused(commsFor(pid).find((r) => /Information needed/.test(String(r.subject))), "request link");
  assert.equal(requestOutbox.filter((m) => m.to === c.inbox).length, 0);
});
await check("(b) request links: the unset-base refusal is unchanged, and a public base sends", async () => {
  delete process.env.PUBLIC_BASE_URL;
  const c1 = makeClient();
  const p1 = makeProject(c1.id);
  billWait(p1);
  await autoSendClientRequests(db, p1, { nemPortalUrl: () => "", send: requestSend });
  assert.match(String(commsFor(p1).at(-1)?.delivery_detail), /^PUBLIC_BASE_URL is not set, so the link would point at this machine/);
  process.env.PUBLIC_BASE_URL = GOOD_BASE;
  const c2 = makeClient();
  const p2 = makeProject(c2.id);
  billWait(p2);
  const out = await autoSendClientRequests(db, p2, { nemPortalUrl: () => "", send: requestSend });
  assert.deepEqual(out.sent, [{ kind: "intake", status: "sent" }], JSON.stringify(out));
  assert.equal(requestOutbox.filter((m) => m.to === c2.inbox).length, 1);
});

// ── (b) the email-intake reply ─────────────────────────────────────────────────────────────────
process.env.EMAIL_INTAKE_ADDRESS = "intake@keelix.example.test";
const intakeOutbox: Array<{ to: string }> = [];
const intakeOpts = {
  send: async (to: string) => { intakeOutbox.push({ to }); },
  extract: async (t: { planText: string }) => {
    const m = /Address: ([^,]+), ([^,]+), ([A-Z]{2}) (\d{5})/.exec(t.planText);
    return { provider: "claude" as const, fields: m ? { street: { value: m[1], confidence: 0.95 }, city: { value: m[2], confidence: 0.95 }, state: { value: m[3], confidence: 0.95 }, zip: { value: m[4], confidence: 0.95 }, owner: { value: "Guard Owner", confidence: 0.9 } } : {}, lowConfidenceFields: [], notes: "" } as never;
  },
};
async function intakeMessage(from: string, tag: string, street: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  ["PV-1 COVER SHEET", `Address: ${street}, Fernhollow, ZZ 99999`, "Owner: Guard Owner"].forEach((line, i) => page.drawText(line, { x: 40, y: 740 - i * 18, size: 11, font }));
  return new MailComposer({ from, to: `intake+${tag}@keelix.example.test`, subject: `Job ${street}`, text: "See attached.", messageId: `<guard-${street.replace(/\W/g, "")}@example.test>`,
    attachments: [{ filename: "Plan Set.pdf", content: Buffer.from(await doc.save()) }] }).compile().build();
}
await check("(b) intake reply: a private-address base keeps the acknowledgement a draft with the reason; a public base sends it", async () => {
  const tag = `guardtag${seq + 1}`;
  const c = makeClient(tag);
  const from = String(c.businessEmail);
  process.env.PUBLIC_BASE_URL = "http://10.0.0.5:4173";
  const r1 = await processIntakeMessages(db, [await intakeMessage(from, tag, "301 Synthetic Way")], intakeOpts);
  assert.equal(r1.created, 1, JSON.stringify(r1.items));
  const p1 = r1.items[0].projectId!;
  assertRefused(commsFor(p1).find((r) => /^Received/.test(String(r.subject))), "intake reply");
  assert.equal(intakeOutbox.length, 0, "a dead link was mailed");
  process.env.PUBLIC_BASE_URL = GOOD_BASE;
  const r2 = await processIntakeMessages(db, [await intakeMessage(from, tag, "302 Synthetic Way")], intakeOpts);
  const p2 = r2.items[0].projectId!;
  assert.equal(commsFor(p2).find((r) => /^Received/.test(String(r.subject)))?.delivery_status, "sent");
  assert.equal(intakeOutbox.length, 1);
});

// ── (b) the installer handoff ──────────────────────────────────────────────────────────────────
await check("(b) installer handoff: a localhost base keeps the packet a draft with the reason; a public base sends it", async () => {
  const c = makeClient();
  const pid = makeProject(c.id);
  db.run("UPDATE projects SET status = 'handoff_ready' WHERE id = ?", [pid]);
  process.env.PUBLIC_BASE_URL = DEAD_BASE;
  const r1 = await sendInstallerHandoff(db, R.getProjectDetail(db, pid).project, { trigger: "manual", actor: "Pat Synthetic" });
  assert.equal(r1.deliveryStatus, "draft", JSON.stringify(r1));
  assert.ok(String(r1.detail).startsWith(PREFIX), String(r1.detail));
  assertRefused(commsFor(pid).filter((r) => /handoff/i.test(String(r.logged_by))).at(-1), "handoff");
  assert.equal(mailedTo(c.inbox), 0, "a dead link was mailed");
  process.env.PUBLIC_BASE_URL = GOOD_BASE;
  const r2 = await sendInstallerHandoff(db, R.getProjectDetail(db, pid).project, { trigger: "manual", actor: "Pat Synthetic" });
  assert.equal(r2.deliveryStatus, "sent", JSON.stringify(r2));
  assert.equal(mailedTo(c.inbox), 1);
});

// ── (c) the invoice ────────────────────────────────────────────────────────────────────────────
function draftInvoice(clientId: string, description: string): string {
  const id = `inv-guard-${++seq}`;
  const ts = new Date().toISOString();
  db.run(`INSERT INTO client_invoices (id, number, client_id, period_start, period_end, status, bill_to, billing_mode,
      reimbursement_total_usd, service_total_usd, received_total_usd, due_total_usd, created_by, created_at, updated_at)
    VALUES (?, ?, ?, '2026-10-01', '2026-11-01', 'draft', '', 'monthly', 0, 0, 0, 0, 'Pat Synthetic', ?, ?)`, [id, `KX-GUARD-${seq}`, clientId, ts, ts]);
  invoices.addManualInvoiceLine(db, clientId, id, { kind: "onboarding", amountUsd: 500, description }, "Pat Synthetic");
  return id;
}
await check("(c) invoice: it builds no link from the base, so a dead base alone does not hold it", async () => {
  delete process.env.PUBLIC_BASE_URL;
  const c = makeClient();
  const sent: string[] = [];
  const r = await invoices.sendClientInvoice(db, c.id, draftInvoice(c.id, "Client onboarding fee"), "Pat Synthetic", { send: async (to) => { sent.push(to); } });
  assert.equal(r.delivered, true, r.detail);
  assert.equal(sent.length, 1);
});
await check("(c) invoice: a dead link in its own text refuses it, kept as a draft with the reason", async () => {
  process.env.PUBLIC_BASE_URL = GOOD_BASE;
  const c = makeClient();
  const sent: string[] = [];
  const r = await invoices.sendClientInvoice(db, c.id, draftInvoice(c.id, "Onboarding, details at http://127.0.0.1:4173/portal?token=abc"), "Pat Synthetic", { send: async (to) => { sent.push(to); } });
  assert.equal(r.delivered, false);
  assert.ok(r.detail.startsWith(PREFIX), r.detail);
  assert.equal(sent.length, 0);
  const row = db.get<Row>("SELECT * FROM communications WHERE subject LIKE 'Invoice KX-GUARD-%' ORDER BY created_at DESC, rowid DESC LIMIT 1");
  assertRefused(row!, "invoice");
});

await check("every client send path asks the guard (source check, so a new path cannot skip it silently)", () => {
  const src = (f: string) => fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", f), "utf8");
  for (const f of ["clientNotifier.ts", "clientRequestLinks.ts", "emailIntake.ts", "installerHandoff.ts", "clientInvoices.ts"]) {
    assert.ok(/clientLinkRefusal\(/.test(src(f)), `${f} does not ask clientLinkRefusal`);
  }
  // clientNotifier: both of its sends (the status update and the re-send).
  assert.equal((src("clientNotifier.ts").match(/clientLinkRefusal\(/g) ?? []).length, 2);
});

smtp.close();
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nclientLinkGuard: all checks passed");
process.exit(0);
