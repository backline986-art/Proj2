// A HAND RECORDING'S UPLOADS NAME THEIR DOCUMENT (owner 2026-11-20: "I submitted two hand recorded
// resipies that didn't work"). The recorder saved every upload with docType "", which the replay skips
// (recipeAdapter: no document for that slot), so the portal then refused to go on. The slot's own label
// now names the document with the learner's table, and a slot it cannot name is asked about at save.
//
//   MUST name the document from a slot label the learner's table reads ("Site Plan", "One-line
//        diagram", "Electrical permit application").
//   MUST NOT guess for a label that names nothing ("Browse..", ""): that one is asked, never guessed.
//   The choices offered at save include every type the table can produce, and the plan set.
//
// KILL: guessUploadDocType returns "" always → the first check fails.
// Run: npx tsx portal-bot/src/recordUploadDocType.test.ts
import assert from "node:assert/strict";
import { guessUploadDocType, UPLOAD_DOC_TYPE_CHOICES } from "./recordRecipe";
import { UPLOAD_LABEL_PATTERNS } from "./adapters/autoLearnAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

check("a slot whose label names a document gets that document type", () => {
  assert.equal(guessUploadDocType("Site Plan"), "site_plan");
  assert.equal(guessUploadDocType("One-line diagram"), "sld");
  assert.equal(guessUploadDocType("Electrical permit application"), "electrical_application");
});
check("a label that names nothing is never guessed", () => {
  assert.equal(guessUploadDocType("Browse.."), "");
  assert.equal(guessUploadDocType(""), "");
  assert.equal(guessUploadDocType(undefined), "");
});
check("the save-time choices cover every type the table produces, plus the plan set", () => {
  for (const p of UPLOAD_LABEL_PATTERNS) assert.ok(UPLOAD_DOC_TYPE_CHOICES.includes(p.docType), p.docType);
  assert.ok(UPLOAD_DOC_TYPE_CHOICES.includes("plan_set"));
  assert.equal(new Set(UPLOAD_DOC_TYPE_CHOICES).size, UPLOAD_DOC_TYPE_CHOICES.length, "no duplicates");
});

console.log(failures === 0 ? "\nrecordUploadDocType: all checks passed" : `\nrecordUploadDocType: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
