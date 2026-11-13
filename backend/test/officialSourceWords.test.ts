// THE WORDS FOR AN OFFICIAL FACT (owner, 2026-11-13, decision card "Choose how facts read from an
// official page are labelled": "Verified from site, with date").
//
// An official fact counts as verified and reads "Verified from <host>, <YYYY-MM-DD>": the SITE and the
// read date, never a person. A person's mark stays "Verified by <name>, <date>". These checks pin:
//   1. the one shared wording (shared/src/officialSource.officialSourceWords);
//   2. the vanilla-JS copies in the dashboard, the lookup panel and the requirements panel say exactly
//      the same for the same input (the frontend cannot import the shared module);
//   3. the official fee words on the quote and the invoice are the shared words;
//   4. no official display still calls itself unchecked ("not checked by a person"), and none takes a
//      person's name.
//
// Kill tests, run by hand: K1 change a frontend copy's wording → (2) fails; K2 the invoice back to its
// own words → (3) fails; K3 put "not checked by a person" back on the fee card's official note → (4).

import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const { officialSourceWords } = await import("../../shared/src/officialSource");
const { officialFeeWords } = await import("../src/feeOfficial");
const invoices = await import("../src/invoices");

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

let failures = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

const SAMPLES: Array<[unknown, unknown]> = [
  ["www.elmcrestzz.gov", "2026-11-11T20:00:00.000Z"],
  ["www.elmcrestzz.gov", "2026-11-11"],
  ["  www.cityofelmcrestzz.org ", ""],
  ["www.elmcrestzz.gov", null],
  ["", "2026-11-11T20:00:00.000Z"],
  [null, undefined],
  ["www.elmcrestzz.gov", "not a date"],
];

console.log("official source words");

check("(1) one wording: 'Verified from <host>, <date>', the date only when there is one, never a person", () => {
  assert.equal(officialSourceWords("www.elmcrestzz.gov", "2026-11-11T20:00:00.000Z"), "Verified from www.elmcrestzz.gov, 2026-11-11");
  assert.equal(officialSourceWords("www.elmcrestzz.gov", ""), "Verified from www.elmcrestzz.gov");
  assert.equal(officialSourceWords("www.elmcrestzz.gov", "yesterday"), "Verified from www.elmcrestzz.gov", "a broken date is left out, not printed");
  assert.equal(officialSourceWords("", "2026-11-11"), "Verified from the authority's own page, 2026-11-11");
  for (const [h, d] of SAMPLES) assert.doesNotMatch(officialSourceWords(h as string, d as string), /Verified by/);
});

/** A frontend file's own copy of officialSourceWords, run in a sandbox with the file's `str`. */
function frontendCopy(rel: string): (h: unknown, d: unknown) => string {
  const src = read(rel);
  const m = /( *)function officialSourceWords\(host, fetchedAt\) \{[\s\S]*?\n\1\}/.exec(src);
  assert.ok(m, `${rel} has no officialSourceWords`);
  const sandbox: Record<string, unknown> = {};
  vm.runInNewContext(`const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());\n${m![0]}\nthis.f = officialSourceWords;`, sandbox);
  return sandbox.f as (h: unknown, d: unknown) => string;
}

check("(2) the dashboard, lookup and requirements panels say exactly the shared words", () => {
  for (const rel of ["frontend/dashboard.js", "frontend/lookup-verify.js", "frontend/utility-requirements.js"]) {
    const f = frontendCopy(rel);
    for (const [h, d] of SAMPLES) assert.equal(f(h, d), officialSourceWords(h as string, d as string), `${rel} ${JSON.stringify([h, d])}`);
  }
});

check("(3) the fee quote and the invoice line use the shared words", () => {
  assert.equal(officialFeeWords({ host: "www.elmcrestzz.gov", sourceUrl: "https://www.elmcrestzz.gov/fees", fetchedAt: "2026-11-11T20:00:00.000Z" }), "Verified from www.elmcrestzz.gov, 2026-11-11");
  const comp = { authority: "Elmcrest", discipline: "electrical", amountUsd: 94, sourceUrl: "https://www.elmcrestzz.gov/fees", collectedVia: "", tier: "official" as const, officialHost: "www.elmcrestzz.gov", sourceQuote: "Solar PV permit | $94.00", sourceReadAt: "2026-11-11T20:00:00.000Z" };
  assert.equal(invoices.publishedFeeProvenance([comp as never]), officialSourceWords("www.elmcrestzz.gov", "2026-11-11"));
  const fees = read("backend/src/submissionFees.ts");
  assert.ok((fees.match(/officialFeeWords\(/g) ?? []).length >= 2, "both official sentences on the quote take the shared words");
});

check("(4) no official display calls itself unchecked or takes a person's name", () => {
  const dash = read("frontend/dashboard.js");
  const note = /const officialNote = [\s\S]*?: "";/.exec(dash)?.[0] ?? "";
  assert.ok(note, "the fee card's official note");
  assert.match(note, /officialSourceWords\(line\.officialSource\.host, line\.officialSource\.fetchedAt\)/);
  assert.doesNotMatch(note, /not checked by a person|verifiedBy/i);
  const lv = read("frontend/lookup-verify.js");
  const official = /if \(isOfficialRow\(lookup\)\) \{[\s\S]*?\n {4}\}/.exec(lv)?.[0] ?? "";
  assert.ok(official, "the lookup panel's official badge");
  assert.match(official, /officialSourceWords\(/);
  assert.doesNotMatch(official, /not checked by a person|verifiedBy/i);
  const ur = read("frontend/utility-requirements.js");
  assert.match(ur, /if \(item\.tier === 'official'\) return officialSourceWords\(hostOf\(item\.sourceUrl\), item\.fetchedAt\);/);
  for (const rel of ["backend/src/submissionFees.ts", "backend/src/invoices.ts", "backend/src/feeOfficial.ts"]) {
    assert.doesNotMatch(read(rel).split("\n").filter((l) => !/^\s*(?:\/\/|\*)/.test(l)).join("\n"), /\bfrom \$\{[^}]*\.host\}, read /, `${rel} still builds the old 'from <host>, read <date>' words itself`);
  }
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nofficialSourceWords: all checks passed");
