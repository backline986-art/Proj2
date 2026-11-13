// ---------------------------------------------------------------------------
// CEC solar equipment list sync. The California Energy Commission publishes the
// authoritative listings (modules + inverters) that utility portals (PowerClerk
// et al.) load their equipment dropdowns from — certified names there rarely
// match plan-set names. A weekly sync into cec_equipment feeds:
//   (a) certified-name candidates for the learner's equipment pass,
//   (b) an offline inverter-spec fallback (output A / W),
//   (c) an ADVISORY QC note when a parsed model isn't CEC-listed.
// No LLM anywhere — stub mode is identical. Failure-safe: rows are replaced
// only inside a transaction after a full successful parse + sanity gate, so a
// moved URL / layout change leaves a stale table, never a broken one.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import { readXlsx, pick, type SheetData } from "./xlsxRead";
import { id } from "./ids";
import { logger } from "./logger";
import { startPersistentSchedule } from "./schedulerState";
import { nowIso } from "./time";
import { isOfficialSourceHost } from "../../shared/src/officialSource";
import { operatorPolicyAnswer } from "../../shared/src/perJobQuestions";

export type CecKind = "module" | "inverter";

export interface CecRow {
  manufacturer: string;
  model: string;
  powerW: number | null;
  outputCurrentA: number | null;
  listedAt: string;
  /** INVERTERS ONLY: the list's own "UL 1741 Supplement SB Certification" column, "Y" or "N" ("" when
   *  the workbook has no such column). Kept in the row's raw_json (no migration). */
  ul1741sb?: "Y" | "N" | "";
  /** Who certified it: the list's "UL 1741 (3rd Ed.) Supplement SB Certification" (certifying entity). */
  ul1741sbBy?: string;
}

export interface CecSyncSummary {
  modules: number;
  inverters: number;
  skipped: string[];
  syncedAt: string;
}

// Defaults are the CEC's published solar-equipment-list workbooks; the CEC moves
// these paths occasionally — env is the operational truth, and the sanity gate
// makes a stale default harmless (old rows kept).
const CEC_DEFAULT_MODULES_URL =
  "https://solarequipment.energy.ca.gov/Home/DownloadtoExcel?filename=PVModuleList";
const CEC_DEFAULT_INVERTERS_URL =
  "https://solarequipment.energy.ca.gov/Home/DownloadtoExcel?filename=InvertersList";

function cecUrl(kind: CecKind): string {
  return kind === "module"
    ? process.env.CEC_MODULES_URL || CEC_DEFAULT_MODULES_URL
    : process.env.CEC_INVERTERS_URL || CEC_DEFAULT_INVERTERS_URL;
}

// Minimum plausible list sizes — the real lists are tens of thousands of rows;
// a truncated download or an error page must never wipe good data.
const SANITY_MIN: Record<CecKind, number> = { module: 500, inverter: 200 };

/** Fetch a URL and return the bytes only if it looks like a real xlsx (zip). */
export async function fetchXlsx(url: string): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(url, { redirect: "follow", signal: controller.signal });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      // xlsx = zip: PK\x03\x04 magic. Guard against HTML error pages.
      if (buf.length > 1000 && buf[0] === 0x50 && buf[1] === 0x4b) return buf;
      return null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

// CEC workbooks carry a deep preamble (title, contact info, footnote paragraphs
// — ~14 rows in the real lists) above the real header row, so readXlsx's
// first-non-empty-row-as-headers heuristic mis-keys them. The header row is the
// one whose cell is exactly "Manufacturer"/"Manufacturer Name" — footnote
// paragraphs merely CONTAIN the word, so an exact short-cell match is required.
function findHeaderedRows(sheet: SheetData): Record<string, string>[] {
  const isHeaderCell = (v: string) => /^manufacturer( name)?\s*$/i.test(v.trim());
  if (sheet.headers.some(isHeaderCell)) return sheet.rows;
  for (let i = 0; i < Math.min(sheet.rows.length, 30); i++) {
    const candidate = Object.values(sheet.rows[i]);
    if (!candidate.some(isHeaderCell)) continue;
    // Real headers embed newlines ("Grid Support\nListing Date") — collapse them.
    const headers = candidate.map((h, idx) => (h && h.trim() ? h.trim().replace(/\s+/g, " ") : `col${idx}`));
    return sheet.rows.slice(i + 1).map((r) => {
      const values = Object.values(r);
      const obj: Record<string, string> = {};
      headers.forEach((h, idx) => {
        const key = obj[h] !== undefined ? `${h}__${idx}` : h;
        obj[key] = values[idx] ?? "";
      });
      return obj;
    });
  }
  return [];
}

function num(v: string): number | null {
  const n = Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse one CEC workbook into rows. Exported for tests (fetch-free). */
export function parseCecSheet(kind: CecKind, buf: Buffer): CecRow[] {
  const out: CecRow[] = [];
  const seen = new Set<string>();
  for (const sheet of readXlsx(buf)) {
    for (const row of findHeaderedRows(sheet)) {
      const manufacturer = pick(row, "Manufacturer Name", "Manufacturer");
      const model = pick(row, "Model Number", "Model");
      if (!manufacturer || !model) continue;
      const key = `${manufacturer.toLowerCase()}|${model.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let powerW: number | null;
      if (kind === "module") {
        powerW = num(pick(row, "Nameplate Pmax", "PTC", "Power Rating", "Nameplate"));
      } else {
        // The CEC grid-support list's power column ("Maximum Continuous Output
        // Power at Unity Power Factor") is in kW; values under 1000 are kW
        // (residential + commercial), values at/above are already watts.
        const raw = num(pick(row, "Rated Output Power", "Maximum Continuous Output Power", "Power Rating", "Rated Power"));
        powerW = raw === null ? null : raw < 1000 ? raw * 1000 : raw;
      }
      let outputCurrentA: number | null = null;
      if (kind === "inverter") {
        outputCurrentA = num(pick(row, "Maximum Continuous Output Current", "Output Current", "Rated Output Current"));
        if (outputCurrentA === null && powerW !== null) {
          // The CEC list has no current column — derive from nominal voltage.
          const volts = num(pick(row, "Nominal Voltage", "Voltage Nominal"));
          if (volts !== null && volts >= 100) outputCurrentA = Math.round((powerW / volts) * 100) / 100;
        }
      }
      // THE LIST'S OWN UL 1741 SB ANSWER (inverters). The workbook prints a Y/N column
      // ("UL 1741 Supplement SB Certification") and, further right, the certifying entity under a
      // different heading ("UL 1741 (3rd Ed.) Supplement SB Certification"); pick() matches a heading by
      // its start, so the two never read as each other.
      const sbRaw = kind === "inverter" ? pick(row, "UL 1741 Supplement SB Certification").toUpperCase() : "";
      const ul1741sb: "Y" | "N" | "" = sbRaw.startsWith("Y") ? "Y" : sbRaw.startsWith("N") ? "N" : "";
      const sbBy = ul1741sb === "Y" ? pick(row, "UL 1741 (3rd Ed.) Supplement SB Certification") : "";
      out.push({
        manufacturer,
        model,
        powerW,
        outputCurrentA,
        listedAt: pick(row, "CEC Listing Date", "Grid Support Listing Date", "Listing Date", "Last Update"),
        ...(ul1741sb ? { ul1741sb, ul1741sbBy: /no information/i.test(sbBy) ? "" : sbBy } : {}),
      });
    }
    // No break: the inverter workbook carries Solar_Inverters AND
    // Battery_Inverters sheets (hybrids appear on both; dedupe handles overlap).
  }
  return out;
}

/** Replace one kind's rows inside a transaction. Exported for tests. */
export function importCecRows(db: AppDb, kind: CecKind, rows: CecRow[]): number {
  const ts = nowIso();
  db.transaction(() => {
    db.run("DELETE FROM cec_equipment WHERE kind = ?", [kind]);
    for (const row of rows) {
      db.run(
        `INSERT OR IGNORE INTO cec_equipment (id, kind, manufacturer, model, power_w, output_current_a, listed_at, raw_json, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id(), kind, row.manufacturer, row.model, row.powerW, row.outputCurrentA, row.listedAt || "",
          row.ul1741sb ? JSON.stringify({ ul1741sb: row.ul1741sb, ul1741sbBy: row.ul1741sbBy || "" }) : "{}", ts],
      );
    }
  });
  return rows.length;
}

export async function syncCecEquipment(db: AppDb): Promise<CecSyncSummary> {
  const summary: CecSyncSummary = { modules: 0, inverters: 0, skipped: [], syncedAt: nowIso() };
  for (const kind of ["module", "inverter"] as const) {
    const url = cecUrl(kind);
    const buf = await fetchXlsx(url);
    if (!buf) {
      summary.skipped.push(`${kind}: download failed or not an xlsx (${url}) — kept existing rows.`);
      logger.warn("cec-sync", `download failed for ${kind} list: ${url}`);
      continue;
    }
    let rows: CecRow[] = [];
    try {
      rows = parseCecSheet(kind, buf);
    } catch (err) {
      summary.skipped.push(`${kind}: parse failed (${err instanceof Error ? err.message : String(err)}) — kept existing rows.`);
      continue;
    }
    if (rows.length < SANITY_MIN[kind]) {
      summary.skipped.push(`${kind}: only ${rows.length} rows parsed (< ${SANITY_MIN[kind]} sanity floor) — layout likely changed; kept existing rows.`);
      logger.warn("cec-sync", `sanity gate: ${kind} parsed ${rows.length} rows — keeping old data`);
      continue;
    }
    const n = importCecRows(db, kind, rows);
    if (kind === "module") summary.modules = n;
    else summary.inverters = n;
  }
  primeCecCache(db);
  return summary;
}

const compact = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Words that appear in so many manufacturer names that matching on them would return
// noise rather than the certified name for THIS make.
const CEC_GENERIC_MAKE_WORDS = new Set([
  "solar", "energy", "power", "systems", "system", "technologies", "technology", "electric",
  "electronics", "america", "american", "international", "industries", "industry", "group",
  "company", "limited", "corporation", "holdings", "global", "green", "clean", "renewable",
  "manufacturing", "trading", "science", "sciences",
]);

/** Certified manufacturer names matching an operator/plan-set make ("apsystems"
 *  → "Altenergy Power System Inc."). Same compact normalization the static
 *  alias table uses; contains-match both ways, min 4 chars, capped at 5. */
export function certifiedNamesForMake(db: AppDb, kind: CecKind | "battery", make: string): string[] {
  const want = compact(make);
  if (want.length < 4 || kind === "battery") return []; // battery list not synced (column ready for later)
  try {
    const rows = db.query<{ manufacturer: string }>("SELECT DISTINCT manufacturer FROM cec_equipment WHERE kind = ?", [kind]);
    const out: string[] = [];
    // A DISTINCTIVE token from the plan-set make, for the very common case where the
    // certified name is a different phrase rather than a longer version of the same one.
    // Whole-string containment alone silently missed exactly the makes these projects use:
    //   "ZNShine Solar"  vs  "ZNSHINE PV-TECH Co., Ltd."   -> neither contains the other
    //   "Q CELLS"        vs  "Hanwha Qcells (Qidong) Co."
    // Generic words are excluded because "solar"/"energy"/"power" would match hundreds of
    // manufacturers and turn a precise lookup into noise; a token must also be >= 5 chars,
    // so "ap" from "AP Systems" cannot match half the list either. Makes whose certified
    // name shares NO distinctive token ("AP Systems" -> "Altenergy Power System Inc.")
    // remain the job of the curated alias table, which is why both sources are consulted.
    const tokens = String(make ?? "").toLowerCase().split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 5 && !CEC_GENERIC_MAKE_WORDS.has(t))
      .map((t) => t);
    for (const row of rows) {
      const c = compact(row.manufacturer);
      if (c.length < 4) continue;
      const whole = c.includes(want) || want.includes(c);
      const byToken = !whole && tokens.some((t) => c.includes(t));
      if (whole || byToken) {
        out.push(row.manufacturer);
        if (out.length >= 5) break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

// In-memory inverter-spec cache so llm.ts stays DB-free (import direction:
// llm → cecEquipment only). Primed at startup and after each successful sync.
let inverterCache: Map<string, { manufacturer: string; model: string; powerW: number | null; outputCurrentA: number | null }> | null = null;
// Module cache for the same reason: the parser resolves a missing/unsure moduleMake from
// the model string ("Q.TRON BLK M-G2.C1+/AC" is listed under Hanwha Q CELLS) without a DB.
let moduleCache: Array<{ manufacturer: string; model: string; key: string }> | null = null;

export function primeCecCache(db: AppDb): void {
  try {
    const rows = db.query<{ manufacturer: string; model: string; power_w: number | null; output_current_a: number | null }>(
      "SELECT manufacturer, model, power_w, output_current_a FROM cec_equipment WHERE kind = 'inverter'",
    );
    const map = new Map<string, { manufacturer: string; model: string; powerW: number | null; outputCurrentA: number | null }>();
    for (const r of rows) {
      map.set(compact(r.model), {
        manufacturer: r.manufacturer,
        model: r.model,
        powerW: r.power_w == null ? null : Number(r.power_w),
        outputCurrentA: r.output_current_a == null ? null : Number(r.output_current_a),
      });
    }
    inverterCache = map;
  } catch {
    inverterCache = null;
  }
  try {
    const rows = db.query<{ manufacturer: string; model: string }>("SELECT manufacturer, model FROM cec_equipment WHERE kind = 'module'");
    moduleCache = rows.map((r) => ({ manufacturer: r.manufacturer, model: r.model, key: compact(r.model) }));
  } catch {
    moduleCache = null;
  }
}

/**
 * The manufacturer the CEC list files a MODULE model under — or null. Used by the parser
 * to resolve a make the plan set never printed ("(26) Q.TRON BLK M-G2.C1+/AC - 430W").
 * Exact (punctuation-insensitive) first; otherwise the listing must START with the model at
 * a token boundary; a hit counts only when every matching listing agrees on ONE manufacturer
 * (a shared prefix across two makers is not an answer). Never guesses: null on ambiguity.
 */
export function lookupCecModuleMake(model: string): { manufacturer: string; listedModel: string } | null {
  if (!moduleCache || !moduleCache.length) return null;
  const want = compact(model);
  if (want.length < 4) return null;
  const wantNorm = String(model ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  let pool = moduleCache.filter((m) => m.key === want);
  if (!pool.length) {
    pool = moduleCache.filter((m) => {
      const t = m.model.toLowerCase().replace(/\s+/g, " ").trim();
      if (!t.startsWith(wantNorm)) return false;
      const next = t.charAt(wantNorm.length);
      return !next || !/[a-z0-9]/.test(next);
    });
  }
  const makers = [...new Set(pool.map((m) => m.manufacturer))];
  if (makers.length !== 1) return null;
  return { manufacturer: makers[0], listedModel: pool[0].model };
}

/** Offline inverter lookup from the primed CEC cache. null when unprimed/empty/miss. */
export function lookupCecInverter(model: string): { manufacturer: string; model: string; powerW: number | null; outputCurrentA: number | null } | null {
  if (!inverterCache || !inverterCache.size) return null;
  const want = compact(model);
  if (want.length < 3) return null;
  const exact = inverterCache.get(want);
  if (exact) return exact;
  for (const [key, val] of inverterCache) {
    if (key.length >= 4 && (key.includes(want) || want.includes(key))) return val;
  }
  return null;
}

/**
 * The model string a PORTAL will actually list, for a plan-set model.
 *
 * Utility portals load their equipment dropdowns from the CEC list, whose model strings
 * carry suffixes a plan set does not. Measured against the synced list:
 *   plan set "Q.MI.349B-G1"            CEC "Q.MI.349B-G1 {240V}"
 *   plan set "ZXM7-SH108-410M"         CEC "ZXM7-SH108-410/M"
 *   plan set "DS3-L"                   CEC "DS3-L {240V}"  AND  "DS3-LV {120V}"
 *   plan set "Q.TRON BLK M-G2.C1+/AC"  CEC ...415 / 420 / 425 / 430 / 435 / 440
 *
 * Resolving this HERE rather than in the browser is what makes it work on every portal
 * shape: PowerClerk renders a native <select> on one page and a Vue combobox <input> on
 * another, and the combobox has no <option> elements to read, so a page-side matcher
 * silently gives up exactly where the equipment matters most.
 *
 * Rules, in order — the same ones a person would use:
 *   1. exact, including punctuation-insensitively ("410M" vs "410/M");
 *   2. otherwise the listing must START with the model at a TOKEN BOUNDARY, so "DS3-L"
 *      can never resolve to "DS3-LV";
 *   3. among several, the project's WATTAGE decides — it is the only thing separating the
 *      six Q.TRON options.
 * Returns "" when the choice stays ambiguous: filing the wrong module beats nothing.
 */
/**
 * True when `a` and `b` differ by exactly one INSERTED/DELETED LETTER.
 * Substitutions are deliberately excluded: at distance 1 they turn a trailing
 * revision letter into a different SKU ("…-440/M" vs "…-440/N").
 */
function oneLetterIndel(a: string, b: string): boolean {
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (long.length - short.length !== 1) return false;
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  if (!/[a-z]/.test(long[i] ?? "")) return false; // the extra character must be a letter
  return short.slice(i) === long.slice(i + 1);
}

export function certifiedModelFor(
  db: AppDb,
  kind: CecKind,
  make: string,
  model: string,
  watts?: string | number | null,
): string {
  const want = String(model ?? "").trim();
  if (!want) return "";
  const wantNorm = want.toLowerCase().replace(/\s+/g, " ").trim();
  const wantBare = wantNorm.replace(/[^a-z0-9]/g, "");
  if (wantBare.length < 3) return "";
  try {
    // Scope to the manufacturer when we can name it — two makes can ship models whose
    // strings collide, and the make is already resolved by the time this is asked.
    const makers = make ? certifiedNamesForMake(db, kind, make) : [];
    const rows = makers.length
      ? db.query<{ model: string; power_w: number | null }>(
        `SELECT model, power_w FROM cec_equipment WHERE kind = ? AND manufacturer IN (${makers.map(() => "?").join(",")})`,
        [kind, ...makers],
      )
      : db.query<{ model: string; power_w: number | null }>("SELECT model, power_w FROM cec_equipment WHERE kind = ?", [kind]);

    const boundary: string[] = [];
    const indel: string[] = [];
    const w = String(watts ?? "").replace(/[^0-9]/g, "");
    for (const row of rows) {
      const listed = String(row.model ?? "");
      const t = listed.toLowerCase().replace(/\s+/g, " ").trim();
      if (!t) continue;
      const tBare = t.replace(/[^a-z0-9]/g, "");
      if (t === wantNorm || tBare === wantBare) return listed; // exact
      if (t.startsWith(wantNorm)) {
        const next = t.charAt(wantNorm.length);
        if (!next || !/[a-z0-9]/.test(next)) boundary.push(listed);
      }
      // Plan sets drop or double a series letter ("ZXM7-UHLD108-440/N" for the
      // listed "ZXM7-UHLDD108-440/N"). Only a one-LETTER insert/delete counts,
      // and only when the listed wattage matches what the plan set states — a
      // digit edit would silently swap 440W for 445W, or 108 cells for 109.
      if (w && Number(row.power_w ?? 0) === Number(w) && oneLetterIndel(wantBare, tBare)) indel.push(listed);
    }
    if (boundary.length === 1) return boundary[0];
    if (boundary.length > 1 && w) {
      const byWatts = boundary.filter((b) => b.replace(/[^0-9]/g, "").includes(w));
      if (byWatts.length === 1) return byWatts[0];
    }
    // Fires only when nothing above matched and exactly one listing is a
    // one-letter edit away. Ambiguity means we say nothing, not "probably this".
    if (!boundary.length && wantBare.length >= 8 && indel.length === 1) return indel[0];
    return "";
  } catch {
    return "";
  }
}

/**
 * IS THIS MODEL ON THE CEC LIST, AND UNDER WHAT NAME — the one answer for the advisory QC check and
 * the portal fill (dry-run 2026-09-28 B15: QC wrote "module … was not found … portals may reject it"
 * for a plan-set "ZXM7-UHLD108-440/N" while the NEM fill in the same session resolved and filed it as
 * the listed "ZXM7-UHLDD108-440/N" — two matchers answering one question). certifiedModelFor (the
 * fill's own lookup, make-scoped, wattage-checked one-letter repair) is asked FIRST; its certified
 * name is returned so the caller can say which name the portal will see. Only when it gives no single
 * answer ("" — nothing matched, OR several listings fit) does the older containment test decide
 * `listed`, with no certified name (never "probably this one").
 */
export function cecListing(
  db: AppDb,
  kind: CecKind,
  model: string,
  make = "",
  watts?: string | number | null,
): { listed: boolean; certifiedName: string } {
  const certifiedName = certifiedModelFor(db, kind, make, model, watts);
  if (certifiedName) return { listed: true, certifiedName };
  return { listed: listedByContainment(db, kind, model), certifiedName: "" };
}

/**
 * THE JOB'S INVERTER, AS THE CEC CHECKS READ IT: the string inverter's model, else the microinverter's,
 * with the make that goes with it. One reading for QC's listing row, its UL 1741 SB row and the gate.
 */
export function jobInverterForCec(snapshot: Record<string, unknown> | null | undefined): { model: string; make: string } {
  const s = (k: string): string => String(snapshot?.[k] ?? "").trim();
  const micro = !s("invModel") && Boolean(s("pvMicroModel"));
  return {
    model: s("invModel") || s("pvMicroModel"),
    make: micro ? s("pvMicroMake") : s("invMake") || s("inverterManufacturer"),
  };
}

export interface CecUl1741SbAnswer {
  /** True only when EVERY CEC listing the model can be prints "Y"; false only when every one prints "N". */
  certified: boolean;
  /** The listings the answer was read from (several when the plan set names a model without its suffix). */
  listedModels: string[];
  /** The certifying entity, when every listing names the same one; else "". */
  certifiedBy: string;
  /** When the list was last synced into this database (the newest row's synced_at). */
  syncedAt: string;
  /** Where the list comes from: the CEC's own download (a government host). */
  sourceUrl: string;
}

/**
 * VERIFY FIRST (owner, 2026-11-13: "verify first, then verify prior to warning"): does the CEC's own
 * inverter list say this model is UL 1741 SB certified? The CEC (energy.ca.gov) publishes a Y/N per
 * listing; utilities that ask for "UL 1741 SB listing" are asking exactly this, and the weekly sync
 * already downloads it. An official, government-published answer, read from the list's bytes, never
 * from a model.
 *
 * WHICH LISTINGS: the same rules as certifiedModelFor, without its guesses. Exact (punctuation-
 * insensitive) wins alone; otherwise every listing that STARTS with the model at a token boundary
 * ("IQ8M" -> "IQ8M-72-2-US {240V}" and "IQ8M-72-M-US {208V}", never "IQ8MC-…"), scoped to the make when
 * the make names CEC manufacturers. The answer counts only when every one of them agrees, so a model
 * string that could be two SKUs with different answers answers nothing. A row synced before this column
 * was read carries no flag: no answer (null), and the job is checked exactly as before.
 */
export function cecUl1741SbListing(db: AppDb, model: string, make = ""): CecUl1741SbAnswer | null {
  const want = String(model ?? "").trim();
  if (!want) return null;
  const wantNorm = want.toLowerCase().replace(/\s+/g, " ").trim();
  const wantBare = wantNorm.replace(/[^a-z0-9]/g, "");
  if (wantBare.length < 3) return null;
  // Official only from the list's own (government) host, by the one shared predicate: a mirror set in
  // CEC_INVERTERS_URL is not the CEC, and its answer verifies nothing.
  const sourceUrl = cecUrl("inverter");
  if (!isOfficialSourceHost(sourceUrl)) return null;
  try {
    const makers = make ? certifiedNamesForMake(db, "inverter", make) : [];
    type Row = { model: string; raw_json: string; synced_at: string };
    const rows = makers.length
      ? db.query<Row>(
        `SELECT model, raw_json, synced_at FROM cec_equipment WHERE kind = 'inverter' AND manufacturer IN (${makers.map(() => "?").join(",")})`,
        makers,
      )
      : db.query<Row>("SELECT model, raw_json, synced_at FROM cec_equipment WHERE kind = 'inverter'");
    const exact: Row[] = [];
    const boundary: Row[] = [];
    for (const row of rows) {
      const t = String(row.model ?? "").toLowerCase().replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (t === wantNorm || t.replace(/[^a-z0-9]/g, "") === wantBare) { exact.push(row); continue; }
      if (t.startsWith(wantNorm)) {
        const next = t.charAt(wantNorm.length);
        if (!next || !/[a-z0-9]/.test(next)) boundary.push(row);
      }
    }
    const pool = exact.length ? exact : boundary;
    if (!pool.length) return null;
    const flags = pool.map((r) => {
      try {
        const raw = JSON.parse(String(r.raw_json || "{}")) as { ul1741sb?: string; ul1741sbBy?: string };
        return { sb: raw.ul1741sb === "Y" || raw.ul1741sb === "N" ? raw.ul1741sb : "", by: String(raw.ul1741sbBy ?? "").trim() };
      } catch {
        return { sb: "", by: "" };
      }
    });
    if (flags.some((f) => !f.sb)) return null;
    const allY = flags.every((f) => f.sb === "Y");
    const allN = flags.every((f) => f.sb === "N");
    if (!allY && !allN) return null;
    const bys = [...new Set(flags.map((f) => f.by).filter(Boolean))];
    return {
      certified: allY,
      listedModels: pool.map((r) => r.model),
      certifiedBy: allY && bys.length === 1 ? bys[0] : "",
      syncedAt: pool.map((r) => String(r.synced_at ?? "")).sort().pop() || "",
      sourceUrl,
    };
  } catch {
    return null;
  }
}

/**
 * THE UTILITY'S "USE THE REQUIRED SETTINGS" ITEM, ANSWERED (owner, 2026-11-13: "assume yes for inverter
 * settings, or even better the spec sheet … or look it up"): the CEC's own list says the inverter is
 * UL 1741 SB certified (it can take a utility's required profile) AND the operator's standing answer
 * says installs are commissioned with the utility's settings. Both, or nothing: an inverter the list
 * does not certify still asks a person.
 */
export function inverterSettingsByStandingAnswer(answer: CecUl1741SbAnswer | null): boolean {
  return answer?.certified === true && operatorPolicyAnswer("utilitySettingsCommissioned") === "Yes";
}

/** The job's inverter against the CEC list's UL 1741 SB column (jobInverterForCec + cecUl1741SbListing). */
export function jobInverterUl1741Sb(db: AppDb, snapshot: Record<string, unknown> | null | undefined): CecUl1741SbAnswer | null {
  const { model, make } = jobInverterForCec(snapshot);
  return model ? cecUl1741SbListing(db, model, make) : null;
}

/** Is a model on the CEC list? (cecListing — the one answer; make and wattage sharpen it.) */
export function isCecListed(db: AppDb, kind: CecKind, model: string, make = "", watts?: string | number | null): boolean {
  return cecListing(db, kind, model, make, watts).listed;
}

/** The older test: one compacted model string contains the other. Only cecListing's fallback. */
function listedByContainment(db: AppDb, kind: CecKind, model: string): boolean {
  const want = compact(model);
  if (want.length < 3) return false;
  try {
    const rows = db.query<{ model: string }>("SELECT model FROM cec_equipment WHERE kind = ?", [kind]);
    return rows.some((r) => {
      const c = compact(r.model);
      return c === want || (Math.min(c.length, want.length) >= 4 && (c.includes(want) || want.includes(c)));
    });
  } catch {
    return false;
  }
}

export function cecTableCount(db: AppDb, kind?: CecKind): number {
  try {
    const row = kind
      ? db.get<{ n: number }>("SELECT COUNT(*) n FROM cec_equipment WHERE kind = ?", [kind])
      : db.get<{ n: number }>("SELECT COUNT(*) n FROM cec_equipment");
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

// Weekly scheduler — clone of startAhjFormRefreshScheduler's shape (env-gated
// day-tick with the 32-bit setInterval-overflow guard). CEC_SYNC_DAYS default 7;
// <= 0 disables.
export function startCecSyncScheduler(db: AppDb): void {
  const days = Number(process.env.CEC_SYNC_DAYS ?? 7);
  if (!Number.isFinite(days) || days <= 0) {
    logger.info("cec-sync", "CEC equipment sync scheduler disabled (CEC_SYNC_DAYS <= 0).");
    return;
  }
  logger.info("cec-sync", `CEC equipment sync scheduler started — refreshing listings every ${days} day(s).`);
  // Clock persisted in scheduler_state — restarts resume it rather than resetting it.
  startPersistentSchedule(db, {
    task: "cec_sync",
    days,
    scope: "cec-sync",
    tick: async () => {
      const summary = await syncCecEquipment(db);
      logger.info("cec-sync", `CEC sync: ${summary.modules} module(s), ${summary.inverters} inverter(s)${summary.skipped.length ? `; skipped: ${summary.skipped.join(" | ")}` : ""}.`);
    },
  });
}
