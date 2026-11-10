// ===========================================================================
// filing-destination.js — PROPOSED FILING DESTINATIONS on a job's track groups, confirmed by one
// click (owner, 2026-11-10; backend/src/filingDestinationProposals.ts). No DOM, no network.
//
// Where a filing goes (a portal address, an email address, "filed inside the city's permit") stays a
// PERSON's fact: nothing proposed here is used until a named person confirms it. Keelix pre-fills the
// destination it read on the authority's own official page, with the page link and the page's own
// words, so confirming is one click per city or utility, done once. Edit and Reject are one click too.
//
// For each authority the GET /api/projects/:id/filing-destinations route returns, this renders:
//   - VERIFIED: nothing (the track card and the verify control already say who verified what);
//   - PROPOSED: each proposal — the address, "Proposed — not yet confirmed", the official page (link,
//     http(s) only, its host and the date it was read), the page's words, whether those words contain
//     the address (else: the address is the link behind them, open the page), and Confirm / Edit /
//     Reject. Confirm is DISABLED with the reasons when the server says it would be refused;
//   - the proposals a person rejected (who, when, why) with "Offer again";
//   - candidates that were not proposed and why (not an official page, no words), folded away.
// dashboard.js does the clicks (named-person confirm first, then the route). Universal: no city,
// utility, portal or state is special. dashboard.html loads it as a classic script
// (window.FilingDestination); backend/test/filingDestinationControl.test.ts loads it through node:vm.
// Every interpolated value is escaped.
// ===========================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.FilingDestination = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
  const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
  const httpUrl = (u) => (/^https?:\/\/[^\s]+$/i.test(str(u)) ? str(u) : '');
  const day = (iso) => str(iso).slice(0, 10);

  const KIND = { portal: 'Application portal', email: 'Applications by email to', with_permit: 'Filed inside the AHJ permit application' };
  const FROM = { reference: 'reference data', permit_lookup: 'per-job permit lookup', utility_lookup: "utility's filing lookup" };

  /** Which authority kinds a track group shows: the utility group shows the utility's, the permit group the AHJ's. */
  function forGroup(payload, authorityKind) {
    const list = payload && Array.isArray(payload.destinations) ? payload.destinations : [];
    return list.filter((d) => d && d.authority && d.authority.kind === authorityKind);
  }

  function addressLine(p) {
    if (p.kind === 'with_permit') return `<strong>${esc(KIND.with_permit)}</strong>${p.name ? ` (${esc(p.name)})` : ''}`;
    return `${esc(KIND[p.kind] || p.kind)}: <code>${esc(p.address)}</code>`;
  }

  function proposalHtml(d, p) {
    const track = (d.tracks || [])[0] || '';
    const link = httpUrl(p.sourceUrl);
    const source = link
      ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(p.sourceHost || link)}</a>`
      : esc(p.sourceUrl);
    const names = p.kind === 'with_permit' ? ''
      : p.quoteNamesAddress
        ? '<span class="muted">The page\'s words contain this address.</span>'
        : '<span class="warn">The page\'s words do not contain this address: it is the link behind them. Open the page and check it before confirming.</span>';
    const problems = (p.problems || []).length
      ? `<p class="warn">Cannot be confirmed: ${esc(p.problems.join('; '))}</p>` : '';
    const disabled = (p.problems || []).length ? ' disabled' : '';
    const attrs = `data-fd-track="${esc(track)}" data-fd-id="${esc(p.id)}"`;
    return `<div class="fd-proposal" data-fd-proposal="${esc(p.id)}">
  <div>${addressLine(p)} <span class="badge">Proposed — not yet confirmed</span></div>
  <div class="muted">From ${source} (${p.official === false ? 'not an official page: Edit only' : 'official page'}), read ${esc(day(p.fetchedAt))}, via the ${esc(FROM[p.from] || p.from)}.</div>
  <blockquote class="fd-quote">${esc(p.quote)}</blockquote>
  ${names}
  ${problems}
  <div class="fd-actions">
    <button type="button" class="btn btn-primary" data-fd-confirm ${attrs}${disabled}>Confirm (I checked the page)</button>
    <button type="button" class="btn" data-fd-edit ${attrs}>Edit</button>
    <button type="button" class="btn" data-fd-reject ${attrs}>Reject</button>
  </div>
  <div class="fd-edit" data-fd-edit-slot="${esc(p.id)}" hidden>
    <label>Address <input type="text" data-fd-field="address" value="${esc(p.address)}"${p.kind === 'with_permit' ? ' disabled' : ''}></label>
    <label>Page you read it on <input type="url" data-fd-field="sourceUrl" value="${esc(p.sourceUrl)}"></label>
    <label>The page's words <textarea data-fd-field="quote" rows="3">${esc(p.quote)}</textarea></label>
    <input type="hidden" data-fd-field="kind" value="${esc(p.kind)}">
    <input type="hidden" data-fd-field="name" value="${esc(p.name || '')}">
    <button type="button" class="btn btn-primary" data-fd-save ${attrs}>Save as confirmed by me</button>
  </div>
</div>`;
  }

  function rejectedHtml(d) {
    const track = (d.tracks || [])[0] || '';
    if (!(d.rejected || []).length) return '';
    return `<details class="fd-rejected"><summary>${esc(d.rejected.length)} rejected proposal(s)</summary><ul>${d.rejected.map((r) =>
      `<li><code>${esc(r.address || r.kind)}</code>, rejected by ${esc(r.rejectedBy)} on ${esc(day(r.rejectedAt))}${r.reason ? `: ${esc(r.reason)}` : ''} <button type="button" class="btn btn-link" data-fd-unreject data-fd-track="${esc(track)}" data-fd-id="${esc(r.id)}">Offer again</button></li>`).join('')}</ul></details>`;
  }

  function skippedHtml(d) {
    if (!(d.skipped || []).length) return '';
    return `<details class="fd-skipped"><summary>${esc(d.skipped.length)} source(s) not proposed</summary><ul>${d.skipped.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></details>`;
  }

  /** The block for one track group ("utility" or "ahj"); '' when there is nothing to show. */
  function renderGroup(payload, authorityKind) {
    return forGroup(payload, authorityKind).map((d) => {
      if (d.status === 'verified') return '';
      const body = (d.proposals || []).map((p) => proposalHtml(d, p)).join('') + rejectedHtml(d) + skippedHtml(d);
      if (!body) return '';
      return `<div class="fd-block" data-fd-authority="${esc(d.authority.profileKey)}">
  <div class="fd-head"><strong>Where ${esc(d.authority.name)} takes this filing</strong> <span class="muted">Nothing is filed or sent to a proposed destination until a named person confirms it.</span></div>
  ${body}
</div>`;
    }).join('');
  }

  /** The proposal a button names, from the payload (null when it is no longer there). */
  function findProposal(payload, id) {
    for (const d of (payload && payload.destinations) || []) {
      const p = (d.proposals || []).find((x) => x.id === id);
      if (p) return { destination: d, proposal: p };
    }
    return null;
  }

  /** The PUT body for Confirm: exactly what was shown. */
  function confirmBody(track, p) {
    return { track, proposalId: p.id, kind: p.kind, address: p.address, ...(p.name ? { name: p.name } : {}), sourceUrl: p.sourceUrl, quote: p.quote };
  }

  /** The PUT body for an Edit: the person's own statement (no proposalId). */
  function editBody(track, values) {
    const kind = str(values.kind);
    return { track, kind, address: kind === 'with_permit' ? '' : str(values.address), ...(str(values.name) ? { name: str(values.name) } : {}), sourceUrl: str(values.sourceUrl), quote: str(values.quote) };
  }

  function confirmMessage(name, p) {
    const what = p.kind === 'with_permit' ? 'its application is filed inside the AHJ permit application' : `${KIND[p.kind] || p.kind}: ${p.address}`;
    return `Confirm where ${name} takes this filing?\n\n${what}\nRead on: ${p.sourceUrl}\n"${p.quote}"\n\nThis is recorded under your name as checked by a person. Nothing is filed or sent by this click.`;
  }

  return { renderGroup, findProposal, confirmBody, editBody, confirmMessage, KIND };
});
