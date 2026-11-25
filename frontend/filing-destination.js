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
// A CLIENT'S OWN ANSWER (from "client_supplied": what the client typed on its Company setup page) is
// shown as a proposal too, marked as the client's word: it has no page of the authority's and no
// words from it, so Confirm is always disabled and a person records it through Edit as their own
// check. Where a person already verified the destination and the client says otherwise, the queue
// lists the difference ("The client says otherwise") with Set aside; the verified record stands.
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
  const FROM = { reference: 'reference data', permit_lookup: 'per-job permit lookup', utility_lookup: "utility's filing lookup", client_supplied: "client's own answer", seeded_kb: 'seeded knowledge base' };
  const ACCOUNT = { yes: 'The client says it has an account there.', no: 'The client says it has no account there.' };

  /** What the client said beside the address: the account yes/no and its example number. Never a login. */
  function clientNoteHtml(note) {
    if (!note || typeof note !== 'object') return '';
    const parts = [ACCOUNT[str(note.hasAccount)] || '', str(note.example) ? `Example number: ${esc(str(note.example))}.` : ''].filter(Boolean);
    return parts.length ? `<div class="muted" data-fd-client-note>${parts.join(' ')}</div>` : '';
  }

  /** Which authority kinds a track group shows: the utility group shows the utility's, the permit group the AHJ's. */
  function forGroup(payload, authorityKind) {
    const list = payload && Array.isArray(payload.destinations) ? payload.destinations : [];
    return list.filter((d) => d && d.authority && d.authority.kind === authorityKind);
  }

  function addressLine(p) {
    if (p.kind === 'with_permit') return `<strong>${esc(KIND.with_permit)}</strong>${p.name ? ` (${esc(p.name)})` : ''}`;
    return `${esc(KIND[p.kind] || p.kind)}: <code>${esc(p.address)}</code>`;
  }

  /** The job and track a button acts on: the queue's proposal carries its own (`act`, the job whose
   *  track card shows it); on a track card it is that card's job (no project attribute) and first track. */
  function actAttrs(d, item) {
    const act = item && item.act && typeof item.act === 'object' ? item.act : null;
    // A SERVICE-AREA authority (no job names it yet): its client, the area entry and the authority the
    // queue shows; the click goes to that client's service-area route (the same decision functions).
    const area = !act && item && item.areaAct && typeof item.areaAct === 'object' ? item.areaAct : null;
    const track = act ? str(act.track) : area ? str(area.track) : ((d.tracks || [])[0] || '');
    if (area) return `data-fd-track="${esc(track)}" data-fd-client="${esc(area.clientId)}" data-fd-area-entry="${esc(area.entryKey)}" data-fd-authority-key="${esc(area.authorityKey)}"`;
    return `data-fd-track="${esc(track)}"${act ? ` data-fd-project="${esc(act.projectId)}"` : ''}`;
  }

  /** A service-area authority whose proposal carries no route to act on: shown, not actionable here. */
  function noActionHere(d, p) {
    return Boolean(d && d.serviceArea && !(p && (p.act || p.areaAct)));
  }

  /** A SEEDED knowledge-base address with no page words on file: shown so the queue does not hide it,
   *  for Edit only. No Confirm button is drawn (the server refuses one anyway); the person opens the
   *  authority's page and saves the page and its words as their own check. */
  function seededProposalHtml(d, p) {
    const link = httpUrl(p.sourceUrl);
    const page = link ? ` The entry names this page: <a href="${esc(link)}" target="_blank" rel="noopener">${esc(p.sourceHost || link)}</a>.` : '';
    const attrs = `${actAttrs(d, p)} data-fd-id="${esc(p.id)}"`;
    return `<div class="fd-proposal" data-fd-proposal="${esc(p.id)}" data-fd-seeded>
  <div>${addressLine(p)} <span class="badge">Seeded — not yet confirmed</span></div>
  <div class="muted">From the seeded knowledge base: no page words are on file, so it cannot be confirmed by one click.${page}</div>
  <p class="warn">Edit only: open ${esc(d.authority.name)}'s own application page, check this address, then save the page and its words as your own check.</p>
  ${noActionHere(d, p) ? `<p class="muted" data-fd-area-noact>No job names ${esc(d.authority.name)} yet: Edit and Reject open on the first job's track card.</p>` : `<div class="fd-actions">
    <button type="button" class="btn btn-primary" data-fd-edit ${attrs}>Edit and save</button>
    <button type="button" class="btn" data-fd-reject ${attrs}>Reject</button>
  </div>`}
  ${noActionHere(d, p) ? '' : `<div class="fd-edit" data-fd-edit-slot="${esc(p.id)}" hidden>
    <label>Address <input type="text" data-fd-field="address" value="${esc(p.address)}"></label>
    <label>Page you read it on <input type="url" data-fd-field="sourceUrl" value="${esc(link)}"></label>
    <label>The page's words <textarea data-fd-field="quote" rows="3"></textarea></label>
    <input type="hidden" data-fd-field="kind" value="${esc(p.kind)}">
    <input type="hidden" data-fd-field="name" value="${esc(p.name || '')}">
    <button type="button" class="btn btn-primary" data-fd-save ${attrs}>Save as confirmed by me</button>
  </div>`}
</div>`;
  }

  function proposalHtml(d, p) {
    const fromClient = p.from === 'client_supplied';
    if (p.seeded === true || p.from === 'seeded_kb') return seededProposalHtml(d, p);
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
    const attrs = `${actAttrs(d, p)} data-fd-id="${esc(p.id)}"`;
    const provenance = fromClient
      ? `<div class="muted" data-fd-client-supplied>From the client's own answer on its Company setup page, ${esc(day(p.fetchedAt))}. It is the client's word, not a page of ${esc(d.authority.name)}'s: check it yourself, then use Edit.</div>
  ${clientNoteHtml(p.clientSupplied)}`
      : `<div class="muted">From ${source} (${p.official === false ? 'not an official page: Edit only' : 'official page'}), read ${esc(day(p.fetchedAt))}, via the ${esc(FROM[p.from] || p.from)}.</div>
  <blockquote class="fd-quote">${esc(p.quote)}</blockquote>
  ${names}
  ${p.clientSupplied ? `<div class="muted" data-fd-client-agrees>The client's own answer names this address too.</div>${clientNoteHtml(p.clientSupplied)}` : ''}`;
    return `<div class="fd-proposal" data-fd-proposal="${esc(p.id)}">
  <div>${addressLine(p)} <span class="badge">${fromClient ? 'Client-supplied — not yet confirmed' : 'Proposed — not yet confirmed'}</span></div>
  ${provenance}
  ${problems}
  ${noActionHere(d, p) ? `<p class="muted" data-fd-area-noact>No job names ${esc(d.authority.name)} yet: Confirm, Edit and Reject open on the first job's track card.</p>` : `<div class="fd-actions">
    <button type="button" class="btn btn-primary" data-fd-confirm ${attrs}${disabled}>Confirm (I checked the page)</button>
    <button type="button" class="btn" data-fd-edit ${attrs}>Edit</button>
    <button type="button" class="btn" data-fd-reject ${attrs}>Reject</button>
  </div>`}
  ${noActionHere(d, p) ? '' : `<div class="fd-edit" data-fd-edit-slot="${esc(p.id)}" hidden>
    <label>Address <input type="text" data-fd-field="address" value="${esc(p.address)}"${p.kind === 'with_permit' ? ' disabled' : ''}></label>
    <label>Page you read it on <input type="url" data-fd-field="sourceUrl" value="${esc(p.sourceUrl)}"></label>
    <label>The page's words <textarea data-fd-field="quote" rows="3">${esc(p.quote)}</textarea></label>
    <input type="hidden" data-fd-field="kind" value="${esc(p.kind)}">
    <input type="hidden" data-fd-field="name" value="${esc(p.name || '')}">
    <button type="button" class="btn btn-primary" data-fd-save ${attrs}>Save as confirmed by me</button>
  </div>`}
</div>`;
  }

  function rejectedHtml(d) {
    if (!(d.rejected || []).length) return '';
    return `<details class="fd-rejected"><summary>${esc(d.rejected.length)} rejected proposal(s)</summary><ul>${d.rejected.map((r) =>
      `<li><code>${esc(r.address || r.kind)}</code>, rejected by ${esc(r.rejectedBy)} on ${esc(day(r.rejectedAt))}${r.reason ? `: ${esc(r.reason)}` : ''}${noActionHere(d, r) ? '' : ` <button type="button" class="btn btn-link" data-fd-unreject ${actAttrs(d, r)} data-fd-id="${esc(r.id)}">Offer again</button>`}</li>`).join('')}</ul></details>`;
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

  // ── DESTINATIONS TO CONFIRM: every authority still waiting on a person, across the org's open jobs ──
  // (GET /api/filing-destinations). The SAME proposal block, the same Confirm / Edit / Reject buttons;
  // each button carries the job and track whose card shows that proposal (data-fd-project), so the
  // click sends that job's existing route exactly as the track card does. An authority only a client's
  // SERVICE AREA names carries that client, entry and authority instead (data-fd-client …): its click
  // goes to the client's service-area route, which runs the same decision. No bulk action.

  const AUTHORITY_KIND = { ahj: 'Permit issuer', utility: 'Utility' };

  /** A page link's text: the address without its scheme or trailing slash. */
  const pageLabel = (u) => httpUrl(u).replace(/^https?:\/\//i, '').replace(/\/$/, '');

  function handCheckHtml(a) {
    const pages = (a.handCheck || []).filter((h) => httpUrl(h.pageUrl));
    if (!pages.length) return '';
    return `<div class="fd-handcheck" data-fd-handcheck><strong>Check by hand</strong> <span class="muted">These pages refused an automated read, so what they say may be missing here. Open each in your browser; record what you find with Confirm, Edit or the job's Verify.</span><ul>${pages.map((h) =>
      `<li><a href="${esc(httpUrl(h.pageUrl))}" target="_blank" rel="noopener">${esc(pageLabel(h.pageUrl))}</a> <span class="muted">(${esc(h.happened)}${h.recordedAt ? `, ${esc(h.recordedAt)}` : ''})</span>${h.check ? `: ${esc(h.check)}` : ''}</li>`).join('')}</ul></div>`;
  }

  const jobLink = (j) => `<a href="#/project/${esc(encodeURIComponent(str(j.projectId)))}">${esc(j.label || j.projectId)}</a>`;

  function queueAuthorityHtml(a) {
    const kind = AUTHORITY_KIND[a.authority.kind] || a.authority.kind;
    const jobs = a.jobs || [];
    const shown = jobs.slice(0, 5).map(jobLink).join(', ') + (jobs.length > 5 ? ` and ${esc(jobs.length - 5)} more` : '');
    const proposals = (a.proposals || []).map((p) => proposalHtml(a, p)).join('');
    const area = a.serviceArea || null;
    const none = proposals ? ''
      : area ? `<p class="warn" data-fd-none>Nothing on file to propose. No job names ${esc(a.authority.name)} yet: state where it takes filings on the first job's track card.</p>`
      : `<p class="warn" data-fd-none>Nothing on file to propose. Open ${jobs[0] ? jobLink(jobs[0]) : 'the job'} and state where ${esc(a.authority.name)} takes this filing on its track card.</p>`;
    const typed = area && area.entry ? `${str(area.entry.name)}, ${str(area.entry.state)}` : '';
    const where = area
      ? `<span class="badge" data-fd-service-area>Service area</span> <span class="muted">${esc((a.tracks || []).join(', '))} · no open job yet${area.matchedFrom === 'typed' ? ` · as typed (${esc(typed)}): no record on file matches it yet` : ` · from the service area entry "${esc(typed)}"`}</span>`
      : `<span class="muted">${esc((a.tracks || []).join(', '))} · waiting: ${shown}</span>`;
    return `<div class="fd-block fd-queue-authority" data-fd-authority="${esc(a.authority.profileKey)}" data-fd-kind="${esc(a.authority.kind)}">
  <div class="fd-head"><strong>${esc(a.authority.name)}</strong> <span class="badge">${esc(kind)}${a.authority.state ? `, ${esc(a.authority.state)}` : ''}</span> ${where}</div>
  ${handCheckHtml(a)}
  ${proposals}${none}
  ${rejectedHtml(a)}${skippedHtml(a)}
</div>`;
  }

  /** A verified authority this client's own answer disagrees with: both shown, the verified one stands. */
  function conflictsHtml(cl) {
    const list = Array.isArray(cl.conflicts) ? cl.conflicts : [];
    if (!list.length) return '';
    return list.map((x) => `<div class="fd-block fd-conflict" data-fd-conflict="${esc(x.authority.profileKey)}">
  <div class="fd-head"><strong>${esc(x.authority.name)}</strong> <span class="badge">The client says otherwise</span> <span class="muted">A person already verified where ${esc(x.authority.name)} takes filings. That record stands; nothing changes unless a person re-verifies it.</span></div>
  <div>Verified: ${esc(x.verified)}</div>
  ${(x.conflicts || []).map((c) => `<div class="fd-proposal" data-fd-conflict-statement="${esc(c.statementId)}">
    <div>The client says: ${esc(KIND[c.kind] || c.kind)}: <code>${esc(c.address)}</code> <span class="muted">(${esc(day(c.statedAt))})</span></div>
    ${clientNoteHtml(c)}
    <div class="fd-actions"><button type="button" class="btn" data-fd-dismiss-statement="${esc(c.statementId)}" data-fd-client="${esc(cl.clientId)}">Set the client's answer aside</button></div>
  </div>`).join('')}
</div>`).join('');
  }

  /** The whole view. '' never: an empty queue says so. */
  function renderQueue(q) {
    const clients = (q && Array.isArray(q.clients)) ? q.clients : [];
    const c = (q && q.counts) || {};
    const lede = `<p class="fd-queue-lede">Each Confirm is one named person's click on one authority, recorded under your name. Nothing is filed or sent by these clicks. An authority is shared: confirming it here confirms it for every job that files there.</p>`;
    if (!clients.length) {
      return `${lede}<p class="muted" data-fd-queue-empty>Every authority your open jobs and your clients' service areas name has a person-verified destination${c.alreadyVerified ? ` (${esc(c.alreadyVerified)} verified)` : ''}.</p>`;
    }
    const summary = `<p class="fd-queue-summary" data-fd-queue-summary><strong>${esc(c.authorities || 0)}</strong> ${(c.authorities || 0) === 1 ? 'authority waits' : 'authorities wait'} on a person: ${esc(c.oneClick || 0)} one-click, ${esc(c.editOnly || 0)} need Edit, ${esc(c.noProposal || 0)} with nothing to propose${c.handCheck ? `, ${esc(c.handCheck)} with pages to check by hand` : ''}${c.serviceArea ? `; ${esc(c.serviceArea)} only in a service area, with no job yet` : ''}. ${esc(c.alreadyVerified || 0)} already verified.${c.conflicts ? ` On ${esc(c.conflicts)} of those a client's own answer says otherwise.` : ''}</p>`;
    return lede + summary + clients.map((cl) =>
      `<section class="fd-queue-client" data-fd-client="${esc(cl.clientId)}"><h3>${esc(cl.clientName)} <span class="muted">(${esc((cl.authorities || []).length)})</span></h3>${(cl.authorities || []).map(queueAuthorityHtml).join('')}${conflictsHtml(cl)}</section>`).join('');
  }

  /** The queue as the payload findProposal reads (every authority, flat). */
  function queuePayload(q) {
    return { destinations: ((q && q.clients) || []).flatMap((cl) => cl.authorities || []) };
  }

  return { renderGroup, findProposal, confirmBody, editBody, confirmMessage, KIND, renderQueue, queuePayload };
});
