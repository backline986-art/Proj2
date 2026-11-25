// ONE PORTAL LOGIN, ONE SESSION AT A TIME (#281).
//
// Some hosted platforms allow exactly one session per user across ALL their tenants. A
// client's interconnection login for one utility's tenant and for another utility's tenant on
// the same platform can be the same user name, and the platform then ends the older session
// when the newer one signs in. Live, 2026-11-23: a second utility's run signed in six minutes
// into the first's replay; the first browser showed the platform's "Session Ended" page,
// stalled, and left a partly filled application. The profile lock (browser.ts acquireProfile)
// could not see it: it is keyed on one client + portal host, and these were two hosts.
//
// So a run also leases the ACCOUNT the remote side sees: the registrable domain of the portal
// it signs in to (siteOfUrl: pgenm.powerclerk.com and pacificorpnetmetering.powerclerk.com are
// both powerclerk.com) plus the login user name, case-folded. A run whose account is leased by a
// run on ANOTHER profile waits, bounded, and is then refused with the reason, before any
// browser opens. The lease is held for the whole run and, when the run leaves its window open
// for a person (review, or a failed step's fix window), until that window closes: a person in
// the window is the same session.
//
// In memory, for this process: the runs and windows it guards are this process's own. Keys
// hold a user name, so they are never logged or put in a message; a refusal names the site only.
import path from "node:path";
import { siteOfUrl } from "./siteOf";

/** How long a run waits for another run (or its open window) to let go of the same login.
 *  PORTAL_ACCOUNT_WAIT_MS tunes it; the default matches the profile wait (browser.ts). */
export const ACCOUNT_WAIT_MS = Math.max(0, Number(process.env.PORTAL_ACCOUNT_WAIT_MS ?? 15 * 60 * 1000));
const POLL_MS = 1000;

/** The site a login belongs to: the portal URL's registrable domain, else the host a profile
 *  directory is named for (backend portalProfileDir ends in the portal host). "" when neither. */
export function accountSiteOf(loginUrl: string | undefined, userDataDir?: string): string {
  const fromUrl = loginUrl ? siteOfUrl(loginUrl) : "";
  if (fromUrl) return fromUrl;
  const base = userDataDir ? path.basename(userDataDir).toLowerCase() : "";
  return base.includes(".") ? siteOfUrl(`https://${base}/`) : "";
}

/** The account key, or "" when there is no user name or no site to key it on (then only the
 *  profile lock applies, as before). */
export function accountLeaseKey(loginUrl: string | undefined, username: string | undefined, userDataDir?: string): string {
  const user = String(username ?? "").trim().toLowerCase();
  const site = accountSiteOf(loginUrl, userDataDir);
  return user && site ? `${site}\u0000${user}` : "";
}

interface Holder { id: number; dir: string }
const holders = new Map<string, Holder[]>();
let seq = 0;

/** Is the key held by a run or window on a profile other than `dir`? */
function heldElsewhere(key: string, dir: string): boolean {
  return (holders.get(key) ?? []).some((h) => h.dir !== dir);
}

/** Thrown when the wait runs out. The words are the run-abort vocabulary's (backend runAbort.ts):
 *  our own lease refused to start the run — never a verdict on the portal or the recipe. */
export class AccountLeaseBusy extends Error {}

/**
 * Wait until no run or open window on ANOTHER profile holds this login, then hold it. Returns the
 * release (idempotent). A key of "" holds nothing. Runs on the same profile are left to the
 * profile lock and the prior-window rule (index.ts), which already serialise them.
 */
export async function acquireAccountLease(key: string, userDataDir: string | undefined, waitMs = ACCOUNT_WAIT_MS, site = ""): Promise<() => void> {
  if (!key) return () => {};
  const dir = String(userDataDir ?? "").toLowerCase();
  const deadline = Date.now() + Math.max(0, waitMs);
  while (heldElsewhere(key, dir)) {
    if (Date.now() >= deadline) {
      throw new AccountLeaseBusy(
        `Timed out after ${Math.round(waitMs / 1000)}s waiting for the portal login to free up${site ? ` on ${site}` : ""}: another run, or a window a person is reviewing in, is signed in with the same login on another of this platform's portals. `
        + "The platform allows one session per user, so signing in now would end that one. This run was not started; retry it once that run finishes and its window is closed.",
      );
    }
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(1, deadline - Date.now()))));
  }
  const me: Holder = { id: ++seq, dir };
  holders.set(key, [...(holders.get(key) ?? []), me]);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const rest = (holders.get(key) ?? []).filter((h) => h.id !== me.id);
    if (rest.length) holders.set(key, rest); else holders.delete(key);
  };
}

/** Test seam: how many holders a key has now. */
export function accountLeaseHolders(key: string): number {
  return (holders.get(key) ?? []).length;
}
