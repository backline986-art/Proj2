// THE UL LISTINGS INTAKE READ OFF A PAGE IMAGE ARE SHOWN (audit 2026-11-28).
// The parser page's read of an image-only data sheet fills the field and keeps the printed words in
// parserEvidenceText. Nothing read that key: QC's sheet-content row said "no UL 1741(-SB) listing
// text found" and "no module listing text found", and the reviewer's UL-listing reader said the
// module listing was not shown, on jobs whose intake had read exactly those words.
// Pins, through the real write paths (createProject with a parser payload, saveProjectDocument,
// documentInventory, sheetContentGaps, runQcForProject, packageListings):
//   - MUST-PASS: the words intake recorded for the module listing and for an inverter field clear the
//     QC rows and are what the reviewer's reader returns, with where intake read them;
//   - "UL 1741SB" / "UL1741SA" printed with no bare "UL 1741" is the UL 1741 listing;
//   - MUST-EXCLUDE: a field's VALUE alone (no quoted words), a quote recorded for another product's
//     field, a quote that is not from the plan set, and a negation ("not listed to UL 1741") show nothing.
// Synthetic data only. Run: tsx backend/test/requiredDocListingEvidence.test.ts
import "./_isolate"; // FIRST
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "listing-evidence-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;
const db = await (await import("../src/db")).openDatabase();
const repo = await import("../src/repository");
const docs = await import("../src/projectDocuments");
const req = await import("../src/requiredDocuments");
const rules = await import("../src/codeReviewRules");
const { runQcForProject } = await import("../src/qc");

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};

let n = 0;
const make = (evidence: string[], extra: Record<string, string> = {}) => {
  const p = repo.createProject(db, {
    owner: `Fixture Owner ${++n}`, street: "100 Test St", city: "Testville", state: "ZZ", zip: "00001",
    ahj: "City of Testville", utility: "Testville Power", dcKw: "8", acKw: "6",
    pvMicroModel: "ZZ-MICRO-300", pvMicroQty: "20", moduleModel: "ZZ-MOD-400",
    // Some readable body text, so the content check runs at all; it names neither listing.
    projectDescriptionText: "ROOF MOUNT PV SYSTEM WITH MICROINVERTERS",
    parserEvidenceText: evidence.join("\n"),
    ...extra,
  } as never).project;
  for (const docType of ["module_spec", "inverter_spec"]) {
    docs.saveProjectDocument(db, p.id, { docType, filename: `${docType}.pdf`, contentType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n${docType} ${n}\n`), source: "upload" });
  }
  return p.id;
};
const gapsOf = (id: string) => {
  const project = repo.getProjectDetail(db, id).project;
  return req.sheetContentGaps(project, req.documentInventory(db, project).presence);
};
const missing = (id: string, docType: string) => gapsOf(id).find((g) => g.docType === docType)?.missing ?? [];
const qcRow = (id: string, docType: string) => {
  runQcForProject(db, id);
  return db.get<{ message: string }>("SELECT message FROM qc_results WHERE project_id = ? AND rule_id = ?", [id, `docs.${docType}.content`])?.message ?? "";
};
// The lines as the parser page writes them: field = value  [where, NN%] "printed words".
const MODULE_LINE = 'moduleListingAgency = CSA  [plan set page 11 (DS-1), 60%] "CERTIFICATES: UL 61730-1 & UL 61730-2"';
const INVERTER_LINE = 'inverterSettings = UL 1741 SB  [plan set page 12 (DS-2), 85%] "UL LISTED AS PV RAPID SHUT DOWN EQUIPMENT UL1741SA, UL 1741SB"';

console.log("\n1. BASELINE: with no recorded evidence the rows say what was not found");
{
  const id = make([]);
  run("the module listing is missing", missing(id, "module_spec").length === 1, JSON.stringify(gapsOf(id)));
  run("the UL 1741 listing is missing", missing(id, "inverter_spec").length === 1, JSON.stringify(gapsOf(id)));
  run("the QC row says what it read", /words intake recorded from page images/.test(qcRow(id, "inverter_spec")), qcRow(id, "inverter_spec"));
}

console.log("\n2. MUST-PASS: the words intake recorded are shown");
{
  const id = make([MODULE_LINE, INVERTER_LINE], { moduleListingAgency: "CSA", inverterSettings: "UL 1741 SB" });
  run("no module-listing gap", missing(id, "module_spec").length === 0, JSON.stringify(gapsOf(id)));
  run("no UL 1741 gap", missing(id, "inverter_spec").length === 0, JSON.stringify(gapsOf(id)));
  run("QC writes neither content row", qcRow(id, "module_spec") === "" && qcRow(id, "inverter_spec") === "", `${qcRow(id, "module_spec")} | ${qcRow(id, "inverter_spec")}`);
  const project = repo.getProjectDetail(db, id).project;
  const shown = rules.packageListings(project).module;
  run("the reviewer's reader returns the module listing", /UL 61730/.test(String(shown?.excerpt)), JSON.stringify(shown));
  run("…and says where intake read it", /Intake's read of the plan set page 11 \(DS-1\)/.test(String(shown?.source)), JSON.stringify(shown));
  run("the inverter reader returns the page too", /plan set page 12/.test(String(rules.inverterListingShown(project)?.source)), JSON.stringify(rules.inverterListingShown(project)));
}

console.log("\n3. UL 1741SB / UL1741SA with no bare UL 1741");
{
  const id = make([], { labelsText: "INVERTER CERTIFIED TO UL1741SA AND UL 1741SB" });
  run("MUST-PASS: the supplement spelling is the listing", missing(id, "inverter_spec").length === 0, JSON.stringify(gapsOf(id)));
  run("MUST-EXCLUDE: a longer number is not", !rules.INVERTER_LISTING_PATTERNS.some((re) => re.test("PART NO UL 17412")));
}

console.log("\n4. MUST-EXCLUDE: what is not the sheet's own words about that product");
{
  const valueOnly = make(["moduleListingAgency = UL 61730  [plan set page 11 (DS-1), 60%]", "inverterSettings = UL 1741 SB  [plan set page 12 (DS-2), 85%]"], { moduleListingAgency: "UL", inverterSettings: "UL 1741 SB" });
  run("a field's value with no quoted words shows nothing", missing(valueOnly, "module_spec").length === 1 && missing(valueOnly, "inverter_spec").length === 1, JSON.stringify(gapsOf(valueOnly)));
  const otherField = make(['rackingModel = ZZ-RAIL  [plan set page 13 (DS-3), 80%] "FOR USE WITH UL 61730 MODULES AND UL 1741 INVERTERS"']);
  run("a quote recorded for another product's field shows nothing", missing(otherField, "module_spec").length === 1 && missing(otherField, "inverter_spec").length === 1, JSON.stringify(gapsOf(otherField)));
  const otherSource = make(['moduleListingAgency = UL  [utility bill, 60%] "UL 61730"', 'inverterSettings = x  [doc, 85%] "UL 1741"']);
  run("a quote that is not from the plan set shows nothing", missing(otherSource, "module_spec").length === 1 && missing(otherSource, "inverter_spec").length === 1, JSON.stringify(gapsOf(otherSource)));
  const negated = make(['inverterSettings = none  [plan set page 12 (DS-2), 85%] "NOT LISTED TO UL 1741"']);
  run("a negation shows nothing to the reviewer's reader", rules.inverterListingShown(repo.getProjectDetail(db, negated).project) === null);
}

if (failures > 0) {
  console.error(`\n${failures} listing-evidence check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll listing-evidence checks passed.");
