// THE FEE LINES AN ITEMIZED RECEIPT PRINTS, AND A FEE SCHEDULE CHECKED LINE BY LINE AGAINST THEM.
//
// An owner export of card receipts (2026-11-23: 1,724 PDFs) held 317 itemized "Transaction Receipt"
// documents from 35 Oregon building departments. Each prints its fee lines with the authority's
// price for each line ("Renewable energy for electrical systems- 5.01kva through 15kva $94.00").
// The fixtures below mirror that document's STRUCTURE as the production text extractor yields it,
// with invented identifiers, names and addresses; the amounts are real ones.
//
//   MUST READ     — every line: label without its account code, the fee amount, the paid amount.
//                   The rows print the fee FIRST (a partial payment reads "$94.00  $15.00").
//   MUST REFUSE   — lines that do not add up to the receipt's total (the receipt is still read).
//   MUST COMPARE  — a kVA band line against the electrical bracket holding that band, a prescriptive
//                   PV line against a flat bracket labelled prescriptive; MATCHES / DIFFERS / NO
//                   BRACKET; never a formula bracket, never a county's receipt against a city.
//   READ-ONLY     — no schedule changes.
//
//   npx tsx backend/test/feeReceiptLines.test.ts
import "./_isolate";
import assert from "node:assert/strict";

process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = "";
process.env.FEE_RESEARCH = "off";

const { openDatabase } = await import("../src/db");
const { parsePaidFeeReceipt, recordPaidFeeReceipt } = await import("../src/feeReceipts");
const { checkReceiptLinesAgainstSchedules, feeScheduleProfileKey, receiptLineKvaBand, receiptLineIsPrescriptivePv } = await import("../src/feeSchedules");

const db = await openDatabase();
let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const receiptText = (issuer: string, receiptNo: string, record: string, rows: string, total: string) =>
  `Transaction Receipt  Record ID: ${record} Receipt Number: ${receiptNo} Receipt Date: 7/20/26  ${issuer}  100 Example Rd NE Exampleton, OR 97000 503-555-0100 building@example.or.us  Worksite address: 1 EXAMPLE WAY NE, EXAMPLETON, OR 97000 Parcel: 000X00XX00000  Fees Paid  Transaction date Units  Description  Account code  Paid amount Fee amount  ${rows} Payment Method:  Credit card authorization: 000000 Payer: J Doe  Payment Amount:  $${total}  Receipt Total:  $${total} Paid through ePermitting website  Printed: 7/20/26 12:06 pm  Page 1 of 1`;

// Marion County shape: two lines, short account codes.
const ELECTRICAL = receiptText("Examplemarion County", "900001", "000-26-000001-ELEC",
  "7/20/26  State of Oregon Surcharge - Elec (12% of applicable fees) STATE  $11.28  $11.28 1.00 Ea 7/20/26  Renewable energy for electrical systems- 5.01kva through 15kva BUILD  $94.00  $94.00 1.00 Ea", "105.28");
// Yamhill County shape: long account codes, a percent line whose units column is its base.
const STRUCTURAL = receiptText("Exampleyamhill County Building Department", "900002", "000-26-000002-STR",
  "7/29/26  Local Administrative Fee - Exampleyamhill Co.  110-3010020-34516-000 0-000-00000 $30.84  $30.84 1.00 Ea 7/29/26  Prescriptive photovoltaic installations  110-3010020-32210-F07 7-000-00000 $193.85  $193.85 1.00 Ea 7/29/26  State of Oregon Surcharge - Bldg (12% of applicable fees) 110-3010020-34506-F07 7-000-00000 $23.26  $23.26 1.00 Ea 7/29/26  Local Technology Fee - Exampleyamhill Co.  110-3010020-34199-PL6 6-000-00000 $11.12  $11.12 224.69 Automatic", "259.07");
// A later partial payment on an earlier line: the fee is $94.00, this receipt paid $15.00 of it.
const PARTIAL = receiptText("Examplemarion County", "900003", "000-26-000003-ELEC",
  "9/11/26  Renewable energy for electrical systems- 5.01kva through 15kva BUILD  $94.00  $15.00 1.00 Ea 9/11/26  State of Oregon Surcharge - Elec (12% of applicable fees) STATE  $21.21  $1.80 1.00 Ea", "16.80");

check("an itemized receipt reads every line: label without its account code, fee, paid", () => {
  const r = parsePaidFeeReceipt(ELECTRICAL)!;
  assert.ok(r, "the receipt itself must read");
  assert.equal(r.authorityAmountUsd, 105.28);
  assert.deepEqual(r.lines, [
    { label: "State of Oregon Surcharge - Elec (12% of applicable fees)", feeUsd: 11.28, paidUsd: 11.28 },
    { label: "Renewable energy for electrical systems- 5.01kva through 15kva", feeUsd: 94, paidUsd: 94 },
  ]);
  const s = parsePaidFeeReceipt(STRUCTURAL)!;
  assert.deepEqual(s.lines!.map((l) => l.label), [
    "Local Administrative Fee - Exampleyamhill Co.", "Prescriptive photovoltaic installations",
    "State of Oregon Surcharge - Bldg (12% of applicable fees)", "Local Technology Fee - Exampleyamhill Co.",
  ]);
  assert.ok(!JSON.stringify(s.lines).match(/EXAMPLE WAY|Parcel|J Doe|000-26-/), "nothing outside the fee table is read into a line");
});

check("a partial payment keeps the line's own fee and adds up on what was paid", () => {
  const r = parsePaidFeeReceipt(PARTIAL)!;
  assert.equal(r.authorityAmountUsd, 16.8);
  assert.deepEqual(r.lines!.map((l) => [l.feeUsd, l.paidUsd]), [[94, 15], [21.21, 1.8]]);
});

check("lines that do not add up to the receipt's total are dropped; the receipt still reads", () => {
  const wrong = ELECTRICAL.replace(/\$105\.28/g, "$106.28");
  const r = parsePaidFeeReceipt(wrong)!;
  assert.equal(r.authorityAmountUsd, 106.28);
  assert.equal(r.lines, undefined);
});

check("band and prescriptive wording", () => {
  assert.deepEqual(receiptLineKvaBand("Renewable energy for electrical systems- 5.01kva through 15kva"), { min: 5.01, max: 15 });
  assert.deepEqual(receiptLineKvaBand("Renewable energy for electrical systems- 5kva or less"), { min: 0, max: 5 });
  assert.equal(receiptLineKvaBand("Services/feeders 200 amps or less"), null);
  assert.equal(receiptLineKvaBand("Wind generation 5kva or less"), null);
  assert.equal(receiptLineIsPrescriptivePv("Prescriptive photovoltaic installations- minimum fee"), true);
  assert.equal(receiptLineIsPrescriptivePv("Non prescriptive solar installations"), false);
});

// --- schedules ---------------------------------------------------------------------------------
let seq = 0;
function schedule(ahj: string, discipline: string, basis: string, brackets: unknown[]): string {
  const key = feeScheduleProfileKey({ state: "OR", ahj }, "permit");
  const ts = new Date().toISOString();
  db.run(
    `INSERT INTO fee_schedules (id, profile_key, state, ahj, utility, track, basis, brackets_json, notes, source_url, source_quote,
       source_kind, confidence, first_seen_at, updated_at, verified_at, verified_by, payment_method, discipline, collected_by_profile_key,
       status, document_date, candidates_json)
     VALUES (?, ?, 'OR', ?, '', 'permit', ?, ?, '', 'https://example.gov/fees', '', 'official', 'seeded', ?, ?, '', '', '', ?, '', 'ok', '', '[]')`,
    [`fl-${++seq}`, key, ahj, basis, JSON.stringify(brackets), ts, ts, discipline],
  );
  return key;
}
const marionKey = schedule("Examplemarion County", "electrical", "system_kw", [
  { minKw: 0, maxKw: 5, feeUsd: 79, label: "5 kVA or less" },
  { minKw: 5.01, maxKw: 15, feeUsd: 94, label: "5.01 to 15 kVA" },
]);
const yamhillElec = schedule("Exampleyamhill County", "electrical", "system_kw", [
  { minKw: 5.01, maxKw: 15, feeUsd: 130, label: "5.01 to 15 kVA" },
]);
schedule("Exampleyamhill County", "structural", "flat", [{ feeUsd: 193.85, label: "Prescriptive photovoltaic installations" }]);
// A formula is not a price: a per-kVA rate is never compared with a printed line.
const rateKey = schedule("Exampleformula County", "electrical", "system_kw", [
  { minKw: 0, maxKw: null, feeUsd: 250, label: "$250.00 for first 25 kVA plus $6.25 per kVA" },
]);
// A city that shares a word with the county must never take the county's receipt.
schedule("City of Examplemarion", "electrical", "system_kw", [{ minKw: 5.01, maxKw: 15, feeUsd: 1, label: "5.01 to 15 kVA" }]);

const read = (t: string) => ({ receipt: parsePaidFeeReceipt(t)!, state: "" });
const elecDiffers = read(ELECTRICAL.replace("Examplemarion County", "Exampleyamhill County").replace("900001", "900004"));
const formula = read(ELECTRICAL.replace("Examplemarion County", "Exampleformula County").replace("900001", "900005"));
const unknownBand = read(ELECTRICAL.replace(/5\.01kva through 15kva/, "15.01kva through 25kva").replace("900001", "900006"));

check("MATCHES, DIFFERS and NO BRACKET, each on the schedule the receipt belongs to", () => {
  const schedulesBefore = JSON.stringify(db.query("SELECT * FROM fee_schedules ORDER BY id"));
  const report = checkReceiptLinesAgainstSchedules(db, [read(ELECTRICAL), read(STRUCTURAL), read(PARTIAL), elecDiffers, formula, unknownBand]);
  const of = (key: string) => report.checks.filter((c) => c.profileKey === key);
  assert.deepEqual(of(marionKey).map((c) => [c.receiptLine.replace(/^.*- /, ""), c.verdict, c.scheduleFeeUsd]), [
    ["5.01kva through 15kva", "matches", 94], // the full receipt
    ["5.01kva through 15kva", "matches", 94], // the partial payment: its line's FEE is $94.00
    ["15.01kva through 25kva", "no_bracket", null],
  ]);
  const yam = of(yamhillElec);
  assert.deepEqual(yam.map((c) => [c.discipline, c.verdict, c.receiptFeeUsd, c.scheduleFeeUsd]), [
    ["structural", "matches", 193.85, 193.85],
    ["electrical", "differs", 94, 130],
  ]);
  assert.equal(of(rateKey).length, 1);
  assert.equal(of(rateKey)[0].verdict, "no_bracket", "a formula bracket is not compared as a price");
  assert.ok(!report.checks.some((c) => c.ahj === "City of Examplemarion"), "a county's receipt was read as the city's");
  assert.equal(report.itemizedReceipts, 6);
  assert.equal(JSON.stringify(db.query("SELECT * FROM fee_schedules ORDER BY id")), schedulesBefore, "the check wrote to a schedule");
});

check("recorded receipts keep their lines, and the check reads them from history", () => {
  assert.equal(recordPaidFeeReceipt(db, parsePaidFeeReceipt(ELECTRICAL)!, null).recorded, true);
  const report = checkReceiptLinesAgainstSchedules(db);
  assert.equal(report.itemizedReceipts, 1);
  assert.deepEqual(report.checks.map((c) => [c.profileKey, c.verdict]), [[marionKey, "matches"]]);
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nfeeReceiptLines: all checks passed");
