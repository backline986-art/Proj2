// WHAT A TYPE-AHEAD PICK IS JUDGED BY, AND WHAT THE REPLAY MAY REMEMBER (#244 fix round).
//
// Pins the pure halves of typeaheadFill.ts that the review of 5eb51ad3 turned on:
//   selectionInputsToWatch — the widget's own selected value is a hidden input the widget
//     demonstrably owns: one it EMPTIED when the query was typed, or one an earlier fill in this
//     document saw it empty (the owned mark).
//     MUST WATCH    a reopened draft's id the typing emptied; an owned input that is empty now.
//     MUST EXCLUDE  an input empty all along (Accela's ClientState beside the box, a widget that
//                   writes its id only on blur); one whose value only changed; one still holding a
//                   value after the typing.
//   selectionRewritten — any watched input written again is a yes; one that is gone is no opinion.
//   typeaheadPortalAnswered — only the portal's own answer is remembered (its no-match words, a
//     settled list with none of the job's); a timeout, a re-rendered list, a pick not kept are not.
// Run: tsx portal-bot/src/typeaheadFill.test.ts
import assert from "node:assert/strict";
import { selectionInputsToWatch, selectionRewritten, typeaheadPortalAnswered } from "./typeaheadFill";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const h = (key: string, value: string, owned = false) => ({ key, name: key.replace(/#\d+$/, ""), value, owned });

// ---- selectionInputsToWatch: MUST WATCH ---------------------------------------------------------
check("a reopened draft's id that the typing emptied is watched", () => {
  assert.deepEqual(selectionInputsToWatch([h("addr_id#1", "a-4812")], [h("addr_id#1", "")]), [{ key: "addr_id#1", name: "addr_id" }]);
});
check("an input an earlier fill marked the widget's own is watched while empty, though empty at rest", () => {
  assert.deepEqual(selectionInputsToWatch([h("addr_id#1", "", true)], [h("addr_id#1", "", true)]), [{ key: "addr_id#1", name: "addr_id" }]);
});
check("two inputs of one name are told apart by their ordinal", () => {
  assert.deepEqual(
    selectionInputsToWatch([h("sel#1", "x"), h("sel#2", "")], [h("sel#1", "x"), h("sel#2", "")]),
    [],
  );
  assert.deepEqual(
    selectionInputsToWatch([h("sel#1", ""), h("sel#2", "y")], [h("sel#1", ""), h("sel#2", "")]),
    [{ key: "sel#2", name: "sel" }],
  );
});

// ---- selectionInputsToWatch: MUST EXCLUDE --------------------------------------------------------
check("MUST EXCLUDE: an unrelated ClientState empty all along (S1) is never watched", () => {
  assert.deepEqual(selectionInputsToWatch([h("addr_ClientState#1", "")], [h("addr_ClientState#1", "")]), []);
});
check("MUST EXCLUDE: an id that is empty at rest and written only on blur (S2) is not watched before the pick", () => {
  assert.deepEqual(selectionInputsToWatch([h("addr_id#1", "")], [h("addr_id#1", "")]), []);
});
check("MUST EXCLUDE: a state that changed but still holds a value (a watermark's ClientState) is not watched", () => {
  assert.deepEqual(selectionInputsToWatch([h("cs#1", "{\"state\":\"watermark\"}")], [h("cs#1", "{\"state\":\"text\"}")]), []);
});
check("MUST EXCLUDE: an input that appears only after the typing is not watched", () => {
  assert.deepEqual(selectionInputsToWatch([], [h("new#1", "")]), []);
});
check("nothing read is nothing watched (an unreadable page never fails a pick)", () => {
  assert.deepEqual(selectionInputsToWatch(null, null), []);
  assert.deepEqual(selectionInputsToWatch(undefined, [h("x#1", "")]), []);
});

// ---- selectionRewritten --------------------------------------------------------------------------
check("the pick wrote the watched id again: taken", () => {
  assert.equal(selectionRewritten([{ key: "addr_id#1" }], [h("addr_id#1", "a-4821")]), true);
});
check("the watched id is still empty after the pick and its blur: NOT taken", () => {
  assert.equal(selectionRewritten([{ key: "addr_id#1" }], [h("addr_id#1", "")]), false);
});
check("the watched input is gone (the widget re-rendered): no opinion, taken", () => {
  assert.equal(selectionRewritten([{ key: "addr_id#1" }], []), true);
});
check("nothing watched: taken", () => {
  assert.equal(selectionRewritten([], [h("addr_id#1", "")]), true);
});

// ---- typeaheadPortalAnswered ---------------------------------------------------------------------
check("the portal's own no-match words, printed for this search, are its answer", () => {
  assert.equal(typeaheadPortalAnswered({ outcome: "no_suggestions", why: "", typed: ["x"], portalSaid: "No results match your search", portalSaidFresh: true }), true);
});
check("MUST EXCLUDE: a no-match sentence that was already on screen before the typing is quoted, not an answer", () => {
  // Static help copy ("Address not found? Call the permit desk.") or another box's leftover panel:
  // a cold first search on such a page must be searched again by the required sweep, as on main.
  assert.equal(typeaheadPortalAnswered({ outcome: "no_suggestions", why: "", typed: ["x"], portalSaid: "Address not found? Call the permit desk." }), false);
});
check("a settled list with none of the job's is its answer", () => {
  assert.equal(typeaheadPortalAnswered({ outcome: "no_match", why: "", offered: ["4812 W QUILLFEATHER DR"], typed: "x" }), true);
});
check("MUST EXCLUDE: no suggestions and no words from the portal (a slow list, a spent budget) is not an answer", () => {
  assert.equal(typeaheadPortalAnswered({ outcome: "no_suggestions", why: "", typed: ["x"] }), false);
});
check("MUST EXCLUDE: a list that re-rendered under the read is not an answer", () => {
  assert.equal(typeaheadPortalAnswered({ outcome: "no_match", why: "", offered: ["a"], typed: "x", listChanged: true }), false);
});
check("MUST EXCLUDE: a pick the box did not keep, a question, an unusable box and a pick are not answers", () => {
  assert.equal(typeaheadPortalAnswered({ outcome: "not_held", why: "", picked: "a" }), false);
  assert.equal(typeaheadPortalAnswered({ outcome: "ask", question: "", offered: [], typed: "", why: "" }), false);
  assert.equal(typeaheadPortalAnswered({ outcome: "unusable", why: "" }), false);
  assert.equal(typeaheadPortalAnswered({ outcome: "picked", picked: "a", held: "a", typed: "a", why: "" }), false);
});

console.log(failures === 0 ? "typeaheadFill.test: PASS" : `typeaheadFill.test: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
