// ---------------------------------------------------------------------------
// NO DEAD LINK REACHES A CLIENT (go-live readiness, owner 2026-11-10).
//
// Every client-facing email carries a link built from PUBLIC_BASE_URL: the status page, the
// one-time login page, the intake page, the client tracker. When PUBLIC_BASE_URL is unset the
// builders fall back to http://localhost:<port>, and a client who clicks it reaches their own
// computer. Two doors (request links, the intake reply) already kept such a message as a draft;
// the status update, the installer handoff, the backlog re-send and the invoice did not, so a
// half-configured server mailed real clients links that could never open.
//
// ONE ANSWER, asked by every client send path before it sends: clientLinkRefusal. It only ever
// ADDS a refusal: a message it lets through is exactly the message the path sent before, and a
// refused one is recorded the way each path already records "not sent" (a CRM draft carrying the
// reason, so a person sees why and can send it by hand once the setting is fixed). It never
// changes a link, a recipient or a body.
//
// The strict default (owner, 2026-11-09): a base a client cannot open is refused. That is unset,
// unparseable, not http(s), a loopback / private / link-local / unspecified IP literal, or a host
// name that only resolves inside a network (localhost and its family, a single-label name, the
// private-use suffixes below). No DNS lookup: the answer is synchronous and offline, so a send
// path cannot be slowed or steered by a resolver. Reserved test names (.example, .test, .invalid)
// are NOT refused here: the suites use them as synthetic public hosts and an operator never sets one.
//
// The body is ALSO scanned, whatever the base says: an http(s) link in the text or HTML whose host
// is one of the above refuses the send. That catches a message drafted while the base was unset
// (its link is frozen into the prose) and any link a path builds some other way.
//
// Staff-only messages (staff alerts, the digest) are not client mail and do not ask this.
// ---------------------------------------------------------------------------
import net from "node:net";
import { ipIsPrivate } from "./publicUrlGuard";

/** Every refusal's delivery_detail starts with this, so the go-live check and the CRM can count
 *  and name the messages the guard held back without parsing prose. */
export const CLIENT_LINK_REFUSAL_PREFIX = "Not sent: dead client link.";

/** Host suffixes that only resolve inside a network (RFC 6761/6762/8375 and common LAN names). */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".intranet", ".corp", ".localdomain"];

/** Why a client could not open a link on this host, or null when the host is public-shaped. */
export function deadLinkHostReason(hostname: string): string | null {
  const host = String(hostname ?? "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  if (!host) return "it has no host";
  if (net.isIP(host)) return ipIsPrivate(host) ? `${host} is a private or local address` : null;
  if (host === "localhost") return "localhost is the reader's own computer";
  if (!host.includes(".")) return `${host} is a single-label name that only resolves inside a network`;
  const suffix = PRIVATE_SUFFIXES.find((s) => host.endsWith(s));
  if (suffix) return `${host} ends in ${suffix}, which only resolves inside a network`;
  return null;
}

/** Why PUBLIC_BASE_URL cannot carry a client link, or null when it can. Reads only the env given. */
export function publicBaseUrlProblem(env: Record<string, string | undefined> = process.env): string | null {
  const raw = String(env.PUBLIC_BASE_URL ?? "").trim();
  if (!raw) return "PUBLIC_BASE_URL is not set, so every client link would point at this machine (localhost)";
  let u: URL;
  try { u = new URL(raw); } catch { return "PUBLIC_BASE_URL is not a URL, so no client link can be built from it"; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return `PUBLIC_BASE_URL uses ${u.protocol}, not http(s)`;
  if (u.username || u.password) return "PUBLIC_BASE_URL carries a user name or password; set the plain address";
  const why = deadLinkHostReason(u.hostname);
  return why ? `PUBLIC_BASE_URL points at a host a client cannot reach (${why})` : null;
}

/** PUBLIC_BASE_URL reduced to scheme://host[:port] for display: never a path, query or user info. */
export function publicBaseOrigin(env: Record<string, string | undefined> = process.env): string {
  try { return new URL(String(env.PUBLIC_BASE_URL ?? "").trim()).origin; } catch { return ""; }
}

const LINK_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

/** The dead hosts linked from this text (deduplicated), each with its reason. */
export function deadLinksIn(text: string): Array<{ host: string; reason: string }> {
  const out: Array<{ host: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const m of String(text ?? "").matchAll(LINK_RE)) {
    let host = "";
    try { host = new URL(m[0]).hostname; } catch { continue; }
    const reason = deadLinkHostReason(host);
    if (!reason || seen.has(host.toLowerCase())) continue;
    seen.add(host.toLowerCase());
    out.push({ host, reason });
  }
  return out;
}

/**
 * THE ONE ANSWER for every client send path: why this message must NOT go to the client, or null.
 * `carriesLink` false is only for a message that holds no link built from PUBLIC_BASE_URL (the
 * invoice today); its body is still scanned. Never throws.
 */
export function clientLinkRefusal(
  message: { body?: string; html?: string; carriesLink?: boolean },
  env: Record<string, string | undefined> = process.env,
): string | null {
  try {
    if (message.carriesLink !== false) {
      const problem = publicBaseUrlProblem(env);
      if (problem) return `${CLIENT_LINK_REFUSAL_PREFIX} ${problem}. Set PUBLIC_BASE_URL to the address clients open, then send this by hand.`;
    }
    const dead = deadLinksIn(`${message.body ?? ""}\n${message.html ?? ""}`);
    if (dead.length) {
      return `${CLIENT_LINK_REFUSAL_PREFIX} A link in this email points at ${dead[0].host} (${dead[0].reason}), which a client cannot open. Fix PUBLIC_BASE_URL, then send this by hand.`;
    }
    return null;
  } catch {
    return `${CLIENT_LINK_REFUSAL_PREFIX} The links in this email could not be checked, so it was not sent.`;
  }
}
