// THE SHIPPED ROWS THE PER-TRACK ISSUER READS (worker-trackissuer). Pins, on the real reference file:
//   - every electricalPermitIssuer citation is whole and its value is in the issuer vocabulary (first
//     word "state" or the AHJ itself), so none is silently ignored;
//   - a state named as issuer has exactly ONE state authority row (stateAuthorityFor "electrical"),
//     which carries no filing door (no submission method, no submissionMethod citation): its door
//     starts unknown and is a person's Confirm;
//   - a separate-counter citation reuses a page and words already cited for the issuer (no uncited
//     claim), and names no URL (it is not a door anyone can launch);
//   - every row still lands seeded: no row claims a tier.
// Run: tsx backend/test/trackIssuerReferenceRows.test.ts
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AhjProcessProfile } from "../../shared/src/types";

const { electricalIssuerKindOf, wholeCitations, stateAuthorityRowFor, citedElectricalIssuer } = await import("../src/ahjRowCitations");

const file = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "reference-ahj-processes.json"), "utf8")) as { count: number; profiles: AhjProcessProfile[] };
let failures = 0;
const run = (label: string, fn: () => void) => {
  try { fn(); console.log(`  ok   - ${label}`); } catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const raw = (p: AhjProcessProfile) => ((p as unknown as { citations?: Array<Record<string, string>> }).citations ?? []);

run("the header count matches the rows", () => assert.equal(file.count, file.profiles.length));

run("every electricalPermitIssuer citation is whole and in the vocabulary", () => {
  let n = 0;
  for (const p of file.profiles) {
    const all = raw(p).filter((c) => c.field === "electricalPermitIssuer");
    const whole = wholeCitations(p, "electricalPermitIssuer");
    assert.equal(whole.length, all.length, `${p.state} ${p.ahj}: an issuer citation is not whole`);
    for (const c of whole) { n++; assert.ok(electricalIssuerKindOf(c.value), `${p.state} ${p.ahj}: "${c.value}" is not in the vocabulary`); }
    if (whole.length) assert.ok(citedElectricalIssuer(p), `${p.state} ${p.ahj}: its issuer citations disagree`);
  }
  assert.ok(n > 0, "issuer citations are on file");
});

run("a state named as issuer has exactly one authority row, with no door on it", () => {
  const states = new Set(file.profiles.filter((p) => citedElectricalIssuer(p)?.kind === "state").map((p) => p.state));
  assert.ok(states.size > 0, "at least one AHJ names the state");
  for (const st of states) {
    const rows = file.profiles.filter((p) => p.state === st && p.stateAuthorityFor?.includes("electrical"));
    assert.equal(rows.length, 1, `${st}: one state electrical authority row`);
    const row = stateAuthorityRowFor(st, "electrical")!;
    assert.equal(row.ahj, rows[0].ahj);
    assert.equal(String(row.submissionMethod ?? "").trim(), "", `${st}: the authority's door is not on file (a person confirms it)`);
    assert.ok(!raw(row).some((c) => c.field === "submissionMethod"), `${st}: no door citation`);
    assert.ok(wholeCitations(row).length > 0, `${st}: the authority's name is cited`);
  }
});

run("a separate counter reuses the issuer's cited page and words, and names no URL", () => {
  let n = 0;
  for (const p of file.profiles) {
    for (const c of wholeCitations(p, "electricalSubmissionMethod")) {
      n++;
      assert.ok(!/https?:\/\/|www\.|@/.test(c.value), `${p.state} ${p.ahj}: a counter is not an address`);
      assert.ok(wholeCitations(p, "electricalPermitIssuer").some((i) => i.sourceUrl === c.sourceUrl && i.quote === c.quote), `${p.state} ${p.ahj}: the counter's words are the issuer citation's`);
    }
  }
  assert.ok(n > 0, "a separate counter is on file");
});

run("no row claims a tier (reference rows land seeded)", () => {
  for (const p of file.profiles) assert.ok(!("confidence" in (p as object)) && !("tier" in (p as object)), `${p.state} ${p.ahj}`);
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall reference-row checks passed");
process.exit(0);
