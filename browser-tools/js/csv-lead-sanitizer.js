/* PeakAutomations free tool: csv-lead-sanitizer
   Source of https://peakautomations.online/tools/csv-lead-sanitizer/
   Runs entirely in the browser. Needs /js/tools-core.js (window.PeakTools). MIT licensed. */
(function () {
  var T = window.PeakTools, $ = T.$;
  var inp = $('inp'), out = $('out'), msg = $('msg'), stats = $('stats');

  var COUNTRIES = [
    ['United States / Canada (+1)', '1', false], ['United Kingdom (+44)', '44', true], ['United Arab Emirates (+971)', '971', true],
    ['India (+91)', '91', true], ['Australia (+61)', '61', true], ['Germany (+49)', '49', true], ['France (+33)', '33', true],
    ['Spain (+34)', '34', false], ['Italy (+39)', '39', false], ['Netherlands (+31)', '31', true], ['Saudi Arabia (+966)', '966', true],
    ['Singapore (+65)', '65', false], ['Pakistan (+92)', '92', true], ['South Africa (+27)', '27', true], ['Brazil (+55)', '55', true],
    ['Mexico (+52)', '52', false], ['Nigeria (+234)', '234', true], ['Egypt (+20)', '20', true], ['None (leave numbers without +)', '', false]
  ];
  COUNTRIES.forEach(function (c, i) { var o = document.createElement('option'); o.value = i; o.textContent = c[0]; $('country').appendChild(o); });

  var SAMPLE = '﻿First Name,Last Name,Email,Phone,Company\n' +
    'JOHN ,smith,John.Smith@Example.com ,(415) 555-0132,Acme Inc\n' +
    'maria,gonzÃ¡lez,maria.g@example.com,+34 612 345 678,Sol Agency\n' +
    'JosÃ©,PÃ©rez,jose.p@example.com,0044 7911 123456,Perez Ltd\n' +
    'john,Smith,john.smith@example.com,415-555-0132,Acme Inc\n' +
    'Aisha,Khan,aisha@example.ae,+971 50 123 4567,Khan Trading\n' +
    ',,,,\n' +
    'Li,Wei,li.wei@example.com,12345,Wei​ Co\n' +
    '"O\'Brien, Pat",,pat@example.com,+44 (0)20 7946 0958,"Brien & Sons"\n';

  /* ── CSV parsing / writing ─────────────────── */
  function detectDelim(line) {
    var best = ',', n = -1;
    [',', ';', '\t', '|'].forEach(function (d) { var c = line.split(d).length; if (c > n) { n = c; best = d; } });
    return best;
  }
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    var d = detectDelim(text.split(/\r?\n/)[0] || ''), rows = [], row = [], f = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += ch;
      } else if (ch === '"' && f === '') q = true;
      else if (ch === d) { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }
  function toCSV(rows) {
    return rows.map(function (r) {
      return r.map(function (c) { c = c == null ? '' : String(c); return /[",\n\r]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(',');
    }).join('\r\n') + '\r\n';
  }

  /* ── Text cleaning ─────────────────────────── */
  var CP1252 = { 0x20AC:0x80,0x201A:0x82,0x0192:0x83,0x201E:0x84,0x2026:0x85,0x2020:0x86,0x2021:0x87,0x02C6:0x88,0x2030:0x89,0x0160:0x8A,0x2039:0x8B,0x0152:0x8C,0x017D:0x8E,0x2018:0x91,0x2019:0x92,0x201C:0x93,0x201D:0x94,0x2022:0x95,0x2013:0x96,0x2014:0x97,0x02DC:0x98,0x2122:0x99,0x0161:0x9A,0x203A:0x9B,0x0153:0x9C,0x017E:0x9E,0x0178:0x9F };
  function fixMojibake(s) {
    if (!/[ÂÃâ][\u0080-¿Œ-™]/.test(s)) return s;
    var bytes = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 256) bytes.push(c); else if (CP1252[c] !== undefined) bytes.push(CP1252[c]); else return s;
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)); } catch (e) { return s; }
  }
  var BAD_RE = /[​-‍⁠﻿­�\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
  function cleanText(s, o, st) {
    var before = s;
    if (o.chars) { s = fixMojibake(s).replace(/[  -   　]/g, ' ').replace(BAD_RE, ''); }
    if (o.trim) s = s.replace(/\s+/g, ' ').trim();
    if (s !== before) st.cleaned++;
    return s;
  }
  function capName(s) {
    return s.toLowerCase().replace(/(^|[\s'\-])([a-zà-ÿ])/g, function (m, p, c) { return p + c.toUpperCase(); }).replace(/\bMc([a-z])/g, function (m, c) { return 'Mc' + c.toUpperCase(); });
  }

  /* ── Phone → E.164 ─────────────────────────── */
  function toE164(raw, country) {
    var s = raw.trim();
    if (!s) return null;
    s = s.replace(/\(0\)/g, '').replace(/\s*(?:ext\.?|x|#)\s*\d+$/i, '');
    var plus = /^\s*\+/.test(s), digits = s.replace(/\D/g, '');
    if (!plus && /^00/.test(digits)) { plus = true; digits = digits.slice(2); }
    if (plus) return (digits.length >= 8 && digits.length <= 15) ? '+' + digits : null;
    if (!country[1]) return null;
    var cc = country[1];
    if (digits.indexOf(cc) === 0 && digits.length - cc.length >= 7 && digits.length <= 15 && !(cc === '1' && digits.length === 10)) {
      if (cc !== '1' || digits.length === 11) return '+' + digits;
    }
    if (country[2]) digits = digits.replace(/^0+/, '');
    var full = cc + digits;
    return (full.length >= 8 && full.length <= 15) ? '+' + full : null;
  }

  function opts() {
    var o = {};
    document.querySelectorAll('#opts input').forEach(function (c) { o[c.getAttribute('data-opt')] = c.checked; });
    return o;
  }

  function populateKeys(header) {
    var sel = $('dupKey'), cur = sel.value;
    sel.innerHTML = '<option value="auto">Auto (email, else phone, else whole row)</option>';
    header.forEach(function (h, i) { var o = document.createElement('option'); o.value = i; o.textContent = h || ('Column ' + (i + 1)); sel.appendChild(o); });
    if (cur !== 'auto' && +cur < header.length) sel.value = cur;
  }

  function run() {
    msg.className = 'tool-msg'; stats.innerHTML = ''; $('preview').innerHTML = '';
    if (!inp.value.trim()) { msg.className = 'tool-msg err'; msg.textContent = 'Paste a CSV or choose a file first, or press Load Sample Data.'; out.value = ''; return; }
    var o = opts(), rows = parseCSV(inp.value);
    if (rows.length < 2) { msg.className = 'tool-msg err'; msg.textContent = 'Need a header row and at least one data row.'; return; }
    var header = rows[0].map(function (h) { return h.replace(/^﻿/, '').replace(/\s+/g, ' ').trim(); });
    populateKeys(header);
    var st = { inRows: rows.length - 1, empty: 0, dupes: 0, phoneOk: 0, phoneBad: 0, cleaned: 0 };
    var phoneCols = [], emailCols = [], nameCols = [];
    header.forEach(function (h, i) {
      if (/phone|mobile|\btel\b|telephone|cell|whatsapp|\bfax\b/i.test(h)) phoneCols.push(i);
      if (/e-?mail/i.test(h)) emailCols.push(i);
      if (/(^|\s|_)(first|last|full|given|family)?[\s_]*name$/i.test(h) && !/company|business|org/i.test(h)) nameCols.push(i);
    });
    var country = COUNTRIES[+$('country').value];
    var keyMode = $('dupKey').value, keyCol = keyMode === 'auto' ? (emailCols[0] !== undefined ? emailCols[0] : (phoneCols[0] !== undefined ? phoneCols[0] : -1)) : +keyMode;
    var seen = {}, outRows = [header], badPhones = [];

    for (var r = 1; r < rows.length; r++) {
      var row = header.map(function (_, i) { return cleanText(rows[r][i] == null ? '' : rows[r][i], o, st); });
      if (o.empty && row.every(function (c) { return c === ''; })) { st.empty++; continue; }
      if (o.email) emailCols.forEach(function (i) { row[i] = row[i].toLowerCase(); });
      if (o.names) nameCols.forEach(function (i) { row[i] = capName(row[i]); });
      if (o.phones) phoneCols.forEach(function (i) {
        if (!row[i]) return;
        var e = toE164(row[i], country);
        if (e) { if (e !== row[i]) st.phoneOk++; row[i] = e; } else { st.phoneBad++; badPhones.push('row ' + (r + 1) + ': ' + row[i]); }
      });
      if (o.dupes) {
        var key = keyCol >= 0 ? row[keyCol].toLowerCase() : row.join('\u0001').toLowerCase();
        if (key !== '') {
          if (seen[key]) { st.dupes++; continue; }
          seen[key] = true;
        }
      }
      outRows.push(row);
    }
    out.value = toCSV(outRows);
    msg.className = 'tool-msg ok';
    msg.textContent = 'Done. ' + (outRows.length - 1) + ' of ' + st.inRows + ' rows kept.' + (badPhones.length ? ' Could not convert: ' + badPhones.slice(0, 5).join('; ') + (badPhones.length > 5 ? ' ...' : '') : '');
    stats.innerHTML = [['rows in', st.inRows], ['rows out', outRows.length - 1], ['duplicates removed', st.dupes], ['empty rows removed', st.empty],
      ['phones converted', st.phoneOk], ['phones not converted', st.phoneBad], ['cells cleaned', st.cleaned]]
      .map(function (x) { return '<div class="tool-stat"><b>' + x[1] + '</b>' + x[0] + '</div>'; }).join('');
    var prev = '<tr>' + header.map(function (h) { return '<th>' + T.esc(h) + '</th>'; }).join('') + '</tr>';
    outRows.slice(1, 11).forEach(function (row) { prev += '<tr>' + row.map(function (c) { return '<td>' + T.esc(c) + '</td>'; }).join('') + '</tr>'; });
    $('preview').innerHTML = prev;
  }

  $('run').onclick = run;
  $('sample').onclick = function () { inp.value = SAMPLE; $('country').value = '0'; run(); };
  $('file').addEventListener('change', function () {
    var f = this.files && this.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () { inp.value = rd.result; run(); };
    rd.readAsText(f);
    this.value = '';
  });
  $('copy').onclick = function () { if (out.value) T.copy(out.value, this); };
  $('dl').onclick = function () { if (out.value) T.download('cleaned.csv', out.value, 'text/csv;charset=utf-8'); };
  $('clear').onclick = function () { inp.value = ''; out.value = ''; msg.textContent = ''; stats.innerHTML = ''; $('preview').innerHTML = ''; };
})();
