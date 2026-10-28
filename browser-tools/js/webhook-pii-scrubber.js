/* PeakAutomations free tool: webhook-pii-scrubber
   Source of https://peakautomations.online/tools/webhook-pii-scrubber/
   Runs entirely in the browser. Needs /js/tools-core.js (window.PeakTools). MIT licensed. */
(function () {
  var T = window.PeakTools, $ = T.$;
  var inp = $('inp'), out = $('out'), msg = $('msg'), stats = $('stats');

  var SAMPLE = '{\n  "event": "order.created",\n  "order_id": "ORD-2026-88412",\n  "created": 1792576800,\n' +
    '  "customer": {\n    "first_name": "Jane",\n    "last_name": "Doe",\n    "email": "jane.doe@example.com",\n    "phone": "+1 (415) 555-0132",\n' +
    '    "address": "221B Baker Street, London NW1 6XE",\n    "ip": "203.0.113.42"\n  },\n' +
    '  "billing": {\n    "card_number": "4111 1111 1111 1111",\n    "cardholder_email": "billing@example.com"\n  },\n' +
    '  "headers": {\n    "Authorization": "Bearer FAKEtoken1234567890abcdefXYZ",\n    "x-session": "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiamFuZSJ9.c2lnbmF0dXJlMTIzNDU2"\n  },\n' +
    '  "note": "Please call +44 20 7946 0958 if delivery fails. Reply to jane.doe@example.com",\n' +
    '  "log": "2026-10-27 09:14:02 INFO login ok user=jane.doe@example.com ip=203.0.113.42 ssn=078-05-1120"\n}';

  var NAME_KEY = /^(first[_-]?name|last[_-]?name|full[_-]?name|given[_-]?name|family[_-]?name|surname|name|address\d?|street|address[_-]?line\d?|city|zip|postal[_-]?code|dob|birth[_-]?date|date[_-]?of[_-]?birth)$/i;
  var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
  var TOKEN_RES = [
    /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    /\bsk-[A-Za-z0-9_-]{16,}/g,
    /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /\bAIza[0-9A-Za-z_-]{30,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g
  ];
  var IP_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
  var SSN_RE = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
  var CARD_RE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;
  var PHONE_RE = /(?<![\w.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]\d{2,4}){1,4}(?![\d:])/g;

  function luhn(d) {
    var sum = 0, alt = false;
    for (var i = d.length - 1; i >= 0; i--) {
      var n = +d[i];
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n; alt = !alt;
    }
    return sum % 10 === 0;
  }

  function opts() {
    var o = {};
    document.querySelectorAll('#opts input').forEach(function (c) { o[c.getAttribute('data-opt')] = c.checked; });
    return o;
  }

  function scrub(text, o) {
    var counts = {}, seen = {}, n = {};
    function ph(cat, val) {
      counts[cat] = (counts[cat] || 0) + 1;
      if (!o.numbered) return '[' + cat + ']';
      var k = cat + '|' + val;
      if (!seen[k]) { n[cat] = (n[cat] || 0) + 1; seen[k] = '[' + cat + '_' + n[cat] + ']'; }
      return seen[k];
    }
    // JSON-key based name/address redaction (valid JSON only)
    if (o.names) {
      try {
        var walk = function (v) {
          if (Array.isArray(v)) return v.map(walk);
          if (v && typeof v === 'object') {
            var r = {};
            Object.keys(v).forEach(function (k) {
              r[k] = (NAME_KEY.test(k) && typeof v[k] === 'string' && v[k]) ? ph('NAME_OR_ADDRESS', v[k]) : walk(v[k]);
            });
            return r;
          }
          return v;
        };
        text = JSON.stringify(walk(JSON.parse(text)), null, 2);
      } catch (e) { /* not JSON: pattern matching only */ }
    }
    if (o.token) TOKEN_RES.forEach(function (re) { text = text.replace(re, function (m) { return ph('TOKEN', m); }); });
    if (o.card) text = text.replace(CARD_RE, function (m) {
      var d = m.replace(/[ -]/g, '');
      return (d.length >= 13 && d.length <= 19 && luhn(d)) ? ph('CARD', d) : m;
    });
    if (o.email) text = text.replace(EMAIL_RE, function (m) { return ph('EMAIL', m.toLowerCase()); });
    if (o.ssn) text = text.replace(SSN_RE, function (m) { return ph('SSN', m); });
    if (o.ip) text = text.replace(IP_RE, function (m) { return ph('IP', m); });
    if (o.phone) text = text.replace(PHONE_RE, function (m) {
      var digits = m.replace(/\D/g, '');
      var hasSep = /[+\s().-]/.test(m);
      // skip ISO dates, times and short numbers
      if (!hasSep || digits.length < 9 || digits.length > 15) return m;
      if (/^\d{4}[-.\s]\d{1,2}[-.\s]\d{1,2}(?!\d)/.test(m) || /^\d{1,2}[-.\s]\d{1,2}[-.\s]\d{4}$/.test(m.trim())) return m; // dates
      return ph('PHONE', digits);
    });
    return { text: text, counts: counts };
  }

  function run() {
    var raw = inp.value;
    msg.className = 'tool-msg'; stats.innerHTML = '';
    if (!raw.trim()) { msg.className = 'tool-msg err'; msg.textContent = 'Paste a payload first, or press Load Sample Data.'; out.value = ''; return; }
    var r = scrub(raw, opts()), total = 0;
    Object.keys(r.counts).forEach(function (k) { total += r.counts[k]; });
    out.value = r.text;
    msg.className = 'tool-msg ' + (total ? 'ok' : '');
    msg.textContent = total ? 'Done. ' + total + ' value' + (total === 1 ? '' : 's') + ' redacted. Read the output before sharing it.' :
      'Nothing matched the selected categories. Check the text yourself before sharing it.';
    stats.innerHTML = '<div class="tool-stat"><b>' + total + '</b>total redactions</div>' +
      Object.keys(r.counts).map(function (c) { return '<div class="tool-stat"><b>' + r.counts[c] + '</b>' + T.esc(c.replace(/_/g, ' ').toLowerCase()) + '</div>'; }).join('');
  }

  $('run').onclick = run;
  $('sample').onclick = function () { inp.value = SAMPLE; run(); };
  $('copy').onclick = function () { if (out.value) T.copy(out.value, this); };
  $('dl').onclick = function () { if (out.value) T.download('scrubbed-payload.txt', out.value, 'text/plain'); };
  $('clear').onclick = function () { inp.value = ''; out.value = ''; msg.textContent = ''; stats.innerHTML = ''; };
})();
