// HOW A CLIENT SAYS IT FILES WITH EACH AUTHORITY (brief client-filing-details; clientFilingStatements.ts,
// clientOnboarding.ts, filingDestinationProposals.ts, frontend/filing-destination.js).
//
// On the Company setup page a client may say, per authority its service area names, the portal address
// or intake email it uses, whether it holds an account there (yes/no, never the login) and an example
// record number. Pinned here, on invented authorities (state ZZ):
//   (a) the page is told NAMES only (key, kind, name, state) for the authorities the stored area and
//       the draft's typed places name; nothing on file about any of them rides along;
//   (b) a login never rides in a filing row: a password-shaped key or value is refused (rule 2); an
//       address with a user name in it, a place not in the area and a non-address are named and not stored;
//   (c) NOTHING A CLIENT SAYS BECOMES A DOOR: submit stores the client's own rows only — no knowledge
//       row, no filing-email record, no verified channel; the job's track still reads unverified;
//   (d) it shows as a "client-supplied" proposal on THAT client's jobs and service area only (another
//       client's job on the same authority shows none), never official, and one-click Confirm is REFUSED
//       by the unchanged decideFilingDestination; a named person's own statement (Edit) is what verifies;
//   (e) the same refusals as every door before it shows: a utility portal on a permit authority (rule 5),
//       an information page and a personal mailbox are listed as not proposed, with why;
//   (f) a client answer NEVER replaces a person-verified door: a different address is a conflict beside
//       the verified record (which is byte-identical after), an agreeing answer is no conflict, and a
//       named person can set the answer aside (audited);
//   (g) an answer that names the address a cited proposal already carries adds no second card and
//       leaves that proposal one-click confirmable;
//   (h) READING WRITES NOTHING: the page view, the job's destinations and the queue leave total_changes()
//       where it was;
//   (i) a rejected client-supplied proposal is not offered again; offboarding purges the statements;
//   (j) only the Company setup module, the proposals module and server.ts import the statements module
//       (nothing that decides a channel, stages or sends can read a client's answer);
//   (k) the view (node:vm): a client-supplied card is marked, escaped, has no quoted page and a disabled
//       Confirm; a conflict shows both sides and a Set aside button naming the client and statement.
//   npx tsx backend/test/clientFilingDetails.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { REPO } from "./_isolate";
import { removeTempDir } from "./_tmpdir";

let failures = 0;
let total = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  total++;
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "client-filing-details-"));
const AHJ_A = "City of Fernhollow";    // cites its own official portal (a one-click proposal)
const AHJ_B = "Town of Alderbank";     // nothing on file to propose
const AHJ_V = "Village of Quillmere";  // a person already verified its door
const UTIL_A = "Brightwater Valley Electric";
const A_PAGE = "https://www.fernhollow-zz.gov/building/solar";
const A_PORTAL = "https://permits.fernhollow-zz.gov/apply";
const B_SAID = "https://permits.alderbank-zz.gov/online";
const V_VERIFIED = "https://permits.quillmere-zz.gov/apply";
const V_SAID = "https://quillmere-permits.example.test/start";
const UTILITY_PORTAL = "https://brightwater.powerclerk.com/MvcAccount/Login";
const READ_AT = "2026-11-10T08:19:28Z";
const blankProfile = (ahj: string) => ({
  state: "ZZ", ahj, submissionMethod: "", timeline: "",
  requiresElectricianSign: false, requiresElectricalStamp: false, requiresStructuralStamp: false,
  requiresElectricalPermitApplication: false, requiresBuildingPermitApplication: false, requiresSolarChecklist: false,
  requiresPlanSet: true, requiresUtilityApproval: false, requiresCustomerSignature: false, requiresFloodplainCheck: false,
  requiresJurisdictionCheck: false, otherRequirements: "", reviewerNotes: "", sourceSheet: "ZZ synthetic",
});
const refPath = path.join(tmpDir, "reference-ahj-processes.json");
fs.writeFileSync(refPath, JSON.stringify({
  generatedFrom: "clientFilingDetails.test", count: 3,
  profiles: [
    { ...blankProfile(AHJ_A), submissionMethod: "Online portal", citations: [{ field: "submissionMethod", value: A_PORTAL.replace(/^https:\/\//, ""), sourceUrl: A_PAGE, quote: "Apply online at permits.fernhollow-zz.gov", fetchedAt: READ_AT }] },
    blankProfile(AHJ_B),
    blankProfile(AHJ_V),
  ],
}));
process.env.AHJ_PROCESS_REFERENCE_PATH = refPath;
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PERMIT_PROCESS_LOOKUP = "off";
process.env.ANTHROPIC_API_KEY = "";
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";
process.env.PUBLIC_BASE_URL = "https://keelix.example.test";
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
for (const k of ["STAFF_ALERT_TO", "STAFF_ALERT_WEBHOOK_URL", "SMTP_HOST"]) delete process.env[k];

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { createClient, updateClient, getClient, offboardClient } = await import("../src/clients");
const repo = await import("../src/repository");
const fdp = await import("../src/filingDestinationProposals");
const onb = await import("../src/clientOnboarding");
const cfs = await import("../src/clientFilingStatements");
const tracksMod = await import("../src/submittalTracks");
const kb = await import("../src/knowledgeBase");
const db = await openDatabase();

const PERSON = "Pat Synthetic";
const AREA = [
  { kind: "city" as const, state: "ZZ", name: "Fernhollow" },
  { kind: "city" as const, state: "ZZ", name: "Alderbank" },
  { kind: "city" as const, state: "ZZ", name: "Quillmere" },
];
const clientOne = createClient(db, { companyName: "Filing One Solar (TEST)" });
const clientTwo = createClient(db, { companyName: "Filing Two Solar (TEST)" });
updateClient(db, clientOne.id, { serviceArea: AREA });
const mk = (clientId: string, ahj: string, owner: string) =>
  repo.createProject(db, { clientId, owner, street: "1 Test Way", city: "Fernhollow", state: "ZZ", zip: "99999", ahj, utility: "" } as never).project.id as string;
const jobOneB = mk(clientOne.id, AHJ_B, "Synthetic Owner One");
const jobTwoB = mk(clientTwo.id, AHJ_B, "Synthetic Owner Two");
const jobOneV = mk(clientOne.id, AHJ_V, "Synthetic Owner Three");
kb.saveVerifiedAhjProfile(db, { state: "ZZ", ahj: AHJ_V, portalUrl: V_VERIFIED, notes: "synthetic verified door", verifiedBy: PERSON } as never);

const project = (id: string) => repo.getProjectDetail(db, id).project;
const readTracks = (p: Parameters<typeof tracksMod.getSubmittalTracks>[1]) => tracksMod.getSubmittalTracks(db, p);
const destinations = (id: string) => fdp.filingDestinationsFor(db, project(id), readTracks(project(id)));
const group = (id: string, name: string) => destinations(id).find((g) => g.authority.name === name)!;
const queue = () => fdp.filingDestinationQueue(db, DEFAULT_ORG_ID, readTracks);
const changes = () => (db.get<{ n: number }>("SELECT total_changes() AS n")?.n ?? 0);
const ctx = { filingAuthorities: (clientId: string, draftArea: Parameters<typeof fdp.clientFilingAuthorities>[2]) => fdp.clientFilingAuthorities(db, clientId, draftArea) };
const statements = (clientId: string) => db.query<{ authority_name: string; kind: string; address: string; status: string; has_account: string; example_number: string }>(
  "SELECT authority_name, kind, address, status, has_account, example_number FROM client_filing_statements WHERE client_id = ? ORDER BY created_at, rowid", [clientId]);
const knowledgeSnapshot = () => JSON.stringify(db.query("SELECT * FROM permit_utility_knowledge ORDER BY id"));
const authorities = fdp.clientFilingAuthorities(db, clientOne.id);
const keyOf = (name: string): string => {
  const a = fdp.clientFilingAuthorities(db, clientOne.id, [{ kind: "utility", state: "ZZ", name: UTIL_A }]).find((x) => x.name === name);
  assert.ok(a, `setup: ${name} is not among the client's authorities`);
  return a.key;
};
const mint = (clientId: string) => onb.mintOnboardingLink(db, clientId, { createdBy: PERSON }).token;

await check("(a) the page is told names only, for the stored area and the draft's typed places", () => {
  assert.deepEqual(authorities.map((a) => a.name).sort(), [AHJ_A, AHJ_B, AHJ_V].sort());
  const token = mint(clientOne.id);
  const v = onb.getOnboardingPublic(db, token, ctx);
  assert.deepEqual(v.filingAuthorities!.map((a) => Object.keys(a).sort().join(",")), ["key,kind,name,state", "key,kind,name,state", "key,kind,name,state"]);
  assert.ok(!JSON.stringify(v).includes("fernhollow-zz.gov"), "what is on file for an authority reached the page");
  assert.ok(!JSON.stringify(v).includes("quillmere-zz.gov"), "a verified door reached the page");
  // A place typed in the draft (not yet accepted by staff) is listed once the draft is saved.
  const saved = onb.saveOnboardingDraft(db, token, { fields: { serviceArea: [...AREA, { kind: "utility", state: "ZZ", name: UTIL_A }] } }, ctx);
  assert.ok(saved.filingAuthorities.some((a) => a.kind === "utility" && a.name === UTIL_A), JSON.stringify(saved.filingAuthorities));
  // Without the resolver (no context) the page asks about none.
  assert.deepEqual(onb.getOnboardingPublic(db, token).filingAuthorities, []);
});

await check("(b) a login never rides in a filing row; a bad row is named and not stored", () => {
  const token = mint(clientOne.id);
  const B = keyOf(AHJ_B);
  for (const row of [
    { authorityKey: B, address: B_SAID, password: "hunter2-not-real" },
    { authorityKey: B, address: B_SAID, example: "password: hunter2-not-real" },
    { authorityKey: B, address: B_SAID, loginName: "pat" },
  ]) {
    assert.throws(() => onb.saveOnboardingDraft(db, token, { fields: { filing: [row] } }, ctx), (e: { status?: number }) => e.status === 400, JSON.stringify(row));
  }
  const bad = onb.saveOnboardingDraft(db, token, { fields: { filing: [
    { authorityKey: B, address: "https://pat:pw@permits.alderbank-zz.gov/online" },
    { authorityKey: "ahj|zz|nowhere", address: B_SAID },
    { authorityKey: keyOf(AHJ_A), address: "by the front desk" },
  ] } }, ctx);
  assert.equal(bad.problems.length, 3, JSON.stringify(bad.problems));
  assert.match(bad.problems.join(" "), /without a user name or password/);
  assert.match(bad.problems.join(" "), /not in your service area/);
  assert.throws(() => onb.submitOnboarding(db, token, {}, ctx), (e: { status?: number }) => e.status === 400);
  assert.equal(statements(clientOne.id).length, 0, "a refused row was stored");
});

let tokenOne = "";
await check("(c) nothing a client says becomes a door: submit stores the client's own rows only", () => {
  tokenOne = mint(clientOne.id);
  const kbBefore = knowledgeSnapshot();
  const lookupsBefore = JSON.stringify([db.query("SELECT * FROM permit_process_lookups"), db.query("SELECT * FROM utility_filing_lookups")]);
  const out = onb.submitOnboarding(db, tokenOne, { fields: { filing: [
    { authorityKey: keyOf(AHJ_B), address: "permits.alderbank-zz.gov/online", hasAccount: "yes", example: "BLD-2026-00123" },
    { authorityKey: keyOf(AHJ_V), address: V_SAID, hasAccount: "no" },
  ] } }, ctx);
  assert.equal(out.filingAnswers, 2);
  assert.deepEqual(statements(clientOne.id).map((s) => [s.authority_name, s.kind, s.address, s.status, s.has_account, s.example_number]), [
    [AHJ_B, "portal", B_SAID, "current", "yes", "BLD-2026-00123"],
    [AHJ_V, "portal", V_SAID, "current", "no", ""],
  ]);
  assert.equal(knowledgeSnapshot(), kbBefore, "a client's answer wrote a knowledge row");
  assert.equal(JSON.stringify([db.query("SELECT * FROM permit_process_lookups"), db.query("SELECT * FROM utility_filing_lookups")]), lookupsBefore, "a client's answer wrote a lookup row");
  for (const t of readTracks(project(jobOneB))) assert.notEqual(t.channelBasis, "verified", `${t.type} reads verified after a client's answer`);
  assert.ok(!JSON.stringify(readTracks(project(jobOneB))).includes("alderbank-zz.gov"), "a track view carries the client's address");
  // The audit row carries counts only.
  const audit = JSON.stringify(db.query("SELECT details FROM audit_logs WHERE action = 'client.onboarding_submitted'"));
  assert.ok(!audit.includes("alderbank") && !audit.includes("BLD-2026"), "the audit row carries a client's answer");
});

let suppliedId = "";
await check("(d) a client-supplied proposal on THAT client's job only; one-click Confirm is refused; a person's own statement verifies", () => {
  const g = group(jobOneB, AHJ_B);
  assert.equal(g.status, "proposed");
  assert.equal(g.proposals.length, 1);
  const p = g.proposals[0];
  suppliedId = p.id;
  assert.deepEqual([p.from, p.kind, p.address, p.official, p.sourceUrl, p.quote], ["client_supplied", "portal", B_SAID, false, "", ""]);
  assert.ok(p.problems.length > 0 && /client told us/.test(p.problems[0]), JSON.stringify(p.problems));
  assert.deepEqual([p.clientSupplied?.hasAccount, p.clientSupplied?.example], ["yes", "BLD-2026-00123"]);
  // RULE 6: another client's job on the same authority sees nothing of it.
  const other = group(jobTwoB, AHJ_B);
  assert.equal(other.proposals.length, 0, JSON.stringify(other.proposals));
  assert.ok(!JSON.stringify(destinations(jobTwoB)).includes("BLD-2026"), "another client's job shows this client's example number");
  // The queue: under client one only.
  const q = queue();
  const one = q.clients.find((c) => c.clientId === clientOne.id)!.authorities.find((a) => a.authority.name === AHJ_B)!;
  assert.deepEqual(one.proposals.map((x) => x.from), ["client_supplied"]);
  const two = q.clients.find((c) => c.clientId === clientTwo.id)!.authorities.find((a) => a.authority.name === AHJ_B)!;
  assert.equal(two.proposals.length, 0);
  // The EXISTING Confirm path refuses it (it has no page and no words): nothing is written.
  const kbBefore = knowledgeSnapshot();
  const track = g.tracks[0];
  assert.throws(
    () => fdp.decideFilingDestination(db, project(jobOneB), readTracks(project(jobOneB)), { track, proposalId: p.id, kind: p.kind, address: p.address, sourceUrl: p.sourceUrl, quote: p.quote }, PERSON),
    (e: { status?: number; message?: string }) => e.status === 409 && /cannot be confirmed/.test(String(e.message)),
  );
  // An Edit without the page and its words is refused too (the person's own check).
  assert.throws(
    () => fdp.decideFilingDestination(db, project(jobOneB), readTracks(project(jobOneB)), { track, kind: "portal", address: p.address, sourceUrl: "", quote: "" }, PERSON),
    (e: { status?: number }) => e.status === 400,
  );
  assert.equal(knowledgeSnapshot(), kbBefore, "a refused confirm wrote");
});

await check("(e) the same refusals as every door before it shows", () => {
  const authority = { kind: "ahj" as const, state: "ZZ", name: AHJ_B, table: "permit_process_lookups" as const, profileKey: group(jobOneB, AHJ_B).authority.profileKey };
  const refusals = (kind: "portal" | "email", address: string) => fdp.clientStatementRefusals(db, authority as never, "building", { kind, address });
  assert.match(refusals("portal", UTILITY_PORTAL).join(" "), /utility interconnection portal, not a permit portal \(rule 5\)/);
  assert.match(refusals("portal", "https://www.alderbank-zz.gov/forms/solar-checklist.pdf").join(" "), /information page/);
  assert.match(refusals("email", "alderbank.permits@gmail.com").join(" "), /personal mailbox provider/);
  assert.deepEqual(refusals("portal", B_SAID), []);
  assert.deepEqual(refusals("email", "permits@alderbank-zz.gov"), []);
  // In the read: a refused answer is listed as not proposed, with why, and is not a card.
  db.run("UPDATE client_filing_statements SET address = ? WHERE client_id = ? AND authority_name = ?", [UTILITY_PORTAL, clientOne.id, AHJ_B]);
  const g = group(jobOneB, AHJ_B);
  assert.equal(g.proposals.length, 0);
  assert.ok(g.skipped.some((s) => s.includes("the client's own answer") && /rule 5/.test(s)), JSON.stringify(g.skipped));
  db.run("UPDATE client_filing_statements SET address = ? WHERE client_id = ? AND authority_name = ?", [B_SAID, clientOne.id, AHJ_B]);
});

await check("(f) a client answer never replaces a verified door: a difference is a conflict; an agreeing answer is none; set aside is audited", () => {
  const kbBefore = knowledgeSnapshot();
  const g = group(jobOneV, AHJ_V);
  assert.equal(g.status, "verified");
  assert.equal(g.proposals.length, 0);
  assert.deepEqual(g.conflicts?.map((c) => [c.kind, c.address, c.hasAccount]), [["portal", V_SAID, "no"]]);
  const q = queue();
  const cl = q.clients.find((c) => c.clientId === clientOne.id)!;
  assert.deepEqual(cl.conflicts?.map((c) => [c.authority.name, c.conflicts.length]), [[AHJ_V, 1]]);
  assert.ok(!cl.authorities.some((a) => a.authority.name === AHJ_V), "a verified authority is listed as waiting");
  assert.equal(q.counts.conflicts, 1);
  assert.match(String(readTracks(project(jobOneV)).find((t) => t.channelBasis === "verified")?.channel ?? ""), /./, "the verified door no longer reads verified");
  assert.equal(knowledgeSnapshot(), kbBefore, "reading a conflict wrote the knowledge base");
  // An answer naming the verified portal's own host is no conflict.
  db.run("UPDATE client_filing_statements SET address = ? WHERE client_id = ? AND authority_name = ?", [`${V_VERIFIED}/login`, clientOne.id, AHJ_V]);
  assert.equal(group(jobOneV, AHJ_V).conflicts, undefined);
  db.run("UPDATE client_filing_statements SET address = ? WHERE client_id = ? AND authority_name = ?", [V_SAID, clientOne.id, AHJ_V]);
  // Set aside: a named person; the other client cannot reach it; the verified record is untouched.
  const sid = g.conflicts![0].statementId;
  assert.throws(() => cfs.dismissFilingStatement(db, clientOne.id, sid, " "), (e: { status?: number }) => e.status === 400);
  assert.deepEqual(cfs.dismissFilingStatement(db, clientTwo.id, sid, PERSON), { dismissed: false });
  assert.deepEqual(cfs.dismissFilingStatement(db, clientOne.id, sid, PERSON), { dismissed: true });
  assert.equal(group(jobOneV, AHJ_V).conflicts, undefined);
  assert.equal(queue().counts.conflicts, 0);
  assert.equal(knowledgeSnapshot(), kbBefore, "setting an answer aside wrote the knowledge base");
  const audit = db.query<{ actor_name: string }>("SELECT actor_name FROM audit_logs WHERE action = 'client.filing_statement_dismissed'");
  assert.deepEqual(audit.map((a) => a.actor_name), [PERSON]);
});

await check("(g) an answer naming a cited proposal's address adds no second card; that proposal stays one-click", () => {
  const jobOneA = mk(clientOne.id, AHJ_A, "Synthetic Owner Four");
  const before = group(jobOneA, AHJ_A);
  assert.deepEqual(before.proposals.map((p) => [p.from, p.address, p.problems.length]), [["reference", A_PORTAL, 0]]);
  db.transaction(() => cfs.recordFilingStatements(db, { clientId: clientOne.id, linkId: "", answers: [{ authorityKey: keyOf(AHJ_A), kind: "portal", address: `${A_PORTAL}/`, hasAccount: "yes", example: "" }], authorities: fdp.clientFilingAuthorities(db, clientOne.id) }));
  const after = group(jobOneA, AHJ_A);
  assert.deepEqual(after.proposals.map((p) => [p.from, p.address, p.problems.length, p.clientSupplied?.hasAccount]), [["reference", A_PORTAL, 0, "yes"]]);
  assert.equal(after.proposals[0].id, before.proposals[0].id, "the cited proposal's id changed");
});

await check("(h) reading writes nothing: the page view, a job's destinations and the queue", () => {
  const token = mint(clientTwo.id);
  const n = changes();
  onb.getOnboardingPublic(db, token, ctx);
  fdp.clientFilingAuthorities(db, clientOne.id, [{ kind: "utility", state: "ZZ", name: UTIL_A }]);
  destinations(jobOneB); destinations(jobOneV); destinations(jobTwoB);
  queue();
  cfs.listFilingStatements(db, clientOne.id);
  onb.listOnboardingProposals(db, clientOne.id);
  assert.equal(changes(), n, "a read wrote");
});

await check("(d) a named person's own statement (Edit) is what verifies; the answer then agrees and the authority leaves the queue", () => {
  const g = group(jobOneB, AHJ_B);
  const r = fdp.decideFilingDestination(db, project(jobOneB), readTracks(project(jobOneB)), {
    track: g.tracks[0], kind: "portal", address: B_SAID, sourceUrl: "https://www.alderbank-zz.gov/building", quote: "Apply online at permits.alderbank-zz.gov",
  }, PERSON);
  assert.equal(r.action, "stated");
  const after = group(jobOneB, AHJ_B);
  assert.equal(after.status, "verified");
  assert.equal(after.conflicts, undefined, "the client's agreeing answer reads as a conflict");
  assert.ok(!queue().clients.some((c) => c.authorities.some((a) => a.authority.name === AHJ_B)));
});

await check("(i) a rejected client-supplied proposal is not offered again; offboarding purges the statements", async () => {
  const clientThree = createClient(db, { companyName: "Filing Three Solar (TEST)" });
  updateClient(db, clientThree.id, { serviceArea: [{ kind: "city", state: "ZZ", name: "Fernhollow" }] });
  const a = fdp.clientFilingAuthorities(db, clientThree.id);
  const OTHER = "https://apply.fernhollow-zz.gov/solar";
  db.transaction(() => cfs.recordFilingStatements(db, { clientId: clientThree.id, linkId: "", answers: [{ authorityKey: a[0].key, kind: "portal", address: OTHER, hasAccount: "", example: "" }], authorities: a }));
  const areaQueue = () => queue().clients.find((c) => c.clientId === clientThree.id)!.authorities.find((x) => x.authority.name === AHJ_A)!;
  const shown = areaQueue();
  const supplied = shown.proposals.find((p) => p.from === "client_supplied")!;
  assert.equal(supplied.address, OTHER);
  assert.ok(supplied.areaAct, "a service-area proposal carries its client route");
  const job = fdp.serviceAreaDecisionJob(db, { id: clientThree.id }, { entryKey: supplied.areaAct!.entryKey, authorityKey: supplied.areaAct!.authorityKey, track: supplied.areaAct!.track });
  fdp.rejectFilingDestination(db, job, readTracks(job), { track: supplied.areaAct!.track, proposalId: supplied.id, reason: "not theirs" }, PERSON);
  assert.ok(!areaQueue().proposals.some((p) => p.from === "client_supplied"), "a rejected client-supplied proposal is still offered");
  await offboardClient(db, clientThree.id, { confirm: clientThree.id, actor: PERSON } as never);
  assert.equal(statements(clientThree.id).length, 0, "offboarding left the client's filing answers");
  assert.ok(getClient(db, clientOne.id), "setup: client one is gone");
});

await check("(j) only the Company setup module, the proposals module and server.ts import the statements module", () => {
  const importers: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (!/\.(?:ts|js)$/.test(e.name) || e.name.endsWith(".test.ts")) continue;
      if (/(?:from\s+|import\(\s*)["'][^"']*clientFilingStatements["']/.test(fs.readFileSync(p, "utf8"))) importers.push(path.relative(REPO, p).replace(/\\/g, "/"));
    }
  };
  for (const d of ["backend/src", "portal-bot/src", "shared/src", "scripts"]) walk(path.join(REPO, d));
  assert.deepEqual(importers.sort(), ["backend/src/clientOnboarding.ts", "backend/src/filingDestinationProposals.ts", "backend/src/server.ts"]);
  // And the statements table is read nowhere else by name.
  const readers: string[] = [];
  const scan = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") scan(p); continue; }
      if (/\.ts$/.test(e.name) && !e.name.endsWith(".test.ts") && fs.readFileSync(p, "utf8").includes("client_filing_statements")) readers.push(path.relative(REPO, p).replace(/\\/g, "/"));
    }
  };
  for (const d of ["backend/src", "portal-bot/src", "shared/src"]) scan(path.join(REPO, d));
  assert.deepEqual(readers.sort(), ["backend/src/clientFilingStatements.ts", "backend/src/clients.ts", "backend/src/db.ts"]);
});

await check("(k) the view: a client-supplied card is marked, escaped, without a quoted page and with Confirm disabled; a conflict shows both sides", () => {
  const sandbox: Record<string, unknown> = { module: { exports: {} }, globalThis: {} };
  vm.runInNewContext(fs.readFileSync(path.join(REPO, "frontend/filing-destination.js"), "utf8"), sandbox);
  const FD = (sandbox.module as { exports: { renderQueue: (q: unknown) => string } }).exports;
  const authority = { kind: "ahj", name: "Town of <b>Alderbank</b>", state: "ZZ", profileKey: "zz|alderbank" };
  const html = FD.renderQueue({
    counts: { authorities: 1, oneClick: 0, editOnly: 1, noProposal: 0, alreadyVerified: 1, conflicts: 1 },
    clients: [{
      clientId: "client-1", clientName: "Filing One Solar (TEST)",
      authorities: [{
        authority, tracks: ["building"], status: "proposed", jobs: [], open: null, rejected: [], skipped: [], handCheck: [],
        proposals: [{ id: "p1", kind: "portal", address: 'https://permits.alderbank-zz.gov/"><script>x</script>', sourceUrl: "", sourceHost: "", quote: "", fetchedAt: READ_AT, from: "client_supplied", official: false, quoteNamesAddress: false,
          problems: ["the client told us this"], clientSupplied: { statementId: "s1", hasAccount: "yes", example: "BLD-<i>1</i>", statedAt: READ_AT }, act: { projectId: "job-1", track: "building" } }],
      }],
      conflicts: [{ authority: { kind: "ahj", name: AHJ_V, state: "ZZ", profileKey: "zz|quillmere" }, verified: `Online portal ${V_VERIFIED}`, conflicts: [{ statementId: "s2", kind: "portal", address: V_SAID, hasAccount: "no", example: "", statedAt: READ_AT }] }],
    }],
  });
  assert.ok(!html.includes("<script>") && !html.includes("<b>Alderbank</b>") && !html.includes("<i>1</i>"), "a value reached the page unescaped");
  assert.match(html, /Client-supplied — not yet confirmed/);
  assert.match(html, /data-fd-client-supplied/);
  assert.ok(!html.includes("<blockquote"), "a client-supplied card quotes a page it never had");
  assert.match(html, /data-fd-confirm [^>]*disabled/);
  assert.match(html, /The client says it has an account there\./);
  assert.match(html, /The client says otherwise/);
  assert.ok(html.includes(V_VERIFIED) && html.includes(V_SAID), "a conflict does not show both sides");
  assert.match(html, /data-fd-dismiss-statement="s2" data-fd-client="client-1"/);
  // dashboard.js: the Set aside click asks for the named person before its one route call.
  const dash = fs.readFileSync(path.join(REPO, "frontend/dashboard.js"), "utf8");
  const fn = dash.slice(dash.indexOf("async function dismissFilingStatement("));
  assert.ok(fn.indexOf("namedPersonConsent(") > 0 && fn.indexOf("namedPersonConsent(") < fn.indexOf("/onboarding/filing-statements/"), "the route is called before the named-person confirm");
});

removeTempDir(tmpDir);
console.log(failures === 0 ? `\nclientFilingDetails: all ${total} checks passed.` : `\nclientFilingDetails: ${failures}/${total} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
