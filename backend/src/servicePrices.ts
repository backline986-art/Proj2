// ---------------------------------------------------------------------------
// OUR OWN PRICE PER FILING (#187): the price list, the price each filing is charged at, and the
// filing charges a monthly statement bills.
//
// THE PRICE IS DATA, NEVER CODE. A named admin sets one price per billing track (permit, nem) for
// the org (service_prices); a client may carry its own price per track, or the older single fee for
// both. Nothing in this file knows a number: an org with no price set bills nothing and says so.
//
// RESOLUTION, most specific first (resolveServicePrice):
//   1. the client's own price for this track      clients.service_fee_permit_usd / _nem_usd
//   2. the client's single fee for every filing    clients.service_fee_usd (before #187)
//   3. the org's price list                        service_prices
//   4. the SUBMISSION_SERVICE_FEE_USD env default, only when it is set
//   5. none: no price, never a $0 line.
//
// THE PRICE IS SAVED ON EACH FILING. The filing doors (markTrackSubmitted, the confirmed auto-submit,
// captureConfirmation) call recordFilingServiceCharge beside the fee-quote snapshot: one row per
// project and filing type (building, electrical, combo, mpu, nem), written once with the price in force
// and the client's billing mode at that moment. A resubmission of the same filing (a correction round)
// finds the row and adds nothing; a later price change never re-prices it. Building and electrical
// filed separately are two filings; a combo is one.
//
// WHO BILLS IT. A filing made while the client was billed per submission was paid at the gate (#699)
// and is never billed again here. Every other filing (monthly, or no mode set) is billed on the client's
// statement (clientInvoices.buildClientStatement), once, through the ledger's one-line-one-invoice key.
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

/** Where a price came from, most specific first. "unset" means no price anywhere. */
export type PriceBasis = "client_track" | "client_flat" | "price_list" | "env_default" | "unset";

export interface ResolvedServicePrice {
  track: PriceTrack;
  /** null when no price is set anywhere: bill nothing and say so. */
  priceUsd: number | null;
  basis: PriceBasis;
  /** One sentence a person reads: where the price came from. */
  label: string;
}

export interface ServicePriceEntry {
  track: PriceTrack;
  priceUsd: number | null;
  setBy: string;
  setAt: string;
}

export interface ServicePriceList {
  orgId: string;
  prices: Record<PriceTrack, ServicePriceEntry>;
  /** The env fallback when set, shown so a person can see what an unset track falls back to. */
  envDefaultUsd: number | null;
}

export interface FilingServiceCharge {
  id: string;
  projectId: string;
  permitType: string;
  track: PriceTrack;
  /** The client's billing mode when the filing was recorded. */
  billingMode: string;
  /** null: no price was set when it was filed. */
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

export function priceTrackOf(permitType?: string | null): PriceTrack {
  return String(permitType || "").trim().toLowerCase() === "nem" ? "nem" : "permit";
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

export function getServicePriceList(db: AppDb, orgId: string): ServicePriceList {
  const rows = db.query<Row>("SELECT track, price_usd, set_by, set_at FROM service_prices WHERE org_id = ?", [orgId]);
  const entry = (track: PriceTrack): ServicePriceEntry => {
    const r = rows.find((x) => text(x.track) === track);
    return { track, priceUsd: money(r?.price_usd), setBy: text(r?.set_by), setAt: text(r?.set_at) };
  };
  return { orgId, prices: { permit: entry("permit"), nem: entry("nem") }, envDefaultUsd: envDefaultServicePriceUsd() };
}

/**
 * A NAMED PERSON SETS THE PRICE LIST. Only the tracks present in the input change; null or "" clears
 * one (that track then falls back, and with nothing to fall back to bills nothing). Prices already
 * saved on filings are not touched: a new price applies to filings recorded from now on.
 */
export function setServicePrices(
  db: AppDb,
  orgId: string,
  input: Partial<Record<"permitUsd" | "nemUsd", unknown>>,
  by: string,
): { list: ServicePriceList; changed: Array<{ track: PriceTrack; fromUsd: number | null; toUsd: number | null }> } {
  const who = text(by).trim().slice(0, 120);
  if (!who) throw new HttpError(400, "Name the person setting the prices.");
  const wanted: Array<{ track: PriceTrack; value: number | null }> = [];
  for (const track of PRICE_TRACKS) {
    const key = track === "permit" ? "permitUsd" : "nemUsd";
    if (!(key in input)) continue;
    const raw = input[key];
    if (raw == null || raw === "") { wanted.push({ track, value: null }); continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE_USD) {
      throw new HttpError(400, `The ${TRACK_NAMES[track]} price must be a dollar amount from 0 to ${MAX_PRICE_USD}.`, { field: key });
    }
    wanted.push({ track, value: round2(n) });
  }
  if (!wanted.length) throw new HttpError(400, "Give permitUsd and/or nemUsd (a blank clears that price).");
  const before = getServicePriceList(db, orgId);
  const changed: Array<{ track: PriceTrack; fromUsd: number | null; toUsd: number | null }> = [];
  const ts = nowIso();
  db.transaction(() => {
    for (const { track, value } of wanted) {
      const fromUsd = before.prices[track].priceUsd;
      if (fromUsd === value) continue;
      if (value == null) {
        db.run("DELETE FROM service_prices WHERE org_id = ? AND track = ?", [orgId, track]);
      } else {
        db.run(
          `INSERT INTO service_prices (org_id, track, price_usd, set_by, set_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(org_id, track) DO UPDATE SET price_usd = excluded.price_usd, set_by = excluded.set_by, set_at = excluded.set_at`,
          [orgId, track, value, who, ts],
        );
      }
      changed.push({ track, fromUsd, toUsd: value });
    }
  });
  return { list: getServicePriceList(db, orgId), changed };
}

/** The price in force NOW for this client (or a project with none) on this track. Reads only. */
export function resolveServicePrice(db: AppDb, clientId: string | null, trackInput: string | null | undefined, projectId?: string): ResolvedServicePrice {
  const track = priceTrackOf(trackInput);
  const name = TRACK_NAMES[track];
  if (clientId) {
    const row = db.get<Row>("SELECT service_fee_permit_usd, service_fee_nem_usd, service_fee_usd FROM clients WHERE id = ?", [clientId]);
    const own = money(track === "nem" ? row?.service_fee_nem_usd : row?.service_fee_permit_usd);
    if (own != null) return { track, priceUsd: own, basis: "client_track", label: `this client's own price per ${name}` };
    const flat = money(row?.service_fee_usd);
    if (flat != null) return { track, priceUsd: flat, basis: "client_flat", label: "this client's single service fee for every filing" };
  }
  const list = getServicePriceList(db, orgFor(db, clientId, projectId));
  const listed = list.prices[track].priceUsd;
  if (listed != null) return { track, priceUsd: listed, basis: "price_list", label: `the price list's price per ${name}` };
  if (list.envDefaultUsd != null) return { track, priceUsd: list.envDefaultUsd, basis: "env_default", label: "the server's default service fee (SUBMISSION_SERVICE_FEE_USD)" };
  return { track, priceUsd: null, basis: "unset", label: `no price per ${name} is set (Billing, Prices)` };
}

function mapCharge(r: Row): FilingServiceCharge {
  return {
    id: text(r.id),
    projectId: text(r.project_id),
    permitType: text(r.permit_type),
    track: priceTrackOf(text(r.billing_track)),
    billingMode: text(r.billing_mode),
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
 * per (project, filing type): a correction resubmission of the same filing adds nothing. NEVER THROWS:
 * the filing is the fact that matters, and a missed charge is visible (the job has no charge row).
 * Returns true when it wrote a row.
 */
export function recordFilingServiceCharge(db: AppDb, project: ProjectRecord, permitType: string, submissionId = ""): boolean {
  const key = filingKey(permitType);
  try {
    if (db.get("SELECT 1 AS hit FROM filing_service_charges WHERE project_id = ? AND permit_type = ?", [project.id, key])) return false;
    const price = resolveServicePrice(db, project.clientId, key, project.id);
    const client = project.clientId ? db.get<Row>("SELECT billing_mode FROM clients WHERE id = ?", [project.clientId]) : null;
    const ts = nowIso();
    db.run(
      `INSERT OR IGNORE INTO filing_service_charges
         (id, project_id, permit_type, billing_track, billing_mode, price_usd, price_basis, price_label, submission_id, filed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), project.id, key, price.track, text(client?.billing_mode).toLowerCase(), price.priceUsd, price.basis, price.label, text(submissionId), ts, ts],
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

/** A filing charge is billed by the statement (not the gate) unless it was filed under per-submission billing. */
export function billedOnStatement(charge: FilingServiceCharge): boolean {
  return charge.billingMode !== "per_submission";
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
