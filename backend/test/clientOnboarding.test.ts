// A CLIENT SETS ITSELF UP — AND NOTHING IT TYPES REACHES THE CLIENT RECORD UNTIL A PERSON SAYS SO.
//
// backend/src/clientOnboarding.ts: the staff-minted Company setup link, its draft, its submit, the
// staff accept / edit / reject, the hand-off to the one-time credential link, and the certificates.
//
//   MUST PASS    — a token reads and writes ONLY its own client (rule 6); a bad, expired or revoked
//                  token answers 404; a new link revokes the open one and carries its draft over.
//   MUST PASS    — a submit writes PROPOSALS only; the client record changes on a named person's
//                  accept (as sent or edited), never on a reject; lists are added, never removed.
//   MUST PASS    — the page's "still missing" checklist is the readiness report's own grading.
//   MUST EXCLUDE — a password, security answer or token-shaped value, by key or by shape, anywhere in
//                  a body (rule 2); nothing of it is stored. Portal logins only via the existing
//                  one-time credential link. No model door imports these modules.
//
//   npx tsx backend/test/clientOnboarding.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./_isolate";

process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "onboarding-test-key-not-a-real-secret-0123";
process.env.PUBLIC_BASE_URL = "https://keelix.example.test";
delete process.env.STAFF_ALERT_TO;
delete process.env.STAFF_ALERT_WEBHOOK_URL;

const { openDatabase } = await import("../src/db");
const { createClient, getClient, offboardClient } = await import("../src/clients");
const ob = await import("../src/clientOnboarding");
const readiness = await import("../src/onboardingReadiness");

let failures = 0;
let total = 0;
const check = async (label: string, fn: () => unknown | Promise<unknown>): Promise<void> => {
  total++;
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};
const status = (fn: () => unknown): number => {
  try { fn(); return 200; } catch (e) { return Number((e as { status?: number }).status ?? 500); }
};

const db = await openDatabase();
// Invented companies and places only.
const a = createClient(db, { companyName: "Quillfeather Solar (TEST)", businessState: "ZZ" });
const b = createClient(db, { companyName: "Marrowbank Energy (TEST)", businessEmail: "office@marrowbank.example" });

const A = ob.mintOnboardingLink(db, a.id, { createdBy: "Pat Operator" });
const B = ob.mintOnboardingLink(db, b.id, { createdBy: "Pat Operator" });

await check("mint: a long opaque token, a future expiry, the URL on PUBLIC_BASE_URL; only the token's hash is stored", () => {
  assert.ok(A.token.length >= 40, `token is ${A.token.length} chars`);
  assert.ok(Date.parse(A.expiresAt) > Date.now() + 13 * 86_400_000, "default life is 14 days");
  assert.equal(A.url, `https://keelix.example.test/onboarding?token=${encodeURIComponent(A.token)}`);
  assert.equal(A.linkProblem, null);
  const dump = JSON.stringify(db.query("SELECT * FROM client_onboarding_links"));
  assert.ok(!dump.includes(A.token) && !dump.includes(B.token), "a plaintext token is in the table");
  assert.ok(dump.includes(ob.hashOnboardingToken(A.token)));
});

await check("the go-live link guard: a mint on a base a client cannot open says so", () => {
  const prior = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = "http://localhost:4173";
  const c = createClient(db, { companyName: "Loopback Check (TEST)" });
  const m = ob.mintOnboardingLink(db, c.id, { createdBy: "Pat Operator" });
  process.env.PUBLIC_BASE_URL = prior;
  assert.match(String(m.linkProblem), /localhost|cannot reach/);
});

// ── (1) rule 6: one client's token can neither read nor write another's ──────────────────────────
await check("(1) a token reads only its own client", () => {
  const va = ob.getOnboardingPublic(db, A.token);
  const vb = ob.getOnboardingPublic(db, B.token);
  assert.equal(va.companyName, "Quillfeather Solar (TEST)");
  assert.equal(vb.companyName, "Marrowbank Energy (TEST)");
  assert.ok(!JSON.stringify(va).includes("Marrowbank") && !JSON.stringify(va).includes("marrowbank"), "A's view carries B's data");
  assert.equal(vb.values?.businessEmail, "office@marrowbank.example");
});

await check("(1) a token writes only its own client: A's draft and submit never touch B", () => {
  ob.saveOnboardingDraft(db, A.token, { fields: { businessCity: "Fernhollow" } });
  ob.submitOnboarding(db, A.token, { fields: { businessCity: "Fernhollow", contactName: "Robin Quill" } });
  const bProps = db.query("SELECT * FROM client_onboarding_proposals WHERE client_id = ?", [b.id]);
  assert.equal(bProps.length, 0, "B got a proposal from A's link");
  assert.equal(getClient(db, b.id).businessCity, "");
  assert.equal(ob.getOnboardingPublic(db, B.token).values?.businessCity, "");
});

await check("(1) a token cannot remove another link's certificate, and staff routes for B cannot reach A's proposals", () => {
  const f = ob.addOnboardingFile(db, B.token, { kind: "insurance_certificate", fileName: "coi.pdf", bytes: Buffer.from("%PDF-1.4\n% test\n") });
  const A2 = ob.mintOnboardingLink(db, a.id, { createdBy: "Pat Operator" }); // A's first link was submitted; a fresh one can write
  assert.equal(status(() => ob.removeOnboardingFile(db, A2.token, f.id)), 404);
  assert.equal(ob.listOnboardingProposals(db, b.id).proposals.length, 0);
  const aIds = ob.pendingOnboardingProposalIds(db, a.id);
  assert.ok(aIds.length > 0);
  assert.equal(status(() => ob.decideOnboardingProposals(db, b.id, { accept: aIds }, "Pat Operator")), 404, "B's staff route accepted A's proposal");
  assert.equal(status(() => ob.getOnboardingFile(db, a.id, f.id)), 404, "A reached B's certificate");
  assert.equal(ob.getOnboardingFile(db, b.id, f.id).mime, "application/pdf");
  ob.revokeOnboardingLink(db, a.id, A2.id, "Pat Operator");
});

// ── (2) expiry and revoke ──────────────────────────────────────────────────────────────────────
await check("(2) a bad, revoked or expired token answers 404 with one message; a submitted link reads but refuses writes", () => {
  const c = createClient(db, { companyName: "Expiry Check (TEST)" });
  const m = ob.mintOnboardingLink(db, c.id, { createdBy: "Pat Operator" });
  assert.equal(status(() => ob.getOnboardingPublic(db, "x".repeat(43))), 404);
  assert.equal(status(() => ob.getOnboardingPublic(db, "")), 404);
  db.run("UPDATE client_onboarding_links SET expires_at = ? WHERE id = ?", [new Date(Date.now() - 1000).toISOString(), m.id]);
  assert.equal(status(() => ob.getOnboardingPublic(db, m.token)), 404, "expired link read");
  assert.equal(status(() => ob.saveOnboardingDraft(db, m.token, { fields: { dba: "x" } })), 404, "expired link wrote");
  const m2 = ob.mintOnboardingLink(db, c.id, { createdBy: "Pat Operator" });
  assert.equal(ob.revokeOnboardingLink(db, c.id, m2.id, "Pat Operator").revoked, true);
  assert.equal(status(() => ob.getOnboardingPublic(db, m2.token)), 404, "revoked link read");
  assert.equal(status(() => ob.submitOnboarding(db, m2.token, {})), 404, "revoked link submitted");
  // A's first link was submitted above: it reads its status only, and refuses writes.
  const v = ob.getOnboardingPublic(db, A.token);
  assert.equal(v.status, "submitted");
  assert.equal(v.values, undefined, "a submitted link still shows the answers");
  assert.equal(status(() => ob.saveOnboardingDraft(db, A.token, { fields: { dba: "x" } })), 409);
  const states = ob.listOnboardingLinks(db, c.id).map((l) => l.state);
  // The expired link was still "open" when the second was minted, so the mint revoked it.
  assert.deepEqual(states, ["revoked", "revoked"]);
});

await check("(2) a new link revokes the open one and carries its draft (and certificates) over", () => {
  const c = createClient(db, { companyName: "Carry Over (TEST)" });
  const m1 = ob.mintOnboardingLink(db, c.id, { createdBy: "Pat Operator" });
  ob.saveOnboardingDraft(db, m1.token, { fields: { dba: "Carry On Solar" } });
  ob.addOnboardingFile(db, m1.token, { kind: "bond_certificate", fileName: "bond.png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]) });
  const m2 = ob.mintOnboardingLink(db, c.id, { createdBy: "Pat Operator" });
  assert.equal(status(() => ob.getOnboardingPublic(db, m1.token)), 404, "the replaced link still opens");
  const v = ob.getOnboardingPublic(db, m2.token);
  assert.equal(v.values?.dba, "Carry On Solar");
  assert.equal(v.files?.length, 1);
});

// ── (3) rule 2: the password-field rejection ─────────────────────────────────────────────────────
await check("(3) a password / security answer / token key, at any depth, is refused and nothing is stored", () => {
  const c = createClient(db, { companyName: "Secret Refusal (TEST)" });
  const m = ob.mintOnboardingLink(db, c.id, { createdBy: "Pat Operator" });
  for (const body of [
    { fields: { password: "hunter2" } },
    { fields: { dba: "x" }, securityAnswer: "blue" },
    { fields: { stateLicenses: [{ state: "ZZ", kind: "contractor", number: "1", portalPassword: "x" }] } },
    { fields: { serviceArea: [{ kind: "city", state: "ZZ", name: "Fernhollow", apiToken: "x" }] } },
  ]) {
    assert.equal(status(() => ob.saveOnboardingDraft(db, m.token, body)), 400, JSON.stringify(Object.keys(body.fields)));
    assert.equal(status(() => ob.submitOnboarding(db, m.token, body)), 400);
  }
  const row = db.get<{ draft_json: string }>("SELECT draft_json FROM client_onboarding_links WHERE id = ?", [m.id]);
  assert.equal(row?.draft_json, "{}");
});

await check("(3) a token-shaped, key-shaped, SSN-shaped or labelled secret VALUE is refused too; ordinary answers pass", () => {
  const c = createClient(db, { companyName: "Shape Refusal (TEST)" });
  const m = ob.mintOnboardingLink(db, c.id, { createdBy: "Pat Operator" });
  for (const v of ["sk-ant-api03-abcdefghijklmnop", "ghp_0123456789abcdefABCDEF", "a8F3kq9Zx2Lm7Pq4Wd6Rt1Yv", "123-45-6789", "password: Fernhollow1", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc"]) {
    assert.equal(status(() => ob.saveOnboardingDraft(db, m.token, { fields: { dba: v } })), 400, `accepted ${v.slice(0, 8)}…`);
  }
  for (const v of ["Quillfeather Solar & Roofing LLC", "1200 Example Parkway Suite 300", "permits@quillfeather-solar.example", "(555) 010-0100 x12"]) {
    assert.equal(status(() => ob.saveOnboardingDraft(db, m.token, { fields: { dba: v } })), 200, `refused ${v}`);
  }
  assert.equal(ob.looksSecretShaped("https://permits.example.gov/portal/applications/0123456789abcdef"), false);
});

await check("(3) every question the page asks passes the key check (\"legalBusinessName\" is not \"ssn\"); secret words in any case style do not", () => {
  for (const f of ob.ONBOARDING_FIELDS) assert.equal(status(() => ob.assertNoSecretShapes({ [String(f.key)]: "" })), 200, String(f.key));
  for (const k of ["password", "portalPassword", "security_answer", "securityAnswers", "apiToken", "api_key", "mfaCode", "ssn", "userLogin"]) {
    assert.equal(status(() => ob.assertNoSecretShapes({ [k]: "" })), 400, k);
  }
});

await check("(3) an unknown field is refused (nothing rides in under a name the page does not ask)", () => {
  const c = createClient(db, { companyName: "Unknown Field (TEST)" });
  const m = ob.mintOnboardingLink(db, c.id, { createdBy: "Pat Operator" });
  assert.equal(status(() => ob.saveOnboardingDraft(db, m.token, { fields: { ein: "00-0000000" } })), 400);
  assert.equal(status(() => ob.saveOnboardingDraft(db, m.token, { fields: { billingMode: "monthly" } })), 400);
  assert.equal(status(() => ob.saveOnboardingDraft(db, m.token, { fields: {}, clientId: "other" })), 400);
});

await check("(3) portal logins: the page hands off to the existing one-time credential link, for this client only", () => {
  const c = createClient(db, { companyName: "Portal Handoff (TEST)" });
  const m = ob.mintOnboardingLink(db, c.id, { createdBy: "Pat Operator" });
  const out = ob.requestOnboardingPortalLogins(db, m.token, { portals: [{ portalType: "Fernhollow permits", portalUrl: "https://permits.fernhollow.example.gov/login" }] });
  assert.match(out.path, /^\/credentials\?token=[a-f0-9]{64}$/);
  const reqs = db.query<{ client_id: string; status: string }>("SELECT client_id, status FROM credential_requests WHERE created_by = ?", [`client-onboarding:${m.id}`]);
  assert.deepEqual(reqs.map((r) => [r.client_id, r.status]), [[c.id, "pending"]]);
  assert.equal(db.query("SELECT * FROM portal_credentials WHERE client_id = ?", [c.id]).length, 0, "a credential was stored without the credential link");
  for (const portals of [
    [{ portalType: "x", portalUrl: "https://permits.example.gov/", password: "nope" }],
    [{ portalType: "x", portalUrl: "http://permits.example.gov/" }],
    [{ portalType: "x", portalUrl: "https://user:pw@permits.example.gov/" }],
    [{ portalType: "x", portalUrl: "https://intranet.local/" }],
    [{ portalType: "x", portalUrl: "https://permits.example.gov/?session=abc" }],
  ]) assert.equal(status(() => ob.requestOnboardingPortalLogins(db, m.token, { portals })), 400, JSON.stringify(portals));
  for (let i = 1; i < ob.ONBOARDING_PORTAL_REQUESTS_PER_LINK; i++) ob.requestOnboardingPortalLogins(db, m.token, { portals: [{ portalType: `p${i}`, portalUrl: "https://permits.example.gov/" }] });
  assert.equal(status(() => ob.requestOnboardingPortalLogins(db, m.token, { portals: [{ portalType: "one more", portalUrl: "https://permits.example.gov/" }] })), 429);
});

await check("(3) certificates: PDF / PNG / JPEG only (by their bytes), size and count capped", () => {
  const c = createClient(db, { companyName: "Certificate Caps (TEST)" });
  const m = ob.mintOnboardingLink(db, c.id, { createdBy: "Pat Operator" });
  assert.equal(status(() => ob.addOnboardingFile(db, m.token, { kind: "insurance_certificate", fileName: "x.pdf", bytes: Buffer.from("MZ\x90\x00 not a pdf") })), 415);
  assert.equal(status(() => ob.addOnboardingFile(db, m.token, { kind: "w9", fileName: "x.pdf", bytes: Buffer.from("%PDF-1.4") })), 400);
  assert.equal(status(() => ob.addOnboardingFile(db, m.token, { kind: "insurance_certificate", fileName: "big.pdf", bytes: Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(ob.ONBOARDING_FILE_MAX_BYTES)]) })), 413);
  for (let i = 0; i < ob.ONBOARDING_FILES_PER_LINK; i++) ob.addOnboardingFile(db, m.token, { kind: "other_certificate", fileName: `c${i}.pdf`, bytes: Buffer.from("%PDF-1.4") });
  assert.equal(status(() => ob.addOnboardingFile(db, m.token, { kind: "other_certificate", fileName: "one-more.pdf", bytes: Buffer.from("%PDF-1.4") })), 400);
});

// ── (4) a proposal never overwrites until accepted ────────────────────────────────────────────────
const p = createClient(db, {
  companyName: "Proposal Path (TEST)", businessCity: "Old Town", contactName: "Jamie Stored",
  stateLicenses: [{ state: "ZZ", kind: "contractor", number: "ZZ-C-100" }],
  serviceArea: [{ kind: "city", state: "ZZ", name: "Fernhollow" }],
});
const P = ob.mintOnboardingLink(db, p.id, { createdBy: "Pat Operator" });
const before = JSON.stringify(getClient(db, p.id));
await check("(4) a submit refuses a bad value (an unknown state) and writes nothing", () => {
  assert.equal(status(() => ob.submitOnboarding(db, P.token, { fields: { businessState: "Utahh" } })), 400);
  assert.equal(db.query("SELECT * FROM client_onboarding_proposals WHERE client_id = ?", [p.id]).length, 0);
});
const sent = ob.submitOnboarding(db, P.token, { fields: {
  businessCity: "New Town", contactName: "", dba: "Path Solar", standardDisconnectMake: "Examplecorp",
  stateLicenses: [{ state: "ZZ", kind: "contractor", number: "ZZ-C-100" }, { state: "ZZ", kind: "electrical_contractor", number: "ZZ-E-200", expires: "2028-01-31" }],
  serviceArea: [{ kind: "city", state: "ZZ", name: "Fernhollow" }, { kind: "utility", state: "ZZ", name: "Brightwater Valley Electric" }],
} });

await check("(4) submit: one client-supplied proposal per changed field; blanks and unchanged values make none; the record is untouched", () => {
  assert.equal(sent.submitted, true);
  const props = ob.listOnboardingProposals(db, p.id).proposals;
  assert.deepEqual(props.map((x) => x.field).sort(), ["businessCity", "dba", "serviceArea", "standardDisconnectMake", "stateLicenses"].sort());
  assert.ok(props.every((x) => x.source === "client-supplied" && x.status === "pending"));
  assert.deepEqual((props.find((x) => x.field === "stateLicenses")!.proposed as Array<{ number: string }>).map((l) => l.number), ["ZZ-E-200"], "an unchanged licence was proposed");
  assert.deepEqual((props.find((x) => x.field === "serviceArea")!.proposed as Array<{ name: string }>).map((e) => e.name), ["Brightwater Valley Electric"]);
  assert.equal(JSON.stringify(getClient(db, p.id)), before, "the submit wrote the client record");
});

await check("(4) staff are alerted once (no value in the alert)", () => {
  const rows = db.query<{ kind: string; ref: string; body: string }>("SELECT kind, ref, body FROM staff_notifications WHERE kind = 'client_onboarding' AND ref = ?", [P.id]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].body, /Proposal Path \(TEST\)/);
  assert.ok(!/New Town|Path Solar|ZZ-E-200|Examplecorp/.test(rows[0].body), "the alert carries a value");
});

await check("(4) a reject changes nothing; an accept writes through updateClient; an edit writes the person's value; each is audited without the value", () => {
  const props = ob.listOnboardingProposals(db, p.id).proposals;
  const id = (f: string) => props.find((x) => x.field === f)!.id;
  ob.decideOnboardingProposals(db, p.id, { reject: [id("dba")] }, "Pat Operator");
  assert.equal(getClient(db, p.id).dba, "");
  assert.equal(status(() => ob.decideOnboardingProposals(db, p.id, { edits: { [id("businessCity")]: "not-a-state-is-fine-but-this-is-long".repeat(10) } }, "Pat Operator")), 400, "a 400-char edit was accepted");
  assert.equal(getClient(db, p.id).businessCity, "Old Town", "a refused decision wrote");
  const out = ob.decideOnboardingProposals(db, p.id, {
    accept: [id("standardDisconnectMake"), id("stateLicenses"), id("serviceArea")],
    edits: { [id("businessCity")]: "Newer Town" },
  }, "Pat Operator");
  assert.equal(out.accepted, 4);
  const c = getClient(db, p.id);
  assert.equal(c.businessCity, "Newer Town");
  assert.equal(c.standardDisconnectMake, "Examplecorp");
  assert.equal(c.contactName, "Jamie Stored", "a blank answer blanked a stored value");
  assert.deepEqual(c.stateLicenses!.map((l) => l.number).sort(), ["ZZ-C-100", "ZZ-E-200"], "a stored licence was removed");
  assert.deepEqual(c.serviceArea!.map((e) => e.name).sort(), ["Brightwater Valley Electric", "Fernhollow"]);
  const all = ob.listOnboardingProposals(db, p.id, { all: true }).proposals;
  assert.equal(all.find((x) => x.field === "businessCity")!.status, "edited");
  assert.equal(all.find((x) => x.field === "dba")!.status, "rejected");
  assert.ok(all.every((x) => x.decidedBy === "Pat Operator"));
  const audit = db.query<{ action: string; actor_name: string; details: string }>("SELECT action, actor_name, details FROM audit_logs WHERE action LIKE 'client.onboarding_proposal_%'");
  assert.equal(audit.filter((r) => r.details.includes(p.id)).length, 5);
  assert.ok(audit.every((r) => r.actor_name === "Pat Operator"));
  assert.ok(!audit.some((r) => /Newer Town|Examplecorp|ZZ-E-200/.test(r.details)), "an audit row carries a value");
  assert.equal(status(() => ob.decideOnboardingProposals(db, p.id, { accept: [id("dba")] }, "Pat Operator")), 404, "a decided proposal was decided again");
});

// ── (5) readiness lines ────────────────────────────────────────────────────────────────────────
await check("(5) the checklist is the readiness grading: a NEM place makes the disconnect and the electrical licence needed", () => {
  const c = createClient(db, { companyName: "Checklist Path (TEST)" });
  const m = ob.mintOnboardingLink(db, c.id, { createdBy: "Pat Operator" });
  let v = ob.getOnboardingPublic(db, m.token);
  assert.ok(v.checklist.some((l) => l.key === "serviceArea" && l.level === "fail"), JSON.stringify(v.checklist));
  const saved = ob.saveOnboardingDraft(db, m.token, { fields: { serviceArea: [{ kind: "utility", state: "ZZ", name: "Brightwater Valley Electric" }, { kind: "city", state: "ZZ", name: "Fernhollow" }] } });
  const keys = (lines: typeof saved.checklist) => lines.filter((l) => l.level === "fail").map((l) => l.key);
  assert.ok(keys(saved.checklist).includes("standardDisconnectMake"));
  assert.ok(keys(saved.checklist).includes("licence:ZZ:contractor"));
  assert.ok(keys(saved.checklist).includes("licence:ZZ:nem-electrical"));
  assert.ok(!keys(saved.checklist).includes("serviceArea"));
  assert.ok(saved.checklist.every((l) => !/client row|Clients →|licenceFor|overlay|[A-Z]{2}-[A-Z]-\d/.test(l.text)), "internal detail in a client line");
  const filled = ob.saveOnboardingDraft(db, m.token, { fields: {
    serviceArea: [{ kind: "utility", state: "ZZ", name: "Brightwater Valley Electric" }, { kind: "city", state: "ZZ", name: "Fernhollow" }],
    standardDisconnectMake: "Examplecorp", standardDisconnectModel: "EX-30",
    stateLicenses: [{ state: "ZZ", kind: "contractor", number: "ZZ-C-1" }, { state: "ZZ", kind: "electrical_contractor", number: "ZZ-E-2" }],
  } });
  for (const k of ["standardDisconnectMake", "standardDisconnectModel", "licence:ZZ:contractor", "licence:ZZ:nem-electrical"]) assert.ok(!keys(filled.checklist).includes(k), `${k} still needed`);
  v = ob.getOnboardingPublic(db, m.token);
  assert.deepEqual(keys(v.checklist), keys(filled.checklist), "a reload reads the same checklist");
  // Same grading as the report: the report's licence checks for the same record and place say the same.
  const record = { ...getClient(db, c.id), stateLicenses: [{ state: "ZZ", kind: "contractor", number: "ZZ-C-1" }] };
  const scoped = readiness.readinessScopes(record, readiness.jurisdictionsFromServiceArea([{ kind: "utility", state: "ZZ", name: "X" }]));
  const lc = readiness.licenceChecks(record, scoped.scopes[0]);
  assert.equal(lc.find((x) => x.key === "licence:ZZ:nem-electrical")!.level, "fail");
});

await check("(5) a permit-only area does not make the disconnect a blocker (the report's own rule)", () => {
  const lines = readiness.clientOnboardingChecklist({ companyName: "Permit Only (TEST)", serviceArea: [{ kind: "city", state: "ZZ", name: "Fernhollow" }] }, readiness.jurisdictionsFromServiceArea([{ kind: "city", state: "ZZ", name: "Fernhollow" }]));
  const d = lines.find((l) => l.key === "standardDisconnectMake");
  assert.ok(d && d.level === "warn", JSON.stringify(lines));
  assert.ok(!lines.some((l) => l.key === "licence:ZZ:nem-electrical"));
});

// ── (6) no model, no log, and the purge ───────────────────────────────────────────────────────────
await check("(6) no model door imports the onboarding modules, and they import none", () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|mts)$/.test(e.name) && !/\.test\.ts$|\.smoke\.ts$/.test(e.name)) files.push(rel);
    }
  };
  for (const d of ["backend/src", "portal-bot/src", "shared/src"]) walk(d);
  const importers = files.filter((f) => /from\s+["'][^"']*\/clientOnboarding["']|import\(["'][^"']*\/clientOnboarding["']\)/.test(fs.readFileSync(path.join(REPO, f), "utf8"))).sort();
  assert.deepEqual(importers, ["backend/src/server.ts"]);
  for (const f of ["backend/src/clientOnboarding.ts", "backend/src/onboardingReadiness.ts", "backend/src/publicRateLimit.ts"]) {
    const src = fs.readFileSync(path.join(REPO, f), "utf8");
    assert.ok(!/from\s+["'][^"']*(?:\/llm|modelPayloadScan|reviewerVision|billVision|@anthropic-ai)[^"']*["']/.test(src), `${f} imports a model door`);
    assert.ok(!/logger\./.test(src), `${f} writes a log line`);
  }
});

await check("(6) offboarding a client purges its links, proposals and certificates", async () => {
  await offboardClient(db, b.id, { confirm: b.id, actor: "Pat Operator" });
  for (const t of ["client_onboarding_links", "client_onboarding_proposals", "client_onboarding_files"]) {
    assert.equal(db.query(`SELECT * FROM ${t} WHERE client_id = ?`, [b.id]).length, 0, t);
  }
});

console.log(failures === 0 ? `\nclientOnboarding: all ${total} checks passed.` : `\nclientOnboarding: ${failures}/${total} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
