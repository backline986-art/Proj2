// The track card's view of a track waiting on payment (#576). Kept apart from feePause.ts (a leaf)
// because it reads the credential store and the fee agreement.
import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { listPortalCredentials, selectCredentialUrlsFor } from "./portalCredentials";
import { feeResponsibilityNow } from "./submissionFees";
import { portalHostOf, trackSafeUrl } from "./portalChannel";
import { AWAITING_PAYMENT, feeStopOf, paymentNeededSentence, str, type Row } from "./feePause";

/** What the track card shows while a track waits on payment. */
export interface TrackPaymentView {
  runId: string;
  since: string;
  sentence: string;
  /** Amount read off the page, or null when it could not be read (never 0). */
  amountUsd: number | null;
  unreadReason: string;
  lines: Array<{ label: string; amountUsd: number }>;
  /** The masked screenshot, served by the project-scoped review-screenshot route. */
  screenshotUrl: string;
  /** The portal (the track's own, already rule-5 safe) and the login on file for it. */
  portalUrl: string;
  loginUsername: string;
  /** Who pays this portal's fees, as agreed (portal_credentials.fee_responsibility); "" = unrecorded. */
  feeResponsibility: string;
  /** "Open the saved application": the page the stop happened on, ONLY on the track's own portal
   *  host (rule 5). "" when there is none or it is on any other host. */
  applicationLink: string;
}

/**
 * The newest staging run of this track family when it waits on payment, as the card shows it;
 * null otherwise. `trackPortalUrl` is the card's own portal (the recipe's, or the KB's — already
 * passed through the track's rule-5 filter); a link elsewhere is never shown.
 */
export function trackPaymentView(
  db: AppDb,
  project: ProjectRecord,
  track: string,
  family: string[],
  trackPortalUrl: string | undefined,
): TrackPaymentView | null {
  if (!family.length) return null;
  const run = db.get<Row>(
    `SELECT id, status, started_at, result_json, screenshots_path FROM portal_runs
      WHERE project_id = ? AND permit_type IN (${family.map(() => "?").join(",")}) AND run_type = 'prepare_submit'
      ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    [project.id, ...family],
  );
  if (!run || str(run.status) !== AWAITING_PAYMENT) return null;
  let result: Row | null = null;
  try { result = JSON.parse(str(run.result_json) || "{}") as Row; } catch { result = null; }
  const fee = feeStopOf(result);
  const portalUrl = trackSafeUrl(track, str(trackPortalUrl).trim());
  const host = portalUrl ? portalHostOf(portalUrl) : "";
  // The application's own page: the fee stop's link, else the run's draft reference. Shown only on
  // the SAME host as the track's portal, and only when that host is safe for this track (rule 5).
  const draft = result && typeof result.draftReference === "object" && result.draftReference ? (result.draftReference as Row) : null;
  const candidate = fee?.pageLink || str(draft?.link);
  const applicationLink = candidate && host && /^https?:\/\//i.test(candidate) && trackSafeUrl(track, candidate)
    && portalHostOf(candidate) === host ? candidate : "";
  // The login on file for THIS portal (username only — the secret is never read here).
  let loginUsername = "";
  let feeResponsibility = "";
  try {
    const clientId = str(project.clientId);
    const creds = clientId && portalUrl ? listPortalCredentials(db, clientId) : [];
    const usable = creds.length ? selectCredentialUrlsFor(portalUrl, creds.map((c) => c.portalUrl)) : [];
    const cred = usable.length ? creds.find((c) => c.portalUrl === usable[0]) : undefined;
    if (cred) { loginUsername = cred.usernameReference; feeResponsibility = cred.feeResponsibility; }
  } catch { /* an unreadable credential store names no login */ }
  if (!feeResponsibility) feeResponsibility = feeResponsibilityNow(db, project, track === "nem" ? "nem" : "permit");
  return {
    runId: str(run.id),
    since: str(run.started_at),
    sentence: paymentNeededSentence({ feeStop: fee, portalName: str(result?.portalName) || host }),
    amountUsd: fee?.read ? fee.totalUsd : null,
    unreadReason: fee?.read ? "" : (fee?.unreadReason || "the page the run stopped on was not read"),
    lines: fee?.lines ?? [],
    screenshotUrl: str(run.screenshots_path) ? `/api/projects/${encodeURIComponent(project.id)}/portal-runs/${encodeURIComponent(str(run.id))}/review-screenshot` : "",
    portalUrl,
    loginUsername,
    feeResponsibility,
    applicationLink,
  };
}
