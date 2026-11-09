// AN SLD TITLED WITH A SPACE IS STILL AN SLD (#691). The splitter's `sld` patterns allowed an optional
// HYPHEN ("SINGLE-LINE", "3-LINE DIAGRAM") but not a space, and "THREE LINE DIAGRAM" / "ELECTRICAL
// SCHEMATIC" had no pattern, so a NEM package reported the SLD missing from a plan set that has one.
// Invented title-block strings only: titles, not jurisdictions. The browser copy in parser-review.js
// is pinned to this list by docSplitterMirror.test.ts.
//   npx tsx backend/test/docSplitterSldTitles.test.ts
import "./_isolate";
import { scorePage } from "../src/docSplitter";

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}${detail ? ` ${detail}` : ""}`); }
};
const sheet = (title: string) => `EXAMPLE SOLAR LLC  123 SAMPLE RD  PV-5  ${title}  SCALE: NTS  REV 0`;
const filedAs = (title: string) => scorePage(sheet(title)).docTypes[0] ?? "(none)";

for (const title of ["SINGLE LINE DIAGRAM", "SINGLE LINE", "3 LINE DIAGRAM", "THREE LINE DIAGRAM", "THREE-LINE DIAGRAM", "ONE LINE DIAGRAM", "ONE LINE DRAWING", "ELECTRICAL SCHEMATIC"]) {
  run(`MUST PASS: "${title}" splits as the SLD`, filedAs(title) === "sld", filedAs(title));
  run(`MUST PASS: "${title}" is the page's own title-block name (byPattern)`, scorePage(sheet(title)).byPattern === true);
}
// Pinned: the titles that already split keep splitting.
for (const title of ["SINGLE-LINE DIAGRAM", "SINGLELINE", "ONE-LINE DIAGRAM", "ONELINE", "3-LINE DIAGRAM", "3LINE DIAGRAM", "ELECTRICAL LINE DIAGRAM"]) {
  run(`PINNED: "${title}" still splits as the SLD`, filedAs(title) === "sld", filedAs(title));
}
// Prose that shares the words is not a title.
for (const title of ["THREE LINE ITEMS ON THE FEE SCHEDULE", "PROPERTY LINE", "SETBACK FROM THREE LINES OF CONDUIT", "ONE LINE PER CIRCUIT", "ROOF PLAN - SETBACK 3 FT FROM PROPERTY LINE"]) {
  run(`MUST EXCLUDE: "${title}" is not an SLD`, filedAs(title) !== "sld", filedAs(title));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\ndocSplitterSldTitles: all checks passed");
