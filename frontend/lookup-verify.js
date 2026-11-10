// ===========================================================================
// lookup-verify.js — the VERIFY CONTROL for a job's per-AHJ permit-process row and per-utility
// filing row (#695), on the project detail's track groups. No DOM, no network.
//
// PUT /api/projects/:id/permit-process/verify and PUT /api/projects/:id/utility-filing/verify are
// the person-only doors that turn a seeded row into a verified one (rule 3), and nothing on the
// dashboard called them: a person had to curl them. This renders, for the row the GET routes
// return ({ state, ahj | utility, lookup }):
//   - every fact the row carries, each with its source link (http(s) only), the page's own words
//     and where it came from (per-job lookup, state rule, reference seed, a person);
//   - SEEDED or OFFICIAL row: a "Verify (I checked the authority's page)" button. An official row
//     (#683, a fact read on the authority's own government page) is shown "from <host>", never as
//     person-verified, and still offers Verify: these rows say WHERE a filing goes (a permit portal,
//     a utility's filing location), and filing targets stay person-verified (rule 3);
//   - the button is DISABLED, with the reason, when the row has no cited fact to check, or any value
//     on it carries no http(s) source or no quote (a person verifies words, not a blank). This is the
//     strict default: nothing the person is asked to vouch for is uncited;
//   - VERIFIED row: "Verified by <name>, <date>" and no control.
// The Verify click itself (dashboard.js verifyTrackLookup) asks the confirm below with the person's
// name and PUTs the existing route; nothing is sent or filed from this control.
//
// The module reads whatever authority the row names: no city, utility, portal or state is special.
// dashboard.html loads it as a classic script (window.LookupVerify); backend/test/
// lookupVerifyControl.test.ts loads the same file through node:vm. Every interpolated value is
// escaped.
// ===========================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.LookupVerify = api;
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

  // The two rows this control verifies, by the route segment that verifies each.
  const KINDS = {
    'permit-process': { noun: 'permit process', entityKey: 'ahj', title: 'Permit process on file' },
    'utility-filing': { noun: 'utility filing location', entityKey: 'utility', title: 'Utility filing location on file' },
  };

  const ORIGIN = {
    lookup: 'per-job lookup',
    state_rule: 'state rule',
    kb: 'reference seed',
    operator: 'stated by a person',
  };

  const DISCIPLINE = { structural: 'structural', electrical: 'electrical', combo: 'combination', other: 'other' };
  const PROGRAM = { net_metering: 'net metering', net_billing: 'net billing (export credit)', interconnection_only: 'interconnection only' };

  // A fact's value in words. Values are untrusted text; the caller escapes.
  function valueText(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map((x) => valueText(x)).filter(Boolean).join('; ');
    if (typeof v === 'object') {
      // A fee answer.
      if ('amountUsd' in v || 'basis' in v) {
        const amt = typeof v.amountUsd === 'number' && Number.isFinite(v.amountUsd) ? `$${v.amountUsd.toFixed(2)}` : 'amount not priced';
        return `${amt}${str(v.basis) ? ` (${str(v.basis)})` : ''}`;
      }
      // A utility filing location.
      if ('name' in v || 'url' in v || 'method' in v) {
        const where = v.method === 'with_ahj_permit' ? 'filed inside the AHJ\'s permit application' : str(v.url);
        const docs = Array.isArray(v.documents) && v.documents.length ? ` — documents: ${v.documents.map(str).filter(Boolean).join('; ')}` : '';
        return `${str(v.name) || '(unnamed)'}${where ? ` — ${where}` : ''}${docs}`;
      }
      return Object.entries(v).filter(([, x]) => x !== '' && x != null).map(([k, x]) => `${k}: ${valueText(x)}`).join('; ');
    }
    return str(v);
  }

  // Every cited fact on the row, labelled, in reading order. { label, fact }.
  function rowFacts(kind, lookup) {
    if (!lookup || typeof lookup !== 'object') return [];
    const out = [];
    const add = (label, fact, display) => { if (fact && typeof fact === 'object') out.push({ label, fact, display }); };
    if (kind === 'utility-filing') {
      add('Filing location', lookup.filing);
      add(`Program${str(lookup.programName) ? ` (${str(lookup.programName)})` : ''}`, lookup.program, (v) => PROGRAM[v] || str(v));
      return out;
    }
    add('Issuing agency', lookup.issuingAgency);
    add('Permit structure', lookup.permitStructure, (v) => (v === 'combo' ? 'one combination permit' : v === 'separate' ? 'separate permits' : str(v)));
    for (const p of Array.isArray(lookup.permits) ? lookup.permits : []) {
      if (!p) continue;
      const name = `${str(p.label) || 'Permit'} (${DISCIPLINE[p.discipline] || str(p.discipline) || 'permit'})`;
      add(`${name}: issuing agency`, p.issuingAgency);
      add(`${name}: portal`, p.portalUrl);
      add(`${name}: record type`, p.recordType);
      add(`${name}: documents`, p.documents);
      add(`${name}: fee`, p.fee);
    }
    (Array.isArray(lookup.prerequisites) ? lookup.prerequisites : []).forEach((f) => add('Step at another office', f));
    add('Building program', lookup.buildingProgram, (v) => (v === 'own' ? 'the AHJ runs its own' : v === 'state' ? 'the state agency issues' : str(v)));
    add('Zoning for the unincorporated county', lookup.unincorporatedZoning);
    add('Ground-mount zoning', lookup.groundMountZoning, (v) => (v === 'required' ? 'required' : v === 'not_required' ? 'not required' : str(v)));
    add('Adopted codes', lookup.codes);
    return out;
  }

  const hasValue = (f) => f && f.value != null && !(Array.isArray(f.value) && f.value.length === 0) && f.value !== '';

  // Is the row (or this fact) from an OFFICIAL source (#683)? Official = the row says so, or the fact
  // carries tier 'official'. Shown "from <host>", never as a person's verification.
  const isOfficialRow = (lookup) => Boolean(lookup) && lookup.confidence === 'official';
  const isOfficialFact = (f) => Boolean(f) && (f.tier === 'official' || f.confidence === 'official');

  /**
   * Why this row cannot be verified from the dashboard ([] when it can). Strict by default: every value
   * on the row must carry an http(s) source and the page's own words, and at least one must exist.
   */
  function verifyBlockers(kind, lookup) {
    if (!KINDS[kind] || !lookup) return ['no row is on file to verify'];
    const facts = rowFacts(kind, lookup);
    const withValue = facts.filter((x) => hasValue(x.fact));
    if (!withValue.length) return ['the row found nothing to check: every fact on it is not found'];
    if (kind === 'utility-filing' && !hasValue(lookup.filing)) return ['the row found no filing location: there is nothing here to verify'];
    const reasons = [];
    for (const x of withValue) {
      const noUrl = !httpUrl(x.fact.sourceUrl);
      const noQuote = str(x.fact.quote).length < 3;
      if (noUrl || noQuote) reasons.push(`${x.label} has no ${noUrl && noQuote ? 'source page or quote' : noUrl ? 'source page' : 'quote'}`);
    }
    return reasons;
  }

  function entityName(kind, payload) {
    const k = KINDS[kind];
    const lookup = payload && payload.lookup;
    const entity = str((lookup && lookup[k.entityKey]) || (payload && payload[k.entityKey]));
    const st = str((lookup && lookup.state) || (payload && payload.state));
    return `${entity || '(unnamed)'}${st ? `, ${st.toUpperCase()}` : ''}`;
  }

  // "Verified by <name>, <date>" (plain text; the caller escapes). '' for a row that is not verified.
  function verifiedStamp(lookup) {
    if (!lookup || lookup.confidence !== 'verified') return '';
    const day = str(lookup.verifiedAt).slice(0, 10);
    return `Verified${str(lookup.verifiedBy) ? ` by ${str(lookup.verifiedBy)}` : ''}${day ? `, ${day}` : ''}`;
  }

  // The provenance badge for the row as a whole.
  function provenanceHtml(lookup) {
    if (!lookup) return '';
    if (lookup.confidence === 'verified') return `<span class="badge badge-pass" data-lookup-verified>${esc(verifiedStamp(lookup))}</span>`;
    if (isOfficialRow(lookup)) {
      const host = hostOf(lookup.officialSource && lookup.officialSource.sourceUrl) || str(lookup.officialSource && lookup.officialSource.host);
      return `<span class="badge badge-info" data-lookup-official>${esc(host ? `from ${host}` : 'from an official source')}</span> <span class="muted">not checked by a person</span>`;
    }
    return '<span class="badge badge-none" data-lookup-seeded>Seeded by research</span> <span class="muted">not checked by a person</span>';
  }

  function factHtml(x) {
    const f = x.fact;
    const value = hasValue(f) ? (x.display ? x.display(f.value) : valueText(f.value)) : '';
    const url = httpUrl(f.sourceUrl);
    const origin = isOfficialFact(f) && hostOf(url) ? `from ${hostOf(url)}` : (ORIGIN[f.origin] || str(f.origin) || 'on file');
    const head = value
      ? `<strong>${esc(x.label)}:</strong> ${esc(value)} <span class="muted">(${esc(origin)})</span>`
      : `<strong>${esc(x.label)}:</strong> <span class="muted">not found${str(f.notFound) ? ` — ${esc(f.notFound)}` : ''}</span>`;
    if (!value) return `<li data-lookup-fact>${head}</li>`;
    const source = url
      ? `<a href="${esc(url)}" target="_blank" rel="noopener" data-lookup-source>${esc(hostOf(url) || 'source')}</a>`
      : '<span style="color:var(--warning)" data-lookup-source-missing>no source page</span>';
    const quote = str(f.quote)
      ? `<q data-lookup-quote>${esc(f.quote)}</q>`
      : '<span style="color:var(--warning)" data-lookup-quote-missing>no quote</span>';
    return `<li data-lookup-fact>${head}<div class="muted" style="font-size:11px;margin:1px 0 3px">${source} — ${quote}</div></li>`;
  }

  /**
   * The block for one row on the project's track group. `payload` is the GET route's body
   * ({ state, ahj | utility, lookup }); no row on file renders nothing (there is nothing to verify).
   */
  function renderLookupVerify(kind, payload) {
    const k = KINDS[kind];
    const lookup = payload && payload.lookup;
    if (!k || !lookup || typeof lookup !== 'object') return '';
    const facts = rowFacts(kind, lookup);
    const cited = facts.filter((x) => hasValue(x.fact)).length;
    const verified = lookup.confidence === 'verified';
    const blockers = verified ? [] : verifyBlockers(kind, lookup);
    const official = isOfficialRow(lookup)
      ? `<p class="muted" style="font-size:11px;margin:4px 0 0">Read on the authority's own page, so it is used as data now. Where a filing goes stays a person's check: verify it once you have read it.</p>`
      : '';
    const control = verified
      ? ''
      : blockers.length
        ? `<div style="margin-top:6px">
            <button type="button" class="secondary" data-lookup-verify="${esc(kind)}" disabled aria-disabled="true" title="${esc(`Cannot verify: ${blockers.join('; ')}`)}">Verify (I checked the authority's page)</button>
            <span class="muted" style="font-size:11px" data-lookup-verify-blocked>Cannot verify from here: ${esc(blockers.join('; '))}. Refresh the lookup, or state the facts you read through the verify route.</span>
          </div>`
        : `<div style="margin-top:6px">
            <button type="button" class="secondary" data-lookup-verify="${esc(kind)}" title="Records, under your name, that you checked each fact above on its cited page. Research never overwrites it afterwards. Nothing is sent or filed.">Verify (I checked the authority's page)</button>
            <span class="muted" style="font-size:11px">Open each source and check its words first. Nothing is sent or filed.</span>
          </div>`;
    return `<div class="track-lookup" data-track-lookup="${esc(kind)}" style="margin:0 0 8px;font-size:12px">
      <details>
        <summary><strong>${esc(k.title)}</strong> for ${esc(entityName(kind, payload))} — ${provenanceHtml(lookup)} <span class="muted">(${cited} fact${cited === 1 ? '' : 's'} found)</span></summary>
        <ul style="margin:4px 0 0 18px;padding:0">${facts.map(factHtml).join('')}</ul>
        ${official}
        ${control}
      </details>
    </div>`;
  }

  // Verifying locks the row against research (rule 3) — never on one stray click.
  function confirmMessage(kind, name) {
    const k = KINDS[kind] || { noun: 'row' };
    return `Verify the ${k.noun} on file for ${name}?\n\nThis records, under your name, that you checked each fact against the words on its cited page. From then on research never overwrites it. Nothing is sent or filed.`;
  }

  return { esc, httpUrl, KINDS, rowFacts, verifyBlockers, verifiedStamp, entityName, renderLookupVerify, confirmMessage, valueText };
});
