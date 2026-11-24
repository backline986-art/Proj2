// Page captures (pageCapture.ts) and their staff export (pageCaptureExport.ts): the pure parts.
// The real-browser half (the masked picture, the snapshot, the recorder's quiet gate) is
// pageCapture.dom.smoke.ts.
//
//   MUST-PASS    a page URL keeps its origin, path and short query words; a record reference or a
//                token in the query does not survive (Bend's referenceNumber=TMPPR...).
//   MUST-PASS    one page shape = one fingerprint, whatever the job (digits, case, label order).
//   MUST-EXCLUDE a known secret, however it is spaced or dashed, does not survive the scrub; a
//                password (no digits) does not either.
//   MUST-PASS    the export puts in a picture ONLY when its snapshot says it was masked; a refused
//                page goes in as text with its reason; every page string is re-scrubbed; nothing
//                outside the capture folder goes in.
//
// Kill: drop the masked check in exportPageCaptures -> the refused page's picture is exported and
// "export: refused page has no picture" fails; drop the redaction in scrubForExport -> the planted
// digit run survives and "export: snapshot re-scrubbed" fails; keep query values in
// sanitizeCaptureUrl -> the URL checks fail.
//
//   npx tsx portal-bot/src/pageCapture.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "page-capture-test-"));
process.env.PORTAL_PAGE_CAPTURE_DIR = path.join(tmp, "captures");

const { sanitizeCaptureUrl, pageFingerprint, scrubKnownSecrets, portalSlug, PageCaptureLog, secretTripwire, scrubCaptureText } = await import("./pageCapture");
const { exportPageCaptures, listCapturedPortals, scrubForExport, exportTextLeaks } = await import("./pageCaptureExport");

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

console.log("\n1. URLs");
{
  const bend = sanitizeCaptureUrl("https://cityview.ci.bend.or.us/Portal/Permit/Application?referenceNumber=TMPPR20260017175&isstep=True&isAddNewPermit=False#top");
  check("origin and path kept", bend.startsWith("https://cityview.ci.bend.or.us/Portal/Permit/Application?"), bend);
  check("short words kept", bend.includes("isstep=True") && bend.includes("isAddNewPermit=False"), bend);
  check("the record reference dropped", !bend.includes("TMPPR") && !bend.includes("20260017175") && bend.includes("referenceNumber=…"), bend);
  check("no fragment", !bend.includes("#top"), bend);
  const tok = sanitizeCaptureUrl("https://portal.example.gov/apply/7734009155/step2?session=abc123def456&token=eyJhbGciOi");
  check("a token in the query dropped", !tok.includes("abc123def456") && !tok.includes("eyJhbGciOi"), tok);
  check("a long digit run in the path masked", !tok.includes("7734009155"), tok);
  check("not a web URL: nothing kept", sanitizeCaptureUrl("javascript:alert(1)") === "javascript:…" && sanitizeCaptureUrl("") === "");
}

console.log("\n2. Fingerprints");
{
  const a = pageFingerprint({ url: "https://x.gov/apply?ref=1", headings: ["Location"], labels: ["Search for location:", "Location Type(s)"] });
  const b = pageFingerprint({ url: "https://x.gov/apply?ref=2", headings: ["location"], labels: ["Location Type(s)", "Search for location:"] });
  const c = pageFingerprint({ url: "https://x.gov/apply", headings: ["Contacts"], labels: ["Search for location:", "Location Type(s)"] });
  check("same step on two jobs: one fingerprint", a === b, `${a} ${b}`);
  check("another step at the same URL: another fingerprint", a !== c);
  check("fingerprint is 16 hex characters", /^[0-9a-f]{16}$/.test(a), a);
}

console.log("\n3. Secret scrub");
{
  const s = scrubKnownSecrets("Account: 7734-009-155 Meter 1009 9887 76 pw Hunter2Zebra! hunter2zebra! ok", ["7734009155", "1009988776", "Hunter2Zebra!", "Tr0ub4dor&3"]);
  check("account with dashes scrubbed", !/7734.?009.?155/.test(s), s);
  check("meter with spaces scrubbed", !/1009.?9887.?76/.test(s), s);
  check("password scrubbed in any case", !/hunter2zebra/i.test(s), s);
  const pw = scrubKnownSecrets("the password is CorrectHorse here", ["CorrectHorse"]);
  check("a password with no digits scrubbed", !/CorrectHorse/i.test(pw), pw);
  check("no secrets: text unchanged", scrubKnownSecrets("Account: 7734009155", []) === "Account: 7734009155");
  check("portal slug from the name", portalSlug("City of Bend") === "city-of-bend" && portalSlug("", "https://cityview.ci.bend.or.us/x") === "cityview-ci-bend-or-us");
}

console.log("\n3b. The tripwire (Helm's review of #296)");
{
  check("a meter number the run did not know trips it", secretTripwire(["Service details  Meter Number: 5550 9876 12"], []).includes("meter"));
  check("an account number on another row trips it", secretTripwire(["Other applications", "Account # 4411-220-987"], []).includes("account"));
  check("an ESI id trips it", secretTripwire(["ESI ID 10443720001234567"], []).includes("utility-id"));
  check("a written password trips it", secretTripwire(["Password: Hunter2Zebra!"], []).includes("password"));
  check("a value the run knew (and so masked) does not", secretTripwire(["Account Number: 7734 009 155"], ["7734009155"]).length === 0);
  check("a rating is not an id ('meter 200A', '240 V')", secretTripwire(["Main panel 200A, meter 200A, service 240 V"], []).length === 0);
  check("a page with no secret wording does not", secretTripwire(["Enter the location for the subject property. Tax lot 171232CA05700"], []).length === 0);
  const t = scrubCaptureText("Meter Number: 55509876 and account 4411220987 x@y.com", []);
  check("the snapshot scrub removes what the tripwire finds", !/55509876|4411220987|x@y\.com/.test(t), t);
}

console.log("\n4. Turned off");
{
  process.env.PORTAL_PAGE_CAPTURE = "0";
  check("PORTAL_PAGE_CAPTURE=0: no log", PageCaptureLog.start({ kind: "replay", portal: "x" }) === null);
  delete process.env.PORTAL_PAGE_CAPTURE;
  const log = PageCaptureLog.start({ kind: "replay", portal: "x" });
  check("on by default", !!log);
  const r = await log!.capture(null, "p1");
  check("no page: skipped, nothing thrown", r.status === "skipped");
  const fake = await log!.capture({ url: () => "about:blank" } as never, "p1");
  check("a test fake without frames(): skipped", fake.status === "skipped");
}

console.log("\n5. Export");
{
  const pages = path.join(process.env.PORTAL_PAGE_CAPTURE_DIR!, "city-of-bend", "pages");
  fs.mkdirSync(pages, { recursive: true });
  const okFp = "0123456789abcdef";
  const badFp = "fedcba9876543210";
  const rec = (fp: string, at: string, heading: string, shot: Record<string, unknown>, extra = ""): Record<string, unknown> => ({
    fp, portal: "City of Bend", kind: "record", runId: "2026-11-24T16-00-00-record-abc123", reason: "page loaded", capturedAt: at,
    url: "https://cityview.ci.bend.or.us/Portal/Permit/Application?referenceNumber=…", title: "Permit Application | City of Bend",
    headings: [heading], shot,
    frames: [{ url: "", title: "", headings: [heading], text: `Enter the location ${extra}`, controls: [{ tag: "input", type: "text", label: "Search for location:", name: "", id: "", required: false, visible: true, disabled: false, secret: false }], actions: ["CAN'T FIND ADDRESS?"], html: "<html></html>" }],
  });
  fs.writeFileSync(path.join(pages, `${okFp}.json`), JSON.stringify(rec(okFp, "2026-11-24T16:00:00.000Z", "Location", { file: `${okFp}.png`, masked: true, tripwire: "clear", secretsMasked: 1 }, "acct 5550001111 x@y.com")));
  fs.writeFileSync(path.join(pages, `${okFp}.png`), Buffer.from("PNGOK"));
  fs.writeFileSync(path.join(pages, `${badFp}.json`), JSON.stringify(rec(badFp, "2026-11-24T16:05:00.000Z", "Contacts", { file: "", masked: false, refused: "the page holds 1 closed shadow root(s)" })));
  // A picture beside the refused page (an old build, a hand copy): must NOT be exported.
  fs.writeFileSync(path.join(pages, `${badFp}.png`), Buffer.from("PNGRAW"));
  // A picture an earlier build marked masked with no tripwire reading: never exported.
  const oldFp = "00000000aaaaaaaa";
  fs.writeFileSync(path.join(pages, `${oldFp}.json`), JSON.stringify(rec(oldFp, "2026-11-24T16:10:00.000Z", "Review", { file: `${oldFp}.png`, masked: true, secretsMasked: 0 })));
  fs.writeFileSync(path.join(pages, `${oldFp}.png`), Buffer.from("PNGOLD"));
  // Something else in the folder that is not a capture.
  fs.writeFileSync(path.join(pages, "notes.json"), JSON.stringify({ fp: "../../etc", capturedAt: "x" }));
  fs.writeFileSync(path.join(process.env.PORTAL_PAGE_CAPTURE_DIR!, "city-of-bend", "secret.txt"), "7734009155");

  const listed = listCapturedPortals();
  check("list names the portal and its page count", listed.length === 1 && listed[0].portal === "city-of-bend" && listed[0].pages === 4, JSON.stringify(listed));
  const out = path.join(tmp, "exports");
  const res = exportPageCaptures({ portal: "Bend", out, now: new Date("2026-11-24T17:00:00Z") });
  check("one zip for the matching portal", res.length === 1 && fs.existsSync(res[0].zip) && res[0].zip.startsWith(out), JSON.stringify(res));
  const zip = new AdmZip(res[0].zip);
  const names = zip.getEntries().map((e) => e.entryName).sort();
  check("zip holds README, three snapshots and ONE picture", JSON.stringify(names) === JSON.stringify(["01-location.json", "01-location.png", "02-contacts.json", "03-review.json", "README.md"]), JSON.stringify(names));
  check("export: a picture marked masked with no tripwire reading is not exported", !names.includes("03-review.png"));
  check("export: refused page has no picture", !names.includes("02-contacts.png"));
  const first = zip.readAsText("01-location.json");
  check("export: snapshot re-scrubbed", !first.includes("5550001111") && !first.includes("x@y.com"), first.slice(0, 400));
  check("export: capture time and id kept as written", first.includes("2026-11-24T16:00:00.000Z") && first.includes(okFp));
  const readme = zip.readAsText("README.md");
  check("README lists both pages in order, the refused one with its reason", /\| 1 \| Location \|/.test(readme) && /\| 2 \| Contacts \|[^\n]*none: the page holds 1 closed shadow root/.test(readme), readme);
  check("nothing outside pages/ exported", !zip.getEntries().some((e) => zip.readAsText(e).includes("7734009155")));
  const noPics = exportPageCaptures({ portal: "bend", out: path.join(tmp, "exports2"), pictures: false });
  check("--no-pictures: text only", new AdmZip(noPics[0].zip).getEntries().every((e) => !e.entryName.endsWith(".png")));
  check("an unknown portal: no zip", exportPageCaptures({ portal: "nowhere", out }).length === 0);
  let threw = false;
  try { exportPageCaptures({ portal: "  " }); } catch { threw = true; }
  check("no portal named: refused", threw);
  // THE MODEL-BOUND OUTPUT: secret-shaped values planted in every place a snapshot carries page text.
  const PLANT = ["Meter Number: 55509876", "Account # 4411-220-987", "ESI ID 10443720001234567", "SSN 523-45-6789", "Password: Hunter2Zebra!", "x9@example.org"];
  const plant = PLANT.join(" | ");
  const leakFp = "1111222233334444";
  const leaky = rec(leakFp, "2026-11-24T16:20:00.000Z", `Heading ${plant}`, { file: `${leakFp}.png`, masked: true, tripwire: "clear" }, plant);
  leaky.title = plant;
  leaky.reason = plant;
  (leaky.frames as Array<Record<string, unknown>>)[0].html = `<html><body><p>${plant}</p><label>${plant}</label></body></html>`;
  (leaky.frames as Array<Record<string, unknown>>)[0].actions = [plant];
  (leaky.frames as Array<Record<string, unknown>>)[0].controls = [{ tag: "select", type: "select", label: plant, name: plant, id: "", required: false, visible: true, disabled: false, secret: false, options: [plant] }];
  fs.writeFileSync(path.join(pages, `${leakFp}.json`), JSON.stringify(leaky));
  fs.writeFileSync(path.join(pages, `${leakFp}.png`), Buffer.from("PNGLEAK"));
  const res2 = exportPageCaptures({ portal: "bend", out: path.join(tmp, "exports3") });
  const z2 = new AdmZip(res2[0].zip);
  const texts = z2.getEntries().filter((e) => !e.entryName.endsWith(".png")).map((e) => z2.readAsText(e));
  check("model-bound: every text in the zip passes the model door's scan", texts.every((t) => exportTextLeaks(t).length === 0), texts.map(exportTextLeaks).join(";"));
  check("model-bound: no planted value survives anywhere", !texts.some((t) => /55509876|4411.?220.?987|10443720001234567|523-45-6789|Hunter2Zebra|x9@example\.org/.test(t)));
  const leakJson = z2.getEntries().find((e) => e.entryName.endsWith(".json") && z2.readAsText(e).includes(leakFp));
  check("model-bound: the planted page still goes, scrubbed", !!leakJson);
  // PIN THE SNAPSHOT'S FIELDS: a new field must be added here on purpose, with its scrub.
  const one = JSON.parse(z2.readAsText(leakJson!)) as Record<string, unknown>;
  const frame0 = (one.frames as Array<Record<string, unknown>>)[0];
  check("model-bound: the snapshot's fields are exactly the pinned ones",
    JSON.stringify(Object.keys(one).sort()) === JSON.stringify(["capturedAt", "fp", "frames", "headings", "kind", "portal", "reason", "runId", "shot", "title", "url"])
    && JSON.stringify(Object.keys(frame0).sort()) === JSON.stringify(["actions", "controls", "headings", "html", "text", "title", "url"])
    && JSON.stringify(Object.keys((frame0.controls as Array<Record<string, unknown>>)[0]).sort()) === JSON.stringify(["disabled", "id", "label", "name", "options", "required", "secret", "tag", "type", "visible"]),
    JSON.stringify([Object.keys(one), Object.keys(frame0)]));
  const s = scrubForExport({ fp: "0011223344556677", capturedAt: "2026-11-24T16:00:00.000Z", title: "Acct 7734009155" });
  check("scrubForExport leaves the record keys, scrubs the page text", s.fp === "0011223344556677" && s.capturedAt === "2026-11-24T16:00:00.000Z" && !String(s.title).includes("7734009155"), JSON.stringify(s));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? `\nAll ${total}/${total} pageCapture checks passed.` : `\n${failures}/${total} pageCapture check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
