// THE APPROVAL SHEET SAYS WHERE AND HOW THE FILING GOES (review-audit draft 02).
//
// The sheet named the applicant, the address, the sizes and the equipment, but not the channel: for a
// track that files by email (#667) Approve & auto-submit composes and SENDS in one run, and the sheet
// showed no recipient, subject or attachment — an email cannot be recalled. It showed no portal host,
// no attachment list, no licence, valuation or fee; a permit carrying the utility's application
// (#664) had no utility rows, so the bill cross-check happened nowhere; and the service address printed
// twice. Pinned here (invented jobs and addresses, the stage fixture's scratch DB):
//   (E) AN EMAIL TRACK: the recipient, "sends in this run", the subject (the filing email's own
//       template) and every attachment by label and file name — the same packet the send attaches.
//   (P) A PORTAL TRACK: the portal host of its own complete recipe; with no recipe of its own, no host
//       is claimed and a note says an approved run stops at review. The attachments the run uploads.
//   (L) A PERMIT TRACK: the contractor licence it carries, the valuation and its basis, the fee quote.
//   (N) NEM INSIDE THE PERMIT: with a person-verified with-permit row the permit sheet carries the
//       applicant, utility, account and meter rows, masked, and flags a bill mismatch.
//   (A) THE ADDRESS is printed once.
//   (W) Still a read: total_changes() unchanged, whatever channel.
//
// KILL TESTS: build the address the old way → (A) fails; drop the carriesUtility switch → (N) fails;
// read the fee with buildPaymentQuote (which writes the payment row) → (W) fails.
//
// Run: npx tsx backend/test/approvalSheetChannel.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("approval-sheet-channel");
const { db, repo } = fx;
const { buildApprovalSheet, serviceAddressLine } = await import("../src/approvalSheet");
const fe = await import("../src/filingEmail");
const ufl = await import("../src/utilityFilingLookup");
const tracks = await import("../src/submittalTracks");

const ACCOUNT = "1234567890"; // the fixture's synthetic account / meter numbers
const METER = "987654321";
const project = (id: string) => repo.getProjectDetail(db, id).project;
type Track = "nem" | "building" | "electrical" | "combo";
const sheetFor = (id: string, track: Track) => buildApprovalSheet(db, project(id), track);
const rowOf = (sheet: ReturnType<typeof sheetFor>, key: string) => {
  const r = sheet.rows.find((x) => x.key === key);
  assert.ok(r, `no ${key} row: ${JSON.stringify(sheet.rows.map((x) => x.key))}`);
  return r!;
};
const changes = () => db.get<{ n: number }>("SELECT total_changes() AS n")!.n;

// ── (A) the address, once ─────────────────────────────────────────────────────────────────────
await check("(A) the service address is printed once (the line already carries city, state and zip)", () => {
  const id = fx.newProject();
  const value = rowOf(sheetFor(id, "nem"), "address").value;
  assert.equal(value.split("Portland").length - 1, 1, value);
  assert.equal(value.split("97201").length - 1, 1, value);
  assert.equal(serviceAddressLine({ projectAddress: "100 Test St, Salt Lake City, UT, 84105", city: "Salt Lake City", state: "UT", zip: "84105" }), "100 Test St, Salt Lake City, UT, 84105");
  assert.equal(serviceAddressLine({ projectAddress: "100 Test St", city: "Salt Lake City", state: "UT", zip: "84105" }), "100 Test St, Salt Lake City UT 84105");
  // "UT" inside a street word is not the state.
  assert.equal(serviceAddressLine({ projectAddress: "9 Utah Ave", city: "Ogden", state: "UT", zip: "" }), "9 Utah Ave, Ogden UT");
});

// ── (P) a portal track ────────────────────────────────────────────────────────────────────────
await check("(P1) no recipe of its own: no host is claimed, and the sheet says an approved run stops at review", () => {
  const id = fx.newProject();
  const s = sheetFor(id, "nem");
  const ch = rowOf(s, "channel");
  assert.equal(ch.value, "");
  assert.ok(s.issues.some((i) => i.rowKey === "channel" && /stops at the review screen/.test(i.text)), JSON.stringify(s.issues));
});
await check("(P2) with the AHJ's own complete recipe: the portal host, and the attachments the run uploads by type and file", () => {
  fx.completeRecipe(); // AHJ-scoped Portland recipe, https://permits.portland.example/apply
  const id = fx.newProject();
  const s = sheetFor(id, "building");
  assert.equal(rowOf(s, "channel").value, "permits.portland.example (portal)");
  assert.match(rowOf(s, "channel").sourceLabel, /recipe learned for Portland/);
  const att = rowOf(s, "attachments");
  assert.match(att.label, /^Attachments \(\d+\)$/);
  assert.match(att.value, /plan set \([^)]*plan-set\.pdf\)/, att.value);
});

// ── (L) what the authority prints ─────────────────────────────────────────────────────────────
await check("(L) a permit sheet names the contractor licence, the valuation with its basis, and the fee quote; the NEM sheet carries no licence row", () => {
  const id = fx.newProject();
  const s = sheetFor(id, "building");
  assert.match(rowOf(s, "licence").value, /240136/, "the fixture client's CCB is not on the building sheet");
  const val = rowOf(s, "valuation");
  assert.match(val.value, /^\$[\d,]+/, val.value);
  assert.ok(val.sourceLabel.length > 10, "the valuation's basis is not stated");
  assert.ok(rowOf(s, "fee"));
  assert.ok(!sheetFor(id, "nem").rows.some((r) => r.key === "licence" || r.key === "valuation"));
});

// ── (E) an email track ────────────────────────────────────────────────────────────────────────
const ADDRESS = "interconnections@utility-example.com";
const PAGE = "https://www.utility-example.com/solar/apply";
const QUOTE = `Email your completed application and attachments to ${ADDRESS}.`;
await check("(E) an email track: the recipient, 'sends in this run', the subject and every attachment the send carries", () => {
  const saved = ufl.saveUtilityFilingLookup(db, {
    state: "OR", utility: "PGE", lookedUpAt: new Date().toISOString(),
    filing: { value: { name: "email", url: null }, sourceUrl: PAGE, quote: QUOTE, origin: "lookup" },
    program: { value: "net_metering", sourceUrl: PAGE, quote: "Net metering program", origin: "lookup" },
  } as never);
  assert.equal(saved.saved, true, `setup: ${saved.reason}`);
  const id = fx.newProject();
  const authority = fe.authorityForTrack(project(id), "nem")!;
  assert.equal(fe.setFilingEmail(db, authority, { address: ADDRESS, sourceUrl: PAGE, quote: QUOTE }, "A. Person").saved, true, "setup: filing email");
  const before = changes();
  const s = sheetFor(id, "nem");
  assert.equal(changes(), before, "(W) the email sheet wrote a row");
  const ch = rowOf(s, "channel");
  assert.equal(ch.label, "Files by");
  assert.match(ch.value, new RegExp(`^Email to ${ADDRESS.replace(/\./g, "\\.")}`));
  assert.match(ch.value, /SENDS it in this run/);
  assert.match(ch.value, /cannot be recalled/);
  const packet = fe.filingPacket(db, project(id), "nem");
  assert.ok(packet.length > 0, "setup: the NEM packet is empty");
  const att = rowOf(s, "attachments");
  assert.equal(att.label, `Attachments (${packet.length})`);
  for (const f of packet) assert.ok(att.value.includes(`${f.label} (${f.filename})`), `${f.filename} missing from ${att.value}`);
  assert.match(rowOf(s, "emailSubject").value, /\[Ref [0-9A-F]{8}-NEM\]/);
  for (const secret of [ACCOUNT, METER]) assert.ok(!JSON.stringify(s).includes(secret), `the sheet carried ${secret}`);
});

// ── (N) the utility's application rides in the permit ─────────────────────────────────────────
await check("(N) a person-verified with-permit utility: the permit sheet carries the applicant, utility, account and meter rows and flags the bill mismatch", () => {
  const STATE = "UT", UTILITY = "Maplecrest City Light & Power"; // invented
  const WP_PAGE = "https://www.maplecrest.example.gov/light-power/solar";
  const WP_QUOTE = "Apply for net metering through the city's building permit portal; the net metering agreement is part of the permit application.";
  ufl.saveUtilityFilingLookup(db, {
    state: STATE, utility: UTILITY,
    filing: { value: { name: "City building permit application", url: null, method: "with_ahj_permit" }, sourceUrl: WP_PAGE, quote: WP_QUOTE, origin: "lookup" },
    program: { value: "net_metering", sourceUrl: WP_PAGE, quote: WP_QUOTE, origin: "lookup" },
    lookedUpAt: new Date().toISOString(),
  } as never);
  assert.equal(ufl.verifyUtilityFilingLookup(db, { state: STATE, utility: UTILITY }, { verifiedBy: "Pat Operator" }).saved, true);
  const id = fx.newProject({ state: STATE, city: "Maplecrest", ahj: "City of Maplecrest", utility: UTILITY, zip: "84000" });
  repo.updateProject(db, id, { ubAccountNumber: "1234567899", ubMeterNumber: METER, ubAccountHolder: "Casey Different" });
  assert.ok(ufl.nemFiledWithPermit(db, project(id)), "setup: the with-permit row is not in force");
  const permitTrack = tracks.requiredTracks(project(id)).find((t) => t !== "nem") as Track;
  const before = changes();
  const s = sheetFor(id, permitTrack);
  assert.equal(changes(), before, "(W) the with-permit sheet wrote a row");
  assert.equal(s.category, "permit");
  assert.ok(rowOf(s, "ahj").value, "the issuing agency row is gone");
  assert.match(rowOf(s, "utility").value, /Maplecrest City Light/);
  assert.equal(rowOf(s, "applicant").value, "Casey Different", "the bill holder is not the applicant on the with-permit sheet");
  const account = rowOf(s, "account");
  assert.equal(account.value, "•••• 7890");
  assert.equal(account.check, "mismatch", "the bill's other account number is not flagged");
  assert.ok(rowOf(s, "meter"));
  assert.ok(!JSON.stringify(s).includes(ACCOUNT) && !JSON.stringify(s).includes("1234567899"), "MUST-EXCLUDE: a whole account number");
  // MUST-EXCLUDE: an ordinary permit (no with-permit row) still has no utility rows.
  const plain = sheetFor(fx.newProject(), "building");
  assert.ok(!plain.rows.some((r) => ["account", "meter", "applicant", "utility"].includes(r.key)), JSON.stringify(plain.rows.map((r) => r.key)));
});

await check("(W) every channel's sheet writes nothing", () => {
  const id = fx.newProject();
  const before = changes();
  for (const t of ["nem", "building"] as const) sheetFor(id, t);
  assert.equal(changes(), before, "the approval sheet wrote a row");
});

finish("approvalSheetChannel");
