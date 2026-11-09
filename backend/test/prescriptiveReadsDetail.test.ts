// THE PRESCRIPTIVE SCREEN READS THE ATTACHMENT DETAIL, THE FRAMING TYPE AND THE SNOW LABELS (#336).
//
// A real set routed prescriptive passed on presence ("Attachment/racking details included: Yes"). A
// structural review of it found: the only attachment detail fastened the roof hook INTO THE DECKING
// while a general note and the roof-plan legend put the attachments on the framing members; every
// roof-plane schedule said TRUSS where the parse said rafter; and the cover sheet's ROOF snow load
// was the structural sheet's GROUND snow load, the number the prescriptive screen keys on.
//
// These checks pin, on synthetic sheets modelled on that set's wording (no real plan text, names or
// addresses):
//   - a deck mount with no stated basis warns on the prescriptive screen, naming the contradicting
//     framing note; a stated basis (sheathing type + thickness AND a listed capacity) silences it, and a
//     framing attachment or a negated deck mount never raises it;
//   - the framing type is read off a roof-plane schedule; a parse that says rafter where every
//     schedule says truss is a review item; the plans correct a model "truss" only toward rafter;
//   - one value labelled ground snow on one sheet and roof snow on another is a callout naming both
//     sheets, and the checklist's snow row answers [verify], never Yes;
//   - the prescriptive application's attachment row asks for the basis instead of printing Yes, and a
//     deck mount leaves the checklist's attached-to-framing fact unread.
// Run: tsx backend/test/prescriptiveReadsDetail.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { ParserLlmExtraction, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { evaluateDesignCodeFindings } from "../src/codeReviewRules";
import { evaluatePrescriptiveCriteria } from "../src/permitPath";
import { supplementStructuralIntake } from "../src/structuralIntake";
import { buildApplicationDocumentPackage } from "../src/applicationDocs";
import { planSheets, readDeckMount, readSnowLabels } from "../src/planAttachmentRead";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// One line per sheet, as pdf.js extracts a plan set.
const COVER = "SHEET: PV 0.0 COVER SHEET. DESIGN CRITERIA: ROOF SNOW LOAD: 20 PSF. ULTIMATE WIND SPEED: 100 MPH. EXPOSURE CATEGORY: C.";
const ROOF_PLAN = "SHEET: PV 1.1 ROOF PLAN. LEGEND: ATTACHMENT POINTS = RAFTER. ROOF PLANE 1 TRUSS SIZE & SPACING – 2x4 @ 24 in O.C. ROOF PLANE 2 TRUSS SIZE & SPACING – 2x4 @ 24 in O.C.";
const NOTES = "SHEET: E 1.2 GENERAL NOTES. ALL PV RELATED RACKING ATTACHMENTS WILL BE STAGGERED AMONGST THE ROOF FRAMING MEMBERS.";
const DETAIL = "SHEET: S 1.1 ATTACHMENT DETAIL. ROOF HOOK, DECK MOUNT. (4) WOOD SCREW, M6.3 x 65. PENETRATE INTO DECKING. GROUND SNOW LOAD = 20 PSF.";
const SET = [COVER, ROOF_PLAN, NOTES, DETAIL].join("\n");

const mk = (snapshot: Record<string, unknown>, state = "OR"): ProjectRecord => ({
  id: "reads-detail", clientId: "c", homeownerName: "Detail Probe", projectAddress: "1 Test Lane",
  city: "Testville", state, zip: "97000", ahj: "City of Testville",
  utility: "Test Power", accountNumber: "", meterNumber: "",
  systemSizeDcKw: 6, systemSizeAcKw: 5, interconnectionMethod: "Load-side breaker",
  status: "pending",
  parserSnapshot: {
    state, ahj: "City of Testville", mounting: "Roof mount", permitPath: "prescriptive",
    framingType: "rafter", roofRafterSpacing: "24", roofRafterSpan: "10", snow: "20", deadLoad: "3", wind: "C",
    racking: "Roof hook on rail", planSetExtractedText: SET, ...snapshot,
  },
} as unknown as ProjectRecord);
const gate = (p: ProjectRecord, docTypes: string[] = []): ReviewerFinding[] => evaluateDesignCodeFindings(p, null, undefined, docTypes, []);
const byId = (fs: ReviewerFinding[], id: string) => fs.find((f) => f.id === id);
const DECK = "city.struct.deck-mount-basis-missing";
const FRAME = "city.struct.framing-type-conflict";
const SNOW = "city.struct.snow-load-label-conflict";

// ---- the attachment detail ---------------------------------------------------------------------
check("a deck mount with no stated basis warns, quoting the detail and naming the framing note it contradicts", () => {
  const f = byId(gate(mk({})), DECK);
  assert.ok(f, "finding raised");
  assert.equal(f!.severity, "warning");
  assert.match(f!.message, /S 1\.1: "PENETRATE INTO DECKING"|S 1\.1: "ROOF HOOK, DECK MOUNT"/);
  assert.match(f!.message, /E 1\.2: "ALL PV RELATED RACKING ATTACHMENTS/);
  assert.match(f!.message, /PV 1\.1: "LEGEND: ATTACHMENT POINTS = RAFTER"/);
  assert.ok(!/Detail Probe|1 Test Lane/.test(`${f!.title} ${f!.message}`), "no names or addresses");
});

check("a stated deck-mount basis (sheathing type + thickness AND a listed capacity) silences it; half a basis does not", () => {
  const basis = `${DETAIL} ROOF SHEATHING: 15/32" CDX PLYWOOD. DECK MOUNT ALLOWABLE PULLOUT CAPACITY 410 LBS PER ICC-ES ESR-0000.`;
  assert.equal(byId(gate(mk({ planSetExtractedText: [COVER, ROOF_PLAN, NOTES, basis].join("\n") })), DECK), undefined);
  const half = `${DETAIL} ROOF SHEATHING: 7/16" OSB.`;
  const f = byId(gate(mk({ planSetExtractedText: [COVER, ROOF_PLAN, NOTES, half].join("\n") })), DECK);
  assert.ok(f, "sheathing alone is not a basis");
  assert.match(f!.message, /does not state the listed deck-mount capacity/);
});

check("a framing attachment, a lag through the sheathing into the rafter, or a negated deck mount raises nothing", () => {
  const framing = `SHEET: S 1.1 ATTACHMENT DETAIL. FLASHED L-FOOT. 5/16" X 4" LAG SCREW THROUGH THE SHEATHING INTO RAFTER, 2.5" MIN EMBEDMENT. ATTACHMENTS SHALL NOT PENETRATE INTO DECKING ONLY. NO DECK MOUNTS.`;
  assert.equal(byId(gate(mk({ planSetExtractedText: [COVER, NOTES, framing].join("\n") })), DECK), undefined);
  assert.equal(readDeckMount(planSheets(mk({ planSetExtractedText: framing }))).deckMount.length, 0);
});

check("the deck-mount warning stays on the prescriptive screen: not outside it, not with stamped engineering", () => {
  assert.equal(byId(gate(mk({}, "NV")), DECK), undefined, "no prescriptive screen on file for this state (no context)");
  assert.equal(byId(gate(mk({}), ["structural_letter"]), DECK), undefined, "the engineer owns the basis");
});

// ---- the framing type --------------------------------------------------------------------------
check("a parse that says rafter where every roof-plane schedule says truss is a review item", () => {
  const f = byId(gate(mk({})), FRAME);
  assert.ok(f, "finding raised");
  assert.equal(f!.severity, "warning");
  assert.match(f!.title, /plans say truss, the parse says rafter/);
  assert.match(f!.message, /TRUSS SIZE & SPACING/);
  assert.equal(byId(gate(mk({ framingType: "truss" })), FRAME), undefined, "agreement raises nothing");
  assert.equal(byId(gate(mk({ framingType: "rafter/truss" })), FRAME), undefined, "an ambiguous parse is not a contradiction");
});

const read = (planText: string, fields: ParserLlmExtraction["fields"] = {}) =>
  supplementStructuralIntake({ provider: "stub", fields, lowConfidenceFields: [], notes: "" }, planText).fields;

check("the framing type, size and spacing are read off a roof-plane schedule", () => {
  const f = read(ROOF_PLAN);
  assert.equal(f.framingType?.value, "truss");
  assert.equal(f.roofRafterSize?.value, "2x4");
  assert.equal(f.roofRafterSpacing?.value, 24);
  assert.equal(read("ROOF FRAMING: (E) MANUFACTURED TRUSSES @ 24\" O.C.").framingType?.value, "truss");
});

check("the plans move a model's framing type only toward rafter (the stricter arm), never toward truss", () => {
  assert.equal(read(ROOF_PLAN, { framingType: { value: "rafter", confidence: 0.8 } }).framingType?.value, "rafter");
  assert.equal(read("RAFTER SIZE & SPACING: 2X6 @ 24\" O.C.", { framingType: { value: "truss", confidence: 0.8 } }).framingType?.value, "rafter");
});

// ---- roof vs ground snow -----------------------------------------------------------------------
check("one value labelled roof snow on one sheet and ground snow on another is a callout naming both sheets", () => {
  const f = byId(gate(mk({})), SNOW);
  assert.ok(f, "finding raised");
  assert.equal(f!.severity, "warning");
  assert.match(f!.message, /20 psf is labelled GROUND snow on S 1\.1 and ROOF snow on PV 0\.0/);
});

check("distinct ground and roof snow loads, or a sheet stating only ground snow, raise nothing", () => {
  const cover = COVER.replace("ROOF SNOW LOAD: 20 PSF", "ROOF SNOW LOAD: 14 PSF");
  assert.equal(byId(gate(mk({ planSetExtractedText: [cover, ROOF_PLAN, NOTES, DETAIL].join("\n") })), SNOW), undefined);
  assert.equal(readSnowLabels(planSheets(mk({ planSetExtractedText: DETAIL })), 20), null);
});

check("a roof snow load and no ground snow load, parsed as the ground snow, is the same callout", () => {
  const detail = DETAIL.replace(" GROUND SNOW LOAD = 20 PSF.", "");
  const f = byId(gate(mk({ planSetExtractedText: [COVER, ROOF_PLAN, NOTES, detail].join("\n") })), SNOW);
  assert.ok(f, "finding raised");
  assert.match(f!.message, /ROOF snow load of 20 psf .*no ground snow load/);
});

check("the checklist's ground snow row answers [verify], never Yes, when the labels disagree", () => {
  const row = (p: ProjectRecord) => evaluatePrescriptiveCriteria(p).find((r) => r.key === "snowLoad")!;
  const conflicted = row(mk({}));
  assert.equal(conflicted.answer, "[verify]");
  assert.match(conflicted.detail, /PV 0\.0/);
  assert.equal(row(mk({ planSetExtractedText: DETAIL })).answer, "Yes", "a ground snow load read cleanly still answers Yes");
  assert.equal(row(mk({ snow: "80" })).answer, "No", "an over-limit value stays No");
});

// ---- the checklist the operator files ----------------------------------------------------------
check("the prescriptive application's attachment row asks for the deck-mount basis instead of printing Yes", () => {
  const doc = buildApplicationDocumentPackage(mk({})).docs.find((d) => d.id === "prescriptive-application");
  assert.ok(doc, "prescriptive application built");
  const line = doc!.markdown.split("\n").find((l) => l.includes("Attachment/racking details included"))!;
  assert.match(line, /\[verify\] — the attachment detail fastens into the roof decking/);
  assert.ok(!/included: Yes/.test(line));
  const clean = buildApplicationDocumentPackage(mk({ planSetExtractedText: [COVER, NOTES].join("\n") })).docs.find((d) => d.id === "prescriptive-application")!;
  assert.match(clean.markdown, /Attachment\/racking details included: Yes/);
});

check("a deck mount leaves the attached-to-framing fact unread, even beside a 'mounted to the roof framing' note", () => {
  const f = read(`SOLAR PANELS ARE TO BE MOUNTED TO THE ROOF FRAMING.\n${DETAIL}`, { attachmentToFraming: { value: "yes", confidence: 0.9 } });
  assert.equal(f.attachmentToFraming, undefined);
  assert.equal(read("SOLAR PANELS ARE TO BE MOUNTED TO THE ROOF FRAMING.").attachmentToFraming?.value, "yes", "no deck mount: the note still reads");
});

if (failures) {
  console.error(`\n${failures} prescriptiveReadsDetail check(s) failed`);
  process.exit(1);
}
console.log("\nprescriptiveReadsDetail: all checks passed");
