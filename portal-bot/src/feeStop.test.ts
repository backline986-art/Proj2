// The fee a fee_payment stop reads (#576), pure half: which page text is a fee, and which field
// values a fee screenshot must mask. The real-browser half is adapters/feeStop.dom.smoke.ts.
//
// Run: npx tsx portal-bot/src/feeStop.test.ts
import assert from "node:assert/strict";
import { feeFromPage, secretValuesOf } from "./feeStop";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); } catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

check("a fee table: the printed total wins, the lines are kept", () => {
  const r = feeFromPage([{ label: "Electrical Permit Fee", value: "$250.00" }, { label: "Plan Review Fee", value: "$87.50" }, { label: "Total Fees", value: "$337.50" }], "");
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.reading.totalUsd, 337.5); assert.equal(r.reading.lines.length, 2); }
});
check("an Accela fee section in the page text is read when no label/value pair is", () => {
  const r = feeFromPage([], "Fees\nOutstanding:\nDate Invoice Number Amount\n11/09/2026 1234 $150.00\nTotal outstanding fees: $150.00\n");
  assert.equal(r.ok, true, JSON.stringify(r));
});
check("no fee on the page is a refusal, never a $0 fee", () => {
  const r = feeFromPage([{ label: "Customer", value: "Desmond Yarrowby" }], "Fee summary for this application.");
  assert.equal(r.ok, false);
  const zero = feeFromPage([{ label: "Total Due", value: "$0.00" }], "");
  assert.equal(zero.ok, false);
});
check("the job's valuation is never read as a fee", () => {
  const r = feeFromPage([{ label: "Job Valuation", value: "$21,383.55" }], "");
  assert.equal(r.ok, false);
});
check("secretValuesOf: account / meter numbers are secrets; who holds the account is not", () => {
  const got = secretValuesOf({ accountNumber: "1234567890", meterNumber: "987654321", accountHolderName: "Desmond Yarrowby", homeownerName: "Desmond Yarrowby", pin: "12" });
  assert.deepEqual(got.sort(), ["1234567890", "987654321"]);
});

if (failures) { console.error(`\n${failures} feeStop test(s) failed.`); process.exit(1); }
console.log("\nAll feeStop tests passed.");
