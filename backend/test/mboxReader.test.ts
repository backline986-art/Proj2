// THE MAILBOX IMPORTER READS EMAILS, NOT MIME, AND FILES ONLY REAL DEFICIENCY REQUESTS (2026-11-23 back-test).
//
//   (D) decoding: quoted-printable HTML, base64 plain text and an RFC 2047 subject read as text;
//       the stored sample is readable (no "Content-Type", no "=3D", no CSS).
//   (S) signature continuity: the source signature is made of the RAW subject and body exactly as the
//       old reader produced them, so a mailbox imported before is recognised (no duplicate rows) and
//       a watched mailbox's old notices are never matched again.
//   (R) what counts: a footer's "signature", a PacifiCorp-style "assigned to your customer generation
//       application" notice and a generic "additional information is required" file NO correction
//       example; "please provide the signed owner authorization" files one (Owner Authorization); an
//       ask that is only in the quoted history does not count.
//   (L) relearn: an earlier import's wrong records and examples are replaced in place, the shared
//       rollup is rebuilt from what is left; a dry run writes nothing.
//
// KILL TESTS: classify the raw body → D/R fail; sign the decoded body → S fails; drop the ask
// requirement → R fails.
//
// Run: npx tsx backend/test/mboxReader.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { openDatabase } = await import("../src/db");
const kb = await import("../src/knowledgeBase");
const { decodeMimeBody, decodeEncodedWords, currentMessageText } = await import("../src/mimeText");
const db = await openDatabase();

let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`ok   - ${name}`); }
  catch (err) { failed++; console.log(`FAIL - ${name}: ${err instanceof Error ? err.message : String(err)}`); }
};

const ORG = "default";
const LABEL = "Test mailbox";

function message(i: number, subject: string, headers: string, body: string): string {
  return `From sender${i}@example.test Mon Nov 23 10:0${i % 10}:00 2026
From: Permits <permits${i}@city.example.test>
To: filings@example.test
Subject: ${subject}
Date: Mon, 23 Nov 2026 10:0${i % 10}:00 -0800
MIME-Version: 1.0
${headers}

${body}
`;
}

const qpHtml = (html: string) => html.replace(/=/g, "=3D").replace(/(.{60})/g, "$1=\n");

// 1. A quoted-printable HTML correction letter that ASKS for a signed owner authorization.
const realAsk = message(1, "=?UTF-8?Q?Corrections_required_=E2=80=93_solar_permit?=",
  'Content-Type: multipart/alternative; boundary="b1"',
  `--b1
Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

${qpHtml('<html><head><style>.x{color:red}</style></head><body><div class="x">Your solar permit application for the photovoltaic system was reviewed.</div><p>Please provide the signed owner authorization form before we can continue the building permit review.</p></body></html>')}
--b1--`);

// 2. A footer "signature" on a plain status email: no deficiency.
const footer = message(2, "Solar permit under review", 'Content-Type: text/plain; charset="utf-8"\nContent-Transfer-Encoding: base64',
  Buffer.from("Your solar building permit is under review. If more information is needed we will contact you.\n\n-- \nEmail signature: City Permits Desk. This application form portal is monitored.\n").toString("base64"));

// 3. A PacifiCorp-style notice: assigned, not asked.
const assigned = message(3, "Application assigned", "Content-Type: text/plain",
  "Your customer generation interconnection application has been assigned to an engineer. Owner authorization and signature were received.");

// 4. A generic "additional information is required, log in to view": a real ask, but no specific thing.
const generic = message(4, "Action needed on your interconnection application", "Content-Type: text/plain",
  "Additional information is required for your interconnection application. Please log in to PowerClerk to view the details.");

// 5. The ask is only in the quoted history.
const quoted = message(5, "RE: solar permit", "Content-Type: text/plain",
  "Thanks, the solar permit has been received and is under review.\n\nOn Mon, Nov 2, 2026 at 9:00 AM Permits wrote:\n> Please provide the signed owner authorization. A signature is required.\n");

const mbox = [realAsk, footer, assigned, generic, quoted].join("\n");

// The reader as it was before decoding — frozen here to pin signature continuity (S).
function oldReaderBody(raw: string): { subject: string; date: string; body: string } {
  const cleaned = raw.replace(/^From [^\n]+\n/, "");
  const [rawHeaders, ...bodyParts] = cleaned.split(/\n\n/);
  const h: Record<string, string> = {};
  for (const line of rawHeaders.split("\n")) { const i = line.indexOf(":"); if (i > 0) h[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
  return { subject: h.subject || "", date: h.date || "", body: bodyParts.join("\n\n").replace(/--[a-z0-9_=-]+/gi, "\n").slice(0, 12000) };
}
const v2Signature = (raw: string): string => {
  const o = oldReaderBody(raw.trim());
  return crypto.createHash("sha256").update(`mbox-v2|${LABEL}|${o.subject}|${o.date}|${o.body.replace(/\s+/g, " ").trim().slice(0, 180)}`).digest("hex");
};

await check("D1 quoted-printable HTML reads as text; CSS and tags gone", () => {
  const raw = realAsk.replace(/^From [^\n]+\n/, "");
  const [h, ...b] = raw.split("\n\n");
  const headers: Record<string, string> = {};
  for (const line of h.split("\n")) { const i = line.indexOf(":"); if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
  const text = decodeMimeBody(headers, b.join("\n\n"));
  assert.match(text, /Please provide the signed owner authorization form/);
  assert.doesNotMatch(text, /=3D|<div|color:red|Content-Type/);
});
await check("D2 an encoded-word subject decodes", () => {
  assert.equal(decodeEncodedWords("=?UTF-8?Q?Corrections_required_=E2=80=93_solar_permit?="), "Corrections required – solar permit");
  assert.equal(decodeEncodedWords("=?utf-8?B?UGVybWl0IGlzc3VlZA==?="), "Permit issued");
});
await check("D3 the newest message only: quoted history and signature block left out", () => {
  const t = currentMessageText("Received, thanks.\n\nOn Mon, Nov 2, 2026 at 9:00 AM Desk wrote:\n> Please provide X\n");
  assert.equal(t, "Received, thanks.");
  assert.equal(currentMessageText("Approved.\n-- \nJane Signature, City"), "Approved.");
});

const result = await kb.importMboxKnowledge(db, { orgId: ORG, mboxText: mbox, sourceLabel: LABEL, defaultState: "OR", defaultAhj: "City of Testville", defaultUtility: "Test Power" });
type Rec = { source_signature: string; bucket: string; correction_subcategory: string; sample: string; required_documents_json: string };
const recs = db.query<Rec>("SELECT source_signature, bucket, correction_subcategory, sample, required_documents_json FROM mbox_learning_records");
const bySig = new Map(recs.map((r) => [r.source_signature, r]));
const hfe = () => db.query<{ root_cause: string; sample: string }>("SELECT root_cause, sample FROM historical_failure_examples WHERE source_type = 'mbox'");

await check("S1 every record is signed from the raw subject and body, as the old reader made them", () => {
  for (const raw of [realAsk, footer, assigned, generic, quoted]) assert.ok(bySig.has(v2Signature(raw)), "a record's signature moved");
});
await check("S2 a second import is all duplicates", async () => {
  const again = await kb.importMboxKnowledge(db, { orgId: ORG, mboxText: mbox, sourceLabel: LABEL, defaultState: "OR", defaultAhj: "City of Testville", defaultUtility: "Test Power" });
  assert.equal(again.learningEvents, 0);
  assert.equal(again.failureExamplesImported, 0);
});
await check("R1 exactly one correction example: the signed owner authorization ask", () => {
  const rows = hfe();
  assert.equal(result.failureExamplesImported, 1, JSON.stringify(result.bucketCounts));
  assert.equal(rows.length, 1);
  assert.match(rows[0].root_cause, /Owner Authorization/);
});
await check("R2 the footer, the notice, the generic ask and the quoted ask carry no category or document", () => {
  for (const raw of [footer, assigned, generic, quoted]) {
    const r = bySig.get(v2Signature(raw));
    assert.ok(r, "record missing");
    assert.equal(r!.correction_subcategory, "", `${r!.bucket}: ${r!.correction_subcategory}`);
    assert.equal(r!.required_documents_json, "[]");
  }
});
await check("R3 the stored sample is readable text", () => {
  const r = bySig.get(v2Signature(realAsk))!;
  assert.match(r.sample, /signed owner authorization/i);
  assert.doesNotMatch(r.sample, /Content-Type|=3D|<html|boundary/i);
});

// (L) Make the earlier import look like the old reader's: wrong categories and a junk example per message.
await check("L1 relearn replaces an earlier import's wrong records and examples; dry run writes nothing", async () => {
  db.run("UPDATE mbox_learning_records SET correction_subcategory = 'Owner Authorization', sample = 'Content-Type: text/html'");
  const profile = db.get<{ profile_key: string }>("SELECT profile_key FROM mbox_learning_records LIMIT 1")!.profile_key;
  for (const raw of [footer, assigned, generic]) {
    db.run(`INSERT INTO historical_failure_examples (id, org_id, source_signature, profile_key, state, ahj, utility, portal_name, feature_tags_json,
              outcome, correction_bucket, root_cause, required_action, sample, source_type, source_label, occurred_at, created_at)
            VALUES (?, ?, ?, ?, 'OR', 'City of Testville', 'Test Power', '', '[]', 'correction', 'A_operator_fix', 'Documentation / Owner Authorization', 'x', 'junk', 'mbox', ?, '2026-11-01', '2026-11-01')`,
      [crypto.randomUUID(), ORG, crypto.createHash("sha256").update(v2Signature(raw)).digest("hex"), profile, LABEL]);
  }
  kb.rebuildKnowledgeRollup(db, profile);
  const before = hfe().length;
  assert.equal(before, 4);

  const dry = await kb.relearnMboxKnowledge(db, { orgId: ORG, mboxText: mbox, dryRun: true });
  assert.equal(dry.matched, 5);
  assert.equal(dry.failureExamplesBefore, 4);
  assert.equal(dry.failureExamplesAfter, 1);
  assert.deepEqual(dry.byCategory, { "Owner Authorization": 1 });
  assert.equal(hfe().length, 4, "the dry run wrote");

  const live = await kb.relearnMboxKnowledge(db, { orgId: ORG, mboxText: mbox });
  assert.equal(live.failureExamplesAfter, 1);
  assert.equal(hfe().length, 1);
  const recsAfter = db.query<Rec>("SELECT source_signature, bucket, correction_subcategory, sample, required_documents_json FROM mbox_learning_records");
  assert.equal(recsAfter.filter((r) => r.correction_subcategory === "Owner Authorization").length, 1);
  assert.ok(recsAfter.every((r) => !/Content-Type/.test(r.sample)), "a sample was not replaced");
  const rollup = JSON.parse(db.get<{ common_corrections_json: string }>("SELECT common_corrections_json FROM permit_utility_knowledge WHERE profile_key = ?", [profile])!.common_corrections_json) as Array<{ count: number }>;
  assert.equal(rollup.reduce((n, c) => n + c.count, 0), 1, JSON.stringify(rollup));
});
await check("L2 a message never imported is left alone", async () => {
  const fresh = message(7, "Permit issued", "Content-Type: text/plain", "Your solar permit has been issued.");
  const r = await kb.relearnMboxKnowledge(db, { orgId: ORG, mboxText: fresh });
  assert.equal(r.notImported, 1);
  assert.equal(r.matched, 0);
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall mbox reader checks passed");
process.exit(failed ? 1 : 0);
