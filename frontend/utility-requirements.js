// ===========================================================================
// utility-requirements.js — WHAT A JOB'S UTILITY'S APPLICATION ASKS FOR, on the project detail's
// utility track group (review-audit draft 03 follow-up). No DOM, no network.
//
// GET /api/projects/:id/utility-filing/application-requirements lists every item the shipped seed and
// the utility's filing row carry (a meter photo, a one-line, the inverter's settings…), each with its
// tier and source. This renders that list:
//   - each item with what it is, what a missing one does (warns / may block), where it came from
//     (SEEDED: the shipped reference or a lookup's proposal, not checked by a person; OFFICIAL (#683):
//     "Verified from <host>, <date>", read on the utility's own official page; VERIFIED: "Verified by <name>, <date>"),
//     its source link (http(s) only) and the page's own words; an item a higher tier replaces is marked
//     "superseded";
//   - "Verify…" on a seeded or official item and "Edit…" on a person's, which fill the form below with
//     the item; the form also adds an item. A NAMED PERSON saves it (dashboard.js saveUtilityRequirement:
//     confirm + name, then PUT …/application-requirements with mode "merge", so other people's items
//     stay as recorded). Strict by default: nothing is saved without an http(s) page and its words, and
//     the server refuses words that do not name the item;
//   - no filing row yet: the list (the shipped seed) with no form; the utility's filing lookup runs first.
// This is how a utility whose page refuses automated reads gets cited: a person reads the page and
// records its words. Nothing here is sent or filed, and nothing decides where a filing goes.
//
// The module reads whatever utility the job names: no utility, state or portal is special.
// dashboard.html loads it as a classic script (window.UtilityRequirements); backend/test/
// utilityRequirementsPanel.test.ts loads the same file through node:vm. Every interpolated value is
// escaped.
// ===========================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.UtilityRequirements = api;
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
  const hostOf = (u) => { try { return new URL(httpUrl(u)).hostname.toLowerCase(); } catch { return ''; } };

  // Every kind the requirement data knows (shared UTILITY_REQUIREMENT_KEYS), in words.
  const KINDS = {
    meter_photo: 'Meter photo',
    account_verification: 'Utility account (number or bill)',
    one_line: 'One-line / single-line diagram',
    site_plan: 'Site plan',
    module_spec: 'Module spec sheets',
    inverter_spec: 'Inverter spec sheets',
    inverter_settings: 'Inverter settings',
    inverter_listing_ul1741sb: 'UL 1741 SB inverter listing',
    ac_disconnect: 'AC disconnect',
    storage_mode_declaration: 'Battery operating mode',
    owner_signature: 'Owner signature',
  };
  const KEYS = Object.keys(KINDS);

  // "Verified from <host>, <date>": the official tier's words (owner, 2026-11-13). The same shape as
  // shared/src/officialSource.officialSourceWords (pinned by officialSourceWords.test).
  function officialSourceWords(host, fetchedAt) {
    const h = str(host);
    const day = /^\d{4}-\d{2}-\d{2}/.test(str(fetchedAt)) ? str(fetchedAt).slice(0, 10) : '';
    return `Verified from ${h || "the authority's own page"}${day ? `, ${day}` : ''}`;
  }

  // "Verified by <name>, <date>" / "Verified from <host>, <date>" / "Seeded …" (plain text; the caller escapes).
  function provenance(item) {
    if (item.tier === 'verified') {
      const day = str(item.verifiedAt).slice(0, 10);
      return `Verified${str(item.verifiedBy) ? ` by ${str(item.verifiedBy)}` : ''}${day ? `, ${day}` : ''}`;
    }
    if (item.tier === 'official') return officialSourceWords(hostOf(item.sourceUrl), item.fetchedAt);
    return item.origin === 'shipped' ? 'Seeded (shipped reference)' : 'Seeded by research';
  }
  const BADGE = { verified: 'badge-pass', official: 'badge-info', seeded: 'badge-none' };

  // What a missing item does, in words. A seeded item without the page's words only ever warns.
  function missingText(item) {
    if (item.whenMissing !== 'blocker') return 'warns when missing';
    if (item.tier === 'seeded' && str(item.quote).length < 8) return 'warns when missing (uncited)';
    return 'may block when missing';
  }

  function itemHtml(item, i, canRecord) {
    const url = httpUrl(item.sourceUrl);
    const source = url
      ? `<a href="${esc(url)}" target="_blank" rel="noopener" data-req-source>${esc(str(item.sourceName) || hostOf(url) || 'source')}</a>`
      : `<span data-req-source-name>${esc(str(item.sourceName) || 'no source page')}</span>`;
    const quote = str(item.quote)
      ? `<q data-req-quote>${esc(item.quote)}</q>`
      : '<span style="color:var(--warning)" data-req-quote-missing>no quote: it warns only until a person records the page\'s words</span>';
    const action = !canRecord
      ? ''
      : item.tier === 'verified'
        ? ` <button type="button" class="secondary" style="font-size:11px;padding:1px 6px" data-req-edit="${i}">Edit…</button>`
        : ` <button type="button" class="secondary" style="font-size:11px;padding:1px 6px" data-req-verify="${i}">Verify…</button>`;
    const superseded = item.inEffect === false ? ' <span class="muted" data-req-superseded>(superseded)</span>' : '';
    return `<li data-req-item="${esc(item.key)}" data-req-tier="${esc(item.tier)}">
      <strong>${esc(KINDS[item.key] || item.key)}</strong> — ${esc(missingText(item))}
      <span class="badge ${BADGE[item.tier] || 'badge-none'}" data-req-provenance>${esc(provenance(item))}</span>${superseded}${action}
      <div class="muted" style="font-size:11px;margin:1px 0 3px">${source} — ${quote}</div>
    </li>`;
  }

  function formHtml() {
    const options = KEYS.map((k) => `<option value="${esc(k)}">${esc(KINDS[k])}</option>`).join('');
    return `<details data-req-form style="margin-top:6px">
      <summary><strong>Record an item</strong> <span class="muted">(add one, or Verify / Edit above to fill this in)</span></summary>
      <div style="display:grid;gap:4px;max-width:560px;margin-top:4px">
        <label>Item <select data-req-field="key">${options}</select></label>
        <label>When missing <select data-req-field="whenMissing"><option value="warning">warn</option><option value="blocker">block (the page makes it mandatory)</option></select></label>
        <label>Page name <input type="text" maxlength="200" data-req-field="sourceName" placeholder="e.g. the utility's interconnection page"></label>
        <label>Page URL <input type="url" maxlength="500" data-req-field="sourceUrl" placeholder="https://…"></label>
        <label>The page's own words <textarea rows="2" maxlength="600" data-req-field="quote" placeholder="Copy the sentence that names the item, word for word"></textarea></label>
        <div><button type="button" data-req-save>Save under my name</button> <span class="muted" style="font-size:11px">Open the page and copy its words first. Nothing is sent or filed.</span></div>
      </div>
    </details>`;
  }

  /**
   * The block for the job's utility on the utility track group. `payload` is the GET route's body
   * ({ state, utility, displayName, rowExists, items }); no utility named renders nothing.
   */
  function renderRequirementsPanel(payload) {
    if (!payload || typeof payload !== 'object' || !str(payload.utility)) return '';
    const items = Array.isArray(payload.items) ? payload.items.filter((x) => x && KINDS[x.key]) : [];
    const name = str(payload.displayName) || str(payload.utility);
    const counts = ['verified', 'official', 'seeded'].map((t) => [t, items.filter((x) => x.tier === t && x.inEffect !== false).length]).filter(([, n]) => n);
    const summary = items.length
      ? `${items.filter((x) => x.inEffect !== false).length} item${items.filter((x) => x.inEffect !== false).length === 1 ? '' : 's'} (${counts.map(([t, n]) => `${n} ${t}`).join(', ')})`
      : 'nothing on file: the utility side is not reviewed';
    const canRecord = Boolean(payload.rowExists);
    const list = items.length
      ? `<ul style="margin:4px 0 0 18px;padding:0">${items.map((x) => itemHtml(x, payload.items.indexOf(x), canRecord)).join('')}</ul>`
      : '<p class="muted" style="margin:4px 0 0" data-req-empty>No requirement is on file for this utility yet. Record what its application asks for, with the page and its words.</p>';
    const tail = canRecord
      ? formHtml()
      : '<p class="muted" style="font-size:11px;margin:4px 0 0" data-req-no-row>No filing record is on file for this utility yet: its filing lookup runs first, then items can be recorded here.</p>';
    return `<div class="track-lookup" data-utility-requirements style="margin:0 0 8px;font-size:12px">
      <details>
        <summary><strong>What ${esc(name)}'s application asks for</strong> — <span class="muted">${esc(summary)}</span></summary>
        ${list}
        ${tail}
      </details>
    </div>`;
  }

  /** The form's values for an item (Verify / Edit fill the form with it). */
  function prefill(item) {
    return {
      key: KINDS[item && item.key] ? item.key : KEYS[0],
      whenMissing: item && item.whenMissing === 'blocker' ? 'blocker' : 'warning',
      sourceName: str(item && item.sourceName),
      sourceUrl: httpUrl(item && item.sourceUrl),
      quote: str(item && item.quote),
    };
  }

  /**
   * The PUT body for one item, or why it cannot be saved. Strict: an http(s) page and its words (8+
   * characters) are required; the server also refuses words that do not name the item.
   */
  function formPayload(values) {
    const v = values || {};
    const key = str(v.key);
    if (!KINDS[key]) return { ok: false, reason: 'Choose which item the page asks for.' };
    const sourceUrl = httpUrl(v.sourceUrl);
    if (!sourceUrl) return { ok: false, reason: 'Give the http(s) page you read it on.' };
    const quote = str(v.quote).replace(/\s+/g, ' ');
    if (quote.length < 8) return { ok: false, reason: 'Copy the page\'s own words that name the item.' };
    const item = { key, whenMissing: v.whenMissing === 'blocker' ? 'blocker' : 'warning', sourceUrl: sourceUrl.slice(0, 500), quote: quote.slice(0, 600) };
    if (str(v.sourceName)) item.sourceName = str(v.sourceName).slice(0, 200);
    return { ok: true, body: { requirements: [item], mode: 'merge' } };
  }

  // Recording locks the item against research (rule 3) — never on one stray click.
  function confirmMessage(utility, key) {
    return `Record "${KINDS[key] || key}" as what ${utility || 'this utility'}'s application asks for?\n\nThis records, under your name, that you read these words on the cited page. Research never overwrites it afterwards, and a blocking item can hold this utility's jobs. Nothing is sent or filed.`;
  }

  return { esc, KINDS, KEYS, provenance, missingText, renderRequirementsPanel, prefill, formPayload, confirmMessage };
});
