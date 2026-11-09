// A SECRET SPLIT BY AN INVISIBLE, SMALL OR FULLWIDTH CHARACTER NEVER REACHES THE PLANNER (#292, rule 2).
//
// redactSecretValues (shared/src/portalSafety.ts) is the one embedded-secret scrub. Its separator
// class read whitespace, ASCII and U+2010-2015 dashes, U+2212, ". # / , _ ( )" — and nothing upstream
// normalises the text — so a meter number written "80<sep>000<sep>100" reached the model intact when
// <sep> was a soft hyphen (U+00AD, which PDF text layers emit at hyphenation points), a zero-width
// character (U+200B/200C/200D, U+2060) or a small/fullwidth dash (U+FE58, U+FE63, U+FF0D); fullwidth
// digits (U+FF10-FF19) were not matched at all. The same class was hand-copied in ahjReviewRules.ts
// (wordingNamesProject) and knowledgeBase.ts (GROUPED_DIGITS); there is now ONE, exported from
// portalSafety (SECRET_SEPARATOR_CLASS and its parts), read with the `u` flag.
//
//   (a) MUST-PASS: each of those separators, fullwidth digits and punctuation, a lettered secret, a
//       secret stored in fullwidth digits, and the real designNotesDigest path — all redacted.
//   (b) MUST-EXCLUDE: code sections, dates with any dash, ratings, ZIPs, 120/240 V and longer digit
//       runs stay verbatim.
//   (c) ONLY EVER MORE THAN MAIN: main's function (ca2c27c0, after #436) copied VERBATIM as the oracle;
//       over a generated corpus, with a same-length marker as the replacement, every character main
//       redacts is redacted by the branch too.
//   (d) The other readers of the class: wordingNamesProject flags the new separators (and still lets
//       "120/240 V" through); the knowledge base's sample scrub (redactEmailText) does too.
//   (e) One class: no hand-copied dash range is left in ahjReviewRules.ts or knowledgeBase.ts.
//
// KILL (verified red by hand): delete PHASE 3 from redactSecretValues → every non-#436 separator in
// (a), the fullwidth cases and the digest check fail; restore GROUPED_DIGITS's literal class → (d)'s
// email checks and (e) fail.
//
// All numbers are synthetic.
//
//   npx tsx backend/test/redactSecretValuesUnicode.test.ts
import { REPO } from "./_isolate";
import fs from "node:fs";
import path from "node:path";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` \u2014 ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};
const show = (s: string): string => JSON.stringify(s);

/** MAIN'S redactSecretValues, verbatim (origin/main ca2c27c0, #436 merged). The oracle: never edit it. */
const MAIN_CLASS = "[\\s\\-\\u2010-\\u2015\\u2212.#/,_()]";
const MAIN_CLASS_ORIGINAL = "[\\s\\-\\u2010-\\u2015\\u2212.#/]";
function mainRedactSecretValues(text: string, secrets: Iterable<string>, replace: (hit: string) => string = () => "[redacted]"): string {
  let out = text;
  const list = Array.from(secrets ?? [], (secret) => String(secret ?? ""));
  for (const raw of list) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length >= 5) {
      const pattern = digits.split("").join(`${MAIN_CLASS_ORIGINAL}*`);
      out = out.replace(new RegExp(`(?<!\\d)${pattern}(?!\\d)`, "g"), (m) => replace(m));
    } else if (raw.trim().length >= 6 && /\d/.test(raw)) {
      const literal = raw.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      out = out.replace(new RegExp(literal, "gi"), (m) => replace(m));
    }
  }
  const sep = `${MAIN_CLASS}*`;
  for (const raw of list) {
    const digits = raw.replace(/\D/g, "");
    const alnum = raw.replace(/[^0-9A-Za-z]/g, "");
    if (digits.length >= 5) {
      out = out.replace(new RegExp(`(?<!\\d)${digits.split("").join(sep)}(?!\\d)`, "g"), (m) => replace(m));
    }
    if (/[A-Za-z]/.test(alnum) && /\d/.test(alnum) && (digits.length >= 5 || raw.trim().length >= 6)) {
      const pattern = alnum.split("").join(sep);
      out = out.replace(new RegExp(`${/^\d/.test(alnum) ? "(?<!\\d)" : ""}${pattern}${/\d$/.test(alnum) ? "(?!\\d)" : ""}`, "gi"), (m) => replace(m));
    }
  }
  return out;
}

const fullwidth = (s: string): string => s.replace(/[0-9A-Za-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));

async function main(): Promise<void> {
  const { redactSecretValues, SECRET_SEPARATOR_CLASS } = await import("../../shared/src/portalSafety");
  const { designNotesDigest, projectSecretValues } = await import("../src/autoLearn");
  const { wordingNamesProject } = await import("../src/ahjReviewRules");
  const { redactEmailText } = await import("../src/knowledgeBase");
  const asciiDigits = (s: string): string => s.normalize("NFKC").replace(/[^0-9]/g, "");

  const ACCOUNT = "1234567890";
  const METER = "80000100";
  const secrets = [ACCOUNT, METER];

  // ── (a) MUST-PASS ─────────────────────────────────────────────────────────────────────────
  const seps: Array<[string, string]> = [
    ["U+00AD soft hyphen", "\u00AD"],
    ["U+200B zero-width space", "\u200B"],
    ["U+200C zero-width non-joiner", "\u200C"],
    ["U+200D zero-width joiner", "\u200D"],
    ["U+2060 word joiner", "\u2060"],
    ["U+FEFF byte-order mark", "\uFEFF"],
    ["U+FE58 small em dash", "\uFE58"],
    ["U+FE63 small hyphen-minus", "\uFE63"],
    ["U+FF0D fullwidth hyphen-minus", "\uFF0D"],
    ["U+FF0E fullwidth full stop", "\uFF0E"],
    ["U+FF03 fullwidth number sign", "\uFF03"],
    ["U+FF0F fullwidth solidus", "\uFF0F"],
    ["U+2E3A two-em dash", "\u2E3A"],
    ["U+30A0 double hyphen", "\u30A0"],
    ["soft hyphen + line wrap", "\u00AD\n"],
    ["zero-width space beside an ASCII hyphen", "-\u200B"],
  ];
  for (const [label, d] of seps) {
    const meter = `meter #80${d}000${d}100 per photo`;
    const outMeter = redactSecretValues(meter, secrets);
    check(`MUST-PASS: ${label}-split meter is redacted`, outMeter === "meter #[redacted] per photo", show(outMeter));
    const acct = `acct 1234${d}5678${d}90 on the bill`;
    const outAcct = redactSecretValues(acct, secrets);
    check(`MUST-PASS: ${label}-split account is redacted`, outAcct === "acct [redacted] on the bill", show(outAcct));
  }
  const whole: Array<[string, string]> = [
    ["fullwidth digits", `meter ${fullwidth("80000100")} per photo`],
    ["fullwidth digits, fullwidth dashes", `meter ${fullwidth("80")}\uFF0D${fullwidth("000")}\uFF0D${fullwidth("100")} per photo`],
    ["mixed ASCII and fullwidth digits", `meter 80${fullwidth("000")}100 per photo`],
    ["a soft hyphen inside every digit pair", `meter ${METER.split("").join("\u00AD")} per photo`],
  ];
  for (const [label, text] of whole) {
    const out = redactSecretValues(text, secrets);
    check(`MUST-PASS: ${label} is redacted`, out === "meter [redacted] per photo", show(out));
  }
  const lettered = redactSecretValues("meter 1ND\u200B4421 and 1\uFF0DND\uFF0D4421 and \uFF11\uFF2E\uFF44\uFF14\uFF14\uFF12\uFF11 on site", ["1ND4421"]);
  check("MUST-PASS: a lettered meter split by a zero-width space, a fullwidth dash, or written fullwidth is redacted",
    lettered === "meter [redacted] and [redacted] and [redacted] on site", show(lettered));
  const storedFullwidth = redactSecretValues("meter 80-000-100 per photo", [fullwidth(METER)]);
  check("MUST-PASS: a secret STORED in fullwidth digits still redacts the ASCII number", storedFullwidth === "meter [redacted] per photo", show(storedFullwidth));
  const maskKept = redactSecretValues("acct 1234\u00AD5678\u00AD90", secrets, (hit) => `<${hit.replace(/[^0-9A-Za-z]/g, "").slice(-4)}>`);
  check("MUST-PASS: a caller's replace() receives the hit (last-4 masks keep working)", maskKept === "acct <7890>", show(maskKept));

  // The real model path: the planner's design digest, from parser text with a soft hyphen at a PDF
  // hyphenation point and zero-width spaces between groups.
  const project = {
    id: "p-unicode", accountNumber: ACCOUNT, meterNumber: METER,
    parserSnapshot: {
      meter: METER, account: ACCOUNT,
      sitePlanNotesText: "Existing main service panel tied to exterior utility meter #80\u00AD000\u00AD100, new PV AC disconnect within 10' of the utility meter per NEC 690.13",
      electricalCalcText: "Utility account 1234\u200B5678\u200B90 on file; 200A main, 70A fuses in the new PV AC disconnect",
    },
  } as never;
  check("SETUP: projectSecretValues lists the account and the meter",
    projectSecretValues(project).includes(ACCOUNT) && projectSecretValues(project).includes(METER), JSON.stringify(projectSecretValues(project)));
  const digest = designNotesDigest(project);
  check("MUST-PASS: the design digest carries neither invisibly-split secret",
    !asciiDigits(digest).includes(METER) && !asciiDigits(digest).includes(ACCOUNT) && digest.includes("[redacted]"), show(digest));
  check("MUST-EXCLUDE: the digest keeps the disconnect line and the ratings",
    /disconnect within 10'/i.test(digest) && /200A main/.test(digest) && /70A fuses/.test(digest), show(digest));

  // ── (b) MUST-EXCLUDE ──────────────────────────────────────────────────────────────────────
  const keep: Array<[string, string]> = [
    ["code sections", "Comply with NEC 690.12 and CRC R324.6.1 \u2014 rapid shutdown."],
    ["dates, any dash", "Resubmitted 2026\uFE5810\uFE5808; inspected 2026\uFF0D10\uFF0D09; due 10\u00AD22\u00AD2026; filed 2026\u2E3A11\u2E3A01."],
    ["ratings, ZIPs, voltage", "37 modules, 12.913 kW AC, ZIP 97140, 200A main, 120/240 V, 120\uFF0F240 V, 70A fuses."],
    ["another identifier split invisibly", "Permit 2026\u200B004417 issued."],
    ["a longer run containing the secret", "Ref 91234\u00AD5678\u00AD90 is a different number."],
    ["the secret as a prefix of a longer run", "Ref 1234\uFF0D5678\uFF0D9012 is a different number."],
    ["a longer fullwidth run", `Ref ${fullwidth("980000100")} and ${fullwidth("800001007")} are different numbers.`],
  ];
  for (const [label, text] of keep) {
    const out = redactSecretValues(text, secrets);
    check(`MUST-EXCLUDE: ${label} stay(s) verbatim`, out === text, show(out));
  }

  // ── (c) ONLY EVER MORE THAN MAIN ──────────────────────────────────────────────────────────
  const corpusSecrets = [ACCOUNT, METER, "1ND4421", "AB1234X", "Sol@r2024", "SA:12AB34", "8814402937", "  55501 "];
  const corpusSeps = ["", " ", "-", "\u2014", "\u2212", ".", "#", "/", ",", "_", "(", "\n", "\r\n", "\u00AD", "\u200B", "\u2060", "\uFE58", "\uFF0D", "\uFF0E", "-\u00AD"];
  const contexts = [(s: string) => `acct ${s} on file`, (s: string) => `9${s}`, (s: string) => `${s}1 tail`, (s: string) => `NEC 690.12; ${s}; 2026-10-08`, (s: string) => s];
  const marker = (hit: string): string => "\u0000".repeat(hit.length);
  let cases = 0;
  let wider = 0;
  const misses: string[] = [];
  for (const secret of corpusSecrets) {
    const chars = secret.trim().split("");
    for (const sep of corpusSeps) {
      for (const form of [chars.join(sep), fullwidth(chars.join(sep)), chars.slice(0, 3).join("") + sep + chars.slice(3).join("")]) {
        for (const ctx of contexts) {
          const text = ctx(form);
          const set = [secret, ...corpusSecrets.filter((s) => s !== secret).slice(0, 2)];
          const was = mainRedactSecretValues(text, set, marker);
          const now = redactSecretValues(text, set, marker);
          cases++;
          let ok = was.length === text.length && now.length === text.length;
          for (let i = 0; ok && i < text.length; i++) if (was[i] === "\u0000" && now[i] !== "\u0000") ok = false;
          if (!ok && misses.length < 5) misses.push(show(text));
          if (mainRedactSecretValues(text, set) !== text && redactSecretValues(text, set) === text && misses.length < 5) misses.push(`default replace: ${show(text)}`);
          if (now !== was) wider++;
        }
      }
    }
  }
  check(`ONLY EVER MORE: every character main redacts is redacted by the branch (${cases} cases)`, misses.length === 0, misses.join(" | "));
  check("ONLY EVER MORE: the corpus exercises the widening (some cases redact more than main)", wider > 0, `wider=${wider}`);

  // ── (d) the class's other readers ─────────────────────────────────────────────────────────
  // "/" and its fullwidth form are not separators here: "120/240 V" is a service voltage.
  for (const [label, d] of seps.filter(([, d]) => !d.includes("\uFF0F"))) {
    check(`wordingNamesProject flags a ${label}-split number`, wordingNamesProject(`Meter 123${d}45`, {}));
  }
  check("wordingNamesProject flags a fullwidth-digit number", wordingNamesProject(`Meter ${fullwidth("12345")}`, {}));
  check("wordingNamesProject still lets a service voltage through (ASCII and fullwidth slash)",
    !wordingNamesProject("Service is 120/240 V", {}) && !wordingNamesProject("Service is 120\uFF0F240 V", {}));
  for (const [label, d] of seps.filter(([, d]) => !/[\n.\uFF0E/\uFF0F]/.test(d))) {
    const out = redactEmailText(`Please confirm meter 80${d}000${d}100 today.`);
    check(`redactEmailText scrubs a ${label}-grouped number`, !asciiDigits(out).includes("80000100") && out.includes("[number]"), show(out));
  }
  const fwOut = redactEmailText(`Please confirm meter ${fullwidth("80000100")} today.`);
  check("redactEmailText scrubs a fullwidth-digit number", fwOut.includes("[number]"), show(fwOut));
  const kbKeep = "Per NEC 690.12 and IEEE 1547-2018, 120/240 V service, resubmitted 2026-10-08.";
  check("redactEmailText keeps the readable shapes it kept before", redactEmailText(kbKeep) === kbKeep, show(redactEmailText(kbKeep)));

  // ── (e) one class ─────────────────────────────────────────────────────────────────────────
  check("SECRET_SEPARATOR_CLASS reads every \\p{Dash} and \\p{Cf}", SECRET_SEPARATOR_CLASS.includes("\\p{Dash}") && SECRET_SEPARATOR_CLASS.includes("\\p{Cf}"), SECRET_SEPARATOR_CLASS);
  for (const file of ["ahjReviewRules.ts", "knowledgeBase.ts"]) {
    const src = fs.readFileSync(path.join(REPO, "backend", "src", file), "utf8");
    const copies = src.match(/\u2010-\u2015|\\u2010-\\u2015|\\u2010|\\u2212/g) ?? [];
    check(`${path.basename(file)} keeps no hand-copied dash range (it imports the shared class)`, copies.length === 0, copies.join(", "));
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
