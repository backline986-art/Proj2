// ---------------------------------------------------------------------------
// OUR OWN PRICE PER FILING (#187): the price list, the per-project cap, the price each filing is
// charged at, and the filing charges a statement bills.
//
// THE PRICE IS DATA, NEVER CODE. A named admin sets, for the org (service_prices), one price per permit
// filing, one per NEM application and one cap per project, for each PRICING TIER: "founding" (the
// founding clients) and "standard" (everyone else). A client is founding when its pricing tier says so
// (clients.pricing_tier); every other client is standard. A client may also carry its own price per
// track, or the older single fee for every filing. Nothing in this file knows a number: an org with no
// price set bills nothing and says so, and a tier with no cap set has no cap.
//
// RESOLUTION, most specific first (resolveServicePrice):
//   1. the client's own price for this track      clients.service_fee_permit_usd / _nem_usd
//   2. the client's single fee for every filing    clients.service_fee_usd (before #187)
//   3. the org's price list for the client's tier  service_prices
//   4. the SUBMISSION_SERVICE_FEE_USD env default, only when it is set
//   5. none: no price, never a $0 line.
//
// THE CAP (owner, 2026-11-12: "$230 cap for founders, $275 for everyone else") is per PROJECT for its
// whole life: the project's filings together never bill more than the cap of the client's tier. A
// filing is charged min(its price, the cap less what the project's earlier filings were charged), so
// building + electrical + NEM at $99 + $99 + $79 bills $99 + $99 + $32 under a $230 cap.
//
// THE PRICE IS SAVED ON EACH FILING. The filing doors (markTrackSubmitted, the confirmed auto-submit,
// captureConfirmation) call recordFilingServiceCharge beside the fee-quote snapshot: one row per
// project and filing type (building, electrical, combo, mpu, nem), written once with the list price, the
// cap and the charged amount in force, and the client's billing mode at that moment. A resubmission of
// the same filing (a correction round) finds the row and adds nothing; a later price change never
// re-prices it. Building and electrical filed separately are two filings ($99 each, owner 2026-11-12);
// a combo is one.
//
// WHO BILLS IT. Under per-submission billing the gate (#699) collects ONE filing per track before
// staging, so the first filing of each track on a project is the gate's and is never billed again here;
// a second filing of the same track (the electrical after the building) is billed on the statement.
// Every filing made under any other mode (monthly, or no mode set) is billed on the client's statement
// (clientInvoices.buildClientStatement), once, through the ledger's one-line-one-invoice key.
//
// NOTHING HERE PAYS, CHARGES OR SENDS ANYTHING (rule 1): these are records a person invoices from.
// Universal: nothing is keyed to a state, utility, portal or AHJ.
// ---------------------------------------------------------------------------
import type { AppDb } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { HttpError } from "./httpError";
import { id as newId } from "./ids";
import { text } from "./json";
import { nowIso } from "./time";
import { logger } from "./logger";

type Row = Record<string, unknown>;

export type PriceTrack = "permit" | "nem";
export const PRICE_TRACKS: readonly PriceTrack[] = ["permit", "nem"];

export type PricingTier = "founding" | "standard";
export const PRICING_TIERS: readonly PricingTier[] = ["founding", "standard"];

/** What a price-list row prices: a filing of one track, the per-project cap, or the client onboarding
 *  fee (#208: put on a new client's first statement; once paid, credited back against Keelix's own
 *  filing fees). */
export type PriceItem = PriceTrack | "project_cap" | "onboarding";
const PRICE_ITEMS: readonly PriceItem[] = ["permit", "nem", "project_cap", "onboarding"];

/** Where a price came from, most specific first. "unset" means no price anywhere. */
export type PriceBasis = "client_track" | "client_flat" | "price_list" | "env_default" | "unset";

export interface ResolvedServicePrice {
  track: PriceTrack;
  tier: PricingTier;
  /** null when no price is set anywhere: bill nothing and say so. */
  priceUsd: number | null;
  basis: PriceBasis;
  /** One sentence a person reads: where the price came from. */
  label: string;
}

export interface ServicePriceEntry {
  priceUsd: number | null;
  setBy: string;
  setAt: string;
}

export type TierPrices = Record<PriceItem, ServicePriceEntry>;

export interface ServicePriceList {
  orgId: string;
  tiers: Record<PricingTier, TierPrices>;
  /** The env fallback when set, shown so a person can see what an unset price falls back to. */
  envDefaultUsd: number | null;
}

export interface FilingServiceCharge {
  id: string;
  projectId: string;
  permitType: string;
  track: PriceTrack;
  /** The client's billing mode when the filing was recorded. */
  billingMode: string;
  tier: PricingTier;
  /** The price before the cap; null when no price was set when it was filed. */
  listPriceUsd: number | null;
  /** The project's cap in force when it was filed; null = no cap. */
  capUsd: number | null;
  /** What this filing is charged: the list price, cut to what the cap leaves. null with no price. */
  priceUsd: number | null;
  priceBasis: PriceBasis;
  priceLabel: string;
  submissionId: string;
  filedAt: string;
  waivedAt: string;
  waivedBy: string;
  waiveReason: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const MAX_PRICE_USD = 100_000;

export const TRACK_NAMES: Record<PriceTrack, string> = { permit: "permit filing", nem: "NEM application" };
export const TIER_NAMES: Record<PricingTier, string> = { founding: "founding", standard: "standard" };

export function priceTrackOf(permitType?: string | null): PriceTrack {
  return String(permitType || "").trim().toLowerCase() === "nem" ? "nem" : "permit";
}

export function pricingTierOf(raw: unknown): PricingTier {
  return String(raw ?? "").trim().toLowerCase() === "founding" ? "founding" : "standard";
}

/** The filing a charge is for: its own type, so building and electrical are two filings. A legacy run
 *  with no type is the permit filing. */
function filingKey(permitType?: string | null): string {
  const t = String(permitType || "").trim().toLowerCase();
  return t || "permit";
}

/** The env fallback, ONLY when the variable is actually set: an unset variable is no price, not $0. */
export function envDefaultServicePriceUsd(): number | null {
  const raw = String(process.env.SUBMISSION_SERVICE_FEE_USD ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? round2(n) : null;
}

function money(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? round2(n) : null;
}

/** The org a client (else the project) belongs to, for the price list. */
function orgFor(db: AppDb, clientId: string | null, projectId?: string): string {
  if (clientId) {
    const row = db.get<Row>("SELECT org_id FROM clients WHERE id = ?", [clientId]);
    if (text(row?.org_id)) return text(row?.org_id);
  }
  if (projectId) {
    const row = db.get<Row>("SELECT org_id FROM projects WHERE id = ?", [projectId]);
    if (text(row?.org_id)) return text(row?.org_id);
  }
  return DEFAULT_ORG_ID;
}

function tierOfClient(db: AppDb, clientId: string | null): PricingTier {
  if (!clientId) return "standard";
  return pricingTierOf(db.get<Row>("SELECT pricing_tier FROM clients WHERE id = ?", [clientId])?.pricing_tier);
}

export function getServicePriceList(db: AppDb, orgId: string): ServicePriceList {
  const rows = db.query<Row>("SELECT tier, item, price_usd, set_by, set_at FROM service_prices WHERE org_id = ?", [orgId]);
  const tierPrices = (tier: PricingTier): TierPrices => {
    const entry = (item: PriceItem): ServicePriceEntry => {
      const r = rows.find((x) => text(x.tier) === tier && text(x.item) === item);
      return { priceUsd: money(r?.price_usd), setBy: text(r?.set_by), setAt: text(r?.set_at) };
    };
    return { permit: entry("permit"), nem: entry("nem"), project_cap: entry("project_cap"), onboarding: entry("onboarding") };
  };
  return { orgId, tiers: { founding: tierPrices("founding"), standard: tierPrices("standard") }, envDefaultUsd: envDefaultServicePriceUsd() };
}

const INPUT_KEYS: Record<PriceItem, string> = { permit: "permitUsd", nem: "nemUsd", project_cap: "capUsd", onboarding: "onboardingUsd" };
const ITEM_NAMES: Record<PriceItem, string> = { permit: "price per permit filing", nem: "price per NEM application", project_cap: "cap per project", onboarding: "onboarding fee" };

export interface PriceChange { tier: PricingTier; item: PriceItem; fromUsd: number | null; toUsd: number | null }

/**
 * A NAMED PERSON SETS THE PRICE LIST: `{ founding: {permitUsd, nemUsd, capUsd}, standard: {...} }`.
 * Only the keys present change; null or "" clears one (a cleared price then falls back, and with nothing
 * to fall back to bills nothing; a cleared cap is no cap). Prices already saved on filings are not
 * touched: a new price applies to filings recorded from now on.
 */
export function setServicePrices(
  db: AppDb,
  orgId: string,
  input: Partial<Record<PricingTier, unknown>>,
  by: string,
): { list: ServicePriceList; changed: PriceChange[] } {
  const who = text(by).trim().slice(0, 120);
  if (!who) throw new HttpError(400, "Name the person setting the prices.");
  const wanted: Array<{ tier: PricingTier; item: PriceItem; value: number | null }> = [];
  for (const tier of PRICING_TIERS) {
    const block = input?.[tier];
    if (block == null) continue;
    if (typeof block !== "object" || Array.isArray(block)) throw new HttpError(400, `"${tier}" must be an object of permitUsd, nemUsd, capUsd and onboardingUsd.`);
    const b = block as Record<string, unknown>;
    for (const item of PRICE_ITEMS) {
      const key = INPUT_KEYS[item];
      if (!(key in b)) continue;
      const raw = b[key];
      if (raw == null || raw === "") { wanted.push({ tier, item, value: null }); continue; }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE_USD) {
        throw new HttpError(400, `The ${TIER_NAMES[tier]} ${ITEM_NAMES[item]} must be a dollar amount from 0 to ${MAX_PRICE_USD}.`, { field: `${tier}.${key}` });
      }
      wanted.push({ tier, item, value: round2(n) });
    }
  }
  if (!wanted.length) throw new HttpError(400, "Give founding and/or standard prices: permitUsd, nemUsd, capUsd, onboardingUsd (a blank clears one).");
  const before = getServicePriceList(db, orgId);
  const changed: PriceChange[] = [];
  const ts = nowIso();
  db.transaction(() => {
    for (const { tier, item, value } of wanted) {
      const fromUsd = before.tiers[tier][item].priceUsd;
      if (fromUsd === value) continue;
      if (value == null) {
        db.run("DELETE FROM service_prices WHERE org_id = ? AND tier = ? AND item = ?", [orgId, tier, item]);
      } else {
        db.run(
          `INSERT INTO service_prices (org_id, tier, item, price_usd, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(org_id, tier, item) DO UPDATE SET price_usd = excluded.price_usd, set_by = excluded.set_by, set_at = excluded.set_at`,
          [orgId, tier, item, value, who, ts],
        );
      }
      changed.push({ tier, item, fromUsd, toUsd: value });
    }
  });
  return { list: getServicePriceList(db, orgId), changed };
}

/** The price in force NOW for this client (or a project with none) on this track. Reads only. */
export function resolveServicePrice(db: AppDb, clientId: string | null, trackInput: string | null | undefined, projectId?: string): ResolvedServicePrice {
  const track = priceTrackOf(trackInput);
  const tier = tierOfClient(db, clientId);
  const name = TRACK_NAMES[track];
  if (clientId) {
    const row = db.get<Row>("SELECT service_fee_permit_usd, service_fee_nem_usd, service_fee_usd FROM clients WHERE id = ?", [clientId]);
    const own = money(track === "nem" ? row?.service_fee_nem_usd : row?.service_fee_permit_usd);
    if (own != null) return { track, tier, priceUsd: own, basis: "client_track", label: `this client's own price per ${name}` };
    const flat = money(row?.service_fee_usd);
    if (flat != null) return { track, tier, priceUsd: flat, basis: "client_flat", label: "this client's single service fee for every filing" };
  }
  const list = getServicePriceList(db, orgFor(db, clientId, projectId));
  const listed = list.tiers[tier][track].priceUsd;
  if (listed != null) return { track, tier, priceUsd: listed, basis: "price_list", label: `the ${TIER_NAMES[tier]} price per ${name}` };
  if (list.envDefaultUsd != null) return { track, tier, priceUsd: list.envDefaultUsd, basis: "env_default", label: "the server's default service fee (SUBMISSION_SERVICE_FEE_USD)" };
  return { track, tier, priceUsd: null, basis: "unset", label: `no ${TIER_NAMES[tier]} price per ${name} is set (Billing, Prices)` };
}

/** The per-project cap in force NOW for this client's tier; null = no cap. Reads only. */
export function resolveProjectCap(db: AppDb, clientId: string | null, projectId?: string): { capUsd: number | null; tier: PricingTier } {
  const tier = tierOfClient(db, clientId);
  return { capUsd: getServicePriceList(db, orgFor(db, clientId, projectId)).tiers[tier].project_cap.priceUsd, tier };
}

/** The onboarding fee in force NOW for this client's tier (#208); null = none set. Reads only. */
export function resolveOnboardingFee(db: AppDb, clientId: string | null): { feeUsd: number | null; setAt: string; tier: PricingTier } {
  const tier = tierOfClient(db, clientId);
  const entry = getServicePriceList(db, orgFor(db, clientId)).tiers[tier].onboarding;
  return { feeUsd: entry.priceUsd, setAt: entry.setAt, tier };
}

/** What the project's OTHER filings are charged (waived ones excluded): the cap's running total. */
export function projectChargedUsd(db: AppDb, projectId: string, exceptChargeId = ""): number {
  const r = db.get<{ total: number | null }>(
    "SELECT SUM(price_usd) AS total FROM filing_service_charges WHERE project_id = ? AND waived_at = '' AND price_usd IS NOT NULL AND id != ?",
    [projectId, exceptChargeId],
  );
  return round2(Number(r?.total ?? 0));
}

/** A price cut to what the cap leaves after `chargedUsd`. */
export function underCap(priceUsd: number, capUsd: number | null, chargedUsd: number): number {
  if (capUsd == null) return round2(priceUsd);
  return round2(Math.max(0, Math.min(priceUsd, capUsd - chargedUsd)));
}

function mapCharge(r: Row): FilingServiceCharge {
  return {
    id: text(r.id),
    projectId: text(r.project_id),
    permitType: text(r.permit_type),
    track: priceTrackOf(text(r.billing_track)),
    billingMode: text(r.billing_mode),
    tier: pricingTierOf(r.pricing_tier),
    listPriceUsd: money(r.list_price_usd),
    capUsd: money(r.cap_usd),
    priceUsd: money(r.price_usd),
    priceBasis: (text(r.price_basis) || "unset") as PriceBasis,
    priceLabel: text(r.price_label),
    submissionId: text(r.submission_id),
    filedAt: text(r.filed_at),
    waivedAt: text(r.waived_at),
    waivedBy: text(r.waived_by),
    waiveReason: text(r.waive_reason),
  };
}

/**
 * THE PRICE SAVED ON A FILING. Called by every filing door after the filing is recorded. Written once
 * per (project, filing type): a correction resubmission of the same filing adds nothing. The charged
 * amount is the price cut to what the project's cap leaves. NEVER THROWS: the filing is the fact that
 * matters, and a missed charge is visible (the job has no charge row). Returns true when it wrote a row.
 */
export function recordFilingServiceCharge(db: AppDb, project: ProjectRecord, permitType: string, submissionId = ""): boolean {
  const key = filingKey(permitType);
  try {
    if (db.get("SELECT 1 AS hit FROM filing_service_charges WHERE project_id = ? AND permit_type = ?", [project.id, key])) return false;
    const price = resolveServicePrice(db, project.clientId, key, project.id);
    const { capUsd } = resolveProjectCap(db, project.clientId, project.id);
    const charged = price.priceUsd == null ? null : underCap(price.priceUsd, capUsd, projectChargedUsd(db, project.id));
    const client = project.clientId ? db.get<Row>("SELECT billing_mode FROM clients WHERE id = ?", [project.clientId]) : null;
    const ts = nowIso();
    db.run(
      `INSERT OR IGNORE INTO filing_service_charges
         (id, project_id, permit_type, billing_track, billing_mode, pricing_tier, list_price_usd, cap_usd, price_usd, price_basis, price_label, submission_id, filed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), project.id, key, price.track, text(client?.billing_mode).toLowerCase(), price.tier, price.priceUsd, capUsd, charged,
        price.basis, price.label, text(submissionId), ts, ts],
    );
    return true;
  } catch (err) {
    logger.warn("billing", "could not save the price on this filing — the filing is recorded; bill it by hand", {
      projectId: project.id, permitType: key, err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Every filing charge on a client's projects (through the project's CURRENT client), oldest first. */
export function listFilingCharges(db: AppDb, clientId: string): Array<FilingServiceCharge & { project: Row }> {
  return db.query<Row>(
    `SELECT c.*, p.homeowner_name AS p_homeowner_name, p.project_address AS p_project_address
       FROM filing_service_charges c JOIN projects p ON p.id = c.project_id
      WHERE p.client_id = ?
      ORDER BY c.filed_at, c.id`,
    [clientId],
  ).map((r) => ({ ...mapCharge(r), project: { homeownerName: text(r.p_homeowner_name), projectAddress: text(r.p_project_address) } }));
}

/**
 * The charges the GATE already covers: under per-submission billing, the first filing of each track on
 * a project (by filed time). Every other charge is for the statement to bill.
 */
export function gateCoveredChargeIds(charges: FilingServiceCharge[]): Set<string> {
  const covered = new Set<string>();
  const seen = new Set<string>();
  const ordered = [...charges].sort((a, b) => a.filedAt.localeCompare(b.filedAt) || a.id.localeCompare(b.id));
  for (const c of ordered) {
    if (c.billingMode !== "per_submission") continue;
    const k = `${c.projectId}:${c.track}`;
    if (seen.has(k)) continue;
    seen.add(k);
    covered.add(c.id);
  }
  return covered;
}

/**
 * A PERSON DECIDES NOT TO BILL ONE FILING (filed in error, a courtesy refile). Only through its own
 * client (another client's charge is a 404), never once it is on a live invoice (void that invoice
 * first), and recorded against the named person with their reason.
 */
export function waiveFilingCharge(db: AppDb, clientId: string, chargeId: string, reason: unknown, by: string): FilingServiceCharge {
  const row = db.get<Row>(
    "SELECT c.* FROM filing_service_charges c JOIN projects p ON p.id = c.project_id WHERE c.id = ? AND p.client_id = ?",
    [chargeId, clientId],
  );
  if (!row) throw new HttpError(404, "Filing charge not found.");
  const why = text(reason).trim().slice(0, 300);
  if (!why) throw new HttpError(400, "Say why this filing is not billed.");
  if (text(row.waived_at)) return mapCharge(row);
  const live = db.get<Row>(
    `SELECT i.number FROM client_invoice_lines l JOIN client_invoices i ON i.id = l.invoice_id
      WHERE l.payment_id = ? AND l.released_at IS NULL LIMIT 1`,
    [chargeId],
  );
  if (live) throw new HttpError(409, `This filing is already on invoice ${text(live.number)}. Void that invoice first.`);
  db.run("UPDATE filing_service_charges SET waived_at = ?, waived_by = ?, waive_reason = ? WHERE id = ?",
    [nowIso(), text(by).slice(0, 120), why, chargeId]);
  return mapCharge(db.get<Row>("SELECT * FROM filing_service_charges WHERE id = ?", [chargeId]) as Row);
}
