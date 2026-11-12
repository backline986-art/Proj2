// ===========================================================================
// go-live.js — the GO-LIVE CHECK view (owner, 2026-11-10; backend/src/goLiveCheck.ts,
// GET /api/go-live). No DOM, no network: render(report) returns the HTML for the dashboard's
// Go-live check modal, and dashboard.js does the fetch.
//
// Each line: its state (Blocker / Warn / Off / OK), its label, one plain sentence of what it means,
// and the settings it reads as "set" / "not set". The report never carries a setting's value, and
// every interpolated string is escaped. A line the Destinations to confirm view resolves carries a
// button (data-golive-open="destinations") that dashboard.js wires to that view.
// dashboard.html loads it as a classic script (window.GoLive); goLiveCheck.test loads it through node:vm.
// ===========================================================================
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.GoLive = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const AREAS = [
    ['filing', 'Filing switches'], ['client', 'Client links and email'], ['access', 'Sign-in and secrets'],
    ['lookups', 'Lookups and research'], ['integrations', 'Integrations'], ['browser', 'Browser'],
    ['backups', 'Backups'], ['data', 'Database and jobs'], ['test', 'Test-only settings'],
  ];
  const BADGE = {
    red: ['badge-fail', 'Blocker'], warn: ['badge-warning', 'Warn'], off: ['badge-info', 'Off'], ok: ['badge-pass', 'OK'],
  };

  function lineHtml(l) {
    const [cls, word] = BADGE[l.state] || BADGE.warn;
    const settings = (l.settings || []).map((s) =>
      `<span class="golive-setting${s.set ? ' is-set' : ''}"><code>${esc(s.name)}</code> ${s.set ? 'set' : 'not set'}</span>`).join(' ');
    const open = l.view === 'destinations'
      ? ` <button type="button" class="secondary golive-open" data-golive-open="destinations">Open Destinations to confirm</button>` : '';
    return `<li class="golive-line golive-${esc(l.state)}" data-golive-line="${esc(l.id)}" data-golive-state="${esc(l.state)}">` +
      `<span class="badge ${cls}">${word}</span> <strong>${esc(l.label)}</strong>` +
      `<div class="golive-meaning">${esc(l.meaning)}${open}</div>` +
      (settings ? `<div class="golive-settings muted">${settings}</div>` : '') + '</li>';
  }

  function render(report) {
    if (!report || !Array.isArray(report.lines)) return '<p class="muted">The go-live check did not load.</p>';
    const c = report.counts || {};
    const head = `<p class="golive-summary" data-golive-ready="${report.ready ? 'yes' : 'no'}">` +
      (report.ready ? '<strong>No blocker.</strong> ' : `<strong>${esc(c.red || 0)} blocker(s).</strong> `) +
      `${esc(c.warn || 0)} warning(s), ${esc(c.off || 0)} switched off, ${esc(c.ok || 0)} OK. ` +
      'This view reads the server\'s settings and database and changes nothing; it shows whether each setting is set, never its value.</p>';
    const areas = AREAS.map(([key, title]) => {
      const ls = report.lines.filter((l) => l.area === key);
      if (!ls.length) return '';
      return `<section class="golive-area" data-golive-area="${esc(key)}"><h3>${esc(title)}</h3><ul class="golive-lines">${ls.map(lineHtml).join('')}</ul></section>`;
    }).join('');
    const other = Array.isArray(report.other) ? report.other : [];
    const setOther = other.filter((s) => s.set);
    const tail = `<details class="golive-other"><summary>Other settings (${esc(setOther.length)} of ${esc(other.length)} set; their defaults are fine)</summary>` +
      `<p class="muted">${other.map((s) => `<code>${esc(s.name)}</code> ${s.set ? 'set' : 'not set'}`).join(' · ') || 'None.'}</p></details>`;
    return head + areas + tail;
  }

  return { render };
});
