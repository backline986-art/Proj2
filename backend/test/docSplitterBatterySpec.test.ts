// A BATTERY / ESS DATASHEET INSIDE THE PLAN SET IS FOUND BY ITS CONTENT, NOT A DS SHEET CODE (#261).
//
// A storage job owes the battery's cut sheet (essRequirements.ts: battery_spec, blocking), and its make,
// model and kWh feed the NEM portal and the AHJ's ESS review. Before: docSplitter had no battery
// category, so the datasheet inside the plan set was never cut into its own battery_spec document; and
// the parser page (parser.html detectSplitPages) looked only at DS-coded sheets — one design firm's
// numbering — so every other plan set read "MISSING - 07 Battery / ESS Spec Sheet" with the datasheet
// in the PDF.
//
// Pinned here, on synthetic text:
//   1. batteryPage / scorePage: a datasheet by its BODY (labelled kWh + storage words + datasheet rows)
//      or its NAME is the battery spec, whatever the sheet number;
//   2. MUST-EXCLUDE (Helm's triage): no battery page → nothing; an inverter datasheet, an ESS / hybrid
//      inverter datasheet, a combined INVERTER / BATT sheet and a calculation sheet are never the battery
//      spec (the inverter-reading ones are undecided, for the page-index read or a person); an SLD or
//      ESS detail that calls the battery out stays where it is; a gateway datasheet is not a battery;
//   3. buildUtilityPackage cuts a battery_spec part (permit, nem, all) and never reports it missing on a
//      set with no battery; the page-index read's battery_spec answer fills the part (#79 path);
//   4. the submit gate's inventory stops holding battery_spec once the split ran;
//   5. the parser page's split map (the REAL detectSplitPages / updateSplitUi from parser.html, run in
//      node:vm with parser-review.js) reports the battery spec READY on a set with no DS code.
// Run: npx tsx backend/test/docSplitterBatterySpec.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so docs never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { REPO } from "./_isolate";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-splitter-battery-spec-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = "";
process.env.PERMIT_PROCESS_LOOKUP = "off";

const { openDatabase } = await import("../src/db");
const { createProject } = await import("../src/repository");
const { createClient } = await import("../src/clients");
const { saveProjectDocument } = await import("../src/projectDocuments");
const { buildUtilityPackage, batteryPage, scorePage, isUndecidedSpecPage } = await import("../src/docSplitter");
const rd = await import("../src/requiredDocuments");

const db = await openDatabase();

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};
const json = (v: unknown) => JSON.stringify(v);

// ----- synthetic sheets (every make / model / number below is invented) -----------------------
const title = (sheet: string, name: string) => ["SYNTH SOLAR CO  123 FIXTURE RD", `SHEET NAME: ${name}`, `SHEET NUMBER: ${sheet}`];
// A battery datasheet bound into the plan set as PV-8, under a generic EQUIPMENT title: no DS code, no
// battery sheet name. Only its body says what it is.
const BATTERY_BODY = [
  "EXAMPLECELL HB-10 HOME BATTERY", "Usable Energy 10.1 kWh", "Continuous Power 5 kW", "Round-trip efficiency 90%",
  "Depth of discharge 100%", "Warranty 10 years", "Operating temperature -20 C to 50 C", "Chemistry LFP",
  "Scalable up to 4 units", "Certifications UL 9540, UL 1973, UL 9540A",
];
const BATTERY_DS = [...title("PV-8", "EQUIPMENT DATASHEET"), ...BATTERY_BODY];
// The same body under the EQUIPMENT SPECIFICATION title the undecided rule watches (#66).
const BATTERY_EQUIP_SPEC = [...title("PV-12", "EQUIPMENT SPECIFICATION"), ...BATTERY_BODY];
// A table layout: the unit in the label.
const BATTERY_TABLE = [...title("S-3", "MANUFACTURER DATA"), "EXAMPLECELL STACK 20", "Energy (kWh) 20.2", "Battery chemistry Lithium iron phosphate",
  "Cycle life 6,000 cycles", "Warranty 10 years", "Peak power 10 kW", "UL 1973 listed"];
// Image-only datasheets: the title block names them, nothing else is text.
const BATTERY_NAMED = title("PV-9", "BATTERY SPEC SHEET");
const ESS_NAMED = title("SS-2", "ESS DATA SHEET");
const STORAGE_NAMED = title("A-4", "ENERGY STORAGE SYSTEM SPECIFICATIONS");

// MUST-EXCLUDE pages.
const SLD = [...title("PV-6", "3-LINE DIAGRAM"), "ESS: EXAMPLECELL HB-10, USABLE ENERGY 10.1 kWh, LITHIUM ION, UL 9540", "BATTERY SPECIFICATIONS SEE PV-8",
  "WARRANTY PER MANUFACTURER", "CONTINUOUS POWER 5 kW", "OPERATING TEMPERATURE PER MFR"];
const ESS_DETAIL = [...title("PV-5", "ESS LOCATION DETAIL"), "ENERGY STORAGE SYSTEM 10.1 kWh USABLE ENERGY", "LITHIUM ION, NEMA 3R, UL 9540", "3 FT CLEARANCE PER NEC 706"];
const STRING_INVERTER = [...title("PV-10", "INVERTER SPECIFICATION SHEET"), "EXAMPLE 7.6 kW STRING INVERTER", "MPPT voltage range 200-480 V",
  "CEC weighted efficiency 97.5%", "Warranty 12 years", "Operating temperature -25 C to 60 C", "UL 1741 SB"];
// A hybrid / ESS inverter datasheet that lists the battery it pairs with — capacity, round trip and all.
const HYBRID_INVERTER = [...title("PV-11", "EQUIPMENT DATASHEET"), "EXAMPLE HX-8 HYBRID INVERTER", "Battery capacity 9.7 kWh to 29.1 kWh",
  "Battery round-trip efficiency 94%", "Warranty 10 years", "Operating temperature -20 C to 50 C", "Continuous power 8 kW", "2 MPPT, PV input 600 V", "UL 1741 SB, UL 9540"];
// Named as a battery sheet but its body reads as an inverter.
const HYBRID_NAMED_BATTERY = [...title("PV-13", "BATTERY SPEC SHEET"), "EXAMPLE HX-8 HYBRID INVERTER", "4 MPPT", "PV input 600 V"];
// A combined INVERTER / BATT title, image-only.
const INV_BATT_NAMED = title("DS 4", "INVERTER/BATT DATA SHEET");
const CALCS = [...title("PV-7", "WIRING CALCULATIONS"), "BATTERY SPECIFICATIONS", "Usable energy 10.1 kWh", "Round trip efficiency 90%",
  "Warranty 10 years", "Operating temperature 50 C", "Continuous power 5 kW", "LFP"];
const GATEWAY = [...title("PV-14", "GATEWAY DATA SHEET"), "EXAMPLE BACKUP GATEWAY for the HB-10 battery", "Warranty 10 years", "Operating temperature -20 C to 50 C", "Continuous current 200 A"];
const NOTES_E = [...title("E 1.2", "ELECTRICAL NOTES"), "ENERGY STORAGE SYSTEM NOTES: TOTAL ENERGY 10.1 kWh", "BATTERY WARRANTY PER MFR", "OPERATING TEMPERATURE PER MFR", "ROUND TRIP EFFICIENCY PER MFR"];
const INDEX = ["SHEET INDEX PV-1 SITE PLAN PV-6 3-LINE DIAGRAM PV-8 BATTERY SPEC SHEET PV-9 ESS DATA SHEET"];
const MODULE = [...title("PV-10", "PV MODULE SPECIFICATION SHEET"), "EXAMPLE 400 W MODULE", "Warranty 25 years", "Operating temperature -40 C to 85 C"];
const SITE = [...title("PV-1", "SITE PLAN"), "FIRE PATHWAYS 36 IN"];

const t = (lines: string[]) => lines.join(" ");

// ---------------------------------------------------------------------------
console.log("1. A BATTERY DATASHEET BY ITS CONTENT OR NAME IS THE BATTERY SPEC (no DS code)");
for (const [name, lines] of [
  ["body under a generic EQUIPMENT DATASHEET title (PV-8)", BATTERY_DS],
  ["body under an EQUIPMENT SPECIFICATION title (PV-12)", BATTERY_EQUIP_SPEC],
  ["body as a table, kWh in the label (S-3)", BATTERY_TABLE],
  ["image-only, BATTERY SPEC SHEET title (PV-9)", BATTERY_NAMED],
  ["image-only, ESS DATA SHEET title (SS-2)", ESS_NAMED],
  ["image-only, ENERGY STORAGE SYSTEM SPECIFICATIONS title (A-4)", STORAGE_NAMED],
] as const) {
  const text = t(lines as unknown as string[]);
  const s = scorePage(text);
  run(`${name}: batteryPage = "spec"`, batteryPage(text) === "spec", String(batteryPage(text)));
  run(`${name}: filed as battery_spec, only`, json(s.docTypes) === json(["battery_spec"]), json(s));
  run(`${name}: not reported undecided`, !isUndecidedSpecPage(text, s), json(s));
}

console.log("\n2. MUST-EXCLUDE");
for (const [name, lines, want] of [
  ["an SLD that calls the battery out", SLD, ["sld"]],
  ["an ESS location detail (callouts, no datasheet table)", ESS_DETAIL, []],
  ["a string inverter datasheet", STRING_INVERTER, ["inverter_spec"]],
  ["a hybrid / ESS inverter datasheet listing battery capacity", HYBRID_INVERTER, []],
  ["an inverter body under a BATTERY SPEC SHEET title", HYBRID_NAMED_BATTERY, []],
  ["a combined INVERTER/BATT DATA SHEET title", INV_BATT_NAMED, []],
  ["a WIRING CALCULATIONS sheet tabulating the battery", CALCS, []],
  ["a gateway datasheet", GATEWAY, []],
  ["an E x.x electrical notes sheet with ESS notes", NOTES_E, []],
  ["the cover's SHEET INDEX naming BATTERY SPEC SHEET", INDEX, []],
  ["a module datasheet", MODULE, ["module_spec"]],
] as const) {
  const text = t(lines as unknown as string[]);
  const s = scorePage(text);
  run(`${name}: never battery_spec (filed ${json(want)})`, !s.docTypes.includes("battery_spec") && json(s.docTypes) === json(want), json(s));
}
for (const [name, lines] of [
  ["a hybrid / ESS inverter datasheet listing battery capacity", HYBRID_INVERTER],
  ["an inverter body under a BATTERY SPEC SHEET title", HYBRID_NAMED_BATTERY],
  ["a combined INVERTER/BATT DATA SHEET title", INV_BATT_NAMED],
] as const) {
  const text = t(lines as unknown as string[]);
  run(`${name}: reported UNDECIDED (a person or the page-index read decides), never dropped`,
    batteryPage(text) === "undecided" && isUndecidedSpecPage(text, scorePage(text)), String(batteryPage(text)));
}
run("the calcs sheet is not undecided either (known not to be a spec)", !isUndecidedSpecPage(t(CALCS), scorePage(t(CALCS))));

// ---------------------------------------------------------------------------
const mkPdf = async (sheets: string[][]): Promise<Buffer> => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const lines of sheets) {
    const page = pdf.addPage([1224, 792]);
    lines.forEach((line, i) => page.drawText(line, { x: 40, y: 740 - i * 20, size: 8, font }));
  }
  return Buffer.from(await pdf.save());
};
const client = createClient(db, { companyName: "Battery Spec Test Solar", ccbLicenseNumber: "261261" });
let n = 0;
const projectWith = async (sheets: string[][]) => {
  const p = createProject(db, {
    clientId: client.id, owner: `Battery Owner ${++n}`, street: `${n} Battery Way`, city: "Sagebrush", state: "CO", zip: "80000",
    ahj: "Sagebrush", utility: "Example Mountain Electric", dcKw: "6", acKw: "5",
  }).project;
  saveProjectDocument(db, p.id, { docType: "plan_set", filename: `battery-plan-set-${n}.pdf`, contentType: "application/pdf", buffer: await mkPdf(sheets), source: "upload" });
  return p;
};
const SET = [SITE, SLD, CALCS, BATTERY_DS, STRING_INVERTER, MODULE, GATEWAY]; // battery datasheet is page 4
const BATTERY_PAGE = 4;

console.log("\n3. THE SPLITTER CUTS THE BATTERY SPEC");
for (const target of ["permit", "nem", "all"] as const) {
  const p = await projectWith(SET);
  const r = await buildUtilityPackage(db, p.id, target);
  const part = r.parts.find((x) => x.docType === "battery_spec");
  run(`[${target}] a battery_spec part holds page ${BATTERY_PAGE} only`, json(part?.pages) === json([BATTERY_PAGE]), json(r.parts.map((x) => [x.docType, x.pages])));
  run(`[${target}] the battery spec is packaged`, r.packagedDocTypes.includes("battery_spec"), json(r.packagedDocTypes));
  run(`[${target}] MUST-EXCLUDE: the calcs (3), inverter (5) and gateway (7) pages are not in it`, ![3, 5, 7].some((pg) => part?.pages.includes(pg)), json(part?.pages));
}
{
  const p = await projectWith([SITE, SLD, STRING_INVERTER, MODULE]);
  const r = await buildUtilityPackage(db, p.id, "permit");
  run("MUST-EXCLUDE: a set with no battery page cuts no battery_spec part", !r.parts.some((x) => x.docType === "battery_spec"), json(r.parts.map((x) => x.docType)));
  run("…and never reports it missing (a storage job's own rows say whether it is owed)",
    !r.missingDocTypes.includes("battery_spec") && !r.missingSheetTypes.includes("battery_spec"), json([r.missingDocTypes, r.missingSheetTypes]));
}
{
  // The hybrid inverter is undecided; the existing page-index read (#79) names page 2 a battery
  // datasheet → the battery part. No new call: the same classifyPlanPages the module/inverter path uses.
  const p = await projectWith([SLD, [...title("PV-15", "EQUIPMENT SPECIFICATION")], HYBRID_INVERTER]);
  const shown: number[][] = [];
  const llm = {
    async classifyPlanPages(input: { pageImages: Array<{ page: number }> }) {
      shown.push(input.pageImages.map((x) => x.page));
      return { pages: input.pageImages.map((x) => ({ page: x.page, sheet: "", title: "", kind: x.page === 2 ? "battery_spec" : "inverter_spec" })) };
    },
  };
  const r = await buildUtilityPackage(db, p.id, "all", { llm });
  const pages = (d: string) => r.parts.find((x) => x.docType === d)?.pages ?? [];
  run("the undecided pages (title-only spec, hybrid inverter) go to the ONE existing page-index read", json(shown) === json([[2, 3]]), json(shown));
  run("the read's battery_spec page is cut into the battery part", json(pages("battery_spec")) === json([2]), json(r.parts.map((x) => [x.docType, x.pages])));
  run("…and the hybrid inverter the read named an inverter is in inverter_spec, not battery_spec", json(pages("inverter_spec")) === json([3]), json(r.parts.map((x) => [x.docType, x.pages])));
}

// ---------------------------------------------------------------------------
console.log("\n4. THE SUBMIT GATE: the split battery spec clears the battery_spec hold");
{
  const p = await projectWith(SET);
  const BATTERY = { hasBattery: "Yes", batteryMake: "Examplecell", batteryModel: "HB-10", batteryQty: "1" };
  const project = { ...(p as object), parserSnapshot: { ...BATTERY, packetReadinessText: "MISSING - 07 Battery / ESS Spec Sheet" } } as never;
  const held = () => rd.documentInventory(db, project).missingBlocking.some((d) => d.docType === "battery_spec");
  run("before the split: battery_spec is held", held());
  await buildUtilityPackage(db, p.id, "permit");
  run("after the split: battery_spec is present from the cut part", !held());
}

// ---------------------------------------------------------------------------
console.log("\n5. THE PARSER PAGE'S SPLIT MAP: READY without a DS code");
{
  const html = fs.readFileSync(path.join(REPO, "frontend", "parser.html"), "utf8");
  const cut = (name: string): string => {
    const start = html.indexOf(`\nfunction ${name}(`);
    if (start < 0) throw new Error(`parser.html has no function ${name}`);
    const open = html.indexOf("{", html.indexOf(")", start));
    let depth = 0;
    for (let i = open; i < html.length; i++) {
      if (html[i] === "{") depth++;
      else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(`unbalanced function ${name}`);
  };
  const values: Record<string, string> = {};
  const sandbox: Record<string, unknown> = {
    window: {} as Record<string, unknown>, state: { planDoc: null as unknown },
    setVal: (id: string, v: string) => { values[id] = v; }, getVal: () => "", updateProjectDoxUi: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(REPO, "frontend", "parser-review.js"), "utf8"), sandbox, { filename: "parser-review.js" });
  const cleanLine = html.split("\n").find((l) => /^const clean = /.test(l));
  if (!cleanLine) throw new Error("parser.html has no const clean");
  vm.runInContext(cleanLine.replace(/^const /, "var "), sandbox, { filename: "parser.html" });
  vm.runInContext(["normalizeText", "actualSheetCode", "pagesByCode", "dsPages", "detectSplitPages", "updateSplitUi"].map(cut).join("\n"), sandbox, { filename: "parser.html" });
  const splitUi = (sheets: string[][]) => {
    (sandbox.state as { planDoc: unknown }).planDoc = { pageCount: sheets.length, pages: sheets.map((lines, i) => ({ page: i + 1, text: lines.join("\n") })) };
    vm.runInContext("updateSplitUi()", sandbox);
    return { split: values.splitPagesText ?? "", ready: values.utilityDownloadChecklistText ?? "" };
  };
  const line = (text: string, re: RegExp) => text.split("\n").find((l) => re.test(l)) ?? "";
  const withBattery = splitUi(SET);
  run(`"07 Battery / ESS specs" lists page ${BATTERY_PAGE}`, line(withBattery.split, /^07 /) === `07 Battery / ESS specs: ${BATTERY_PAGE}`, line(withBattery.split, /^07 /));
  run("readiness says READY - 07 Battery / ESS Spec Sheet", line(withBattery.ready, /07 Battery/) === "READY - 07 Battery / ESS Spec Sheet", line(withBattery.ready, /07 Battery/));
  // The gate reads those two lines (requiredDocuments.sheetInPlanSet) on a project with a plan-set file.
  const docs = { plan_set: "/x/plan.pdf" };
  const gateProject = { parserSnapshot: { splitPagesText: withBattery.split, packetReadinessText: withBattery.ready } } as never;
  run("…and the gate counts the battery spec in the plan set", rd.sheetInPlanSet(gateProject, "battery_spec", docs));
  const none = splitUi([SITE, SLD, CALCS, STRING_INVERTER, MODULE, GATEWAY, ESS_DETAIL]);
  run("MUST-EXCLUDE: no battery page → not detected (calcs, inverter, gateway, ESS detail are not it)",
    line(none.split, /^07 /) === "07 Battery / ESS specs: not detected", line(none.split, /^07 /));
  const noneProject = { parserSnapshot: { splitPagesText: none.split, packetReadinessText: none.ready } } as never;
  run("…and the gate does not count one", !rd.sheetInPlanSet(noneProject, "battery_spec", docs));
  const ds = splitUi([SITE, SLD, [...title("DS 3", "BATTERY DATA SHEET")]]);
  run("a DS-coded BATTERY DATA SHEET still fills the row", line(ds.split, /^07 /) === "07 Battery / ESS specs: 3", line(ds.split, /^07 /));
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
