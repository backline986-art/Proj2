import crypto from "node:crypto";
import fs from "node:fs";
import type { ParserLlmExtraction } from "../../shared/src/types";
import { DEFAULT_ORG_ID, type AppDb } from "./db";
import { namesAcDisconnectLabel, type PlanSetImageDisconnectRead } from "./acDisconnectIntake";
import { planSetDisconnectPart } from "./baselineRules";
import { nowIso } from "./time";

// WHAT THE SERVER'S OWN IMAGE READ OF A PLAN SET SAID ABOUT ITS AC DISCONNECT (#135).
//
// A scanned plan set has no text layer. The intake reads its key sheets by vision
// (scannedPlanSet.readPlanSetForExtraction, behind POST /api/parser/plan-scan-extract — rule 2's one
// allowed read of the customer's own document) and hands the fields back to the parser page, which
// posts them on save. From then on a job's fields keep no record of where a value came from: a parse,
// a person's edit and an API body all save the same key. So for a utility whose cited list asks for an
// AC disconnect, an image-only plan set was held at the gate even when the read found the switch: the
// gate's evidence is the plan-set TEXT, and a key alone is never evidence (#133).
//
// This table is the server's own note of that read, written at the one place the read runs and keyed
// by the PDF's bytes (sha-256) and the org that posted it, because no job exists yet when a plan set
// is scanned. Later, a job of THAT org (rule 6: by its own org_id column, stamped from the session,
// never a request body) whose OWN stored plan set is those same bytes may count the note as "the plan
// set shows an AC disconnect". Nothing a client posts can write it, and no value in a job's snapshot
// stands in for it.
//
// WHAT IS KEPT, AND WHAT NEVER IS:
//   - only the AC disconnect's own plan-set fields (FIELDS below): the part, the amp rating, the
//     fusing, and "a disconnect is shown". Never another field of the read — the account, the meter, a name or an address are not
//     on the list and cannot be stored here;
//   - only a field the IMAGE read answered (listed in visionFields), from the plan set
//     (evidence.source "plan_set"), whose quoted callout names the AC disconnect's own label
//     (acDisconnectIntake.namesAcDisconnectLabel — a DC, rapid-shutdown or storage disconnect is not
//     it), and whose value has the field's shape (a part with a part number; "60A"; "fusible" /
//     "non-fusible"; "yes" / "provided" / "shown" — a bare "required" is a rule, not a switch on the
//     sheet, and is not kept);
//   - the value and the sheet it was read from. The quoted callout itself is checked and then dropped:
//     it is a model's transcription of the sheet and is not needed again.
// "Shown", never "proven": the gate's finding stays a warning for a person to check on the sheet.
// The reader below writes nothing (the "reads write nothing" invariant nextStep.test pins).

/** The AC disconnect's plan-set fields, most specific first. */
const FIELDS: ReadonlyArray<PlanSetImageDisconnectRead["field"]> = ["acDiscMakeModel", "acDiscAmps", "acDiscFused", "acDiscReq"];
type ImageReadField = PlanSetImageDisconnectRead["field"];

export function planSetPdfSha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** The field's value in its stored form; "" when it does not have the field's shape. */
function shaped(field: ImageReadField, raw: unknown): string {
  const value = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!value || value.length > 80) return "";
  if (field === "acDiscMakeModel") {
    const part = planSetDisconnectPart({ acDiscMakeModel: value });
    return part.named && part.model ? `${part.make} ${part.model}`.trim() : "";
  }
  if (field === "acDiscAmps") {
    const m = value.match(/^(\d{2,3})\s?A(?:MPS?)?$/i);
    return m ? `${m[1]}A` : "";
  }
  if (field === "acDiscReq") return /^(?:yes|provided|shown)\b/i.test(value) ? "shown" : "";
  const fused = value.toLowerCase().replace(/[\s_]+/g, "-");
  return /^non-?fus(?:ed|ible)$|^un-?fused$/.test(fused) ? "non-fusible" : /^fus(?:ed|ible)$/.test(fused) ? "fusible" : "";
}

/**
 * Note what the image read of this PDF said about its AC disconnect. Called by the plan-scan route
 * with the bytes it read and the read's own result — the only writer. Returns the fields kept.
 * A later read of the same bytes replaces the note; a read that names no AC disconnect clears it.
 */
export function recordPlanSetImageRead(db: AppDb, orgId: string, pdfBytes: Uint8Array, extraction: ParserLlmExtraction | null | undefined): ImageReadField[] {
  const org = String(orgId || DEFAULT_ORG_ID);
  const sha = planSetPdfSha256(pdfBytes);
  const fields = extraction?.fields ?? {};
  const fromImage = new Set(extraction?.visionFields ?? []);
  const mode = extraction?.planReadMode === "hybrid" ? "hybrid" : "vision";
  const kept: Array<{ field: ImageReadField; value: string; sheet: string }> = [];
  for (const field of FIELDS) {
    const entry = fields[field];
    if (!entry || !fromImage.has(field)) continue;
    if (entry.evidence?.source !== "plan_set") continue;
    if (!namesAcDisconnectLabel(entry.evidence?.excerpt)) continue;
    const value = shaped(field, entry.value);
    if (!value) continue;
    kept.push({ field, value, sheet: String(entry.evidence?.sheet ?? "").replace(/\s+/g, " ").trim().slice(0, 40) });
  }
  const at = nowIso();
  db.run("DELETE FROM plan_set_image_reads WHERE org_id = ? AND pdf_sha256 = ?", [org, sha]);
  for (const row of kept) {
    db.run(
      "INSERT INTO plan_set_image_reads (org_id, pdf_sha256, field, value, sheet, read_mode, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [org, sha, row.field, row.value, row.sheet, mode, at],
    );
  }
  return kept.map((row) => row.field);
}

// A stored plan set is hashed once per file version (path, modified time, size), not per gate read.
const shaMemo = new Map<string, string>();
function shaOfFile(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    const key = `${file}:${Math.round(stat.mtimeMs)}:${stat.size}`;
    const held = shaMemo.get(key);
    if (held) return held;
    const sha = planSetPdfSha256(fs.readFileSync(file));
    if (shaMemo.size > 500) shaMemo.clear();
    shaMemo.set(key, sha);
    return sha;
  } catch {
    return null;
  }
}

/** The job's own plan set as stored: its newest plan_set document whose file is on disk. Never
 *  another document type — the note is about a plan set, and only a plan set may claim it. */
function storedPlanSetFile(db: AppDb, projectId: string): string | null {
  const rows = db.query<{ stored_path: string | null }>(
    "SELECT stored_path FROM project_documents WHERE project_id = ? AND doc_type = 'plan_set' ORDER BY uploaded_at DESC, rowid DESC",
    [projectId],
  );
  const newest = String(rows[0]?.stored_path ?? "");
  return newest && fs.existsSync(newest) ? newest : null;
}

/**
 * THE ONE READER for "the server's image read of THIS job's plan set named an AC disconnect", asked by
 * the reviewer gate (repository.buildReviewerReportFor) and by QC (qc.ts). The job's own stored plan
 * set, hashed; the note its own org's scan left for those exact bytes, most specific field first; null when the job has no
 * plan set on file, its newest plan set is different bytes, or no such read was noted. Writes nothing.
 */
export function planSetImageDisconnectRead(db: AppDb, projectId: string): PlanSetImageDisconnectRead | null {
  const file = storedPlanSetFile(db, projectId);
  if (!file) return null;
  const sha = shaOfFile(file);
  if (!sha) return null;
  const org = String(db.query<{ org_id: string | null }>("SELECT org_id FROM projects WHERE id = ?", [projectId])[0]?.org_id || DEFAULT_ORG_ID);
  const rows = db.query<{ field: string; value: string; sheet: string; read_at: string }>(
    "SELECT field, value, sheet, read_at FROM plan_set_image_reads WHERE org_id = ? AND pdf_sha256 = ?",
    [org, sha],
  );
  for (const field of FIELDS) {
    const row = rows.find((r) => r.field === field);
    // Re-shaped on the way out: a row that no longer has the field's shape counts for nothing.
    const value = row ? shaped(field, row.value) : "";
    if (row && value) return { field, value, sheet: String(row.sheet ?? ""), readAt: String(row.read_at ?? "") };
  }
  return null;
}
