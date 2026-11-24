// ---------------------------------------------------------------------------------------------
// PAGE CAPTURE EXPORT — the staff step that turns a portal's local page captures into one zip a
// person can hand to a reviewer (pageCapture.ts writes them during local runs).
//
//   npm run portal:pages:export -- --list
//   npm run portal:pages:export -- --portal bend [--since 2026-11-01] [--out data/page-exports] [--no-pictures]
//
// THIS IS A MODEL-BOUND OUTPUT (hard rule 2). The zip exists to be handed to a reviewer in the cloud,
// which is a model, so it is held to the model door's own test: every text it writes must come back
// from the shared scan (backend/src/modelPayloadScan.ts scanText, the secret-shaped patterns) with
// nothing found, or that page is left out. pageCapture.test.ts pins it, and pins the snapshot's
// fields, so a later field that carries values fails a test.
//
// What goes in, and only this:
//   - a picture only when its snapshot says it was taken through the secret mask on a page that
//     passed the tripwire (shot.masked and shot.tripwire "clear"); any other page goes in as text
//     only, with the reason;
//   - every snapshot re-scrubbed on the way out (the model door's patterns, then redactCaptureText:
//     digit runs of 6+, emails), so a capture written by an older build or edited by hand cannot
//     carry a raw id out;
//   - a README listing the pages in the order they were captured.
// Nothing else under data/ is read, nothing is sent anywhere: the zip is written locally and a
// person decides where it goes. Account, meter and password boxes are painted over in the pictures;
// a picture can still show the job's homeowner name and address, so share it as you would the
// review screenshot.
// ---------------------------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import AdmZip from "adm-zip";
import { runDataDir } from "../../backend/src/statePaths";
import { scanText } from "../../backend/src/modelPayloadScan";
import { deepMapStrings, pageCapturesDir, scrubCaptureText } from "./pageCapture";

export interface ExportedPage {
  n: number;
  file: string;
  heading: string;
  url: string;
  capturedAt: string;
  kind: string;
  picture: boolean;
  noPictureWhy: string;
}

export interface ExportResult {
  portal: string;
  zip: string;
  pages: ExportedPage[];
}

/** The portals that have captures, with their page counts. */
export function listCapturedPortals(base = pageCapturesDir()): Array<{ portal: string; pages: number }> {
  try {
    return fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
      let pages = 0;
      try { pages = fs.readdirSync(path.join(base, d.name, "pages")).filter((f) => f.endsWith(".json")).length; } catch { pages = 0; }
      return { portal: d.name, pages };
    }).filter((p) => p.pages > 0).sort((a, b) => a.portal.localeCompare(b.portal));
  } catch {
    return [];
  }
}

const slugOf = (t: string): string => String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";
const keepKeys = new Set(["fp", "capturedAt", "runId"]);

/** Re-scrub one snapshot for sharing: every string the page supplied through the model door's
 *  patterns and redactCaptureText (scrubCaptureText with no known secret: none is stored). */
export function scrubForExport(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) out[k] = keepKeys.has(k) ? v : deepMapStrings(v, (s) => scrubCaptureText(s, []));
  return out;
}

/** The model door's question, asked of a text about to leave: what secret-shaped values does it
 *  still hold? (Kinds only, never the values.) Empty = it may go. */
export function exportTextLeaks(text: string): string[] {
  const hits = new Map<never, number>();
  scanText(String(text ?? ""), [], new Set<never>(), hits);
  return Array.from(hits.keys()).map(String).sort();
}

/** Build the zip for every portal folder whose name contains `portal`. Throws only on a bad call. */
export function exportPageCaptures(opts: { portal: string; since?: string; out?: string; pictures?: boolean; base?: string; now?: Date }): ExportResult[] {
  const want = String(opts.portal ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!want) throw new Error("Name the portal: --portal <part of its name> (see --list).");
  const base = opts.base ?? pageCapturesDir();
  const since = opts.since ? Date.parse(opts.since) : NaN;
  const outDir = path.resolve(opts.out ?? path.join(runDataDir(), "page-exports"));
  const stamp = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const results: ExportResult[] = [];
  for (const { portal } of listCapturedPortals(base).filter((p) => p.portal.includes(want))) {
    const pagesDir = path.join(base, portal, "pages");
    const records: Array<Record<string, unknown>> = [];
    for (const f of fs.readdirSync(pagesDir).filter((x) => x.endsWith(".json"))) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(pagesDir, f), "utf8")) as Record<string, unknown>;
        if (!r || typeof r !== "object" || typeof r.fp !== "string" || !/^[0-9a-f]{16}$/.test(r.fp)) continue;
        if (Number.isFinite(since) && !(Date.parse(String(r.capturedAt)) >= since)) continue;
        records.push(r);
      } catch { /* an unreadable snapshot is left out */ }
    }
    records.sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
    const zip = new AdmZip();
    const pages: ExportedPage[] = [];
    let n = 0;
    for (const raw of records) {
      const r = scrubForExport(raw);
      const json = JSON.stringify(r, null, 1);
      // FAIL CLOSED: a snapshot the model door would still find something in does not go at all.
      if (exportTextLeaks(json).length) continue;
      n++;
      const shot = (raw.shot ?? {}) as { masked?: unknown; tripwire?: unknown; refused?: unknown };
      const heading = String((Array.isArray(r.headings) ? r.headings[0] : "") || r.title || "page");
      const file = `${String(n).padStart(2, "0")}-${slugOf(heading)}`;
      const png = path.join(pagesDir, `${raw.fp}.png`);
      const vetted = shot.masked === true && shot.tripwire === "clear";
      const picture = opts.pictures !== false && vetted && fs.existsSync(png);
      const noPictureWhy = picture ? "" : opts.pictures === false ? "left out (--no-pictures)"
        : !vetted ? scrubCaptureText(String(shot.refused || "not taken through the secret mask and the tripwire"), [], 300) : "the picture file is missing";
      zip.addFile(`${file}.json`, Buffer.from(json));
      if (picture) zip.addFile(`${file}.png`, fs.readFileSync(png));
      pages.push({ n, file, heading: scrubCaptureText(heading, [], 120), url: String(r.url ?? ""), capturedAt: String(raw.capturedAt ?? ""), kind: String(r.kind ?? ""), picture, noPictureWhy });
    }
    const leftOut = records.length - pages.length;
    const md = [
      `# Page captures: ${portal}`,
      "",
      `Exported ${stamp}. ${pages.length} page(s), oldest first.${leftOut ? ` ${leftOut} page(s) left out: their text still held an id-shaped value after scrubbing.` : ""} Each page has a .json snapshot (labels, buttons, trimmed markup; never a typed value) and, where the secret mask was proven, a .png picture with account, meter and password boxes painted over.`,
      "Pictures can still show the job's homeowner name and address.",
      "",
      "| # | Page | URL | Run | Captured | Picture |",
      "|---|------|-----|-----|----------|---------|",
      ...pages.map((p) => `| ${p.n} | ${p.heading.replace(/\|/g, "/")} | ${p.url.replace(/\|/g, "/")} | ${p.kind} | ${p.capturedAt} | ${p.picture ? `${p.file}.png` : `none: ${p.noPictureWhy.replace(/\|/g, "/")}`} |`),
      "",
    ].join("\n");
    zip.addFile("README.md", Buffer.from(md));
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, `page-captures-${portal}-${stamp}.zip`);
    zip.writeZip(zipPath);
    results.push({ portal, zip: zipPath, pages });
  }
  return results;
}

function arg(argv: readonly string[], name: string): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? String(argv[i + 1]) : "";
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  if (argv.includes("--list") || !arg(argv, "portal")) {
    const list = listCapturedPortals();
    if (!list.length) console.log(`No page captures yet under ${pageCapturesDir()}. They are written during local learns, recordings and replays.`);
    else for (const p of list) console.log(`  ${p.portal}  (${p.pages} page${p.pages === 1 ? "" : "s"})`);
    if (!argv.includes("--list")) console.log("\nExport one with: npm run portal:pages:export -- --portal <name>");
    return 0;
  }
  const results = exportPageCaptures({ portal: arg(argv, "portal"), since: arg(argv, "since") || undefined, out: arg(argv, "out") || undefined, pictures: !argv.includes("--no-pictures") });
  if (!results.length) { console.log(`No captured portal matches "${arg(argv, "portal")}". Try --list.`); return 1; }
  for (const r of results) {
    const pics = r.pages.filter((p) => p.picture).length;
    console.log(`${r.portal}: ${r.pages.length} page(s), ${pics} picture(s) -> ${r.zip}`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
