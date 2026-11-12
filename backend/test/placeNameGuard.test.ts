// NO NEW PLACE NAMES IN CODE (review-audit draft 14, item 3: the brief's own addition, not in the draft).
//
// The owner's standing rule (2026-11-09): universal mechanisms plus per-jurisdiction DATA, never logic
// keyed to one portal, utility, city or state. This guard scans every source file under backend/src,
// portal-bot/src and shared/src (tests, smokes, fixtures, .d.ts and data files are not scanned) with the
// TypeScript scanner, so COMMENTS NEVER COUNT: only string literals, template text, regex literals and
// identifiers do. It looks for the 50 state names, a string literal that IS a two-letter state code, the
// cities and counties of the markets we file in, and utility names. Every hit must be listed in
// fixtures/placeNameAllowlist.json, per file, with a one-line reason and a count per name.
//
// THE ALLOWLIST MAY ONLY SHRINK:
//   - a name a file does not list, or a count above the listed one, fails (a NEW place name in code);
//   - a count BELOW the listed one also fails, so the list is lowered in the same change that removes
//     the name (it can never hold slack for a later addition);
//   - the total may never exceed ALLOWLIST_CEILING below. Lowering the ceiling with the list is the only
//     edit this constant takes; raising it (or adding a file to the list) is a review finding for Helm.
// Moving a rule to data removes its hits; the inventory in the allowlist (category + reason) is the
// queue for the next moves. Run with UPDATE_ALLOWLIST=1 to print the current hits as allowlist JSON
// (reasons kept for files already listed; NEW files get "TODO", which this test then refuses).
//   npx tsx backend/test/placeNameGuard.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const ALLOWLIST_CEILING = 1534;

const STATES = ["Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia","Wisconsin","Wyoming"];
const CODES = "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" ");
const CITIES = ["Portland","Salem","Eugene","Medford","Hillsboro","Beaverton","Gresham","Keizer","Coos Bay","Junction City","Tigard","Lake Oswego","Corvallis","Marion County","Clackamas","Multnomah","Washington County","Salt Lake","Murray","Bountiful","Ogden","Provo","Kaysville","Saratoga Springs","Boise","Meridian","Nampa","Caldwell","Twin Falls","Reno","Las Vegas","Phoenix","Tucson","Scottsdale","Chicago","Philadelphia","Cape Coral","Santa Fe","Elmore County","Ada County","Canyon County"];
const UTILS = ["PGE","PG&E","Portland General","PacifiCorp","Pacific Power","Rocky Mountain Power","Idaho Power","NV Energy","APS","SRP","TEP","PSE","Puget Sound","Austin Energy","Xcel","Avista","SCE","SDG&E","Duke Energy"];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&");
const nameRe = [...STATES, ...CITIES].map((n) => ({ n, re: new RegExp(`(?<![A-Za-z])${esc(n).replace(/ /g, "[\\s_-]?")}(?![A-Za-z])`, "i") }));
const utilRe = UTILS.map((n) => ({ n, re: new RegExp(`(?<![A-Za-z])${esc(n).replace(/ /g, "[\\s_-]?")}(?![A-Za-z])`, /^[A-Z&]+$/.test(n) ? "" : "i") }));
type Hits = Record<string, Record<string, number>>;
function hitsIn(text: string, kind: "string" | "regex" | "ident"): string[] {
  const out: string[] = [];
  let t = text;
  if (kind === "ident") t = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  for (const { n, re } of nameRe) if (re.test(t)) out.push(n);
  for (const { n, re } of utilRe) if (re.test(kind === "ident" ? t : text)) out.push(n);
  if (kind === "string" && CODES.includes(text.trim())) out.push(`"${text.trim()}"`);
  return out;
}
/** Every place-name hit in one source text, by name (comments are trivia to the scanner: never read). */
export function scanSource(src: string): Record<string, number> {
  const found: Record<string, number> = {};
  const add = (names: string[]) => { for (const n of names) found[n] = (found[n] ?? 0) + 1; };
  const sc = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, src);
  let tok = sc.scan();
  let prev = ts.SyntaxKind.Unknown;
  const stack: Array<"brace" | "tpl"> = [];
  while (tok !== ts.SyntaxKind.EndOfFileToken) {
    if (tok === ts.SyntaxKind.StringLiteral || tok === ts.SyntaxKind.NoSubstitutionTemplateLiteral) add(hitsIn(sc.getTokenValue(), "string"));
    else if (tok === ts.SyntaxKind.TemplateHead) { add(hitsIn(sc.getTokenValue(), "string")); stack.push("tpl"); }
    else if (tok === ts.SyntaxKind.Identifier) add(hitsIn(sc.getTokenValue(), "ident"));
    else if (tok === ts.SyntaxKind.OpenBraceToken || tok === ts.SyntaxKind.DollarBraceToken) stack.push("brace");
    else if (tok === ts.SyntaxKind.SlashToken || tok === ts.SyntaxKind.SlashEqualsToken) {
      const exprEnd = [ts.SyntaxKind.Identifier, ts.SyntaxKind.CloseParenToken, ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateTail, ts.SyntaxKind.CloseBraceToken, ts.SyntaxKind.ThisKeyword, ts.SyntaxKind.RegularExpressionLiteral].includes(prev);
      if (!exprEnd) { tok = sc.reScanSlashToken(); if (tok === ts.SyntaxKind.RegularExpressionLiteral) add(hitsIn(sc.getTokenText(), "regex")); }
    } else if (tok === ts.SyntaxKind.CloseBraceToken) {
      const top = stack.pop();
      if (top === "tpl") {
        const t2 = sc.reScanTemplateToken(false);
        add(hitsIn(sc.getTokenValue(), "string"));
        if (t2 === ts.SyntaxKind.TemplateMiddle) stack.push("tpl");
        tok = t2;
      }
    }
    prev = tok;
    tok = sc.scan();
  }
  return found;
}
function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "fixtures") walk(p, out); continue; }
    if (/\.(ts|mts)$/.test(e.name) && !/\.(test|smoke)\.ts$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
}
const files: string[] = [];
for (const d of ["backend/src", "portal-bot/src", "shared/src"]) walk(path.join(root, d), files);
const hits: Hits = {};
for (const f of files.sort()) {
  const h = scanSource(fs.readFileSync(f, "utf8"));
  if (Object.keys(h).length) hits[path.relative(root, f).split(path.sep).join("/")] = h;
}

type Entry = { category: string; reason: string; names: Record<string, number> };
const allowPath = path.join(here, "fixtures", "placeNameAllowlist.json");
const allow = JSON.parse(fs.readFileSync(allowPath, "utf8")) as { _comment: string; files: Record<string, Entry> };
if (process.env.UPDATE_ALLOWLIST === "1") {
  const out: Record<string, Entry> = {};
  for (const [f, names] of Object.entries(hits)) out[f] = { category: allow.files[f]?.category ?? "TODO", reason: allow.files[f]?.reason ?? "TODO", names: Object.fromEntries(Object.entries(names).sort(([a], [b]) => a.localeCompare(b))) };
  console.log(JSON.stringify(out, null, 1));
}

let failures = 0;
let passed = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.log(`  FAIL - ${label}\n         ${(e as Error).message.slice(0, 2500)}`); }
};
console.log("place-name guard (draft 14)");

check("the scanner reads strings, templates, regexes and identifiers, never comments", () => {
  const h = scanSource([
    "// Utah in a comment",
    "/* Nevada in a block comment */",
    "const a = \"Oregon\"; const b = `in ${a} and Idaho`; const re = /boise/i;",
    "const isPortland = 1; const st = \"WA\"; const word = \"OR \" + \"Ohio\";",
    "const total = 4 / 2; const u = \"PacifiCorp\";",
  ].join("\n"));
  assert.deepEqual(h, { Oregon: 1, Idaho: 1, Boise: 1, Portland: 1, "\"WA\"": 1, "\"OR\"": 1, Ohio: 1, PacifiCorp: 1 });
});

check("every place name in code is on the allowlist, at no more than its listed count (no new names)", () => {
  const added: string[] = [];
  for (const [f, names] of Object.entries(hits)) {
    for (const [n, c] of Object.entries(names)) {
      const listed = allow.files[f]?.names[n] ?? 0;
      if (c > listed) added.push(`${f}: ${n} ×${c} (listed ${listed})`);
    }
  }
  assert.deepEqual(added, [], "move the rule to per-jurisdiction data instead of naming a place in code");
});

check("the allowlist holds no slack: a removed name is removed from the list in the same change", () => {
  const stale: string[] = [];
  for (const [f, e] of Object.entries(allow.files)) {
    for (const [n, c] of Object.entries(e.names)) {
      const now = hits[f]?.[n] ?? 0;
      if (now < c) stale.push(`${f}: ${n} listed ×${c}, found ×${now}`);
    }
  }
  assert.deepEqual(stale, [], "lower (or delete) these entries and ALLOWLIST_CEILING with them");
});

check(`every listed file has a category and a one-line reason; the total never exceeds the ceiling (${ALLOWLIST_CEILING})`, () => {
  const bad = Object.entries(allow.files).filter(([, e]) => !e.reason || e.reason === "TODO" || e.reason.includes("\n") || !e.category || e.category === "TODO").map(([f]) => f);
  assert.deepEqual(bad, []);
  const total = Object.values(allow.files).reduce((s, e) => s + Object.values(e.names).reduce((a, b) => a + b, 0), 0);
  assert.ok(total <= ALLOWLIST_CEILING, `allowlist total ${total} exceeds the ceiling ${ALLOWLIST_CEILING}: the list may only shrink`);
});

check("the modules moved to data name no place in code (draft 12 + draft 14)", () => {
  for (const f of ["backend/src/permitPath.ts", "backend/src/reviewerEngine.ts", "backend/src/jurisdictionPermitPaths.ts", "backend/src/jurisdictionQcRules.ts", "backend/src/stateRules.ts"]) {
    assert.equal(hits[f], undefined, `${f}: ${JSON.stringify(hits[f])}`);
    assert.equal(allow.files[f], undefined, `${f} must not be on the allowlist`);
  }
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
