// #668 — THE COMPANION APPLICATION FORM IS DATA, NOT A HOST IN CODE.
//
// The fee researcher used to carry one county's host and form URL: an electrical finding sourced
// from that county's site opened that fixed PDF, and nobody else's. Now the authority's recorded
// application form (the curated forms registry, per-jurisdiction data) is found by the finding's
// own host and discipline, for any jurisdiction, and opened through openFeeDocument.
// Synthetic hosts and forms; the opener is a stub (no network).
// Run: npx tsx backend/test/feeCompanionDocuments.test.ts
import "./_isolate"; // FIRST
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fee-companion-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.sqlite");
const F = await import("../src/feeSchedules");

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`ok   - ${name}`);
  else { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
};

const FORMS = [
  { state: "UT", formType: "electrical_application", url: "https://permits.example-falls.gov/forms/electrical-application.pdf" },
  { state: "UT", formType: "building_application", url: "https://permits.example-falls.gov/forms/building-application.pdf" },
];
const SCHEDULE = "https://permits.example-falls.gov/fees/schedule.pdf";
const ledger = () => ({ evidence: [] as Array<{ url: string }>, corpus: [] as string[] }) as unknown as Parameters<typeof F.openCompanionFeeDocuments>[1];
const opener = (log: string[]) => (async (args: { url?: unknown }) => { log.push(String(args.url)); return ""; }) as unknown as typeof F.openFeeDocument;

{
  const opened: string[] = [];
  const r = await F.openCompanionFeeDocuments({ state: "UT", discipline: "electrical", sourceUrl: SCHEDULE }, ledger(), { open: opener(opened), forms: FORMS });
  check("1. a synthetic AHJ with a RECORDED electrical application form gets it opened during research (once, through the opener)",
    JSON.stringify(opened) === JSON.stringify([FORMS[0].url]) && JSON.stringify(r) === JSON.stringify([FORMS[0].url]), JSON.stringify(opened));
}
{
  const opened: string[] = [];
  await F.openCompanionFeeDocuments({ state: "UT", discipline: "structural", sourceUrl: SCHEDULE }, ledger(), { open: opener(opened), forms: FORMS });
  check("2. the structural finding gets the BUILDING application, never the electrical one", JSON.stringify(opened) === JSON.stringify([FORMS[1].url]), JSON.stringify(opened));
}
{
  const opened: string[] = [];
  await F.openCompanionFeeDocuments({ state: "UT", discipline: "electrical", sourceUrl: "https://www.other-town.example.gov/fees.pdf" }, ledger(), { open: opener(opened), forms: FORMS });
  check("3. MUST-EXCLUDE: an AHJ with no recorded form gets nothing extra (another authority's host)", opened.length === 0, JSON.stringify(opened));
}
{
  const opened: string[] = [];
  await F.openCompanionFeeDocuments({ state: "UT", discipline: "electrical", sourceUrl: SCHEDULE }, ledger(), { open: opener(opened), forms: [] });
  check("4. MUST-EXCLUDE: nothing recorded at all → nothing opened", opened.length === 0);
}
{
  const opened: string[] = [];
  const l = ledger();
  (l.evidence as Array<{ url: string }>).push({ url: FORMS[0].url });
  await F.openCompanionFeeDocuments({ state: "UT", discipline: "electrical", sourceUrl: SCHEDULE }, l, { open: opener(opened), forms: FORMS });
  check("5. a form the pass already read is not fetched twice", opened.length === 0, JSON.stringify(opened));
}
{
  const opened: string[] = [];
  await F.openCompanionFeeDocuments({ state: "ID", discipline: "electrical", sourceUrl: SCHEDULE }, ledger(), { open: opener(opened), forms: FORMS });
  check("6. MUST-EXCLUDE: a form recorded under another state is not this finding's", opened.length === 0, JSON.stringify(opened));
}
check("7. no jurisdiction host or form URL is written in feeSchedules.ts code (comments aside)",
  !fs.readFileSync(path.join(import.meta.dirname, "../src/feeSchedules.ts"), "utf8").split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .some((l) => /https?:\/\/(?![^'"`\s]*example)[a-z0-9.-]+\.(?:gov|us)\b/i.test(l)));

fs.rmSync(dir, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nfee companion documents: all checks passed");
process.exit(0);
