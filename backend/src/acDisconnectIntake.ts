import type { ParserLlmExtraction } from "../../shared/src/types";
import { planSetDisconnectPart } from "./baselineRules";
import { splitPlanPages } from "./packetApplication";

// THE AC DISCONNECT'S PART, READ OFF THE PLAN SET (#384). Live, 2026-10-21 (PacifiCorp PowerClerk
// NEM): the SLD and the equipment schedule named an Eaton DG-series switch, the parse kept only
// acDiscReq = "yes", and the operator typed "Disconnect Switch Manufacturer" / "Model" by hand.
// This reads the part deterministically off the text the parser page already posts
// (/api/parser/llm-extract), the way structuralIntake / packetApplication read theirs, and fills
// the ONE plan-set key the filing reads: acDiscMakeModel (baselineRules.planSetDisconnectPart splits
// it; portalRecipes.resolveRecipeFieldValues hands it to #353's unrecorded-control pass as
// disconnectMake / disconnectModel / disconnectMakeModel). acDiscAmps / acDiscFused ride along where
// the same callout states them — they are what the client's standard part is cross-checked against.
//
// A PART BELONGS TO THE LABEL IT IS WRITTEN AGAINST, AND ONLY THE AC DISCONNECT'S LABEL COUNTS:
//   - after the label ("AC DISCONNECT 1 EATON DG222URB 60A 240V NON-FUSIBLE" — a schedule row), up
//     to the next piece of equipment, so the next row's part is never read as this one's;
//   - before it only when the callout is the disconnect's own ("(N) EATON DG222URB 60A NON-FUSIBLE
//     AC DISCONNECT" — SLD text): nothing but rating words between the part and the label, and no
//     other equipment named just before the make. "COMBINER PANEL EATON BR816L125RP AC DISCONNECT"
//     is the COMBINER's part (the trap llm.ts names), never the disconnect's.
// A DC, rapid-shutdown, storage or any other disconnect's label is not the AC disconnect's, and a
// part written against it is never read. Two different AC parts on one set fill nothing: that is a
// question for the reviewer (a structured conflict), not a pick. A make with no part number, or a
// part number with no make, names no part: the key stays empty, so the client's standard part (or
// #353's stop by name) decides, exactly as before.
//
// The distance-to-meter question (disconnectWithin10ft) is NOT read here: it is a per-job key only
// a person answers (shared perJobQuestions PER_JOB_ANSWER_KEYS), with the operator's standing answer
// behind it. Nothing here reaches an LLM (it runs on the model's RESPONSE) and nothing is logged.

/** The AC disconnect's own label. "DC/AC DISCONNECT" and "AC/DC DISCONNECT" are not it. */
const AC_LABEL = /(?<![A-Z0-9/])A\.?\s?C\.?\s+(?:SAFETY\s+)?DISCONNECT(?:\s+SWITCH)?(?:\s*\(S\))?|\bVISIBLE,?\s+LOCKABLE,?\s+(?:AND\s+)?LABELL?ED\s+DISCONNECT(?:\s+SWITCH)?/gi;

/** Other equipment: ends the text that follows a label, and owns a part written right after it. */
const EQUIPMENT = /\b(?:DISCONNECTS?|SAFETY\s+SWITCH|COMBINER|LOAD\s*CENTER|PANEL(?:BOARD)?|SUB-?PANEL|MSP|MDP|INVERTERS?|MICRO-?INVERTERS?|MODULES?|RAPID\s+SHUTDOWN|RSD|OPTIMIZERS?|BATTER(?:Y|IES)|ESS|GATEWAY|TRANSFER\s+SWITCH|METER|BREAKERS?|OCPD|JUNCTION\s+BOX|J-?BOX|CONDUIT|WIRE|CONDUCTORS?|RACKING|RAILS?|ATTACHMENTS?|MONITORING|ENVOY|EVSE|CHARGER|GENERATOR|TRANSFORMER)\b/i;

/** Disconnect-switch makers, as the schedule prints them -> the name filed. A maker not listed names
 *  no part (never a guessed manufacturer). */
const MAKERS: Array<{ re: RegExp; name: string }> = [
  { re: /^EATON$/i, name: "Eaton" },
  { re: /^CUTLER[-\s]?HAMMER$/i, name: "Cutler-Hammer" },
  { re: /^SQUARE\s?D$/i, name: "Square D" },
  { re: /^SIEMENS$/i, name: "Siemens" },
  { re: /^GENERAL\s+ELECTRIC$/i, name: "General Electric" },
  { re: /^GE$/i, name: "GE" },
  { re: /^SCHNEIDER(?:\s+ELECTRIC)?$/i, name: "Schneider Electric" },
  { re: /^ABB$/i, name: "ABB" },
  { re: /^LEVITON$/i, name: "Leviton" },
  { re: /^HUBBELL$/i, name: "Hubbell" },
  { re: /^MILBANK$/i, name: "Milbank" },
  { re: /^MIDNITE(?:\s+SOLAR)?$/i, name: "MidNite Solar" },
];
const MAKER_WORDS = String.raw`EATON|CUTLER[-\s]?HAMMER|SQUARE\s?D|SIEMENS|GENERAL\s+ELECTRIC|GE|SCHNEIDER(?:\s+ELECTRIC)?|ABB|LEVITON|HUBBELL|MILBANK|MIDNITE(?:\s+SOLAR)?`;
const PART_LEAD = String.raw`[\s,:#/-]*(?:(?:MODEL|CAT(?:ALOG)?\.?|P/N|PART)\s*(?:NO\.?|NUMBER|#)?\s*[:#]?\s*)?`;
/** Make then part number, reading forward from a label. */
const PART_AFTER = new RegExp(String.raw`\b(${MAKER_WORDS})\b${PART_LEAD}([A-Z0-9][A-Z0-9-]*[A-Z0-9])`, "gi");
/** Make then part number, ending where the label's own rating words begin (reading backward). */
const PART_BEFORE = new RegExp(String.raw`\b(${MAKER_WORDS})\b${PART_LEAD}([A-Z0-9][A-Z0-9-]*[A-Z0-9])$`, "i");

/** Words a disconnect callout carries between its part and its label. */
const RATING_WORD = /^(?:\(N\)|\(E\)|NEW|\d{1,3}\s?A(?:MPS?)?|\d{1,3}|AMPS?|\d{3}\s?V(?:AC)?|120\/240\s?V?(?:AC)?|V(?:AC)?|[1-3]\s?P(?:OLE)?|[1-3]-POLE|POLE|NON-?FUS(?:ED|IBLE)|NON|UN-?FUSED|FUS(?:ED|IBLE)|NEMA|NEMA\s?3R|3R|LOCKABLE|VISIBLE|LABELL?ED|HEAVY-?DUTY|GENERAL-?DUTY|HEAVY|DUTY|UTILITY|PV|SOLAR|[,;:()-]+)$/i;
/** A part number: letters AND digits, 4+ characters, and not a rating or a standard. */
function isPartNumber(token: string): boolean {
  const t = token.replace(/[^A-Z0-9]/gi, "");
  return t.length >= 4 && /[A-Z]/i.test(t) && /\d/.test(t)
    && !/^\d+(?:A|AMPS?|V|VAC|VDC|P|POLE|PH|W|KW|KVA|AWG)$/i.test(t)
    && !/^(?:NEMA|UL|NEC|IEC|CSA|ANSI)/i.test(t);
}
const makerName = (raw: string): string | null => MAKERS.find((m) => m.re.test(raw.replace(/\s+/g, " ").trim()))?.name ?? null;

export interface AcDisconnectPartReading { make: string; model: string; page: number | null; excerpt: string }
export interface AcDisconnectReading {
  /** Every AC-disconnect part the set names, one per distinct part. */
  parts: AcDisconnectPartReading[];
  amps: Array<{ value: string; page: number | null; excerpt: string }>;
  fused: Array<{ value: "fusible" | "non-fusible"; page: number | null; excerpt: string }>;
}

function ratingsOf(text: string): { amps: string | null; fused: "fusible" | "non-fusible" | null } {
  const amps = /(?<![A-Z0-9])(\d{2,3})\s?A(?:MPS?)?\b(?!\s*FUSES?\b)/i.exec(text);
  const fused = /\bNON-?FUS(?:ED|IBLE)\b|\bUN-?FUSED\b/i.test(text) ? "non-fusible" : /\bFUS(?:ED|IBLE)\b/i.test(text) ? "fusible" : null;
  return { amps: amps ? `${amps[1]}A` : null, fused };
}

/** The AC disconnect's part, amps and fusing, as the plan-set text states them (see above). */
export function readAcDisconnect(planText: string): AcDisconnectReading {
  const out: AcDisconnectReading = { parts: [], amps: [], fused: [] };
  const seen = { parts: new Set<string>(), amps: new Set<string>(), fused: new Set<string>() };
  for (const p of splitPlanPages(String(planText ?? ""))) {
    // Line breaks kept: a schedule row starts on its own line, and that is what tells "LOAD CENTER" ⏎
    // "AC DISCONNECT …" (two rows) from "BATTERY AC DISCONNECT" (one label).
    const t = p.raw.replace(/[^\S\n]+/g, " ");
    for (const label of t.matchAll(AC_LABEL)) {
      const start = label.index!;
      const end = start + label[0].length;
      // AFTER the label, up to the next piece of equipment (the next schedule row / callout).
      let after = t.slice(end, end + 120);
      const stop = EQUIPMENT.exec(after);
      if (stop) after = after.slice(0, stop.index);
      // BEFORE the label: only the rating words directly in front of it belong to it.
      const before = t.slice(Math.max(0, start - 100), start);
      const tokens = [...before.matchAll(/\S+/g)];
      let i = tokens.length;
      while (i > 0 && RATING_WORD.test(tokens[i - 1][0].replace(/[,;]+$/, ""))) i--;
      const ratingRun = tokens.slice(i).map((m) => m[0]).join(" ");
      const lead = tokens.slice(0, i).map((m) => m[0]).join(" ");
      const leadEnd = i > 0 ? tokens[i - 1].index! + tokens[i - 1][0].length : 0;
      // A callout of its own starts between the lead and the label: a line break, a sentence end, a
      // callout marker ("(N)", "(E)", "NEW") or a bare quantity (the previous schedule row's last cell).
      const ownCallout = i === 0 || /\n/.test(before.slice(leadEnd)) || /[.;]$/.test(tokens[i - 1][0])
        || /\(N\)|\(E\)|\bNEW\b|(?:^|\s)\d+(?=\s|$)/i.test(ratingRun);
      // ANOTHER EQUIPMENT'S AC DISCONNECT ("BATTERY AC DISCONNECT", "GENERATOR AC DISCONNECT") is not
      // the system's: a label whose words run straight on from another piece of equipment is skipped.
      // A part number right before the label ends the other equipment's row and does not qualify it.
      const leadTail = tokens.slice(Math.max(0, i - 2), i).map((m) => m[0]);
      if (!ownCallout && !isPartNumber(leadTail[leadTail.length - 1]) && EQUIPMENT.test(leadTail.join(" "))) continue;
      const excerpt = t.slice(Math.max(0, start - ratingRun.length - 30), Math.min(t.length, end + after.length)).replace(/\s+/g, " ").trim().slice(0, 100);
      let partBefore = false;
      const part = (() => {
        for (const m of after.matchAll(PART_AFTER)) {
          const make = makerName(m[1]);
          if (make && isPartNumber(m[2])) return { make, model: m[2].toUpperCase() };
        }
        const m = PART_BEFORE.exec(lead);
        if (!m) return null;
        const make = makerName(m[1]);
        if (!make || !isPartNumber(m[2])) return null;
        // The make must open its own callout: no other equipment named right before it, unless a
        // callout marker ("(N)", "NEW", a sentence end) starts this one after it.
        const ahead = lead.slice(0, m.index).slice(-40);
        const marker = /(?:\(N\)|\(E\)|\bNEW|[.;])\s*$/i.test(ahead);
        if (!marker && EQUIPMENT.test(ahead)) return null;
        partBefore = true;
        return { make, model: m[2].toUpperCase() };
      })();
      if (part) {
        const key = `${part.make}|${part.model}`.toUpperCase();
        if (!seen.parts.has(key)) { seen.parts.add(key); out.parts.push({ ...part, page: p.page, excerpt }); }
      }
      // The rating AFTER the label is the label's own; the words in front of it are, only when they
      // open its callout or follow its own part ("DC DISCONNECT: … DU221RB 30A AC DISCONNECT" — the
      // 30A is the DC switch's).
      const fwd = ratingsOf(after);
      const back = ownCallout || partBefore ? ratingsOf(ratingRun) : { amps: null, fused: null };
      const r = { amps: fwd.amps ?? back.amps, fused: fwd.fused ?? back.fused };
      if (r.amps && !seen.amps.has(r.amps)) { seen.amps.add(r.amps); out.amps.push({ value: r.amps, page: p.page, excerpt }); }
      if (r.fused && !seen.fused.has(r.fused)) { seen.fused.add(r.fused); out.fused.push({ value: r.fused, page: p.page, excerpt }); }
    }
  }
  return out;
}

const sheetOf = (page: number | null) => (page != null ? `Page ${page} (AC disconnect)` : "AC disconnect");
const compact = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Fill acDiscMakeModel (and acDiscAmps / acDiscFused where the model read left them empty) from the
 *  plan set's own AC-disconnect callouts. The labelled read is the explicit one and fills the key; a
 *  different part the model read is kept beside it as a structured conflict. Two different AC parts
 *  on the set fill nothing and go to review. */
export function supplementAcDisconnect(result: ParserLlmExtraction, planText: string): ParserLlmExtraction {
  const read = readAcDisconnect(planText);
  const fields = { ...result.fields };
  const conflicts = [...(result.conflicts ?? [])];
  const reading = (value: string, r: { page: number | null; excerpt: string }) => ({ value, source: "plan_set" as const, sheet: sheetOf(r.page), excerpt: r.excerpt });
  const prior = fields.acDiscMakeModel;
  const priorValue = prior?.value != null ? String(prior.value).trim() : "";
  if (read.parts.length === 1) {
    const part = read.parts[0];
    const value = `${part.make} ${part.model}`;
    const priorPart = planSetDisconnectPart({ acDiscMakeModel: priorValue });
    if (priorPart.named && (compact(priorPart.make) !== compact(part.make) || compact(priorPart.model) !== compact(part.model))) {
      conflicts.push({ field: "acDiscMakeModel", note: "The plan set's AC disconnect callout names a different part than the text read.", readings: [
        reading(value, part),
        { value: priorValue, source: prior?.evidence?.source ?? "plan_set", sheet: prior?.evidence?.sheet, excerpt: prior?.evidence?.excerpt },
      ] });
    }
    fields.acDiscMakeModel = { value, confidence: 0.95, evidence: { source: "plan_set", sheet: sheetOf(part.page), excerpt: part.excerpt } };
  } else if (read.parts.length > 1) {
    conflicts.push({ field: "acDiscMakeModel", note: "The plan set names more than one AC disconnect part; confirm which is installed.",
      readings: read.parts.map((p) => reading(`${p.make} ${p.model}`, p)) });
  }
  const fillEmpty = (key: "acDiscAmps" | "acDiscFused", list: Array<{ value: string; page: number | null; excerpt: string }>) => {
    if (list.length !== 1) return;
    const cur = fields[key]?.value;
    if (cur != null && String(cur).trim() !== "") return;
    fields[key] = { value: list[0].value, confidence: 0.95, evidence: { source: "plan_set", sheet: sheetOf(list[0].page), excerpt: list[0].excerpt } };
  };
  fillEmpty("acDiscAmps", read.amps);
  fillEmpty("acDiscFused", read.fused);
  return { ...result, fields, ...(conflicts.length ? { conflicts } : {}) };
}

/**
 * THE JOB'S AC DISCONNECT PART, BACKED BY ITS OWN PLAN SET — the ONE reader for "does this job show an
 * AC disconnect from a captured part", asked by the reviewer gate's acDisconnect topic
 * (projectEvidence.evidenceForTopic) and by QC's ac_disconnect package read (qc.ts hands the answer to
 * baselineRules). The part as one line ("Eaton DG222URB"), "" when it does not count.
 *
 * It counts ONLY when both hold:
 *   - the job holds a part in its plan-set key (acDiscMakeModel; planSetDisconnectPart), AND
 *   - the job's own plan-set text names THAT part at its AC-disconnect label (readAcDisconnect above,
 *     the same plan_set read that fills the key at intake).
 * The job's fields keep no record of where a value came from (a parse, a person's edit and an API
 * body all save the same key), so the key alone is never evidence: the plan set is. A part a person
 * typed that the plan set does not name, acDiscReq alone, a rating line that names no part, and the
 * client's standard part (company data, never read off this plan set) all count for nothing, and a
 * utility's AC-disconnect requirement then reads exactly as before.
 */
export function capturedDisconnectPart(snapshot: Record<string, unknown> | null | undefined, planSetText: unknown): string {
  const held = planSetDisconnectPart(snapshot ?? {});
  if (!held.named || !held.model) return "";
  const text = String(planSetText ?? "");
  if (!text.trim()) return "";
  const onSet = readAcDisconnect(text).parts.find((p) => compact(p.model) === compact(held.model) && (!held.make || compact(p.make) === compact(held.make)));
  return onSet ? `${onSet.make} ${onSet.model}` : "";
}

/**
 * THE WORDINGS THAT NAME AN AC DISCONNECT IN PLAN TEXT — the ONE list for "the text names an AC /
 * utility disconnect", read by the reviewer gate's acDisconnect topic (projectEvidence, over all of the
 * job's evidence text) and by QC's ac_disconnect package read (qc.ts hands the answer to baselineRules,
 * on the plan-set text the gate sees). They were the gate's own; QC looked only at the split-page list
 * and the upload notes, so a plan set that says "AC DISCONNECT" cleared the gate while QC still listed
 * the disconnect as possibly missing (#134). A DC, rapid-shutdown or storage disconnect matches none.
 */
export const AC_DISCONNECT_TEXT_PATTERNS: readonly RegExp[] = [/\bAC\s+disconnect/i, /\butility\s+(?:accessible\s+|external\s+)?disconnect/i, /\bexternal\s+disconnect/i, /\blockable\s+disconnect/i, /\bvisible[-\s]?(?:break|blade|open)/i, /\bPV\s+system\s+disconnect/i, /\b690\.13\b/i];

/** True when the job's plan-set text names an AC / utility disconnect in the gate's own wordings. */
export function planTextNamesAcDisconnect(planSetText: unknown): boolean {
  const text = String(planSetText ?? "");
  return Boolean(text.trim()) && AC_DISCONNECT_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}
