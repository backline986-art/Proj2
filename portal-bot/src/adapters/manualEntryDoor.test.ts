// A LOCATION SEARCH'S "ENTER IT BY HAND" DOOR, AND WHICH ADDRESS BOX IT REVEALED (#139).
//
// When a type-ahead location search finds no match (a CityView "Search for location" answering "The
// search value did not match an address"), the learner clicks the portal's own manual-entry door next
// to the box ONCE — "Can't find address?" on the live Bend page — and fills the plain address boxes
// it reveals by their labels. Both readings are words, so both must pass the shapes they exist for
// and exclude the shapes that only look like them (a filter fails both ways).
//
//   npx tsx portal-bot/src/adapters/manualEntryDoor.test.ts
import assert from "node:assert/strict";
import { MANUAL_ENTRY_DOOR, manualAddressPart } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

check("MUST PASS: the doors a location search offers when it finds nothing", () => {
  for (const t of ["Can't find address?", "CAN'T FIND ADDRESS?", "Cannot find your address?", "Can't find the property?", "Enter address manually", "Enter the address manually",
    "Add address manually", "Manual entry", "Manual address entry", "Address not listed?", "My address is not listed", "Property not found?", "Not found?", "Not listed"]) {
    assert.ok(MANUAL_ENTRY_DOOR.test(t), t);
  }
});
check("MUST EXCLUDE: search, navigation and filing controls, and prose that merely mentions not finding", () => {
  for (const t of ["Search", "Find location in map", "Find locations near me", "Add another location", "Use This Location", "Next Step", "Submit Application",
    "Can't find what you need? Contact us at 555-0100 or visit the permit counter during business hours", "Help", "Address", "Not now", "Manual"]) {
    assert.ok(!MANUAL_ENTRY_DOOR.test(t), t);
  }
});
check("the revealed boxes map to street / city / state / zip by their labels", () => {
  assert.equal(manualAddressPart("Street Address:*"), "street");
  assert.equal(manualAddressPart("Street"), "street");
  assert.equal(manualAddressPart("Address Line 1"), "street");
  assert.equal(manualAddressPart("Address"), "street");
  assert.equal(manualAddressPart("City:*"), "city");
  assert.equal(manualAddressPart("State:*"), "state");
  assert.equal(manualAddressPart("State / Province"), "state");
  assert.equal(manualAddressPart("Zip:*"), "zip");
  assert.equal(manualAddressPart("Postal Code"), "zip");
});
check("MUST EXCLUDE: extra lines, units, mailing / e-mail addresses and anything else", () => {
  for (const t of ["Address Extra Line 1:*", "Address Extra Line 2:*", "Address Line 2", "Apt / Unit", "Suite", "Mailing Address", "Email Address:*", "County", "Tax Lot Number*",
    "Statement of work", "Description of Work", ""]) {
    assert.equal(manualAddressPart(t), null, t);
  }
});

if (failures) { console.error(`\n${failures} manualEntryDoor check(s) failed`); process.exit(1); }
console.log("\nmanualEntryDoor: all checks passed");
