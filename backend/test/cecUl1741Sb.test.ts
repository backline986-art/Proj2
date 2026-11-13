// VERIFY FIRST (owner, 2026-11-13): the CEC's own inverter list prints a UL 1741 SB Y/N per listing.
// A utility that asks for the "UL 1741 SB inverter listing" is asking exactly that, so QC and the
// reviewer gate read the list before warning. Pins: the parse keeps the column, the lookup answers only
// when every listing the model can be agrees, rows synced before the column answer nothing, a mirror
// host answers nothing, QC says where the answer came from, and the settings item is answered only by
// the operator's standing answer (owner, 2026-11-13) on an inverter the list certifies.
// Run: tsx backend/test/cecUl1741Sb.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";

function buildXlsx(rows: string[][]): Buffer {
  const zip = new AdmZip();
  const col = (c: number) => (c < 26 ? String.fromCharCode(65 + c) : `A${String.fromCharCode(65 + c - 26)}`);
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const cell = (r: number, c: number, v: string) =>
    v === "" ? "" : `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
  const sheetRows = rows.map((cols, r) => `<row r="${r + 1}">${cols.map((v, c) => cell(r, c, v)).join("")}</row>`).join("");
  zip.addFile("[Content_Types].xml", Buffer.from(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`));
  zip.addFile("_rels/.rels", Buffer.from(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`));
  zip.addFile("xl/workbook.xml", Buffer.from(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Solar_Inverters" sheetId="1" r:id="rId1"/></sheets></workbook>`));
  zip.addFile("xl/_rels/workbook.xml.rels", Buffer.from(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`));
  zip.addFile("xl/worksheets/sheet1.xml", Buffer.from(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`));
  return zip.toBuffer();
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cec-sb-test-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  process.env.AUTOPILOT_AUTO_START = "0";
  process.env.ANTHROPIC_API_KEY = "";
  delete process.env.CEC_INVERTERS_URL;
  const { openDatabase } = await import("../src/db");
  const { parseCecSheet, importCecRows, cecUl1741SbListing, jobInverterUl1741Sb } = await import("../src/cecEquipment");
  const { createProject, buildReviewerReportFor, getProjectDetail } = await import("../src/repository");
  const { runQcForProject } = await import("../src/qc");
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    if (!ok) { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   ${name}`);
  };

  // 1) PARSE. The real workbook's layout (2026-11-13 download): a preamble, the header row, a sub-header
  // row with no manufacturer, then data. Column D is the Y/N; a later column, under a DIFFERENT heading,
  // names the certifying entity ("No Information Submitted" on an N row).
  const header = ["Manufacturer Name", "Model Number1", "Hybrid Inverter2", "UL 1741 Supplement SB Certification",
    "UL 1741 Supplement SA Testing", "Description", "Maximum Continuous Output Power at Unity Power Factor", "Nominal Voltage",
    "UL 1741 (3rd Ed.) Supplement SB  Certification", "Grid Support Listing Date"];
  const xlsx = buildXlsx([
    ["Grid Support Solar/Battery Inverter Certified Equipment List"],
    ["Updated 2026-11-01"],
    header,
    ["", "", "PV and Battery", "3rd Edition", "SA8-SA13", "", "", "", "Certifying Entity", ""],
    ["Enphase Energy, Inc.", "IQ8M-72-2-US {240V}", "N", "Y", "Y", "Microinverter", "0.33", "240", "UL", "2023-05-01"],
    ["Enphase Energy, Inc.", "IQ8M-72-M-US {208V}", "N", "Y", "Y", "Microinverter", "0.33", "208", "UL", "2023-05-01"],
    ["Enphase Energy, Inc.", "IQ8MC-72-M-US {240V}", "N", "N", "Y", "Microinverter", "0.33", "240", "No Information Submitted", "2023-05-01"],
    ["Mixedco Inc.", "MX5000-A {240V}", "N", "Y", "Y", "Inverter", "5", "240", "Intertek", "2023-05-01"],
    ["Mixedco Inc.", "MX5000-B {240V}", "N", "N", "Y", "Inverter", "5", "240", "No Information Submitted", "2023-05-01"],
    ["Oldco Inc.", "OLD3000 {240V}", "N", "N", "Y", "Inverter", "3", "240", "No Information Submitted", "2019-05-01"],
  ]);
  const rows = parseCecSheet("inverter", xlsx);
  check("parse: the sub-header row (no manufacturer) is not a listing", rows.length === 6, `got ${rows.length}`);
  const iq8m = rows.find((r) => r.model === "IQ8M-72-2-US {240V}");
  check("parse: the Y/N column is kept", iq8m?.ul1741sb === "Y", JSON.stringify(iq8m));
  check("parse: the certifying entity comes from its own heading, not the Y/N", iq8m?.ul1741sbBy === "UL", JSON.stringify(iq8m));
  const iq8mc = rows.find((r) => r.model.startsWith("IQ8MC"));
  check("parse: an N row keeps N, and 'No Information Submitted' is not an entity", iq8mc?.ul1741sb === "N" && iq8mc?.ul1741sbBy === "", JSON.stringify(iq8mc));
  check("parse: a module list has no SB column (nothing invented)", parseCecSheet("module", xlsx).every((r) => !r.ul1741sb));
  importCecRows(db, "inverter", rows);

  // 2) LOOKUP. A plan set prints the bare model; the list carries suffixed SKUs.
  const a = cecUl1741SbListing(db, "IQ8M", "Enphase");
  check("lookup: bare 'IQ8M' -> both IQ8M listings, every one Y -> certified", a?.certified === true && a.listedModels.length === 2, JSON.stringify(a));
  check("lookup: IQ8MC (a different model) is never one of IQ8M's listings", !(a?.listedModels ?? []).some((m) => m.startsWith("IQ8MC")), JSON.stringify(a));
  check("lookup: says where the answer came from (the CEC's own government host) and who certified", /solarequipment\.energy\.ca\.gov/.test(a?.sourceUrl ?? "") && a?.certifiedBy === "UL" && Boolean(a?.syncedAt), JSON.stringify(a));
  const exact = cecUl1741SbListing(db, "IQ8MC-72-M-US {240V}", "Enphase");
  check("lookup: an exact listing answers alone (N -> not certified)", exact?.certified === false && exact.listedModels.length === 1, JSON.stringify(exact));
  check("lookup MUST-EXCLUDE: a model string that could be a Y SKU or an N SKU answers nothing", cecUl1741SbListing(db, "MX5000", "Mixedco") === null, JSON.stringify(cecUl1741SbListing(db, "MX5000", "Mixedco")));
  check("lookup: a model not on the list answers nothing", cecUl1741SbListing(db, "NOPE-9000", "Enphase") === null);
  check("lookup: no model answers nothing", cecUl1741SbListing(db, "", "Enphase") === null);
  check("jobInverterUl1741Sb reads the microinverter when there is no string inverter",
    jobInverterUl1741Sb(db, { pvMicroMake: "Enphase", pvMicroModel: "IQ8M" })?.certified === true);

  // A row synced BEFORE this column was read carries raw_json '{}': no answer, never "not certified".
  db.run("UPDATE cec_equipment SET raw_json = '{}' WHERE model = 'IQ8M-72-M-US {208V}'");
  check("lookup MUST-EXCLUDE: a listing synced before the column was read answers nothing", cecUl1741SbListing(db, "IQ8M", "Enphase") === null);
  importCecRows(db, "inverter", rows);

  // A mirror is not the CEC: its answer verifies nothing.
  process.env.CEC_INVERTERS_URL = "https://mirror.example.com/InvertersList.xlsx";
  check("lookup MUST-EXCLUDE: a non-government list URL answers nothing", cecUl1741SbListing(db, "IQ8M", "Enphase") === null);
  delete process.env.CEC_INVERTERS_URL;

  // 3) QC AND THE GATE on an Idaho Power job (its seeded list asks for the UL 1741 SB listing AND the
  // inverter settings). Plan text says neither.
  const job = (invModel: string, make: string) => createProject(db, {
    owner: "SB Test", street: "1 Test St", city: "Boise", state: "ID", zip: "83702", ahj: "City of Boise", utility: "Idaho Power",
    pvMicroMake: make, pvMicroModel: invModel, moduleMake: "Qcells", moduleModel: "Q.TRON BLK M-G2.C1+/AC", moduleQty: "20", moduleWattage: "430",
    dcKw: "8.6", acKw: "6.5", interco: "Load-side breaker", busRating: "200", mainBreaker: "200", pvBreaker: "40",
    electricalCalcText: "NEC 705.12 load-side: 200A bus x 120 percent = 240A. AC disconnect, Eaton DG222URB, within 10 ft of meter.",
  } as never).project.id;
  const qcRows = (pid: string) => db.query<{ rule_id: string; qc_status: string; severity: string; message: string }>(
    "SELECT rule_id, qc_status, severity, message FROM qc_results WHERE project_id = ?", [pid]);
  const gateIds = (pid: string) => buildReviewerReportFor(db, getProjectDetail(db, pid)!.project).findings.map((f) => f.id);

  const certified = job("IQ8M", "Enphase");
  runQcForProject(db, certified);
  const cRows = qcRows(certified);
  const pkg = cRows.find((r) => r.rule_id === "utility-application-package");
  check("QC: a CEC-certified inverter is not listed as missing its UL 1741 SB listing",
    !/UL 1741 SB inverter listing/.test(pkg?.message ?? ""), pkg?.message ?? "(no package row)");
  check("QC: the settings item is answered by the operator's standing answer on a certified inverter (owner, 2026-11-13)",
    !/inverter settings/i.test(pkg?.message ?? ""), pkg?.message ?? "(no package row)");
  const info = cRows.find((r) => r.rule_id === "cec.inverter_ul1741sb");
  check("QC: says where it was verified (CEC list, host, the listings, the certifier)",
    info?.qc_status === "pass" && info.severity === "info" && /Verified from the CEC equipment list \(solarequipment\.energy\.ca\.gov/.test(info.message) && /IQ8M-72-2-US/.test(info.message) && /\(UL\)/.test(info.message)
      && /standing answer/.test(info.message),
    JSON.stringify(info));
  const cGate = gateIds(certified);
  check("gate: no UL 1741 SB listing warning for a CEC-certified inverter", !cGate.includes("reviewer.utility.inverter-listing-ul1741sb"), cGate.join(", "));
  check("gate: no settings warning for a certified inverter under the standing answer", !cGate.includes("reviewer.utility.inverter-settings"), cGate.join(", "));

  const notCertified = job("IQ8MC-72-M-US {240V}", "Enphase");
  runQcForProject(db, notCertified);
  const nPkg = qcRows(notCertified).find((r) => r.rule_id === "utility-application-package");
  check("QC MUST-EXCLUDE: an N listing still reports the UL 1741 SB listing as possibly missing",
    /UL 1741 SB inverter listing/.test(nPkg?.message ?? ""), nPkg?.message ?? "(no package row)");
  check("QC MUST-EXCLUDE: no 'verified' row for an N listing", !qcRows(notCertified).some((r) => r.rule_id === "cec.inverter_ul1741sb"));
  check("gate MUST-EXCLUDE: an N listing keeps the UL 1741 SB listing warning", gateIds(notCertified).includes("reviewer.utility.inverter-listing-ul1741sb"));
  check("QC MUST-EXCLUDE: an N listing keeps the settings item (the standing answer needs a certified inverter)",
    /inverter settings/i.test(nPkg?.message ?? ""), nPkg?.message ?? "(no package row)");
  check("gate MUST-EXCLUDE: an N listing keeps the settings warning", gateIds(notCertified).includes("reviewer.utility.inverter-settings"));

  const ambiguous = job("MX5000", "Mixedco");
  runQcForProject(db, ambiguous);
  check("gate MUST-EXCLUDE: an ambiguous model keeps the warning", gateIds(ambiguous).includes("reviewer.utility.inverter-listing-ul1741sb"));
  check("gate MUST-EXCLUDE: an ambiguous model keeps the settings warning", gateIds(ambiguous).includes("reviewer.utility.inverter-settings"));

  // PACIFICORP'S SETTINGS ITEM (its own QC rule id, pacpower-ul1741sb, on the inverter_settings key):
  // the same standing answer answers it on a certified inverter, and only there.
  const pacJob = (invModel: string) => createProject(db, {
    owner: "SB Test", street: "2 Test St", city: "Coos Bay", state: "OR", zip: "97420", ahj: "City of Coos Bay", utility: "Pacific Power",
    pvMicroMake: "Enphase", pvMicroModel: invModel, moduleMake: "Qcells", moduleModel: "Q.TRON BLK M-G2.C1+/AC", moduleQty: "20", moduleWattage: "430",
    dcKw: "8.6", acKw: "6.5", interco: "Load-side breaker", busRating: "200", mainBreaker: "200", pvBreaker: "40",
  } as never).project.id;
  const pacOk = pacJob("IQ8M");
  runQcForProject(db, pacOk);
  check("QC: Pacific Power's settings row does not fire on a certified inverter", !qcRows(pacOk).some((r) => r.rule_id === "pacpower-ul1741sb"), JSON.stringify(qcRows(pacOk).filter((r) => r.rule_id.startsWith("pacpower"))));
  check("gate: Pacific Power's settings warning does not fire on a certified inverter", !gateIds(pacOk).includes("reviewer.utility.pacpower-settings"), gateIds(pacOk).join(", "));
  const pacN = pacJob("IQ8MC-72-M-US {240V}");
  runQcForProject(db, pacN);
  check("QC MUST-EXCLUDE: Pacific Power's settings row stays on an N listing", qcRows(pacN).some((r) => r.rule_id === "pacpower-ul1741sb"));
  check("gate MUST-EXCLUDE: Pacific Power's settings warning stays on an N listing", gateIds(pacN).includes("reviewer.utility.pacpower-settings"));

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log("\ncecUl1741Sb: all checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
