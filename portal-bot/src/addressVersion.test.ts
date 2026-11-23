// THE JOB'S STREET NAME, NOT ONLY ITS NUMBER, PICKS THE ADDRESS ROW (Helm review of PR #247).
//
// rankAddressVersions filtered rows by city/ZIP and the house NUMBER; on a free search grid a row for
// another street with the same number and city ("150 W Main St, Boise ID 83702") passed, and the
// plainness tie-break then preferred it to the job's own "150 N Capitol Blvd". Every core word of the
// job's street line (the tokens after the number that are not a direction or a street-type suffix)
// must now appear in the row. MUST KEEP: #178's Boise case — the plain version of the SAME property
// still beats its unit-qualified twin.
//
// Browser-free. Run: npx tsx portal-bot/src/addressVersion.test.ts
import assert from "node:assert/strict";
import { rankAddressVersions } from "./addressVersion";

let passed = 0;
const ok = (n: string): void => { passed++; console.log(`ok   ${n}`); };

const common = { city: "Boise", zip: "83702", isElectrical: false, issuingAgency: null };

// MUST-PASS: another street with the same number and city is rejected, the job's street is ranked.
{
  const rows = ["150 W Main St, Boise ID 83702", "150 N Capitol Blvd, Boise ID 83702"];
  const r = rankAddressVersions(rows, { ...common, street: "150 N Capitol Blvd" });
  assert.deepEqual(r.ranked.map((v) => v.text), ["150 N Capitol Blvd, Boise ID 83702"], JSON.stringify(r));
  assert.ok(r.rejected.some((t) => /W Main/.test(t)), `rejected=${JSON.stringify(r.rejected)}`);
  ok("another street with the job's number is rejected; the job's street is the one row");
}

// MUST-PASS: the street word is matched whole — "Capitol" never inside "Capitola".
{
  const rows = ["150 N Capitola Way, Boise ID 83702", "150 N Capitol Blvd, Boise ID 83702"];
  const r = rankAddressVersions(rows, { ...common, street: "150 N Capitol Blvd" });
  assert.deepEqual(r.ranked.map((v) => v.text), ["150 N Capitol Blvd, Boise ID 83702"], JSON.stringify(r));
  ok("the street word is matched as a whole word");
}

// MUST-PASS: a numbered street ("718 NE 8th St") keeps its core token "8th".
{
  const rows = ["718 NE 9th St, Bend OR 97701", "718 NE 8th St, Bend OR 97701"];
  const r = rankAddressVersions(rows, { city: "Bend", zip: "97701", isElectrical: false, issuingAgency: null, street: "718 NE 8th St" });
  assert.deepEqual(r.ranked.map((v) => v.text), ["718 NE 8th St, Bend OR 97701"], JSON.stringify(r));
  ok("a numbered street name is matched by its own token");
}

// MUST KEEP (#178): the plain version of the same property outranks its unit-qualified twin.
{
  const rows = ["150 N CAPITOL BLVD, B C O T, Boise City Hall, Boise ID 83702", "150 N CAPITOL BLVD, Boise ID 83702"];
  const r = rankAddressVersions(rows, { ...common, street: "150 N Capitol Blvd" });
  assert.equal(r.ranked.length, 2, JSON.stringify(r));
  assert.equal(r.ranked[0].text, "150 N CAPITOL BLVD, Boise ID 83702");
  ok("the plain version of the same property still comes first (#178)");
}

// MUST KEEP: with no street given, the grid's order stands and nothing is rejected by street.
{
  const rows = ["150 W Main St, Boise ID 83702", "150 N Capitol Blvd, Boise ID 83702"];
  const r = rankAddressVersions(rows, { ...common });
  assert.equal(r.ranked.length, 2);
  assert.equal(r.ranked[0].text, rows[0]);
  ok("without a street line the ranker is unchanged");
}

console.log(`\nAll ${passed} address-version checks passed.`);
