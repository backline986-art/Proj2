// ---------------------------------------------------------------------------------------------
// THE FEE AT A fee_payment STOP (#576): what the portal asks, read off the page, and a picture of
// it with every secret and card field masked.
//
// A replay stops with pauseReason "fee_payment" when the approved final submit is a pay control
// ("Submit & Pay"), raises a pay-now dialog, or lands on a fee page. Before this, the stop kept the
// control's label and nothing else: nobody downstream could say WHAT to pay. This module reads it.
//
// HARD RULE 1: read only. It never clicks, never types, never navigates; reading a fee is not
// paying it, and the network backstop's payment rules are untouched (nothing here sends a request).
// HARD RULE 2: the screenshot masks every password / secret / payment-card control, and every
// element that renders one of the project's account or meter numbers. When a secret is known and
// the mask cannot be built, NO picture is taken (fail closed), the same rule the learner's
// withSecretMask follows for review shots.
//
// An amount that cannot be read is said to be UNREAD (read:false, totalUsd:null, with the
// reader's reason) — never shown as $0. The parser is the one shared reader
// (shared/src/portalFeeItems.ts), so a fee here and a fee on the monitor mean the same thing.
// ---------------------------------------------------------------------------------------------
import * as fs from "node:fs";
import * as path from "node:path";
import { readAccelaFeeSection, readReviewScreenFees, type PortalFeeLine, type PortalFeeReadResult } from "../../shared/src/portalFeeItems";
import { PORTAL_SAFETY_GLOBAL, PORTAL_SAFETY_IN_PAGE_SOURCE } from "../../shared/src/portalSafety";
import { scrapeReviewScreen } from "./reviewScreenScraper";
import { draftReferenceFromUrl } from "./adapters/submissionLedger";

/** What a fee stop carried, on the run's result (result_json.feeStop). */
export interface FeeStopReading {
  /** True only when the shared reader produced a positive amount. */
  read: boolean;
  /** The amount to pay, or null when it could not be read (never 0). */
  totalUsd: number | null;
  /** The fee lines the page printed (labels digit-masked by the shared reader). */
  lines: PortalFeeLine[];
  /** When unread: the reader's own reason, for the card ("The review screen prints no fee."). */
  unreadReason: string;
  /** Which stop this was: "pay_to_file" | "pay_dialog" | "fee_page". */
  where: FeeStopKind;
  /** The masked full-page screenshot, or "" when none could be taken safely. */
  shotPath: string;
  /** The page the stop happened on, as a storable record link (session material stripped), and
   *  its record key when the URL carries one. The backend links it only on the track's own host. */
  pageLink: string;
  pageRef: string;
}

export type FeeStopKind = "pay_to_file" | "pay_dialog" | "fee_page";

// Which field-value keys hold a secret: the replay's value map uses accountNumber / meterNumber
// (portalRecipes.resolveRecipeFieldValues), plus the parser's own aliases. Who HOLDS the account
// is identity the portal asks for, not a secret.
const SECRET_VALUE_KEY = /acc(oun)?t|meter|ssn|social|passw|agreement|\besi\b|esiid|said\b/i;
const IDENTITY_VALUE_KEY = /holder|name|type|owner|contact/i;

/** The values on a replay's field map that are secrets (≥4 characters). */
export function secretValuesOf(fieldValues: Record<string, unknown> | null | undefined): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(fieldValues ?? {})) {
    if (!SECRET_VALUE_KEY.test(k) || IDENTITY_VALUE_KEY.test(k)) continue;
    const s = String(v ?? "").trim();
    if (s.length >= 4) out.add(s);
  }
  return Array.from(out);
}

/** THE FEE A PAGE ASKS, from its label/value pairs and its text: the review-screen reader first
 *  (a printed total, else the fee lines summed), then the Accela fee-section reader. Pure. */
export function feeFromPage(fields: Array<{ label: string; value: string }>, bodyText: string): PortalFeeReadResult {
  const first = readReviewScreenFees(fields, bodyText);
  if (first.ok) return first;
  const accela = readAccelaFeeSection(bodyText);
  return accela.ok ? accela : first;
}

const MASK_ATTR = "data-fee-stop-mask";

/** Tag every control and element a fee screenshot must hide; returns how many were tagged. Throws
 *  when the page cannot be read. Plain loops only: a function DECLARED inside an evaluated body
 *  needs the __name shim. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tagSecrets(page: any, secrets: string[]): Promise<number> {
  await page.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE);
  const pats = secrets.map((s) => {
    const digits = s.replace(/\D/g, "");
    return digits.length >= 5 ? { digits, literal: "" } : { digits: "", literal: s.toLowerCase() };
  }).filter((p) => p.digits || p.literal.length >= 4);
  return Number(await page.evaluate((a: { g: string; attr: string; ps: Array<{ digits: string; literal: string }> }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const safety = (globalThis as any)[a.g];
    let n = 0;
    // Every control that is, or may hold, a secret or a card number — whatever it holds now.
    for (const el of Array.from(document.querySelectorAll("input, textarea, select"))) {
      const type = String((el as HTMLInputElement).type || "").toLowerCase();
      let hide = type === "password";
      if (!hide && safety) {
        try { hide = !!safety.isSecretField(safety.fieldIdentityInPage(el)) || !!safety.isPaymentElementInPage(el); } catch { hide = true; }
      }
      if (!hide && a.ps.length) {
        const v = String((el as HTMLInputElement).value || "");
        const vd = v.replace(/\D/g, "");
        const vl = v.toLowerCase();
        for (const p of a.ps) if ((p.digits && vd.indexOf(p.digits) >= 0) || (p.literal && vl.indexOf(p.literal) >= 0)) { hide = true; break; }
      }
      if (hide) { el.setAttribute(a.attr, "1"); n++; }
    }
    if (!a.ps.length) return n;
    // Text that renders a known secret ("Account: 7734009155"): the SMALLEST element carrying it.
    const bt = String(document.body ? document.body.textContent || "" : "");
    const btd = bt.replace(/\D/g, "");
    const btl = bt.toLowerCase();
    let any = false;
    for (const p of a.ps) if ((p.digits && btd.indexOf(p.digits) >= 0) || (p.literal && btl.indexOf(p.literal) >= 0)) { any = true; break; }
    if (!any) return n;
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "INPUT" || tag === "TEXTAREA") continue;
      const t = String(el.textContent || "");
      const td = t.replace(/\D/g, "");
      const tl = t.toLowerCase();
      let hit = false;
      for (const p of a.ps) if ((p.digits && td.indexOf(p.digits) >= 0) || (p.literal && tl.indexOf(p.literal) >= 0)) { hit = true; break; }
      if (!hit) continue;
      let childCarries = false;
      for (const c of Array.from(el.children)) {
        const ct = String(c.textContent || "");
        const cd = ct.replace(/\D/g, "");
        const cl = ct.toLowerCase();
        for (const p of a.ps) if ((p.digits && cd.indexOf(p.digits) >= 0) || (p.literal && cl.indexOf(p.literal) >= 0)) { childCarries = true; break; }
        if (childCarries) break;
      }
      if (childCarries) continue;
      el.setAttribute(a.attr, "1");
      n++;
    }
    return n;
  }, { g: PORTAL_SAFETY_GLOBAL, attr: MASK_ATTR, ps: pats }));
}

/**
 * A full-page screenshot with every secret / card field masked, written to `file`. Returns the
 * path, or "" when no picture was taken: the page could not be read while a secret is known (fail
 * closed), or the screenshot itself failed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function maskedFeeShot(page: any, file: string, secrets: string[]): Promise<string> {
  if (!page || typeof page.screenshot !== "function" || typeof page.evaluate !== "function") return "";
  let tagged = 0;
  try {
    tagged = await tagSecrets(page, secrets);
  } catch {
    // Card fields are on every fee page: an unreadable page is never photographed unmasked.
    return "";
  }
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const mask = tagged > 0 && typeof page.locator === "function" ? [page.locator(`[${MASK_ATTR}]`)] : undefined;
    await page.screenshot({ path: file, fullPage: true, ...(mask ? { mask } : {}) });
    return file;
  } catch {
    return "";
  } finally {
    if (tagged > 0) {
      await page.evaluate((attr: string) => {
        for (const el of Array.from(document.querySelectorAll(`[${attr}]`))) el.removeAttribute(attr);
      }, MASK_ATTR).catch(() => null);
    }
  }
}

/**
 * READ THE FEE AT THE STOP: the amount and lines the page prints (scraped read-only), the masked
 * screenshot, and the page's own link. Never throws: a page that cannot be read gives an unread
 * amount and no picture.
 */
export async function readFeeStop(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  opts: { where: FeeStopKind; shotFile: string | null; secrets: string[] },
): Promise<FeeStopReading> {
  let fee: PortalFeeReadResult = { ok: false, reason: "unreadable", detail: "The page could not be read." };
  try {
    const fields = await scrapeReviewScreen(page);
    const body = page && page.locator ? String(await page.locator("body").innerText().catch(() => "")) : "";
    fee = feeFromPage(fields.map((f) => ({ label: f.label, value: f.value })), body);
  } catch { /* unread, said as such below */ }
  const shotPath = opts.shotFile ? await maskedFeeShot(page, opts.shotFile, opts.secrets) : "";
  let pageLink = "";
  let pageRef = "";
  try {
    const here = page && typeof page.url === "function" ? String(page.url() ?? "") : "";
    if (here) { const ref = draftReferenceFromUrl(here); pageLink = ref.link; pageRef = ref.id; }
  } catch { /* a page we cannot read names no link */ }
  return {
    read: fee.ok,
    totalUsd: fee.ok ? fee.reading.totalUsd : null,
    lines: fee.ok ? fee.reading.lines : [],
    unreadReason: fee.ok ? "" : fee.detail,
    where: opts.where,
    shotPath,
    pageLink,
    pageRef,
  };
}
