/* PeakAutomations free tool: curl-to-n8n-converter
   Source of https://peakautomations.online/tools/curl-to-n8n-converter/
   Runs entirely in the browser. Needs /js/tools-core.js (window.PeakTools) and /js/curl-parser.js. MIT licensed. */
(function () {
  var T = window.PeakTools, C = window.CurlToN8n, $ = T.$;
  var inp = $('inp'), out = $('out'), msg = $('msg'), warn = $('warnings'), table = $('breakdown');
  var breakText = '', timer;

  function setMsg(text, cls) { msg.className = 'tool-msg ' + (cls || ''); msg.textContent = text; }
  function row(cells, th) {
    var tr = document.createElement('tr');
    cells.forEach(function (c) { var td = document.createElement(th ? 'th' : 'td'); td.textContent = c; tr.appendChild(td); });
    return tr;
  }

  function convert() {
    warn.innerHTML = '';
    var raw = inp.value;
    if (!raw.trim()) { out.value = ''; breakText = ''; table.innerHTML = '<tr><td>Paste a command or press Load Sample Data.</td></tr>'; setMsg(''); return; }
    var model;
    try { model = C.parse(raw); }
    catch (e) { out.value = ''; breakText = ''; table.innerHTML = '<tr><td>Nothing to show yet.</td></tr>'; setMsg(e.message, 'err'); return; }

    var secrets = C.countSecrets(model);
    if ($('optRedact').checked) model = C.redact(model);
    out.value = JSON.stringify(C.toN8n(model, { pretty: $('optPretty').checked }), null, 2);

    var rows = C.toBreakdown(model);
    breakText = C.breakdownText(rows);
    table.innerHTML = '';
    table.appendChild(row(['Part', 'Name', 'Value'], true));
    rows.forEach(function (r) {
      if (!r.items.length) { var tr = row([r.section, '—', '(none)']); table.appendChild(tr); return; }
      r.items.forEach(function (it, i) { table.appendChild(row([i === 0 ? r.section : '', it.k, it.v])); });
    });
    var cells = table.querySelectorAll('td:last-child'); for (var i = 0; i < cells.length; i++) cells[i].style.whiteSpace = 'pre-wrap';

    setMsg('Converted. Copy the node JSON, click the n8n canvas and press Ctrl+V.', 'ok');
    model.warnings.forEach(function (w) { var li = document.createElement('li'); li.textContent = w; warn.appendChild(li); });
    if (secrets && !$('optRedact').checked) {
      var li = document.createElement('li');
      li.textContent = 'This command contains ' + secrets + ' secret value' + (secrets === 1 ? '' : 's') + ' (keys, tokens or passwords). For production workflows, tick "Replace secrets with placeholders" and use an n8n credential.';
      warn.appendChild(li);
    }
  }

  function load(key) { inp.value = C.SAMPLES[key].curl; convert(); }

  inp.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(convert, 250); });
  $('optRedact').addEventListener('change', convert);
  $('optPretty').addEventListener('change', convert);
  $('run').onclick = convert;
  $('sample').onclick = function () { load('stripe'); };
  document.querySelectorAll('#presets button').forEach(function (b) { b.onclick = function () { load(b.getAttribute('data-sample')); }; });
  $('copy').onclick = function () { if (out.value) { T.copy(out.value, this); setMsg('Node JSON copied. Click the n8n canvas and press Ctrl+V.', 'ok'); } };
  $('copyBreak').onclick = function () { if (breakText) T.copy(breakText, this); };
  $('clear').onclick = function () { inp.value = ''; convert(); };
})();
