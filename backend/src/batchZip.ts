import fs from "node:fs";
import path from "node:path";
import { backendDataDir } from "./statePaths";
import AdmZip from "adm-zip";
import { AUTH_ENABLED } from "./auth";

// Where uploaded zips get extracted before the folder scan runs.
const UPLOAD_ROOT = process.env.BATCH_UPLOAD_DIR ? path.resolve(process.env.BATCH_UPLOAD_DIR) : path.join(backendDataDir(), "batch-uploads");

export interface ExtractedZip {
  folderPath: string;
  pdfCount: number;
  totalEntries: number;
}

// EACH ORG EXTRACTS UNDER ITS OWN ROOT (#276). One shared root let a tenant point
// /api/batch-import/scan at another tenant's extracted zip (or the root itself) and read
// its project-document paths back through its own, correctly scoped, job list. The org id
// is sanitized like the label so it can never climb out of UPLOAD_ROOT.
export function batchUploadRoot(orgId: string): string {
  const safeOrg = orgId.replace(/[^a-z0-9._-]+/gi, "_").replace(/^\.+/, "_").slice(0, 80) || "_";
  return path.join(UPLOAD_ROOT, safeOrg);
}

// True when `folder` lies strictly INSIDE `root`, judged on resolved paths (and on real
// paths where they exist, so a symlink or `..` cannot step out). The root itself does not
// count: scanning it would read every upload at once.
export function folderWithinRoot(folder: string, root: string): boolean {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(folder).startsWith(real(root) + path.sep);
}

// THE ONE ANSWER to "may this caller scan this server folder?" (#276), asked at every door
// that enqueues a folder_scan (/api/batch-import/scan, POST /api/jobs) and again by the job
// worker. The job is stamped with the caller's org, so whatever the folder holds comes back
// through that org's job list. The operator (superadmin, or local single-operator use with
// auth off) may scan any folder; everyone else only inside their own org's upload root.
export function mayScanFolder(scope: { orgId: string; crossOrg: boolean }, folder: string): boolean {
  if (!AUTH_ENABLED || scope.crossOrg) return true;
  return folderWithinRoot(folder, batchUploadRoot(scope.orgId));
}

/**
 * Build a folder_scan job payload FROM THE SERVER'S OWN VIEW of the caller, or null when the
 * caller may not scan that folder (the doors answer null with the same 404 as a missing
 * folder, and queue nothing). Every field is rebuilt, never copied, so a body sent to POST
 * /api/jobs cannot carry `scanAs` in: the worker trusts that marker to skip re-confinement.
 */
export function folderScanPayload(
  scope: { orgId: string; crossOrg: boolean },
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  const folderPath = typeof body.folderPath === "string" ? body.folderPath : "";
  if (!folderPath || !mayScanFolder(scope, folderPath)) return null;
  const opt = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    folderPath,
    defaultState: opt(body.defaultState),
    defaultAhj: opt(body.defaultAhj),
    defaultUtility: opt(body.defaultUtility),
    useLlm: body.useLlm === true || body.useLlm === "true",
    scanAs: !AUTH_ENABLED || scope.crossOrg ? "operator" : "org",
  };
}

/** The worker's re-check: anything not enqueued as the operator stays inside the job's org root. */
export function folderScanJobAllowed(payload: Record<string, unknown>, jobOrgId: string): boolean {
  if (payload.scanAs === "operator") return true;
  return folderWithinRoot(String(payload.folderPath || ""), batchUploadRoot(jobOrgId));
}

/** The names in a zip that this file system cannot store, and what they became on disk (#119). */
export const ZIP_NAMES_MANIFEST = ".job-drop-names.json";

// Windows refuses < > : " | ? * and control characters in a name, a trailing dot or space, and the
// device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9). Applied on every platform so a drop extracts
// the same way wherever it lands.
const UNSTORABLE = /[<>:"|?*\u0000-\u001f]/g;
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** A zip path segment as this file system can store it; the segment itself when it already can. */
export function safeZipSegment(name: string): string {
  let out = name.replace(UNSTORABLE, "_").replace(/[. ]+$/, "");
  if (DEVICE_NAME.test(out)) out = `_${out}`;
  return out || "_";
}

// Extract a zip buffer into a fresh working folder under the org's own root and report
// how many PDFs it contains. The folder scanner walks this directory recursively afterward.
// A segment the file system cannot store (a Mac-made folder "Smith: 123 Main St", a name with
// `<`) is written under a safe name and the original is kept in ZIP_NAMES_MANIFEST at the
// folder's root, so the person still sees the name they gave it. One bad name used to throw
// and fail the WHOLE upload on Windows (#119).
export function extractZipToWorkdir(zipBuffer: Buffer, label: string, orgId: string): ExtractedZip {
  const root = batchUploadRoot(orgId);
  fs.mkdirSync(root, { recursive: true });
  const safeLabel = label.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 40) || "upload";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const folderPath = path.join(root, `${safeLabel}-${stamp}`);
  fs.mkdirSync(folderPath, { recursive: true });

  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  let pdfCount = 0;
  // original segment -> on-disk segment, per parent folder (two originals that clean to the same
  // name get distinct names); on-disk relative path -> original segment, for the manifest.
  const taken = new Map<string, Map<string, string>>();
  const renamed: Record<string, string> = {};
  const segmentOnDisk = (parent: string, original: string): string => {
    const siblings = taken.get(parent) ?? new Map<string, string>();
    taken.set(parent, siblings);
    const known = siblings.get(original);
    if (known) return known;
    const base = safeZipSegment(original);
    const used = new Set(siblings.values());
    let candidate = base;
    for (let n = 2; used.has(candidate); n++) candidate = `${base}~${n}`;
    siblings.set(original, candidate);
    if (candidate !== original) renamed[parent ? `${parent}/${candidate}` : candidate] = original;
    return candidate;
  };
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const parts = entry.entryName.split(/[\\/]+/).filter(Boolean);
    const onDisk: string[] = [];
    for (const part of parts) {
      // `..` and `.` keep their meaning so the zip-slip guard below still sees them.
      onDisk.push(part === ".." || part === "." ? part : segmentOnDisk(onDisk.join("/"), part));
    }
    // Guard against zip-slip: resolve and confirm the target stays inside folderPath.
    const target = path.join(folderPath, ...onDisk);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(folderPath) + path.sep)) continue;
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, entry.getData());
    if (/\.pdf$/i.test(entry.entryName)) pdfCount++;
  }
  if (Object.keys(renamed).length) fs.writeFileSync(path.join(folderPath, ZIP_NAMES_MANIFEST), JSON.stringify(renamed, null, 2));
  return { folderPath, pdfCount, totalEntries: entries.length };
}

/** The names a drop's folders and files were given in the zip, by on-disk path relative to
 *  `folderPath` (posix separators); empty when nothing was renamed or the folder is not an upload. */
export function zipNamesManifest(folderPath: string): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(folderPath, ZIP_NAMES_MANIFEST), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    return out;
  } catch { return {}; }
}
