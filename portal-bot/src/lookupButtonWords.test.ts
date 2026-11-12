// THE LOOKUP-BUTTON WORDS AND THE FILING WORDS ARE DISJOINT (#178).
//
// Accela's Step 1 fills four of its sections by BUTTON, not by typing: "Find Address" (the address
// search, which also populates the Parcel section), "Autofill" (the account's contact into
// Applicant / Contact), "Look Up" (a licensed-professional search). The learner now presses such a
// button once per section state. That is safe under hard rule 1 only while the words that make a
// button a lookup can never also make it a filing or a payment — so this file pins, on the shared
// predicate AND on the page copy of it AND on the two adapters' own filing regexes:
//   - every lookup word, and every realistic lookup label, is NOT submit / pay / final-submit /
//     signature-request worded;
//   - every filing / paying label is NOT a lookup button;
//   - a label carrying BOTH kinds of word ("Search and Submit", "Find & Pay") is NOT a lookup
//     button — the filing predicates win, by construction.
// Kill test: drop `!isSubmitIntent(t)` from isLookupButtonLabel and the cross-product check goes red;
// add "submit" to LOOKUP_BUTTON_WORDS and the first check goes red.
//
//   npx tsx portal-bot/src/lookupButtonWords.test.ts
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  LOOKUP_BUTTON_WORDS,
  isLookupButtonLabel,
  isFinalSubmitControl,
  isPayFee,
  isSignatureRequestControl,
  isSubmitIntent,
  PORTAL_SAFETY_IN_PAGE_SOURCE,
  type PortalSafety,
} from "../../shared/src/portalSafety";
import { SUBMIT_INTENT, isPayFee as learnIsPayFee } from "./adapters/autoLearnAdapter";
import { PAY_FEE_REPLAY_GATE, SUBMIT_KEYWORDS } from "./adapters/recipeAdapter";

let failures = 0;
let passes = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); passes++; console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

// The page copy: the same factory evaluated as a portal page runs it.
const ctx = vm.createContext({});
vm.runInContext(PORTAL_SAFETY_IN_PAGE_SOURCE, ctx);
const pageCopy = vm.runInContext("globalThis.__portalSafety", ctx) as PortalSafety;

/** Labels seen live or plainly of the kind (Accela Step 1, Meridian 2026-11-12; Corvallis; Lee). */
const LOOKUP_MUST_PASS = [
  "Find Address", "FIND PARCEL", "Find Parcel", "Look Up", "Lookup", "Autofill", "Auto-fill", "Auto-Fill",
  "Search", "Search Address", "Populate", "Select from Account", "Validate", "Validate Address", "Verify Address",
  "Find Address »",
];

/** Filing and paying labels — the words rule 1 guards. None may read as a lookup button. */
const FILING_MUST_REFUSE = [
  "Submit", "Submit Application", "Submit & Pay", "Submit and Pay", "File Application", "Continue Application",
  "Finish", "Finalize", "Complete Application", "Send Application", "Confirm Submission", "Complete Submission",
  "Place Order", "Resubmit", "Re-file", "E-File", "Sign and Submit", "Sign & File", "File",
  "Pay Now", "Pay Fees", "Pay", "Make Payment", "Payment", "Checkout", "Add to Cart", "Proceed to Payment",
  "Fees Due", "Buy Now", "Continue to Payment", "Invoice",
  "Request Signatures", "Send for Signature", "Sign & Send",
];

/** A lookup word beside a filing word: NEVER a lookup button. */
const MIXED_MUST_REFUSE = [
  "Search and Submit", "Find & Pay", "Lookup and File Application", "Validate and Submit", "Autofill & Pay Now",
  "Search then Checkout", "Verify Address and Submit Application", "Find Address and Continue Application",
  "Populate and Finish", "Select from Account and Submit",
];

check("the shared lookup word list is the issue's list, lower-case, non-empty", () => {
  assert.ok(LOOKUP_BUTTON_WORDS.length >= 8, `${LOOKUP_BUTTON_WORDS.length} words`);
  for (const w of LOOKUP_BUTTON_WORDS) assert.equal(w, w.toLowerCase(), w);
  for (const w of ["find", "look up", "search", "autofill", "auto-fill", "populate", "select from account", "validate", "verify address"]) {
    assert.ok(LOOKUP_BUTTON_WORDS.includes(w), `missing "${w}"`);
  }
});

check("every lookup WORD is not submit-, pay-, final-submit- or signature-request-worded (shared + page copy + both adapters)", () => {
  for (const w of LOOKUP_BUTTON_WORDS) {
    assert.ok(!isSubmitIntent(w), `isSubmitIntent("${w}")`);
    assert.ok(!isPayFee(w), `isPayFee("${w}")`);
    assert.ok(!isFinalSubmitControl(w), `isFinalSubmitControl("${w}")`);
    assert.ok(!isSignatureRequestControl(w), `isSignatureRequestControl("${w}")`);
    assert.ok(!pageCopy.isSubmitIntent(w) && !pageCopy.isPayFee(w) && !pageCopy.isFinalSubmitControl(w), `page copy: "${w}"`);
    assert.ok(!SUBMIT_INTENT.test(w), `learn SUBMIT_INTENT: "${w}"`);
    assert.ok(!learnIsPayFee(w), `learn isPayFee: "${w}"`);
    assert.ok(!SUBMIT_KEYWORDS.test(w), `replay SUBMIT_KEYWORDS: "${w}"`);
    assert.ok(!PAY_FEE_REPLAY_GATE.test(w), `replay PAY_FEE_REPLAY_GATE: "${w}"`);
    assert.ok(isLookupButtonLabel(w), `isLookupButtonLabel("${w}") should pass`);
    assert.ok(pageCopy.isLookupButtonLabel(w), `page copy isLookupButtonLabel("${w}")`);
  }
});

check("every realistic lookup LABEL passes the lookup predicate and fails every filing predicate", () => {
  for (const l of LOOKUP_MUST_PASS) {
    assert.ok(isLookupButtonLabel(l), `isLookupButtonLabel("${l}")`);
    assert.ok(pageCopy.isLookupButtonLabel(l), `page copy: "${l}"`);
    assert.ok(!isSubmitIntent(l) && !isPayFee(l) && !isFinalSubmitControl(l) && !isSignatureRequestControl(l), `filing predicates on "${l}"`);
    assert.ok(!SUBMIT_INTENT.test(l) && !learnIsPayFee(l), `learn gates on "${l}"`);
    assert.ok(!SUBMIT_KEYWORDS.test(l) && !PAY_FEE_REPLAY_GATE.test(l), `replay gates on "${l}"`);
  }
});

check("every filing / paying label is NOT a lookup button (shared + page copy)", () => {
  for (const l of FILING_MUST_REFUSE) {
    assert.ok(!isLookupButtonLabel(l), `isLookupButtonLabel("${l}") must be false`);
    assert.ok(!pageCopy.isLookupButtonLabel(l), `page copy: "${l}"`);
  }
});

check("a label with a lookup word AND a filing word is NOT a lookup button (the filing predicates win)", () => {
  for (const l of MIXED_MUST_REFUSE) {
    assert.ok(!isLookupButtonLabel(l), `isLookupButtonLabel("${l}") must be false`);
    assert.ok(!pageCopy.isLookupButtonLabel(l), `page copy: "${l}"`);
  }
  // The full cross product, both orders — not a hand-picked sample. DISJOINT means: no label is
  // ever BOTH a lookup button and filing / paying / signature-worded. (A bare "File" files only as
  // a WHOLE label — "Select File" is an attachment control — so "find and File" is neither; the
  // pin is that the two predicates never both say yes, and that nearly every compound here IS
  // filing-worded, so the check is not vacuous.)
  let filingWorded = 0;
  let total = 0;
  const isFiling = (l: string): boolean => isSubmitIntent(l) || isPayFee(l) || isFinalSubmitControl(l) || isSignatureRequestControl(l);
  for (const w of LOOKUP_BUTTON_WORDS) {
    for (const f of FILING_MUST_REFUSE) {
      for (const l of [`${w} and ${f}`, `${f} and ${w}`, `${w} ${f}`]) {
        total++;
        const filing = isFiling(l);
        if (filing) filingWorded++;
        assert.ok(!(filing && isLookupButtonLabel(l)), `"${l}" reads as BOTH a filing control and a lookup button`);
        assert.ok(!(pageCopy.isLookupButtonLabel(l) && (pageCopy.isSubmitIntent(l) || pageCopy.isPayFee(l) || pageCopy.isFinalSubmitControl(l))), `page copy: "${l}" reads as both`);
        if (filing) assert.ok(!isLookupButtonLabel(l), `"${l}" is filing-worded and must not be a lookup button`);
      }
    }
  }
  assert.ok(filingWorded / total >= 0.9, `only ${filingWorded} of ${total} compounds were filing-worded — the cross product proves little`);
});

check("a sentence that merely contains a lookup word is not a button (help text, long labels)", () => {
  for (const l of [
    "Find out how to apply for a permit online with this guide",
    "Search our frequently asked questions and help articles here",
    "Click Autofill to copy account information to applicant.",
    "",
    "   ",
  ]) assert.ok(!isLookupButtonLabel(l), `"${l}"`);
  for (const l of ["Continue", "Next", "Save and resume later", "Add New", "Edit", "Remove", "Clear", "Cancel", "Browse", "Upload"]) {
    assert.ok(!isLookupButtonLabel(l), `"${l}" has no lookup word`);
  }
});

console.log(failures === 0
  ? `\nAll ${passes} lookup-button-word checks passed.`
  : `\n${failures} of ${passes + failures} lookup-button-word check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
