// A PAGE THAT NAMES AN APPLICATION ALREADY IN PROGRESS (#351).
//
// After the permit-type tile a portal can show a no-field notice: "You have an application in
// progress. Draft 2026-0141, 77 Other Ave." with one Continue. That Continue opens SOMEBODY's draft —
// the account's, not this run's — and a learner that takes it types this project over that draft and
// saves it. The learner never resumes a draft on a planner's say-so: on such a page it either starts
// its OWN application (a control that says so: "Start a New Application") or stops and names the
// notice. The one door that resumes a draft is the continue-draft path (#302), which opens only the
// draft that matches this project.
//
// Portal-agnostic wording, read from the page's (already redacted) text. Deliberately NARROWER than
// shared/src/infoPagePass.ts's DRAFT_NOTICE: that one REFUSES a verified-page pass (any "draft" or "in
// progress" at all, fail-closed), whereas this one STOPS a walk, so it must not fire on a form's
// "Save as draft" button, a status column reading "Application Draft", or "work in progress" prose.

/** The notice's sentences, most specific first. Each names an application/draft that already exists. */
const NOTICE_PATTERNS: RegExp[] = [
  // "You have an application in progress", "There are 2 requests not yet submitted"
  /\b(?:you\s+have|you've|there\s+(?:is|are))\s+(?:(?:an?|one|\d+|some|other|existing|unfinished|incomplete)\s+){0,2}(?:applications?|drafts?|requests?|submissions?)\s+(?:(?:that|which)\s+(?:is|are)\s+)?(?:still\s+)?(?:in[\s-]progress|saved|started|unfinished|incomplete|unsubmitted|not\s+(?:yet\s+)?(?:been\s+)?submitted)\b/i,
  // "Saved applications:", "Your in-progress application", "unfinished drafts"
  /\b(?:saved|in[\s-]progress|unfinished|incomplete|unsubmitted)\s+(?:applications?|drafts?|requests?|submissions?)\b/i,
  // "Continue your saved application", "Resume an existing draft"
  /\b(?:continue|resume|finish|complete)\s+(?:your|an?|the)\s+(?:saved|existing|previous|unfinished|incomplete|draft|in[\s-]progress)\s+(?:applications?|drafts?|requests?|submissions?)\b/i,
  // "Draft 2026-0141", "Draft #A-1234", "Draft No. 88812" — a draft named by its number
  /\bdraft\s*(?:#|no\.?|number|id)?\s*:?\s*(?=[A-Z0-9-]*\d)[A-Z]{0,6}-?\d[A-Z0-9-]{2,}\b/i,
];

/** The notice the page shows about an existing application, as one short line for a stop message —
 *  or null when the page names none. */
export function readExistingApplicationNotice(text: string): string | null {
  // A page's text is blocks (menus, headings, paragraphs) one per line: a sentence never spans two.
  const sentences = String(text ?? "").split(/\n+|(?<=[.!?:])\s+/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
  const names = (s: string): boolean => NOTICE_PATTERNS.some((re) => re.test(s));
  const i = sentences.findIndex(names);
  if (i < 0) return null;
  // The next sentence too when it carries the draft's number ("…in progress. Draft 2026-0141, 77
  // Other Ave.") — the person reads WHICH draft the walk stopped on.
  const byNumber = NOTICE_PATTERNS[NOTICE_PATTERNS.length - 1];
  const next = sentences[i + 1];
  const line = !byNumber.test(sentences[i]) && next && byNumber.test(next) ? `${sentences[i]} ${next}` : sentences[i];
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/** A control that starts the run's OWN application ("Start a New Application", "New Request",
 *  "Create New", "Begin Another Application") — never one that continues, resumes, opens or starts
 *  OVER an existing one (a "Start Over" can discard somebody's draft). */
export function isStartNewApplicationControl(label: string): boolean {
  const l = String(label ?? "").replace(/\s+/g, " ").trim();
  if (!l) return false;
  if (/\b(?:continue|resume|existing|saved|draft|edit|open|view|over|again|discard|delete|cancel|withdraw|copy|clone|amend|modify|renew)\b/i.test(l)) return false;
  return /\bnew\b|\banother\b/i.test(l);
}
