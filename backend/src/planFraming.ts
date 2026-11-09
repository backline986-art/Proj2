// THE ROOF FRAMING AND THE PERMIT PATH, READ OFF THE PLANS (#595).
//
// A real Oregon job filed as prescriptive solar came back non-prescriptive, and its parse carried no
// rafter span and no permit path though the plans stated both. The gate flagged "engineered / sealed
// calcs missing" only out of caution. Owner, 2026-11-04: "rafter span and permit path should have
// been off plans vs a guess."
//
// These readers are deterministic, take only the plan set's own words, and never turn a missing fact
// into an answer. structuralIntake.supplementStructuralIntake runs them after the model's read, so a
// sheet past the model's text budget, or a fact the model skipped, still lands, with the plan
// excerpt as its evidence. Each reader returns null when the plans do not state the fact: the gate's
// caution is then the fallback, and it says the plans lacked it (codeReviewRules
// city.struct.span-table-incomplete).
//
// Synthetic strings only in tests: no plan excerpt from a real job goes into this repo.

export interface PlanFact<T> {
  value: T;
  /** The plan text the value was read from (whitespace-collapsed, capped). */
  excerpt: string;
}

// Nominal lumber size: "2X6", "2 x 8", '2" X 4"'. Never the tail of a fraction ("5/16" X 4" LAG"),
// never a decimal ("1.75x11.875" is an engineered member's depth, read by nothing here).
const SIZE = String.raw`(?<![\/\d.])([1-4])\s*(?:"|''|”)?\s*[X×]\s*(\d{1,2})(?!\.\d|[\/\d])\s*(?:"|''|”)?`;
// Species + grade: "DF #2", "DF-L NO. 2", "DOUGLAS FIR-LARCH #2", "HF #2", "SPF #1", "SYP #2".
const SPECIES = String.raw`(D\.?\s?F\.?(?:\s*-\s*|\s+)?L(?:ARCH)?\b|D\.?\s?F\.?(?![A-Z])|DOUG(?:LAS)?[-\s]?FIR(?:\s*-\s*|\s+)?LARCH|DOUG(?:LAS)?[-\s]?FIR|H\.?\s?F\.?(?![A-Z])|HEM[-\s]?FIR|S-?P-?F|S\.?Y\.?P\.?|SOUTHERN\s+(?:YELLOW\s+)?PINE)`;
const GRADE_NO = String.raw`(?:#\s*|NO\.?\s*|GRADE\s*)([123])\b`;
const GRADE = String.raw`${SPECIES}\s*[-,]?\s*${GRADE_NO}`;
const MEMBER = String.raw`(RAFTERS?|TRUSS(?:ES)?|(?:I-?)?JOISTS?|TJIS?)`;
const SPACING = String.raw`(?:@|AT)\s*(\d{1,2})\s*(?:"|''|”|IN\b\.?|INCH(?:ES)?)?\s*(?:O\.?\s*C\b\.?|ON[-\s]CENT(?:ER|RE))`;
// "2X6 DF #2 RAFTERS @ 24" O.C.", "(E) 2X6 RAFTERS (DF-L #2) @ 24" O.C.", '2" X 4" TRUSS @ 24" O.C.'
const CALLOUT = new RegExp(
  String.raw`${SIZE}\s*(?:${GRADE}\s*)?(?:ROOF\s+)?${MEMBER}\s*(?:\(\s*${GRADE}\s*\)\s*)?${SPACING}`,
  "gi",
);

// A length in feet: "11'-6"", "11' 6"", "11 FT 6 IN", "11.5 FT", "12'".
const LENGTH = String.raw`(\d{1,2}(?:\.\d+)?)\s*(?:'(?!')|’|FT\b\.?|FEET\b)(?:\s*-?\s*(\d{1,2}(?:\.\d+)?)\s*(?:"|”|''|IN\b\.?|INCH(?:ES)?))?`;
const SPAN_QUALIFIER = String.raw`(?:MAX(?:IMUM)?\.?|ACTUAL|CLEAR|HORIZ(?:ONTAL)?\.?|PROJECTED|UNSUPPORTED)`;
// "RAFTER SPAN: 11'-6"", "MAX RAFTER SPAN = 12'-0"", "RAFTER CLEAR SPAN 10 FT". A RAIL or MODULE
// span (the racking's span between attachments) is never a framing span, so the label must name a
// framing member; and a TRUSS span is the truss's own design, never the span table's rafter span.
const SPAN_LABEL = new RegExp(
  String.raw`(?:${SPAN_QUALIFIER}\s+)?(?:ROOF\s+)?(?:RAFTER|JOIST|FRAMING)S?\s+(?:${SPAN_QUALIFIER}\s+)?SPANS?\s*(?:LENGTH\s*)?(?:\(\s*FT\s*\)\s*)?[:=]?\s*(?:OF\s+)?${LENGTH}`,
  "gi",
);
// The span written right after a member callout: "2X6 RAFTERS @ 24" O.C., MAX SPAN 11'-6"".
const SPAN_AFTER_CALLOUT = new RegExp(
  String.raw`^\s*[,;]?\s*(?:(?:W\/|WITH)\s*(?:AN?\s+)?)?(?:${SPAN_QUALIFIER}\s+)?SPANS?\s*[:=]?\s*(?:OF\s+)?${LENGTH}`,
  "i",
);

const SIZE_LABEL = new RegExp(String.raw`(?:RAFTER|TRUSS|JOIST|FRAMING|MEMBER)\s+SIZE\s*[:=]\s*${SIZE}`, "gi");
const SPACING_LABEL = new RegExp(
  String.raw`(?:RAFTER|TRUSS|JOIST|FRAMING)\s+SPACING\s*[:=]\s*(\d{1,2})\s*(?:"|''|”|IN\b\.?|INCH(?:ES)?)?\s*(?:O\.?\s*C\b\.?|ON[-\s]CENT(?:ER|RE))?`,
  "gi",
);
const GRADE_LABEL = new RegExp(
  String.raw`(?:LUMBER|WOOD|RAFTER|FRAMING)\s+(?:SPECIES\s*(?:\/|&|AND)\s*GRADE|GRADE\s*(?:\/|&|AND)\s*SPECIES|GRADE(?:\s+OF\s+WOOD)?|SPECIES)\s*[:=]\s*${GRADE}`,
  "gi",
);

function collapse(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ");
}

function excerptOf(m: RegExpMatchArray): string {
  return m[0].trim().slice(0, 200);
}

/** "DF-L #2", "HF #2", "SPF #1", "SYP #2" from a species token and a grade number. */
export function normalizeLumberGrade(species: string, grade: string): string {
  const s = species.toUpperCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  let code: string;
  if (/^(?:DF ?-? ?L|DFL|DF L|DOUG(?:LAS)? ?-?FIR ?-? ?LARCH)/.test(s) || /LARCH/.test(s)) code = "DF-L";
  else if (/^(?:D ?F|DOUG)/.test(s)) code = "DF";
  else if (/^(?:H ?F|HEM)/.test(s)) code = "HF";
  else if (/^S-?P-?F$/.test(s)) code = "SPF";
  else code = "SYP";
  return `${code} #${grade}`;
}

interface Callout {
  size: string;
  member: "rafter" | "truss" | "joist";
  spacingIn: number;
  grade: string | null;
  excerpt: string;
  /** Index just past the callout in the collapsed text (the span may follow it). */
  end: number;
}

function memberKind(word: string): Callout["member"] {
  const w = word.toUpperCase();
  if (w.startsWith("RAFTER")) return "rafter";
  if (w.startsWith("TRUSS")) return "truss";
  return "joist";
}

function readCallouts(text: string): Callout[] {
  const out: Callout[] = [];
  for (const m of text.matchAll(CALLOUT)) {
    // Groups: 1,2 size; 3,4 grade before the member; 5 member; 6,7 grade in parentheses; 8 spacing.
    const grade = m[3] && m[4] ? normalizeLumberGrade(m[3], m[4]) : m[6] && m[7] ? normalizeLumberGrade(m[6], m[7]) : null;
    out.push({
      size: `${m[1]}x${m[2]}`,
      member: memberKind(m[5]),
      spacingIn: Number(m[8]),
      grade,
      excerpt: excerptOf(m),
      end: (m.index ?? 0) + m[0].length,
    });
  }
  return out;
}

/** One distinct value, or nothing: two sheets that disagree are a question for review, not a pick. */
function single<T>(cands: Array<PlanFact<T>>): PlanFact<T> | null {
  const distinct = [...new Set(cands.map((c) => JSON.stringify(c.value)))];
  return distinct.length === 1 ? cands[0] : null;
}

function feet(whole: string, inches: string | undefined): number {
  const ft = Number(whole) + (inches ? Number(inches) / 12 : 0);
  return Math.round(ft * 100) / 100;
}

export interface PlanFraming {
  /** "rafter" | "truss" — the member a sized callout names (joists name no framing type). */
  framingType: PlanFact<"rafter" | "truss"> | null;
  /** Nominal size, e.g. "2x6". */
  roofRafterSize: PlanFact<string> | null;
  /** Species and grade, e.g. "DF-L #2". */
  woodGrade: PlanFact<string> | null;
  /** Inches on centre. */
  roofRafterSpacing: PlanFact<number> | null;
  /** Feet. The LONGEST span the plans state: a prescriptive span table is a maximum, so the longest
   *  span governs, and taking a shorter one would clear a screen the longest one fails. */
  roofRafterSpan: PlanFact<number> | null;
  /** A dimensioned lumber callout exists (BCD 5952's light-frame row). */
  lightFrame: boolean;
}

/** The roof framing the plan text states. Every member is null when the plans do not state it, or
 *  (size, grade, spacing, member) state it two different ways. */
export function readPlanFraming(planText: string): PlanFraming {
  const text = collapse(planText);
  const callouts = readCallouts(text);

  const typeCands: Array<PlanFact<"rafter" | "truss">> = [];
  const sizeCands: Array<PlanFact<string>> = [];
  const gradeCands: Array<PlanFact<string>> = [];
  const spacingCands: Array<PlanFact<number>> = [];
  const spanCands: Array<PlanFact<number>> = [];

  for (const c of callouts) {
    if (c.member !== "joist") typeCands.push({ value: c.member, excerpt: c.excerpt });
    sizeCands.push({ value: c.size, excerpt: c.excerpt });
    spacingCands.push({ value: c.spacingIn, excerpt: c.excerpt });
    if (c.grade) gradeCands.push({ value: c.grade, excerpt: c.excerpt });
    // A truss's span is the truss designer's, not a span-table input: only a rafter or joist
    // callout's span is the roof's rafter span.
    if (c.member === "truss") continue;
    const after = SPAN_AFTER_CALLOUT.exec(text.slice(c.end, c.end + 60));
    if (after) spanCands.push({ value: feet(after[1], after[2]), excerpt: `${c.excerpt}${after[0]}`.trim().slice(0, 200) });
  }
  for (const m of text.matchAll(SIZE_LABEL)) sizeCands.push({ value: `${m[1]}x${m[2]}`, excerpt: excerptOf(m) });
  for (const m of text.matchAll(SPACING_LABEL)) spacingCands.push({ value: Number(m[1]), excerpt: excerptOf(m) });
  for (const m of text.matchAll(GRADE_LABEL)) gradeCands.push({ value: normalizeLumberGrade(m[1], m[2]), excerpt: excerptOf(m) });
  for (const m of text.matchAll(SPAN_LABEL)) spanCands.push({ value: feet(m[1], m[2]), excerpt: excerptOf(m) });

  const spans = spanCands.filter((s) => s.value > 0 && s.value < 100);
  const longest = spans.length ? spans.reduce((a, b) => (b.value > a.value ? b : a)) : null;
  return {
    framingType: single(typeCands),
    roofRafterSize: single(sizeCands),
    woodGrade: single(gradeCands),
    roofRafterSpacing: single(spacingCands),
    roofRafterSpan: longest,
    lightFrame: callouts.length > 0,
  };
}

// ---------------------------------------------------------------------------------------------
// THE PERMIT PATH THE PLANS STATE.
//
// Read only where the plans SAY it: a labelled field ("PERMIT PATH: PRESCRIPTIVE", "DESIGN PATH:
// NON-PRESCRIPTIVE", "PERMIT TYPE: PRESCRIPTIVE SOLAR"), the checklist question ("PRESCRIPTIVE
// INSTALL?: NO"), or a statement about THIS design ("THIS SYSTEM IS DESIGNED PER THE ENGINEERED
// PATH"). A general note ("IF THE PRESCRIPTIVE PATH CANNOT BE MET, AN ENGINEERED DESIGN IS
// REQUIRED") is a rule, not this job's path: a clause carrying a condition, a requirement or a
// negation is skipped. Plans that state both paths answer nothing (review, not a pick).
// ---------------------------------------------------------------------------------------------

export type StatedPermitPath = "prescriptive" | "engineered";

const PATH_WORD = String.raw`(NON[-\s]?PRESCRIPTIVE|PRESCRIPTIVE|ENGINEERED|ENGINEERING)`;
const PATH_LABEL = new RegExp(
  String.raw`\b(?:PERMIT|DESIGN|STRUCTURAL|INSTALL(?:ATION)?|REVIEW|SOLAR|PV|APPLICATION)\s+(?:PATH|TYPE|METHOD|ROUTE)\s*[:=]\s*${PATH_WORD}\b`,
  "i",
);
const PATH_QUESTION = /\bPRESCRIPTIVE\s+(?:SOLAR\s+)?(?:PV\s+|PHOTOVOLTAIC\s+)?(?:SYSTEM\s+)?INSTALL(?:ATION)?\s*\??\s*[:=]\s*(YES|NO)\b/i;
const PATH_STATEMENT = new RegExp(
  String.raw`\bTHIS\s+(?:PV\s+|SOLAR\s+|PHOTOVOLTAIC\s+)?(?:SYSTEM|DESIGN|INSTALLATION|PROJECT|PERMIT|APPLICATION|SUBMITTAL)\s+(?:IS|HAS\s+BEEN|WAS)\s+(?:(?:DESIGNED|SUBMITTED|PERMITTED|FILED|INSTALLED)\s+)?(?:PER|UNDER|USING|AS|FOR|TO|VIA)\s+(?:THE\s+|AN?\s+)?${PATH_WORD}\b`,
  "i",
);
const PATH_TITLE = new RegExp(String.raw`\b${PATH_WORD}\s+(?:DESIGN\s+)?(?:PATH|ROUTE|SOLAR\s+(?:PERMIT|INSTALLATION|APPLICATION))\b`, "i");
// A clause that sets a condition, states a requirement or negates is a rule, not this job's path.
const PATH_HEDGE = /\b(?:IF|UNLESS|WHEN|WHERE|WHETHER|OTHERWISE|MAY|MIGHT|SHALL|MUST|SHOULD|REQUIRED|REQUIRES?|NOT|NO\b(?!\.)|CANNOT|N\/A|OR)\b/i;

function pathOf(word: string): StatedPermitPath {
  return /^PRESCRIPTIVE$/i.test(word.trim()) ? "prescriptive" : "engineered";
}

/** The permit path the plans state, or null when they state none (or both). */
export function readStatedPermitPath(planText: string): PlanFact<StatedPermitPath> | null {
  const hits: Array<PlanFact<StatedPermitPath>> = [];
  // Clauses: a sentence, a semicolon, or a line. "O.C." and "NO. 2" split harmlessly here.
  for (const raw of String(planText ?? "").split(/[\n;]|\.(?=\s|$)/)) {
    const clause = collapse(raw).trim();
    if (!clause || !/PRESCRIPTIVE|ENGINEER/i.test(clause)) continue;
    const label = PATH_LABEL.exec(clause);
    if (label) { hits.push({ value: pathOf(label[1]), excerpt: label[0].slice(0, 200) }); continue; }
    const question = PATH_QUESTION.exec(clause);
    if (question) {
      hits.push({ value: /^YES$/i.test(question[1]) ? "prescriptive" : "engineered", excerpt: question[0].slice(0, 200) });
      continue;
    }
    // Statements and titles carry no label, so a hedge anywhere in the clause disqualifies them.
    if (PATH_HEDGE.test(clause.replace(/\bNON[-\s]?PRESCRIPTIVE\b/gi, "NONPRESCRIPTIVE"))) continue;
    const statement = PATH_STATEMENT.exec(clause);
    if (statement) { hits.push({ value: pathOf(statement[1]), excerpt: statement[0].slice(0, 200) }); continue; }
    // A bare title ("ENGINEERED DESIGN PATH") counts only for the engineered path. "PRESCRIPTIVE
    // SOLAR INSTALLATION" is also the title of the state's checklist and of code lists that cite it,
    // so on its own it never answers prescriptive: that path is read only from a label, the
    // checklist question or a statement about this design.
    const title = PATH_TITLE.exec(clause);
    if (title && pathOf(title[1]) === "engineered") hits.push({ value: "engineered", excerpt: title[0].slice(0, 200) });
  }
  return single(hits);
}
