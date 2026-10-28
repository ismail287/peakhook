/* PeakAutomations free tool: cron-expression-visualizer
   Source of https://peakautomations.online/tools/cron-expression-visualizer/
   Runs entirely in the browser. Needs /js/tools-core.js (window.PeakTools). MIT licensed. */
(function () {
  var T = window.PeakTools, $ = T.$;
  var MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  var DAYS = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  var MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var FIELD_DEF = [
    { id: 'sec', label: 'Second', min: 0, max: 59 },
    { id: 'min', label: 'Minute', min: 0, max: 59 },
    { id: 'hour', label: 'Hour', min: 0, max: 23 },
    { id: 'dom', label: 'Day (month)', min: 1, max: 31 },
    { id: 'mon', label: 'Month', min: 1, max: 12, names: MONTHS, offset: 1 },
    { id: 'dow', label: 'Day (week)', min: 0, max: 7, names: DAYS, offset: 0 }
  ];
  var PRESETS = [
    ['Every minute', '* * * * *'], ['Every 5 minutes', '*/5 * * * *'], ['Every hour', '0 * * * *'],
    ['Daily at 09:00', '0 9 * * *'], ['Weekdays 08:30', '30 8 * * 1-5'], ['Mondays 09:00', '0 9 * * 1'],
    ['Business hours, every 15 min', '*/15 9-17 * * 1-5'], ['1st of month', '0 0 1 * *'], ['Quarterly', '0 0 1 1,4,7,10 *']
  ];
  var TZS = ['browser', 'UTC', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles'];
  var BROWSER_TZ = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';

  /* ── Parsing ───────────────────────────────── */
  function toNum(tok, def) {
    if (/^\d+$/.test(tok)) return +tok;
    if (def.names) { var i = def.names.indexOf(tok.toUpperCase().slice(0, 3)); if (i >= 0) return i + def.offset; }
    throw new Error('Invalid value "' + tok + '" in the ' + def.label.toLowerCase() + ' field');
  }
  function parseField(str, def) {
    var set = {}, parts = str.split(','), star = false;
    parts.forEach(function (part) {
      if (part === '') throw new Error('Empty list item in the ' + def.label.toLowerCase() + ' field');
      var step = 1, range = part, sp = part.split('/');
      if (sp.length > 2) throw new Error('Too many "/" in the ' + def.label.toLowerCase() + ' field');
      if (sp.length === 2) {
        if (!/^\d+$/.test(sp[1]) || +sp[1] < 1) throw new Error('Step must be a positive number in the ' + def.label.toLowerCase() + ' field');
        step = +sp[1]; range = sp[0];
      }
      var lo, hi;
      if (range === '*' || range === '?') { lo = def.min; hi = def.max === 7 ? 6 : def.max; if (sp.length === 1) star = true; }
      else if (range.indexOf('-') > 0) {
        var r = range.split('-'); if (r.length !== 2) throw new Error('Bad range "' + range + '"');
        lo = toNum(r[0], def); hi = toNum(r[1], def);
        if (lo > hi) throw new Error('Range start is after range end in "' + range + '"');
      } else { lo = toNum(range, def); hi = sp.length === 2 ? (def.max === 7 ? 6 : def.max) : lo; }
      if (lo < def.min || hi > def.max) throw new Error(def.label + ' must be between ' + def.min + ' and ' + def.max);
      for (var v = lo; v <= hi; v += step) set[def.id === 'dow' && v === 7 ? 0 : v] = true;
    });
    return { set: set, star: star, raw: str };
  }
  function parseExpr(text, withSec) {
    var tok = text.trim().split(/\s+/);
    var need = withSec ? 6 : 5;
    if (tok.length !== need) throw new Error('Expected ' + need + ' fields (' + (withSec ? 'second ' : '') + 'minute hour day-of-month month day-of-week) but found ' + tok.length);
    var defs = withSec ? FIELD_DEF : FIELD_DEF.slice(1), spec = {};
    defs.forEach(function (d, i) { spec[d.id] = parseField(tok[i], d); });
    if (!withSec) spec.sec = { set: { 0: true }, star: false, raw: '0', implicit: true };
    return spec;
  }
  function vals(f) { return Object.keys(f.set).map(Number).sort(function (a, b) { return a - b; }); }

  /* ── Next runs (wall-clock arithmetic in the chosen zone) ── */
  function zoneName(tz) { return tz === 'browser' ? BROWSER_TZ : tz; }
  function wallParts(ms, tz) {
    var f = new Intl.DateTimeFormat('en-US', { timeZone: zoneName(tz), hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    var o = {}; f.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = +p.value; });
    return Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute, o.second);
  }
  function wallToInstant(wall, tz) {
    var guess = wall - (wallParts(wall, tz) - wall);
    var off = wallParts(guess, tz) - guess;
    return wall - off;
  }
  function dayOk(spec, t) {
    var dm = spec.dom.set[t.getUTCDate()], dw = spec.dow.set[t.getUTCDay()];
    if (spec.dom.star && spec.dow.star) return true;
    if (spec.dom.star) return !!dw;
    if (spec.dow.star) return !!dm;
    return !!(dm || dw);
  }
  function nextWall(spec, fromWall, limitYears) {
    var t = new Date(fromWall), end = fromWall + limitYears * 366 * 864e5, guard = 0;
    while (t.getTime() <= end && guard++ < 100000) {
      var y = t.getUTCFullYear(), mo = t.getUTCMonth(), d = t.getUTCDate(), h = t.getUTCHours(), mi = t.getUTCMinutes(), s = t.getUTCSeconds();
      if (!spec.mon.set[mo + 1]) { t = new Date(Date.UTC(y, mo + 1, 1)); continue; }
      if (!dayOk(spec, t)) { t = new Date(Date.UTC(y, mo, d + 1)); continue; }
      if (!spec.hour.set[h]) { t = new Date(Date.UTC(y, mo, d, h + 1)); continue; }
      if (!spec.min.set[mi]) { t = new Date(Date.UTC(y, mo, d, h, mi + 1)); continue; }
      if (!spec.sec.set[s]) { t = new Date(Date.UTC(y, mo, d, h, mi, s + 1)); continue; }
      return t.getTime();
    }
    return null;
  }
  function nextRuns(spec, tz, count) {
    var out = [], from = wallParts(Date.now(), tz) + 1000;
    for (var i = 0; i < count; i++) {
      var w = nextWall(spec, from, 8);
      if (w === null) break;
      out.push(wallToInstant(w, tz));
      from = w + 1000;
    }
    return out;
  }
  function fmt(ms, tz) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: zoneName(tz), weekday: 'short', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  }
  function rel(ms) {
    var s = Math.max(0, Math.round((ms - Date.now()) / 1000));
    if (s < 60) return 'in ' + s + ' s';
    var m = Math.floor(s / 60); if (m < 60) return 'in ' + m + ' min';
    var h = Math.floor(m / 60); if (h < 48) return 'in ' + h + ' h ' + (m % 60) + ' min';
    return 'in ' + Math.floor(h / 24) + ' days';
  }

  /* ── Plain English ─────────────────────────── */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function list(a) { return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function stepOf(raw) { var m = /^(?:\*|\d+-\d+|\d+)\/(\d+)$/.exec(raw); return m ? +m[1] : null; }
  function describe(spec, withSec) {
    var sec = spec.sec, min = spec.min, hour = spec.hour, parts = [], time;
    var mv = vals(min), hv = vals(hour), sv = vals(sec);
    var secEvery = withSec && sec.star;
    if (secEvery && min.star && hour.star) time = 'Every second';
    else if (withSec && stepOf(sec.raw) && min.star && hour.star) time = 'Every ' + stepOf(sec.raw) + ' seconds';
    else if (!withSec || sv.length === 1 && sv[0] === 0) {
      if (min.star && hour.star) time = 'Every minute';
      else if (stepOf(min.raw) && /^\*\//.test(min.raw) && hour.star) time = 'Every ' + stepOf(min.raw) + ' minutes';
      else if (mv.length === 1 && hour.star) time = mv[0] === 0 ? 'At the start of every hour' : 'At minute ' + mv[0] + ' of every hour';
      else if (/^\*\//.test(hour.raw) && mv.length === 1) time = 'At minute ' + mv[0] + ' of every ' + stepOf(hour.raw) + ' hours';
      else if (mv.length * hv.length <= 6 && !min.star && !hour.star && !/[\/]/.test(min.raw)) {
        var ts = []; hv.forEach(function (h) { mv.forEach(function (m) { ts.push(pad(h) + ':' + pad(m)); }); });
        time = 'At ' + list(ts);
      } else {
        time = (min.star ? 'Every minute' : /^\*\//.test(min.raw) ? 'Every ' + stepOf(min.raw) + ' minutes' : 'At minute ' + list(mv.map(String)));
        if (!hour.star) time += ', ' + (hv.length === 24 ? '' : 'between ' + pad(hv[0]) + ':00 and ' + pad(hv[hv.length - 1]) + ':59' + (hv.length !== hv[hv.length - 1] - hv[0] + 1 ? ' (hours ' + list(hv.map(String)) + ')' : ''));
      }
    } else time = 'At second ' + list(sv.map(String)) + (min.star ? '' : ' of minute ' + list(mv.map(String))) + (hour.star ? '' : ', hour ' + list(hv.map(String)));
    parts.push(time);
    var dv = vals(spec.dom), wv = vals(spec.dow), nv = vals(spec.mon);
    if (!spec.dom.star) parts.push(/^\*\//.test(spec.dom.raw) ? 'every ' + stepOf(spec.dom.raw) + ' days' : 'on the ' + list(dv.map(ordinal)) + ' of the month');
    if (!spec.dow.star) {
      var wd;
      if (wv.length === 5 && wv.join() === '1,2,3,4,5') wd = 'Monday through Friday';
      else if (wv.length === 2 && wv.join() === '0,6') wd = 'weekends';
      else if (wv.length > 2 && wv[wv.length - 1] - wv[0] === wv.length - 1) wd = DAY_NAMES[wv[0]] + ' through ' + DAY_NAMES[wv[wv.length - 1]];
      else wd = list(wv.map(function (i) { return DAY_NAMES[i]; }));
      parts.push((spec.dom.star ? 'on ' : 'and on ') + wd);
    }
    if (!spec.mon.star) parts.push('in ' + (nv.length === 12 ? 'every month' : list(nv.map(function (i) { return MONTH_NAMES[i - 1]; }))));
    return parts.join(', ');
  }

  /* ── UI ────────────────────────────────────── */
  var useSec = $('useSec'), expr = $('expr'), tz = $('tz'), fieldsEl = $('fields'), inputs = {};
  TZS.forEach(function (z) {
    var o = document.createElement('option'); o.value = z; o.textContent = z === 'browser' ? 'Your browser (' + BROWSER_TZ + ')' : z; tz.appendChild(o);
  });
  function buildFields() {
    fieldsEl.innerHTML = ''; inputs = {};
    (useSec.checked ? FIELD_DEF : FIELD_DEF.slice(1)).forEach(function (d) {
      var w = document.createElement('div');
      w.innerHTML = '<div class="tool-label"><span>' + d.label + '</span></div>';
      var i = document.createElement('input'); i.className = 'tool-input'; i.type = 'text'; i.value = '*'; i.setAttribute('aria-label', d.label); i.spellcheck = false; i.autocomplete = 'off';
      i.addEventListener('input', function () { expr.value = joinFields(); update(true); });
      w.appendChild(i); fieldsEl.appendChild(w); inputs[d.id] = i;
    });
    fieldsEl.style.gridTemplateColumns = 'repeat(' + (useSec.checked ? 6 : 5) + ',1fr)';
  }
  function joinFields() { return (useSec.checked ? FIELD_DEF : FIELD_DEF.slice(1)).map(function (d) { return inputs[d.id].value.trim() || '*'; }).join(' '); }
  function splitToFields() {
    var tok = expr.value.trim().split(/\s+/), defs = useSec.checked ? FIELD_DEF : FIELD_DEF.slice(1);
    defs.forEach(function (d, i) { if (tok[i] !== undefined) inputs[d.id].value = tok[i]; });
  }

  function update(fromFields) {
    var msg = $('msg'), human = $('human'), next = $('next'), grid = $('grid'), note = $('gridNote');
    msg.className = 'tool-msg'; msg.textContent = ''; note.textContent = '';
    if (!fromFields) splitToFields();
    var spec;
    try { spec = parseExpr(expr.value, useSec.checked); }
    catch (e) {
      human.textContent = 'Invalid expression'; msg.className = 'tool-msg err'; msg.textContent = e.message; next.innerHTML = ''; grid.innerHTML = ''; return;
    }
    human.textContent = describe(spec, useSec.checked) + '.';
    if (!spec.dom.star && !spec.dow.star) { msg.textContent = 'Both day-of-month and day-of-week are set: this tool runs the job when either matches (classic cron). Some libraries require both.'; }
    var runs = nextRuns(spec, tz.value, 10);
    next.innerHTML = runs.length ? runs.map(function (ms) { return '<li>' + T.esc(fmt(ms, tz.value)) + ' <span>' + rel(ms) + '</span></li>'; }).join('')
      : '<li>No run found in the next 8 years. Check the day and month fields.</li>';
    // Weekly heat grid
    var h = '<div></div>'; for (var i = 0; i < 24; i++) h += '<div class="h"><span>' + (i % 3 === 0 ? i : '') + '</span></div>';
    var anyMin = vals(spec.min).length > 0, maybe = !spec.dom.star || !spec.mon.star;
    for (var d = 1; d <= 7; d++) {
      var dw = d % 7; h += '<div class="d">' + DAYS[dw].charAt(0) + DAYS[dw].slice(1).toLowerCase() + '</div>';
      for (var hr = 0; hr < 24; hr++) {
        var dayHit = spec.dow.star ? true : !!spec.dow.set[dw];
        if (!spec.dom.star && !spec.dow.star) dayHit = true;
        var on = anyMin && dayHit && spec.hour.set[hr];
        h += '<div class="c' + (on ? (maybe ? ' maybe' : ' on') : '') + '" title="' + DAYS[dw] + ' ' + pad(hr) + ':00"></div>';
      }
    }
    grid.innerHTML = h;
    note.textContent = maybe ? 'Amber cells: the hour matches, but the day-of-month or month fields limit which dates actually run.' : '';
  }

  PRESETS.forEach(function (p) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = p[0];
    b.onclick = function () { useSec.checked = false; buildFields(); expr.value = p[1]; update(false); };
    $('presets').appendChild(b);
  });
  useSec.addEventListener('change', function () {
    var tok = expr.value.trim().split(/\s+/);
    if (useSec.checked && tok.length === 5) expr.value = '0 ' + expr.value.trim();
    if (!useSec.checked && tok.length === 6) expr.value = tok.slice(1).join(' ');
    buildFields(); update(false);
  });
  expr.addEventListener('input', function () { update(false); });
  tz.addEventListener('change', function () { update(true); });
  $('sample').onclick = function () { useSec.checked = false; buildFields(); expr.value = '30 8 * * 1-5'; tz.value = 'Asia/Dubai'; update(false); };
  $('copy').onclick = function () { T.copy(expr.value.trim(), this); };

  buildFields(); update(false);
  setInterval(function () { if ($('next').firstChild) update(true); }, 30000);
})();
