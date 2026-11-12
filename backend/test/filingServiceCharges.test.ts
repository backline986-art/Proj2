// OUR PRICE PER FILING (#187): the price list, the price saved on each filing, and the monthly
// statement that bills each filing at that price.
//
//   - the price is DATA: with nothing set, no price resolves (no $0 line, no number in code);
//   - resolution order: the client's own price per track, its single fee, the org's price list, the env
//     default; the price list is per org and never reaches another org's client;
//   - the filing doors (markTrackSubmitted, captureConfirmation) save the price in force ONCE per
//     project and filing type: building and electrical are two filings, a resubmission adds nothing;
//   - a monthly client's statement bills one service line per filing at its saved price (the founding
//     prices set as data here: $99 per permit filing, $79 per NEM application), and a later price
//     change does not re-price it; a second statement and a second invoice never repeat it;
//   - a filing made under per-submission billing is never billed here (the gate took it);
//   - a filing saved with no price is listed until a price is set, then billed at the price then;
//   - a person can waive one filing (named, with a reason), never once it is on a live invoice;
//   - the per-submission gate collects the track's price.
//
//   npx tsx backend/test/filingServiceCharges.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "filing-service-charges-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
for (const k of ["BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH", "CLIENT_NOTIFICATIONS", "CODE_RESEARCH"]) process.env[k] = "off";
for (const k of ["SMTP_HOST", "SMTP_FROM", "ANTHROPIC_API_KEY", "SUBMISSION_SERVICE_FEE_USD"]) delete process.env[k];

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { createClient, updateClient } = await import("../src/clients");
const { createProject, captureConfirmation } = await import("../src/repository");
const { markTrackSubmitted } = await import("../src/submittalTracks");
const { buildPaymentQuote } = await import("../src/submissionFees");
const P = await import("../src/servicePrices");
const L = await import("../src/clientInvoices");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const throwsWith = (fn: () => unknown, re: RegExp): void => {
  assert.throws(fn, (err: unknown) => re.test(err instanceof Error ? err.message : String(err)));
};

const ORG_B = "org-prices-b";
db.run("INSERT OR IGNORE INTO orgs (id, name, edition, created_at) VALUES (?, 'Other Co', 'full', ?)", [ORG_B, new Date().toISOString()]);

const monthly = createClient(db, { companyName: "Monthly Sample Solar", billingMode: "monthly", businessEmail: "ops@monthly.test" });
const blankMode = createClient(db, { companyName: "No Mode Sample Solar", businessEmail: "ops@nomode.test" });
const perSub = createClient(db, { companyName: "Gate Sample Solar", billingMode: "per_submission", businessEmail: "ops@gate.test" });
const otherOrg = createClient(db, { companyName: "Other Org Solar", billingMode: "monthly" }, ORG_B);

let n = 0;
const mk = (clientId: string, org = DEFAULT_ORG_ID) => createProject(db, {
  clientId, owner: `Sample Owner ${++n}`, street: `${n} Sample St`, city: "Sampleville",
  state: "OR", ahj: "City of Sampleton", utility: "Sample Power", dcKw: "8", acKw: "6.4",
}, org).project;
const chargesOf = (projectId: string) => db.query<{ permit_type: string; price_usd: number | null; price_basis: string; billing_mode: string }>(
  "SELECT permit_type, price_usd, price_basis, billing_mode FROM filing_service_charges WHERE project_id = ? ORDER BY permit_type", [projectId]);

const month = new Date().toISOString().slice(0, 7);
const period = L.resolvePeriod({ month });
const filingLines = (clientId: string) => L.buildClientStatement(db, clientId, period).lines.filter((l) => l.lineKey.startsWith("filing:"));

// ── 1. the price list ────────────────────────────────────────────────────────────────────────
check("1a. nothing set: no price resolves (no number in code, never a silent $0)", () => {
  const r = P.resolveServicePrice(db, monthly.id, "permit");
  assert.equal(r.priceUsd, null);
  assert.equal(r.basis, "unset");
});
// The founding prices (owner, 2026-11-12) — set here as DATA, the way a person sets them.
check("1b. a named person sets the price list; an unnamed one is refused; a bad amount is refused", () => {
  throwsWith(() => P.setServicePrices(db, DEFAULT_ORG_ID, { permitUsd: 99 }, ""), /Name the person/);
  throwsWith(() => P.setServicePrices(db, DEFAULT_ORG_ID, { permitUsd: -1 }, "Pat Tester"), /dollar amount/);
  throwsWith(() => P.setServicePrices(db, DEFAULT_ORG_ID, {}, "Pat Tester"), /permitUsd and\/or nemUsd/);
  const { list, changed } = P.setServicePrices(db, DEFAULT_ORG_ID, { permitUsd: "99", nemUsd: 79 }, "Pat Tester");
  assert.equal(list.prices.permit.priceUsd, 99);
  assert.equal(list.prices.nem.priceUsd, 79);
  assert.equal(list.prices.permit.setBy, "Pat Tester");
  assert.equal(changed.length, 2);
  assert.equal(P.setServicePrices(db, DEFAULT_ORG_ID, { permitUsd: 99 }, "Pat Tester").changed.length, 0, "an unchanged price is not a change");
});
check("1c. resolution: price list per track; the client's own price per track, then its single fee, win", () => {
  assert.equal(P.resolveServicePrice(db, monthly.id, "building").priceUsd, 99);
  assert.equal(P.resolveServicePrice(db, monthly.id, "nem").priceUsd, 79);
  assert.equal(P.resolveServicePrice(db, monthly.id, "nem").basis, "price_list");
  const own = createClient(db, { companyName: "Own Price Solar", billingMode: "monthly", serviceFeeUsd: "150", serviceFeeNemUsd: "60" });
  assert.equal(P.resolveServicePrice(db, own.id, "nem").priceUsd, 60);
  assert.equal(P.resolveServicePrice(db, own.id, "nem").basis, "client_track");
  assert.equal(P.resolveServicePrice(db, own.id, "electrical").priceUsd, 150);
  assert.equal(P.resolveServicePrice(db, own.id, "electrical").basis, "client_flat");
  assert.equal(own.serviceFeeNemUsd, 60, "the client record carries its own NEM price");
});
check("1d. the price list is per org: another org's client does not get it", () => {
  assert.equal(P.resolveServicePrice(db, otherOrg.id, "permit").priceUsd, null);
  assert.equal(P.getServicePriceList(db, ORG_B).prices.permit.priceUsd, null);
});
check("1e. the env default is a fallback only when it is set", () => {
  process.env.SUBMISSION_SERVICE_FEE_USD = "120";
  try {
    assert.equal(P.resolveServicePrice(db, otherOrg.id, "permit").priceUsd, 120);
    assert.equal(P.resolveServicePrice(db, otherOrg.id, "permit").basis, "env_default");
    assert.equal(P.resolveServicePrice(db, monthly.id, "permit").priceUsd, 99, "the price list wins over the env default");
  } finally { delete process.env.SUBMISSION_SERVICE_FEE_USD; }
});

// ── 2. the price saved on each filing ───────────────────────────────────────────────────────────
const job = mk(monthly.id);
check("2a. building, electrical and NEM filed = three charges at the price in force, with the billing mode", () => {
  markTrackSubmitted(db, job, "building", { applicationNumber: "BLD-26-0001" });
  markTrackSubmitted(db, job, "electrical", { applicationNumber: "ELE-26-0001" });
  markTrackSubmitted(db, job, "nem", { applicationNumber: "INX-26-0001" });
  const rows = chargesOf(job.id);
  assert.deepEqual(rows.map((r) => [r.permit_type, r.price_usd, r.price_basis, r.billing_mode]), [
    ["building", 99, "price_list", "monthly"],
    ["electrical", 99, "price_list", "monthly"],
    ["nem", 79, "price_list", "monthly"],
  ]);
});
check("2b. a resubmission of the same filing adds nothing, and a price change never re-prices a saved one", () => {
  P.setServicePrices(db, DEFAULT_ORG_ID, { permitUsd: 109 }, "Pat Tester");
  markTrackSubmitted(db, job, "building", { applicationNumber: "BLD-26-0001-R1" });
  assert.equal(P.recordFilingServiceCharge(db, job, "building"), false);
  const rows = chargesOf(job.id);
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.permit_type === "building")?.price_usd, 99);
  P.setServicePrices(db, DEFAULT_ORG_ID, { permitUsd: 99 }, "Pat Tester");
});
check("2c. captureConfirmation (a staged run's door) saves the price too", () => {
  const p = mk(monthly.id);
  const ts = new Date().toISOString();
  db.run("INSERT INTO portal_runs (id, project_id, portal_profile_id, run_type, status, started_at, permit_type) VALUES (?, ?, NULL, 'stage', 'awaiting_human_submit', ?, 'combo')", [`run-${p.id}`, p.id, ts]);
  db.run("INSERT INTO submissions (id, project_id, portal_profile_id, submission_type, permit_type, status, created_at) VALUES (?, ?, NULL, 'permit', 'combo', 'awaiting_human_submit', ?)", [`sub-${p.id}`, p.id, ts]);
  captureConfirmation(db, `run-${p.id}`, { applicationNumber: "CMB-26-0001" });
  assert.deepEqual(chargesOf(p.id).map((r) => [r.permit_type, r.price_usd]), [["combo", 99]]);
});

// ── 3. the monthly statement ──────────────────────────────────────────────────────────────────
check("3a. a monthly client is billed one service line per filing at its saved price: $99 + $99 + $79 (+ the combo)", () => {
  const st = L.buildClientStatement(db, monthly.id, period);
  const mine = st.lines.filter((l) => l.lineKey.startsWith("filing:") && l.projectId === job.id);
  assert.deepEqual(mine.map((l) => l.amountUsd).sort(), [79, 99, 99]);
  assert.ok(mine.every((l) => l.kind === "service" && !l.alreadyPaid && !l.provisional));
  assert.ok(mine.some((l) => /electrical permit filing/.test(l.description)), JSON.stringify(mine.map((l) => l.description)));
  assert.equal(filingLines(monthly.id).length, 4);
  assert.equal(st.serviceTotalUsd, 99 + 99 + 79 + 99);
});
check("3b. invoiced once: the next statement and a second invoice never repeat a filing line", () => {
  const inv = L.createClientInvoice(db, monthly.id, period, "Pat Tester");
  assert.equal(inv.serviceTotalUsd, 99 + 99 + 79 + 99);
  assert.equal(filingLines(monthly.id).length, 0);
  throwsWith(() => L.createClientInvoice(db, monthly.id, period, "Pat Tester"), /Nothing to invoice/);
  // A price change after invoicing changes nothing already billed.
  P.setServicePrices(db, DEFAULT_ORG_ID, { permitUsd: 150 }, "Pat Tester");
  assert.equal(L.getClientInvoice(db, monthly.id, inv.id).serviceTotalUsd, 99 + 99 + 79 + 99);
  P.setServicePrices(db, DEFAULT_ORG_ID, { permitUsd: 99 }, "Pat Tester");
  // Voiding releases the lines for the next invoice, at the same saved prices.
  L.voidClientInvoice(db, monthly.id, inv.id, "test void");
  assert.equal(filingLines(monthly.id).reduce((t, l) => t + l.amountUsd, 0), 99 + 99 + 79 + 99);
});
check("3c. a client with no billing mode set is billed too, and the statement says to set one", () => {
  const p = mk(blankMode.id);
  markTrackSubmitted(db, p, "building", { applicationNumber: "BLD-26-0100" });
  const st = L.buildClientStatement(db, blankMode.id, period);
  assert.deepEqual(st.lines.filter((l) => l.lineKey.startsWith("filing:")).map((l) => l.amountUsd), [99]);
  assert.ok(st.notes.some((x) => /No billing mode is set/.test(x)), JSON.stringify(st.notes));
});
check("3d. a filing under per-submission billing is never billed on the statement (the gate took it), and the gate collects the track's price", () => {
  const p = mk(perSub.id);
  assert.equal(buildPaymentQuote(db, p, "nem").gateAmountUsd, 79);
  assert.equal(buildPaymentQuote(db, p, "permit").gateAmountUsd, 99);
  assert.match(String(buildPaymentQuote(db, p, "permit").serviceFeeSource), /price list/);
  P.recordFilingServiceCharge(db, p, "building");
  assert.equal(chargesOf(p.id)[0]?.billing_mode, "per_submission");
  assert.equal(filingLines(perSub.id).length, 0);
  // The client moves to monthly later: that filing was the gate's, and is still not billed here.
  updateClient(db, perSub.id, { ...perSub, billingMode: "monthly" });
  assert.equal(filingLines(perSub.id).length, 0);
});
check("3e. a filing saved with no price is listed (never a $0 line), then billed once a price is set", () => {
  const p = mk(otherOrg.id, ORG_B);
  P.recordFilingServiceCharge(db, p, "building");
  assert.equal(chargesOf(p.id)[0]?.price_usd, null);
  const st = L.buildClientStatement(db, otherOrg.id, period);
  assert.equal(st.lines.filter((l) => l.lineKey.startsWith("filing:")).length, 0);
  assert.ok(st.excluded.some((x) => /no price per permit filing is set/.test(x.reason)), JSON.stringify(st.excluded));
  P.setServicePrices(db, ORG_B, { permitUsd: 125 }, "Other Admin");
  const after = filingLines(otherOrg.id);
  assert.deepEqual(after.map((l) => l.amountUsd), [125]);
  assert.match(after[0].reconciliation, /No price was set when it was filed/);
});

// ── 4. waiving one filing ───────────────────────────────────────────────────────────────────────
check("4a. a named person waives a filing with a reason; through its own client only; never once invoiced", () => {
  const p = mk(blankMode.id);
  markTrackSubmitted(db, p, "nem", { applicationNumber: "INX-26-0200" });
  const charge = P.listFilingCharges(db, blankMode.id).find((c) => c.projectId === p.id)!;
  throwsWith(() => P.waiveFilingCharge(db, monthly.id, charge.id, "wrong client", "Pat Tester"), /not found/);
  throwsWith(() => P.waiveFilingCharge(db, blankMode.id, charge.id, "", "Pat Tester"), /Say why/);
  const waived = P.waiveFilingCharge(db, blankMode.id, charge.id, "filed in error", "Pat Tester");
  assert.equal(waived.waivedBy, "Pat Tester");
  const st = L.buildClientStatement(db, blankMode.id, period);
  assert.ok(!st.lines.some((l) => l.paymentId === charge.id));
  assert.ok(st.excluded.some((x) => /waived/.test(x.reason)));
  // One already on a live invoice cannot be waived.
  const inv = L.createClientInvoice(db, blankMode.id, period, "Pat Tester");
  const billedCharge = inv.lines.find((l) => l.lineKey.startsWith("filing:"))!;
  throwsWith(() => P.waiveFilingCharge(db, blankMode.id, billedCharge.paymentId, "late change", "Pat Tester"), /already on invoice/);
});

// ── 5. a statement preview writes nothing ───────────────────────────────────────────────────────
check("5a. building a statement writes nothing", () => {
  const before = db.get<{ n: number }>("SELECT (SELECT COUNT(*) FROM filing_service_charges) + (SELECT COUNT(*) FROM client_invoice_lines) + (SELECT COUNT(*) FROM service_prices) AS n")?.n;
  L.buildClientStatement(db, monthly.id, period);
  L.buildClientStatement(db, otherOrg.id, period);
  const after = db.get<{ n: number }>("SELECT (SELECT COUNT(*) FROM filing_service_charges) + (SELECT COUNT(*) FROM client_invoice_lines) + (SELECT COUNT(*) FROM service_prices) AS n")?.n;
  assert.equal(after, before);
});

if (failures) {
  console.error(`\nfilingServiceCharges: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nfilingServiceCharges: all checks passed");
