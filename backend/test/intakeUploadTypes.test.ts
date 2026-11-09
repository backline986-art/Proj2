// WHAT THE INTAKE PAGE OFFERS, THE DOCUMENTS ROUTE TAKES, AND ONE REFUSAL NEVER DROPS THE REST (#311).
//
// Live intake: parser.html's bill and meter-photo pickers said `accept="…image/*…"`, the vision
// pass read a .webp bill fine, and on Save `POST /api/projects/:id/documents?docType=utility_bill`
// refused it with 415 because the route's photo list ended at HEIC. `uploadIntakeDocs` awaited each
// upload in a bare `for` loop, so that one 415 also dropped the meter photo and the stamped
// structural letter after it; the gate then blocked on a "missing" letter the operator had given.
//
// Pinned here:
//   1. a .webp is sniffed as a photo and a photo slot takes it;
//   2. every picker on the intake page carries exactly uploadAcceptFor(slot), the same sets the
//      route refuses by, and every format a photo picker offers attaches through the route;
//   3. the page's own save path (uploadIntakeDoc / uploadIntakeDocs / intakeUploadWarning, lifted out
//      of parser.html and run in a vm against the real saveProjectDocument) attaches a .webp bill and
//      a structural letter, and a 415 on one file still attaches the others and names the refused one.
//
// Synthetic bytes and synthetic names only. PARSER_HTML_PATH points it at a mutated copy for kill runs.
import "./_isolate";
import { REPO } from "./_isolate";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { PDFDocument } from "pdf-lib";

process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { createProject } = await import("../src/repository");
const { saveProjectDocument, listProjectDocuments, uploadAcceptFor } = await import("../src/projectDocuments");
const { sniffFileKind, isImageKind, describeKind, PHOTO_OR_PDF_ACCEPT, PDF_ACCEPT } = await import("../src/fileTypes");
const { HttpError } = await import("../src/httpError");

const db = await openDatabase();

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) console.log(`ok   - ${label}`);
  else { failures++; console.error(`FAIL - ${label}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`); }
};

// Synthetic files, by magic bytes.
const pdf = Buffer.from(await (await PDFDocument.create()).save());
const pad = (head: Buffer) => Buffer.concat([head, Buffer.alloc(64)]);
const webp = pad(Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0x40, 0, 0, 0]), Buffer.from("WEBPVP8 ", "latin1")]));
const SAMPLE_BY_EXT: Record<string, Buffer> = {
  ".pdf": pdf,
  ".jpg": pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
  ".jpeg": pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
  ".png": pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ".gif": pad(Buffer.from("GIF89a", "latin1")),
  ".tif": pad(Buffer.from([0x49, 0x49, 0x2a, 0x00])),
  ".tiff": pad(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])),
  ".heic": pad(Buffer.from("\0\0\0\x18ftypheic", "latin1")),
  ".heif": pad(Buffer.from("\0\0\0\x18ftypmif1", "latin1")),
  ".webp": webp,
};
const dwg = pad(Buffer.from("AC1027", "latin1"));

const newProject = (owner: string) => createProject(db, {
  owner, street: "1 Test Way", city: "Salem", state: "OR", zip: "97301", ahj: "City of Test", utility: "PGE", dcKw: "6.4",
}).project.id;

// ── 1. A .webp is a photo ─────────────────────────────────────────────────────────────────────
console.log("\n[1] a .webp bill is a photo the photo slots take");
check("WebP bytes sniff as webp", sniffFileKind(webp) === "webp", sniffFileKind(webp));
check("webp is an image kind", isImageKind("webp"));
check("a RIFF that is not WebP (a .wav) is NOT a photo", !isImageKind(sniffFileKind(pad(Buffer.from("RIFF\x40\0\0\0WAVEfmt ", "latin1")))));
check("describeKind names it", describeKind("webp", "bill.webp") === "a WebP image");
{
  const pid = newProject("Webp Slot Test");
  for (const docType of ["utility_bill", "meter_photo"]) {
    let err = "";
    try { saveProjectDocument(db, pid, { docType, filename: "bill.webp", contentType: "image/webp", buffer: webp, source: "upload" }); }
    catch (e) { err = e instanceof Error ? e.message : String(e); }
    check(`the documents route takes a .webp as ${docType}`, err === "", err);
  }
}

// ── 2. One answer for picker and route ───────────────────────────────────────────────────────
console.log("\n[2] every intake picker offers exactly what the route takes");
const html = fs.readFileSync(process.env.PARSER_HTML_PATH || path.join(REPO, "frontend", "parser.html"), "utf8").replace(/\r\n/g, "\n");
const pickerAccept = (id: string): string | null => {
  const m = new RegExp(`<input id="${id}" type="file" accept="([^"]*)"`).exec(html);
  return m ? m[1] : null;
};
const SLOT_BY_PICKER: Record<string, string> = {
  planFile: "plan_set", ubFile: "utility_bill", meterPhotoFile: "meter_photo", structuralLetterFile: "structural_letter",
};
for (const [id, docType] of Object.entries(SLOT_BY_PICKER)) {
  const got = pickerAccept(id);
  check(`#${id} accept === uploadAcceptFor("${docType}")`, got === uploadAcceptFor(docType), { got, want: uploadAcceptFor(docType) });
  check(`#${id} never offers a bare image/* wildcard`, !/image\/\*/.test(got ?? ""), got);
}
check("photo slots get the photo-or-PDF list", uploadAcceptFor("utility_bill") === PHOTO_OR_PDF_ACCEPT && uploadAcceptFor("meter_photo") === PHOTO_OR_PDF_ACCEPT);
check("the structural letter slot gets the PDF list", uploadAcceptFor("structural_letter") === PDF_ACCEPT);
{
  const pid = newProject("Accept List Test");
  const exts = PHOTO_OR_PDF_ACCEPT.split(",").filter((t) => t.startsWith("."));
  check("the photo list includes .webp", exts.includes(".webp"), exts);
  for (const ext of exts) {
    const sample = SAMPLE_BY_EXT[ext];
    if (!sample) { check(`a sample exists for offered ${ext}`, false); continue; }
    let err = "";
    try { saveProjectDocument(db, pid, { docType: "utility_bill", filename: `bill${ext}`, contentType: "application/octet-stream", buffer: sample, source: "upload" }); }
    catch (e) { err = e instanceof Error ? e.message : String(e); }
    check(`offered ${ext} attaches as utility_bill`, err === "", err);
  }
}

// ── 3. The page's save path, against the real route logic ────────────────────────────────────
console.log("\n[3] the intake save path attaches each file or names why not");
function liftFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`parser.html does not define ${name}`);
  const asyncStart = src.lastIndexOf("async ", start) === start - 6 ? start - 6 : start;
  let i = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(asyncStart, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
const optionalLine = (re: RegExp) => html.match(re)?.[0] ?? "";
const optionalFn = (name: string) => (html.includes(`function ${name}(`) ? liftFunction(html, name) : "");
const code = [
  liftFunction(html, "uploadIntakeDoc"),
  liftFunction(html, "uploadIntakeDocs"),
  optionalLine(/^const INTAKE_DOC_LABELS = [^\n]+/m),
  optionalFn("intakeUploadWarning"),
].join("\n");

type FakeFile = { name: string; type: string; bytes: Buffer };
const file = (name: string, type: string, bytes: Buffer): FakeFile => ({ name, type, bytes });

/** A fetch that answers the two documents routes the way server.ts does: GET lists, POST runs
 *  saveProjectDocument and turns an HttpError into `{ error }` with its status. `refuse` forces a
 *  415 for one filename, standing in for any refusal the route might give. */
function routeFetch(refuse?: string) {
  const posted: string[] = [];
  const fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: FakeFile }) => {
    const u = new URL(url, "http://intake.test");
    const m = /^\/api\/projects\/([^/]+)\/documents$/.exec(u.pathname);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, statusText: String(status), json: async () => body });
    if (!init || !init.method || init.method === "GET") return reply(200, { documents: listProjectDocuments(db, m[1]) });
    const filename = u.searchParams.get("filename") || "";
    posted.push(filename);
    if (refuse && filename === refuse) return reply(415, { error: `"${filename}" was refused for this test.` });
    try {
      const saved = saveProjectDocument(db, m[1], {
        docType: u.searchParams.get("docType") || "", filename,
        contentType: init.headers?.["Content-Type"] || "application/octet-stream", buffer: init.body!.bytes, source: "upload",
      });
      return reply(201, saved);
    } catch (e) {
      if (e instanceof HttpError) return reply(e.status, { error: e.message });
      throw e;
    }
  };
  return { fetch, posted };
}

async function saveIntake(pid: string, files: Record<string, FakeFile | null>, refuse?: string) {
  const { fetch, posted } = routeFetch(refuse);
  const sandbox: Record<string, unknown> = { fetch, URL, encodeURIComponent, console, state: { planFile: null, ubFile: null, meterFile: null, structuralLetterFile: null, ...files } };
  vm.runInNewContext(`${code}\nthis.uploadIntakeDocs = uploadIntakeDocs; this.intakeUploadWarning = typeof intakeUploadWarning === "function" ? intakeUploadWarning : null;`, sandbox);
  let thrown = "";
  let result: unknown;
  try { result = await (sandbox.uploadIntakeDocs as (id: string) => Promise<unknown>)(pid); }
  catch (e) { thrown = e instanceof Error ? e.message : String(e); }
  const warn = typeof sandbox.intakeUploadWarning === "function" ? String((sandbox.intakeUploadWarning as (f: unknown) => string)(result)) : "";
  const attached = listProjectDocuments(db, pid).map((d) => `${d.docType}:${d.originalFilename}`).sort();
  return { thrown, result, warn, attached, posted };
}

const planSet = file("plan-set.pdf", "application/pdf", pdf);
const webpBill = file("utility-bill.webp", "image/webp", webp);
const meterPhoto = file("meter.jpg", "image/jpeg", SAMPLE_BY_EXT[".jpg"]);
const letter = file("stamped-structural-letter.pdf", "application/pdf", pdf);

{
  const pid = newProject("Webp Save Test");
  const r = await saveIntake(pid, { planFile: planSet, ubFile: webpBill, meterFile: meterPhoto, structuralLetterFile: letter });
  check("a .webp bill + a structural letter: the save does not throw", r.thrown === "", r.thrown);
  check("a .webp bill + a structural letter: all four attach", JSON.stringify(r.attached) === JSON.stringify([
    "meter_photo:meter.jpg", "plan_set:plan-set.pdf", "structural_letter:stamped-structural-letter.pdf", "utility_bill:utility-bill.webp",
  ]), r.attached);
  check("nothing is reported as failed", Array.isArray(r.result) && (r.result as unknown[]).length === 0 && r.warn === "", { result: r.result, warn: r.warn });
}
{
  // A forced 415 on the FIRST file (the plan set): everything after it still goes.
  const pid = newProject("Forced Refusal Test");
  const r = await saveIntake(pid, { planFile: planSet, ubFile: webpBill, meterFile: meterPhoto, structuralLetterFile: letter }, "plan-set.pdf");
  check("forced 415 on the plan set: the save does not throw", r.thrown === "", r.thrown);
  check("forced 415 on the plan set: bill, meter photo and letter still attach", JSON.stringify(r.attached) === JSON.stringify([
    "meter_photo:meter.jpg", "structural_letter:stamped-structural-letter.pdf", "utility_bill:utility-bill.webp",
  ]), r.attached);
  check("forced 415 on the plan set: every file was tried", r.posted.length === 4, r.posted);
  check("the status names the refused file and the route's reason", /plan set "plan-set\.pdf": "plan-set\.pdf" was refused for this test\./.test(r.warn) && /1 document\(s\) did NOT attach/.test(r.warn), r.warn);
}
{
  // A REAL refusal from the route (a CAD drawing sent as the bill): the reason the operator sees
  // is the route's own sentence, and the letter after it attaches.
  const pid = newProject("Real Refusal Test");
  const r = await saveIntake(pid, { ubFile: file("bill.dwg", "application/acad", dwg), structuralLetterFile: letter });
  check("a refused bill does not drop the structural letter", JSON.stringify(r.attached) === JSON.stringify(["structural_letter:stamped-structural-letter.pdf"]), r.attached);
  check("the status carries the route's own reason by name", /utility bill "bill\.dwg": "bill\.dwg" is a CAD drawing/.test(r.warn), r.warn);
}
{
  // Re-saving skips files already on the project and reports nothing.
  const pid = newProject("Resave Test");
  await saveIntake(pid, { ubFile: webpBill });
  const r = await saveIntake(pid, { ubFile: webpBill });
  check("a re-save does not post an already-attached file again", r.posted.length === 0 && r.warn === "", r);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nintakeUploadTypes: all checks passed");
