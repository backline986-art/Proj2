// THE LOGIN NEVER-CLICK LIST MATCHES WHAT IT NAMES.
//
// The list is kept as regex SOURCE strings in plain string literals, so a single "\b" there is a
// backspace character, not a word boundary, and the phrase it guards never matches. "Try another
// way" (an identity provider's way to pick a different second factor) was written that way in the
// first version of the passkey change: choosing an authenticator is the person's (rule 1), so it
// must be on the list for real. The href list's file-extension guard had the same slip.
//
//   npx tsx portal-bot/src/adapters/loginNeverClick.test.ts
import assert from "node:assert/strict";
import { NEVER_CLICK_PATTERNS } from "./loginFlow";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const always = new RegExp(NEVER_CLICK_PATTERNS.always, "i");
const href = new RegExp(NEVER_CLICK_PATTERNS.href, "i");

check("no source string carries a control character (a lost backslash)", () => {
  for (const [k, v] of Object.entries(NEVER_CLICK_PATTERNS)) assert.ok(!/[\x00-\x1f]/.test(v), `${k} holds a control character`);
});
check("another-way and passkey choosers are never clicked", () => {
  for (const t of ["Try another way", "Choose another way", "Use a different way", "Sign in with a passkey", "Use a security key", "Windows Hello", "Face ID"]) assert.ok(always.test(t), t);
});
check("the login's own controls stay clickable", () => {
  for (const t of ["Log in", "Sign In", "Continue", "Next", "login button"]) assert.ok(!always.test(t), t);
});
check("a media or document link is never a login control", () => {
  for (const u of ["https://city.example.gov/media/intro.mp4", "/files/guide.pdf", "/forms/app.docx"]) assert.ok(href.test(u), u);
  for (const u of ["https://city.example.gov/portal/login", "/citizen/Home"]) assert.ok(!href.test(u), u);
});

if (failures) { console.error(`\nloginNeverClick: ${failures} check(s) failed`); process.exit(1); }
console.log("\nloginNeverClick: all checks passed");
