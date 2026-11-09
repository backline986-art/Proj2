import type { ParserLlmExtraction } from "../../shared/src/types";
import { classifyRoofCovering, tileAttachmentFromText, tileSubtype } from "./roofCovering";
import { readPlanFraming, readStatedPermitPath, type PlanFact } from "./planFraming";
import { pathWordingScope } from "./permitPath";

/** Explicit plan facts only. This supplements the text intake, including sheets
 * beyond the model's text budget. It never turns a missing fact into compliance. */
export function supplementStructuralIntake(result: ParserLlmExtraction, planText: string): ParserLlmExtraction {
  const fields = { ...result.fields };
  const text = planText.replace(/\s+/g, " ");
  const add = (key: string, re: RegExp, value: (m: RegExpMatchArray) => string | number, explicitLabel = false) => {
    if (!explicitLabel && fields[key]?.value != null && fields[key]?.value !== "") return;
    const matches = [...text.matchAll(new RegExp(re.source, "gi"))];
    const values = [...new Set(matches.map(value))];
    if (values.length !== 1) return; // conflicting sheets require review
    const m = matches[0];
    fields[key] = { value: values[0], confidence: 0.95,
      evidence: { source: "plan_set", sheet: "Structural plan / notes", excerpt: m[0].slice(0, 200) } };
  };
  // A single explicit roof-material label outranks a model guess from metal
  // mounting hardware or generic installation notes elsewhere in the plans.
  add("constructionCategory", /(?:OCCUPANCY(?:\s*(?:TYPE|GROUP|CLASSIFICATION))?|BUILDING\s*(?:TYPE|USE))\s*[:=]\s*(R-?3\b|SINGLE[-\s]FAMILY(?:\s+DWELLING)?)/i,
    m => m[1].toUpperCase());
  add("buildingStories", /(?:NUMBER\s+OF\s+(?:STORIES|FLOORS)|TOTAL\s+(?:STORIES|FLOORS))\s*[:=]\s*(\d+)\b/i, m => Number(m[1]));
  add("parcelNumber", /(?:PARCEL\s*(?:NUMBER|NO\.?|#)|APN)\s*[:=]\s*([A-Z0-9]+(?:[-.]?[A-Z0-9]+)*)/i, m => m[1]);
  add("roofMaterial", /ROOF\s*MATERIAL\s*:\s*(COMPOSITE?\s+SHINGLES?|COMPOSITION\s+SHINGLES?|ASPHALT\s+SHINGLES?|STANDING\s+SEAM\s+METAL|METAL)/i,
    m => /compos|asphalt/i.test(m[1]) ? "Composition Shingle" : "Metal", true);
  // TILE IS NEVER SHINGLE. An explicit tile roof label ("ROOF MATERIAL: CONCRETE S-TILE",
  // "ROOF TYPE: CLAY TILE") outranks a model guess the same way — unless the set ALSO carries an
  // explicit composition/metal label, in which case the sheets conflict and the model's reading
  // stands for review. The subtype and the tile attachment method ride along (roofCovering.ts).
  const tileLabel = /ROOF(?:ING)?\s*(?:MATERIAL|TYPE|COVERING)\s*:\s*((?:CONCRETE|CLAY|TERRA[-\s]?COTTA)?\s*(?:S[-\s]?|FLAT\s+|BARREL\s+|SPANISH\s+|MISSION\s+|SHAKE\s+)?TILES?(?:\s+ROOF(?:ING)?)?)/i;
  const otherLabel = /ROOF\s*MATERIAL\s*:\s*(COMPOSITE?\s+SHINGLES?|COMPOSITION\s+SHINGLES?|ASPHALT\s+SHINGLES?|STANDING\s+SEAM\s+METAL|METAL)/i;
  const tileHit = tileLabel.exec(text);
  if (tileHit && !otherLabel.test(text)) {
    const words = tileHit[1].replace(/\s+ROOF(?:ING)?$/i, "").trim();
    const subtype = tileSubtype(words);
    const titled = words.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
    fields.roofMaterial = { value: titled, confidence: 0.95,
      evidence: { source: "plan_set", sheet: "Structural plan / notes", excerpt: tileHit[0].slice(0, 200) } };
    if (subtype) fields.roofMaterialSubtype = { value: subtype, confidence: 0.95, evidence: { source: "plan_set", sheet: "Structural plan / notes", excerpt: tileHit[0].slice(0, 200) } };
  }
  if (classifyRoofCovering(fields.roofMaterial?.value, fields.roofMaterialSubtype?.value).family === "tile" && !(fields.tileAttachmentMethod?.value)) {
    const methods = tileAttachmentFromText(text);
    // One method named -> that method. Two named (a hook detail AND a comp-out note) -> the
    // model's reading, or nothing: it is a question for the reviewer, not a pick.
    if (methods.length === 1) fields.tileAttachmentMethod = { value: methods[0].method, confidence: 0.9,
      evidence: { source: "plan_set", sheet: "Attachment detail", excerpt: methods[0].quote.slice(0, 200) } };
  }
  // MODULE ELECTRICALS for NEC 690.7 (Iowa SFM worksheet max system voltage). Only when the
  // text states ONE value (add() refuses conflicting sheets — a plan's SLD module table copied
  // from an older set and the real datasheet disagree more often than not; that is review, not a pick).
  add("moduleVoc", /\b(?:OPEN[-\s]CIRCUIT\s+VOLTAGE|V\s?OC)\s*(?:\(V\))?\s*[:=]?\s*(\d{2}(?:\.\d{1,2})?)\s*V\b/i, m => Number(m[1]));
  add("moduleIsc", /\b(?:SHORT[-\s]CIRCUIT\s+CURRENT|I\s?SC)\s*(?:\(A\))?\s*[:=]?\s*(\d{1,2}(?:\.\d{1,2})?)\s*A\b/i, m => Number(m[1]));
  add("moduleVocTempCoeff", /\bTEMPERATURE\s+COEFFICIENT\s+(?:OF\s+)?V\s?OC\s*(?:\(β\)|\(BETA\))?\s*[:=]?\s*(-\s?0?\.\d{1,3})\s*%\s*\/\s*°?\s*[CK]\b/i, m => Number(m[1].replace(/\s/g, "")));
  // THE ROOF FRAMING AND THE PERMIT PATH, OFF THE PLANS (#595; planFraming.ts). Member type, size,
  // lumber grade and spacing fill only what the model left empty, from ONE stated value (two sheets
  // that disagree are review). The span and the path may also correct the model, but only toward the
  // stricter reading: a longer span than the model's (the longest span governs a span table), and
  // "engineered" over a model "prescriptive" when the plans state the engineered path. A plan
  // reading never relaxes what the model read.
  const framing = readPlanFraming(planText);
  const planFact = <T extends string | number>(key: string, fact: PlanFact<T> | null, sheet = "Structural plan / notes") => {
    if (!fact) return;
    fields[key] = { value: fact.value, confidence: 0.95, evidence: { source: "plan_set", sheet, excerpt: fact.excerpt } };
  };
  const empty = (key: string) => fields[key]?.value == null || String(fields[key]?.value).trim() === "";
  if (empty("framingType")) planFact("framingType", framing.framingType);
  if (empty("roofRafterSpacing")) planFact("roofRafterSpacing", framing.roofRafterSpacing);
  if (empty("roofRafterSize")) planFact("roofRafterSize", framing.roofRafterSize);
  if (empty("woodGrade")) planFact("woodGrade", framing.woodGrade);
  if (empty("lightFrame") && framing.lightFrame) {
    const first = framing.roofRafterSize ?? framing.roofRafterSpacing;
    fields.lightFrame = { value: "yes", confidence: 0.95,
      evidence: { source: "plan_set", sheet: "Structural plan / notes", excerpt: first?.excerpt ?? "Dimensioned lumber framing callout" } };
  }
  if (framing.roofRafterSpan) {
    const modelSpan = empty("roofRafterSpan") ? null : spanFeet(fields.roofRafterSpan.value);
    if (modelSpan == null || modelSpan < framing.roofRafterSpan.value) planFact("roofRafterSpan", framing.roofRafterSpan);
  }
  const statedPath = readStatedPermitPath(planText);
  if (statedPath) {
    const modelPath = pathWordingScope(empty("permitPath") ? "" : String(fields.permitPath.value));
    if (!modelPath || (modelPath === "prescriptive" && statedPath.value === "engineered")) planFact("permitPath", statedPath, "Plan set (stated permit path)");
  }
  add("moduleHeightAboveRoof", /PANELS? WILL NOT MOUNT HIGHER\s*THAN\s*(\d+)\s*INCHES ABOVE THE SURFACE OF\s*THE ROOF/i, m => Number(m[1]));
  add("roofLayers", /(?:EXISTING\s+)?(?:ROOF(?:ING)?\s+LAYERS?\s*[:=]\s*)(\d+)/i, m => Number(m[1]));
  add("attachmentToFraming", /SOLAR PANELS ARE TO BE MOUNTED TO THE ROOF\s*FRAMING/i, () => "yes");
  add("attachmentSpacingIn", /(?:NEW\s+)?PV ATTACHMENTS AT\s*(\d+)'[-\s]*(\d+)"\s*O\.?C/i, m => Number(m[1]) * 12 + Number(m[2]));
  add("attachmentEdgeSpacingIn", /ROOF ATTACHMENTS SHALL BE SPACED NO\s*GREATER THAN\s*(\d+)\s*IN\.?\s*OC IN ANY DIRECTION\s*WHERE LOCATED WITHIN\s*3\s*FT\.?\s*OF A ROOF\s*EDGE, HIP, EAVE OR RIDGE/i, m => Number(m[1]));
  add("manufacturerInstallation", /RACKING SYSTEM\s*&\s*PV ARRAY WILL BE INSTALLED ACCORDING TO CODE[-\s]*COMPLIANT INSTALLATION MANUAL/i, () => "yes");
  return { ...result, fields };
}

/** A span the model wrote, in feet: "11.5", "11'-6\"", "11 ft 6 in". NaN-free: null when unreadable. */
function spanFeet(value: unknown): number | null {
  const v = String(value ?? "").trim();
  const ftIn = /(\d+(?:\.\d+)?)\s*(?:'|’|ft\b\.?|feet\b)\s*-?\s*(?:(\d+(?:\.\d+)?)\s*(?:"|”|in\b|inch))?/i.exec(v);
  const n = ftIn ? Number(ftIn[1]) + (ftIn[2] ? Number(ftIn[2]) / 12 : 0) : Number.parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Include later structural notes/datasheets instead of silently discarding
 * everything after the first 24k characters. Bound the request at 80k. */
export function planTextForExtraction(text: string): string {
  return text.length <= 80000 ? text : text.slice(0, 60000) + "\n[Middle text omitted]\n" + text.slice(-20000);
}
