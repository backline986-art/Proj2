// THE READABLE TEXT OF AN EMAIL (mbox import, watched mailboxes).
//
// The mbox reader used to hand the classifier the raw body: MIME boundaries, part headers,
// quoted-printable soft breaks ("=\n", "=3D"), base64 blocks and whole HTML documents with their
// CSS. The back-test of the operator's imported mailbox (2026-11-23) found the stored samples were
// header and style noise, and words in that noise decided the category: an email footer's
// "signature" read as a missing owner signature, and any "application" or "form" anywhere read as a
// missing application form.
//
// This decodes one RFC 822 message body into plain text:
//   - multipart: walks the parts (nested too); prefers text/plain, falls back to text/html; skips
//     attachments and non-text parts;
//   - Content-Transfer-Encoding base64 and quoted-printable are decoded, then the part's charset;
//   - HTML becomes text (style/script/head dropped, block tags become line breaks, entities decoded);
//   - RFC 2047 encoded words in a header ("=?UTF-8?Q?...?=") are decoded.
// `currentMessageText` keeps only the newest message of a reply chain (the quoted history and the
// sender's signature block are not what this email asks for).
//
// Pure, no I/O, no network. Never throws: anything it cannot decode is returned as it came.

export type MimeHeaders = Record<string, string>;

function headerParam(value: string, name: string): string {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(value || "");
  return (m?.[1] ?? m?.[2] ?? "").trim();
}

function decodeBytes(bytes: Buffer, charset: string): string {
  const cs = (charset || "utf-8").trim().toLowerCase();
  try {
    return new TextDecoder(cs === "us-ascii" || cs === "ascii" ? "utf-8" : cs).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

/** Quoted-printable to bytes: "=\n" soft breaks removed, "=XX" hex escapes decoded. */
function quotedPrintableBytes(value: string): Buffer {
  const soft = value.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const ch = soft[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      out.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      // The mbox was read as UTF-8 text: an unescaped non-ASCII character is already decoded.
      for (const b of Buffer.from(ch, "utf8")) out.push(b);
    }
  }
  return Buffer.from(out);
}

function decodeTransfer(body: string, encoding: string, charset: string): string {
  const enc = (encoding || "").trim().toLowerCase();
  try {
    if (enc === "base64") return decodeBytes(Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64"), charset);
    if (enc === "quoted-printable") return decodeBytes(quotedPrintableBytes(body), charset);
  } catch {
    return body;
  }
  return body;
}

const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', ndash: "-", mdash: "-", hellip: "...", bull: "*", middot: "*", copy: "(c)", reg: "(R)", trade: "(TM)",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#x")) { const n = parseInt(lower.slice(2), 16); return Number.isFinite(n) ? String.fromCodePoint(n) : whole; }
    if (lower.startsWith("#")) { const n = parseInt(lower.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : whole; }
    return ENTITIES[lower] ?? whole;
  });
}

/** HTML to readable text: what a person would see, one block per line. */
export function htmlToPlainText(html: string): string {
  return decodeEntities(
    String(html || "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|section|article)\s*>/gi, "\n")
      .replace(/<(p|div|tr|li|h[1-6]|table|blockquote)\b[^>]*>/gi, "\n")
      .replace(/<\/t[dh]\s*>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** RFC 2047 encoded words in a header value ("=?UTF-8?Q?Permit_issued?=", "=?utf-8?B?...?="). */
export function decodeEncodedWords(value: string): string {
  return String(value || "")
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, kind: string, data: string) => {
      try {
        if (kind.toUpperCase() === "B") return decodeBytes(Buffer.from(data, "base64"), charset);
        return decodeBytes(quotedPrintableBytes(data.replace(/_/g, " ")), charset);
      } catch {
        return whole;
      }
    });
}

function splitHeaders(part: string): { headers: MimeHeaders; body: string } {
  const normalized = part.replace(/\r\n/g, "\n");
  const cut = normalized.search(/\n\n/);
  const rawHeaders = cut >= 0 ? normalized.slice(0, cut) : normalized;
  const body = cut >= 0 ? normalized.slice(cut + 2) : "";
  // A part that does not start with headers has none: the whole of it is body.
  if (!/^[A-Za-z][\w-]*:/.test(rawHeaders.trimStart())) return { headers: {}, body: normalized.replace(/^\n+/, "") };
  const headers: MimeHeaders = {};
  let current = "";
  for (const line of rawHeaders.split("\n")) {
    if (/^\s/.test(line) && current) { headers[current] = `${headers[current]} ${line.trim()}`; continue; }
    const i = line.indexOf(":");
    if (i > 0) { current = line.slice(0, i).trim().toLowerCase(); headers[current] = line.slice(i + 1).trim(); }
  }
  return { headers, body };
}

type TextPart = { kind: "plain" | "html"; text: string };

function collectTextParts(headers: MimeHeaders, body: string, depth: number, out: TextPart[]): void {
  const contentType = headers["content-type"] || "text/plain";
  const type = contentType.split(";")[0].trim().toLowerCase();
  const disposition = (headers["content-disposition"] || "").toLowerCase();
  if (depth > 6) return;
  if (type.startsWith("multipart/")) {
    const boundary = headerParam(contentType, "boundary");
    if (!boundary) { out.push({ kind: "plain", text: body }); return; }
    const marker = `--${boundary}`;
    const pieces = body.split(marker).slice(1);
    for (const piece of pieces) {
      if (piece.startsWith("--")) break; // the closing boundary
      const sub = splitHeaders(piece.replace(/^[ \t]*\r?\n/, ""));
      collectTextParts(sub.headers, sub.body, depth + 1, out);
    }
    return;
  }
  if (disposition.startsWith("attachment")) return;
  if (type === "message/rfc822") {
    const sub = splitHeaders(body);
    collectTextParts(sub.headers, sub.body, depth + 1, out);
    return;
  }
  if (type !== "text/plain" && type !== "text/html") return;
  const decoded = decodeTransfer(body, headers["content-transfer-encoding"] || "", headerParam(contentType, "charset"));
  out.push({ kind: type === "text/html" ? "html" : "plain", text: decoded });
}

/**
 * The readable text of a message body, given its top-level headers (lower-cased names). Plain
 * parts win; HTML parts are converted when a message has no plain part. Never throws.
 */
export function decodeMimeBody(headers: MimeHeaders, body: string): string {
  try {
    const parts: TextPart[] = [];
    collectTextParts(headers, String(body || "").replace(/\r\n/g, "\n"), 0, parts);
    const plain = parts.filter((p) => p.kind === "plain" && p.text.trim());
    const chosen = plain.length ? plain.map((p) => p.text) : parts.filter((p) => p.kind === "html").map((p) => htmlToPlainText(p.text));
    // A "plain" part that is really HTML (some senders mislabel) still reads as text.
    const text = chosen.map((t) => (/<(?:html|body|div|table|p)\b/i.test(t) ? htmlToPlainText(t) : t)).join("\n\n");
    return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return String(body || "");
  }
}

// Where the newest message of a reply chain ends: the quoted history begins.
const QUOTE_START = [
  /^\s*On\b[^\n]{0,200}\bwrote:\s*$/im,
  /^\s*-{2,}\s*Original Message\s*-{2,}/im,
  /^\s*-{2,}\s*Forwarded message\s*-{2,}/im,
  /^\s*From:\s[^\n]+\n\s*(?:Sent|Date):\s/im,
  /^\s*_{10,}\s*$/m,
];
// A sender's signature block: "-- " on its own line (RFC 3676) or a confidentiality footer.
const SIGNATURE_START = [/^-- ?$/m, /^\s*(?:CONFIDENTIALITY|DISCLAIMER|This (?:e-?mail|message) (?:and any attachments )?(?:is|may be) (?:confidential|intended))/im];

/** The newest message only: quoted replies, ">" lines and the signature block are left out. */
export function currentMessageText(text: string): string {
  let out = String(text || "");
  for (const re of [...QUOTE_START, ...SIGNATURE_START]) {
    const m = re.exec(out);
    if (m && m.index > 0) out = out.slice(0, m.index);
  }
  return out
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();
}
