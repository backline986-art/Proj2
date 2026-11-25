// ONE PORTAL LOGIN, ONE SESSION AT A TIME (#281). Live, 2026-11-23: a learn on one utility's tenant of
// a hosted platform signed in six minutes into a replay on another utility's tenant, with the same
// user name; the platform allows one session per user, so the replay's page turned to "Session Ended"
// and it stalled. Here, no browser: the lease and the session rules around it.
//
//   L1 two tenants of one platform with the same user name are ONE account; another name, another site,
//      or no user name is not.
//   L2 a second run on ANOTHER profile waits for the login, and is refused (named, site only, never the
//      user name) when it does not free up; a run on the SAME profile is left to the profile lock.
//   L3 a run that waited gets the login the moment the first lets it go.
//   L4 a window left open for a person keeps the login until it closes (endPortalSession + the window's
//      close), then the other tenant's run starts.
//   L5 on the same profile: another filing's open window is waited for and the run refused while a
//      person is in it; the same filing's re-stage closes its old window, as always.
//
// KILL TESTS (each must turn this file red):
//   K1 accountLeaseKey: key on the full host (new URL(...).hostname) instead of siteOfUrl  → L1, L2 fail.
//   K2 endPortalSession: always release()                                                  → L4 fails.
//   K3 beginPortalSession: drop the other-filing wait (always closePriorStagingBrowser)     → L5 fails.
//
// Run: npx tsx portal-bot/src/accountLease.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountLeaseBusy, accountLeaseHolders, accountLeaseKey, acquireAccountLease } from "./accountLease";
import { beginPortalSession, endPortalSession, trackOpenAdapter } from "./index";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "account-lease-"));
const dirPge = path.join(tmp, "client-1", "utility", "pgenm.powerclerk.com");
const dirPac = path.join(tmp, "client-1", "utility", "pacificorpnetmetering.powerclerk.com");
const PGE = "https://pgenm.powerclerk.com/MvcAccount/Login";
const PAC = "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login";
const USER = "Installer.Login@Example.test";

/** A window left open for a person: close() and the context's close event, nothing else. */
function fakeWindow(): { adapter: never; closed: () => boolean; personCloses: () => void } {
  let closed = false;
  const handlers: Array<() => void> = [];
  const ctx = { on: (ev: string, h: () => void) => { if (ev === "close") handlers.push(h); } };
  const adapter = {
    portalName: "fake",
    page: { context: () => ctx, on: () => {} },
    close: async () => { closed = true; for (const h of handlers) h(); },
  };
  return { adapter: adapter as never, closed: () => closed, personCloses: () => { closed = true; for (const h of handlers) h(); } };
}

await check("L1 two tenants of one platform with the same user name are one account; anything else is not", () => {
  const a = accountLeaseKey(PGE, USER);
  assert.ok(a);
  assert.equal(accountLeaseKey(PAC, USER.toUpperCase()), a, "the same user name on another tenant of the platform");
  assert.equal(accountLeaseKey(undefined, USER, dirPac), a, "the profile directory's host when no URL is passed");
  assert.notEqual(accountLeaseKey(PAC, "someone.else@example.test"), a);
  assert.notEqual(accountLeaseKey("https://aca-oregon.accela.com/oregon/", USER), a);
  assert.equal(accountLeaseKey(PGE, ""), "");
  assert.equal(accountLeaseKey(undefined, USER), "");
});

await check("L2 another profile waits and is refused, named by site and never by user name; the same profile is not held up", async () => {
  const key = accountLeaseKey(PGE, USER);
  const releaseA = await acquireAccountLease(key, dirPge, 0, "powerclerk.com");
  const t0 = Date.now();
  const refusal = await acquireAccountLease(accountLeaseKey(PAC, USER), dirPac, 300, "powerclerk.com").then(() => null, (e: unknown) => e);
  assert.ok(refusal instanceof AccountLeaseBusy, "refused");
  assert.ok(Date.now() - t0 >= 250, "it waited first");
  const msg = (refusal as Error).message;
  assert.match(msg, /waiting for the portal login to free up on powerclerk\.com/);
  assert.match(msg, /not started/);
  assert.ok(!msg.toLowerCase().includes(USER.toLowerCase()) && !msg.includes("@"), "never the user name");
  const sameProfile = await acquireAccountLease(key, dirPge, 0);
  assert.equal(accountLeaseHolders(key), 2, "a run on the same profile is the profile lock's to order");
  sameProfile();
  releaseA();
  assert.equal(accountLeaseHolders(key), 0);
});

await check("L3 a run that waited gets the login as soon as the first lets it go", async () => {
  const key = accountLeaseKey(PGE, USER);
  const releaseA = await acquireAccountLease(key, dirPge, 0);
  setTimeout(releaseA, 200);
  const t0 = Date.now();
  const releaseB = await acquireAccountLease(key, dirPac, 5000);
  assert.ok(Date.now() - t0 < 2500, `waited ${Date.now() - t0} ms`);
  releaseB();
});

await check("L4 a window left open for a person keeps the login until it closes; then the other tenant's run starts", async () => {
  const win = fakeWindow();
  const releaseA = await beginPortalSession({ userDataDir: dirPge, loginUrl: PGE, username: USER, owner: "p-aragon|utility:" });
  trackOpenAdapter(dirPge, win.adapter, "p-aragon|utility:");
  endPortalSession(dirPge, releaseA, true);
  const refused = await beginPortalSession({ userDataDir: dirPac, loginUrl: PAC, username: USER, owner: "p-zorza|utility:", waitMs: 300 }).then(() => null, (e: unknown) => e);
  assert.ok(refused instanceof AccountLeaseBusy, "the other tenant's run is held while the person is in the window");
  win.personCloses();
  const releaseB = await beginPortalSession({ userDataDir: dirPac, loginUrl: PAC, username: USER, owner: "p-zorza|utility:", waitMs: 300 });
  endPortalSession(dirPac, releaseB, false);
  assert.equal(accountLeaseHolders(accountLeaseKey(PGE, USER)), 0, "nothing held after both ended");
});

await check("L5 same profile: another filing's open window is waited for and refused; the same filing's re-stage closes it", async () => {
  const dirAca = path.join(tmp, "client-2", "AHJ", "aca-oregon.accela.com");
  const ACA = "https://aca-oregon.accela.com/oregon/";
  const win = fakeWindow();
  const releaseA = await beginPortalSession({ userDataDir: dirAca, loginUrl: ACA, username: USER, owner: "p-hood|ahj:structural" });
  trackOpenAdapter(dirAca, win.adapter, "p-hood|ahj:structural");
  endPortalSession(dirAca, releaseA, true);
  const other = await beginPortalSession({ userDataDir: dirAca, loginUrl: ACA, username: USER, owner: "p-hood|ahj:electrical", waitMs: 300 }).then(() => null, (e: unknown) => e);
  assert.ok(other instanceof AccountLeaseBusy, "the electrical run does not take the structural review window");
  assert.match((other as Error).message, /window is still open on this portal for a person to review another filing/);
  assert.equal(win.closed(), false, "the person's window was left alone");
  const again = await beginPortalSession({ userDataDir: dirAca, loginUrl: ACA, username: USER, owner: "p-hood|ahj:structural", waitMs: 300 });
  assert.equal(win.closed(), true, "a re-stage of the same filing closes its own old window, as before");
  endPortalSession(dirAca, again, false);
  assert.equal(accountLeaseHolders(accountLeaseKey(ACA, USER)), 0);
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} account lease test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll account lease tests passed.");
process.exit(0);
