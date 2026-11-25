// IMPORT A FOLDER OF PAID FEE RECEIPTS, AND CHECK THE FEE SCHEDULES LINE BY LINE AGAINST THEM.
//
//   npx tsx scripts/import-fee-receipts.ts <folder> --db <path>            (dry run: writes nothing)
//   npx tsx scripts/import-fee-receipts.ts <folder> --db <path> --apply    (records the receipts)
//
// Reads every PDF under <folder> (an export of card receipts, any layout of sub-folders) with the
// app's own text extractor and receipt reader (feeReceipts.parsePaidFeeReceipt): a document that is
// not one of the receipt formats the reader knows is skipped and counted, never guessed at.
//
// DRY RUN BY DEFAULT, and the dry run opens the database READ-ONLY. It prints what would be recorded
// and the line-by-line check (feeSchedules.checkReceiptLinesAgainstSchedules) of the receipts it read
// against the fee schedules on file: for each itemized receipt line that names a solar kVA band or a
// prescriptive PV fee, whether the schedule's own price for that line MATCHES the price the
// authority printed, DIFFERS from it, or holds no bracket for it.
//
// --apply records each receipt through recordPaidFeeReceipt — the upload path's own write, deduped
// by the receipt's identity, as an observed component that whole-filing quotes never read — with no
// project. It NEVER changes a fee schedule (hard rule 3): a schedule that differs is a person's to
// correct from the fee sheet. --apply opens the database through openDatabase(), which runs pending
// migrations first.
//
// --db IS REQUIRED, with no default: the check is only meaningful against the database whose
// schedules quote real jobs, and --apply writes into it.
//
// PRIVACY: what is printed and stored is the jurisdiction, the printed fee lines, the amounts and the
// date. Never a payer, card, worksite, parcel, receipt number or permit number.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { PaidFeeReceipt } from "../shared/src/types";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const dbAt = argv.indexOf("--db");
const dbPath = dbAt >= 0 ? argv[dbAt + 1] ?? "" : "";
const folder = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--db") ?? "";
if (!folder || !dbPath) {
  console.error("usage: npx tsx scripts/import-fee-receipts.ts <folder> --db <path> [--apply]");
  process.exit(2);
}
if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
  console.error(`not a folder: ${folder}`);
  process.exit(2);
}
process.env.AUTOPILOT_DB_PATH = dbPath;

const { AppDb, openDatabase } = await import("../backend/src/db");
const { extractPdfText } = await import("../backend/src/batchImport");
const { parsePaidFeeReceipt, recordPaidFeeReceipt } = await import("../backend/src/feeReceipts");
const { checkReceiptLinesAgainstSchedules } = await import("../backend/src/feeSchedules");

function pdfsUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pdfsUnder(full));
    else if (entry.isFile() && /\.pdf$/i.test(entry.name)) out.push(full);
  }
  return out.sort();
}

const files = pdfsUnder(folder);
const receipts: PaidFeeReceipt[] = [];
const seen = new Set<string>();
let unreadable = 0, notReceipt = 0, duplicates = 0;
for (const file of files) {
  let text = "";
  try { text = await extractPdfText(file, 10); } catch { unreadable++; continue; }
  if (text.replace(/\s/g, "").length < 50) { unreadable++; continue; }
  const receipt = parsePaidFeeReceipt(text);
  if (!receipt) { notReceipt++; continue; }
  // The same payment is often exported twice (an emailed copy and a printed one).
  const identity = `${receipt.jurisdiction.toLowerCase()}|${receipt.receiptNumber}|${receipt.permitNumber}`;
  if (seen.has(identity)) { duplicates++; continue; }
  seen.add(identity);
  receipts.push(receipt);
}

const byJurisdiction = new Map<string, number>();
for (const r of receipts) byJurisdiction.set(r.jurisdiction, (byJurisdiction.get(r.jurisdiction) ?? 0) + 1);
console.log(`\nPaid fee receipts under the folder${apply ? "" : "   (dry run — read-only, nothing written)"}\n`);
console.log(`PDFs ${files.length}: receipts read ${receipts.length + duplicates} (${duplicates} the same payment again), `
  + `not a receipt format the reader knows ${notReceipt}, no text layer (a scan or image) ${unreadable}`);
console.log(`itemized (their fee lines read) ${receipts.filter((r) => r.lines?.length).length}`);
for (const [j, n] of [...byJurisdiction].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${j}`);

const db = apply ? await openDatabase() : new AppDb(new Database(dbPath, { readonly: true, fileMustExist: true }));
if (apply) {
  let recorded = 0, already = 0, conflicts = 0;
  for (const r of receipts) {
    const outcome = recordPaidFeeReceipt(db, r, null);
    if (outcome.recorded) recorded++;
    else if (/conflict/i.test(outcome.reason)) conflicts++;
    else already++;
  }
  console.log(`\nrecorded ${recorded}; already on file ${already}; conflicting with a receipt on file (left as it was) ${conflicts}`);
  // recordPaidFeeReceipt holds each new receipt against its schedule in the background; let it finish.
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

// The check reads what is on file after --apply, and what was just read in a dry run. The state is
// left unknown ("") for receipts only read: the jurisdiction's name decides the schedule.
const report = apply ? checkReceiptLinesAgainstSchedules(db) : checkReceiptLinesAgainstSchedules(db, receipts.map((receipt) => ({ receipt, state: "" })));
console.log(`\nFee schedules vs the fee lines printed on itemized receipts`);
console.log(`itemized receipts ${report.itemizedReceipts}; comparable lines (a solar kVA band or a prescriptive PV fee) ${report.linesComparable}; `
  + `receipts at a jurisdiction with no schedule on file ${report.receiptsWithoutSchedule}`);
const groups = new Map<string, typeof report.checks>();
for (const c of report.checks) {
  const k = `${c.profileKey} [${c.discipline || "undifferentiated"}] (${c.confidence})\u0000${c.receiptLine}`;
  groups.set(k, [...(groups.get(k) ?? []), c]);
}
const tally = { matches: 0, differs: 0, no_bracket: 0 };
for (const [k, cs] of [...groups].sort()) {
  const [schedule, line] = k.split("\u0000");
  const verdicts = new Map<string, number>();
  for (const c of cs) {
    tally[c.verdict]++;
    const v = c.verdict === "matches" ? `MATCHES $${c.receiptFeeUsd.toFixed(2)}`
      : c.verdict === "differs" ? `DIFFERS: receipt $${c.receiptFeeUsd.toFixed(2)} (paid ${c.paidAt}), schedule $${c.scheduleFeeUsd!.toFixed(2)} "${c.scheduleLabel}"`
      : `NO BRACKET on the schedule for receipt $${c.receiptFeeUsd.toFixed(2)}`;
    verdicts.set(v, (verdicts.get(v) ?? 0) + 1);
  }
  console.log(`${schedule}\n    "${line}"`);
  for (const [v, n] of verdicts) console.log(`      ${n} x ${v}`);
}
console.log(`\nlines: matches ${tally.matches}, differs ${tally.differs}, no bracket ${tally.no_bracket}`);
console.log("Nothing on a fee schedule was changed. Correct or verify a differing schedule from its fee sheet.");
