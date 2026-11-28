// THE PARSER'S SERVER HALF, IN ONE PLACE.
//
// The Parser page reads the documents' text in the browser and posts it to
// /api/parser/llm-extract; this is what that route does with it: the model's read, the
// deterministic supplements (structural intake, the packet's own application page, the AC
// disconnect callout), the hybrid image-page merge, and the client suggestion from the plan
// set's title block. Email-in intake (#489) reads the same documents on the server and calls the
// same function, so the two doors cannot disagree about what a plan set says.
import type { AppDb } from "./db";
import type { ClientResolution, LLMProvider, ParserExtractionResponse } from "../../shared/src/types";
import { logger } from "./logger";
import type { ScannedPlanRead } from "./scannedPlanSet";

/**
 * THE PLAN SET'S IMAGE READ, ONE PATH FOR EVERY DOOR. A plan set's image-only pages (datasheets
 * pasted in as pictures) hold fields its text layer cannot reach; scannedPlanSet reads them by
 * vision under its own caps (MAX_VISION_PAGES, MAX_VISION_BYTES), and the server notes what that
 * read said about the AC disconnect, keyed by these bytes and the caller's org (#135). The Parser
 * page's /api/parser/plan-scan-extract route and the unattended doors (email intake, bulk drop)
 * both call THIS, so neither can read a set the other would not. A failed note never takes down
 * the read. Model and render errors propagate: each door owns how it reports them.
 */
export async function readPlanSetImagePages(
  db: AppDb,
  llm: Pick<LLMProvider, "extractProjectFields" | "classifyPlanPages" | "orientPlanPages">,
  pdfBytes: Uint8Array,
  opts: { orgId: string; defaultState?: string },
): Promise<ScannedPlanRead> {
  const { readPlanSetForExtraction } = await import("./scannedPlanSet");
  const read = await readPlanSetForExtraction(llm, pdfBytes, { defaultState: opts.defaultState });
  if (read.mode !== "text" && read.extraction) {
    try {
      const { recordPlanSetImageRead } = await import("./planSetImageReads");
      recordPlanSetImageRead(db, opts.orgId, pdfBytes, read.extraction);
    } catch (err) { logger.warn("parser", "could not note the plan set's image read", { err: err instanceof Error ? err.message : String(err) }); }
  }
  return read;
}

/**
 * THE UNATTENDED DOORS' READ (email intake, bulk drop): the documents' text AND, when the plan set
 * has a text layer with image-only pages, those pages by vision — the same two reads the Parser
 * page makes, merged the same way (the text read wins every field it answered). Before this the
 * unattended doors passed text only, so a datasheet pasted in as a picture was read by nobody.
 *   - only a set WITH text is read this way (hybrid). A pure scan stays where it was: no text, so
 *     no address, so it lands unsorted for a person;
 *   - the stub provider (no model key) reads nothing, as on the page;
 *   - a failed image read never fails the intake: the text read stands and the failure is said in
 *     the notes, which the parse-review record keeps.
 */
export async function extractParserFieldsFromDocuments(
  db: AppDb,
  llm: LLMProvider,
  input: ParserExtractionInput & { planSetPdf?: Uint8Array },
  orgId: string,
): Promise<ParserExtractionResponse> {
  const { planSetPdf, ...texts } = input;
  let planImageRead: unknown;
  let imageReadFailure = "";
  if (planSetPdf?.length && (texts.planText ?? "").trim()) {
    try {
      const read = await readPlanSetImagePages(db, llm, planSetPdf, { orgId, defaultState: texts.defaultState });
      if (read.mode === "hybrid" && read.extraction && read.extraction.provider !== "stub") planImageRead = read.extraction;
    } catch (err) {
      imageReadFailure = err instanceof Error ? err.message : String(err);
      logger.warn("parser", "the plan set's image-only pages could not be read at intake", { error: imageReadFailure });
    }
  }
  const extraction = await extractParserFields(db, llm, { ...texts, ...(planImageRead ? { planImageRead } : {}) }, orgId);
  if (!imageReadFailure) return extraction;
  return {
    ...extraction,
    imagePagesReadFailed: true,
    notes: [`IMAGE-ONLY PAGES NOT READ: the plan set's picture pages could not be read by vision (${imageReadFailure.slice(0, 200)}). Check the datasheet values by hand.`, extraction.notes].filter(Boolean).join(" "),
  };
}

export interface ParserExtractionInput {
  planText?: string;
  utilityBillText?: string;
  meterText?: string;
  structuralLetterText?: string;
  defaultState?: string;
  /** The hybrid plan set's image-page read (/api/parser/plan-scan-extract), merged UNDER the text read. */
  planImageRead?: unknown;
}

/**
 * Extract project fields from document text. `orgFilter` scopes the client suggestion (the same
 * filter every other read takes: a string is one org, null every org). Model errors propagate to
 * the caller, which owns how they are reported; a failed client suggestion never takes down a
 * parse that otherwise worked.
 */
export async function extractParserFields(
  db: AppDb,
  llm: LLMProvider,
  input: ParserExtractionInput,
  orgFilter: string | null,
): Promise<ParserExtractionResponse> {
  const planText = input.planText ?? "";
  const result = await llm.extractProjectFields({
    planText,
    utilityBillText: input.utilityBillText ?? "",
    meterText: input.meterText ?? "",
    structuralLetterText: input.structuralLetterText ?? "",
    defaultState: input.defaultState,
  });
  const { supplementStructuralIntake } = await import("./structuralIntake");
  let extraction = supplementStructuralIntake(result, planText);
  // The packet's own permit application / contract page (contract value, homeowner phone) and
  // the racking callouts, read deterministically with their source page cited (#201).
  const { supplementPacketApplication } = await import("./packetApplication");
  extraction = supplementPacketApplication(extraction, planText);
  // The AC disconnect's make / model (and amps / fusing) from its own SLD / schedule callout (#384).
  const { supplementAcDisconnect } = await import("./acDisconnectIntake");
  extraction = supplementAcDisconnect(extraction, planText);
  // HYBRID PLAN SET: the parser page first posted the PDF to /api/parser/plan-scan-extract, which
  // read the set's image-only pages (datasheets pasted in as pictures) by vision; that read rides
  // back here and is merged UNDER this text read — the text wins every field it answered
  // (scannedPlanSet.mergeImagePageRead validates the posted shape).
  if (input.planImageRead && typeof input.planImageRead === "object") {
    const { mergeImagePageRead } = await import("./scannedPlanSet");
    extraction = mergeImagePageRead(extraction, input.planImageRead);
  }
  // WHICH COMPANY IS THIS? The prompt has always read the title-block installer and
  // always dropped it. Resolve it here, on the response the parser page already
  // waits for, so the (still required) client picker can fill itself instead of
  // asking the coordinator to pick blind. Tenancy-scoped with the same org filter
  // every other read uses — suggesting another tenant's company would be exactly
  // the cross-company error this feature exists to prevent. A resolution failure
  // must never take down a parse that otherwise worked.
  let clientResolution: ClientResolution | undefined;
  try {
    const { resolveClientForExtraction } = await import("./clientMatch");
    clientResolution = resolveClientForExtraction(db, extraction.fields, orgFilter, planText);
  } catch (err) {
    logger.warn("parser", "client resolution failed — parse returned without a client suggestion", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // PAGES THE TEXT READ NEVER SAW (#697). Over the prompt's bound whole pages are dropped from the
  // middle of the set (structuralIntake.planTextForExtractionWindow, the same window the prompt
  // used); the parser page names them so a person checks those sheets by hand.
  const { planTextForExtractionWindow } = await import("./structuralIntake");
  const notRead = planText.trim() ? planTextForExtractionWindow(planText).omittedPages : [];
  return { ...extraction, clientResolution, ...(notRead.length ? { planTextPagesNotRead: notRead } : {}) };
}
