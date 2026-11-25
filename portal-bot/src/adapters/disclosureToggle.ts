// IS THIS CONTROL A DISCLOSURE TOGGLE? One predicate, two readers.
//
// A control carrying aria-expanded and/or aria-controls, or a <legend>/<summary>, opens and
// shuts a panel — an accordion heading, a collapsible fieldset, a details disclosure. Clicking
// it changes what is SHOWN and never posts anything. City of Bend's CityView logon (2026-11-11)
// heads its form with <legend role="button" aria-expanded aria-controls>Sign In</legend> placed
// BEFORE the fields; the login's submit pick matched it by name, clicked it, the panel collapsed
// and nothing was posted. The entry finder (applicationEntry.markSiteChromeInPage) already knew
// the same thing — "aria-expanded alone is a disclosure, not a dropdown" — in its own words.
//
// The predicate is a SELECTOR so the two in-page readers and the Node-side one answer from the
// same text: in-page code must be self-contained (no hoisted helper survives the bundler), so
// the selector travels into page.evaluate as an argument and is applied with el.matches.
//
// A disclosure toggle is still a legitimate REVEAL trigger: when the login panel arrives shut,
// clicking its heading is exactly right. Only the SUBMIT and NEXT-STEP picks refuse it.
import type { Locator } from "playwright";

export const DISCLOSURE_TOGGLE_SELECTOR = "[aria-expanded], [aria-controls], legend, summary";

/** Node-side reading of the same selector, bounded (a detached locator must not wait 30 s). */
export async function isDisclosureToggle(loc: Locator, timeoutMs = 2000): Promise<boolean> {
  try {
    return await (loc as unknown as { evaluate: (fn: (el: Element, sel: string) => boolean, arg: string, o: { timeout: number }) => Promise<boolean> })
      .evaluate((el, sel) => el.matches(sel), DISCLOSURE_TOGGLE_SELECTOR, { timeout: timeoutMs });
  } catch {
    return false;
  }
}
