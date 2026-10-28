/* PeakAutomations free tool: n8n-workflow-sanitizer
   Source of https://peakautomations.online/tools/n8n-workflow-sanitizer/
   Runs entirely in the browser. Needs /js/tools-core.js (window.PeakTools). MIT licensed. */
(function () {
  var T = window.PeakTools, $ = T.$;
  var inp = $('inp'), out = $('out'), msg = $('msg'), stats = $('stats'), log = $('log');

  var SAMPLE = {
    name: 'Lead intake to CRM (sample)',
    nodes: [
      { parameters: { path: 'lead-intake-8f2c1d', httpMethod: 'POST', options: {} },
        id: 'a1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0],
        webhookId: '5b0e6c1e-aaaa-bbbb-cccc-0123456789ab' },
      { parameters: { method: 'POST', url: 'https://api.example-crm.com/v1/contacts?api_key=FAKE1234567890abcdef',
          sendHeaders: true,
          headerParameters: { parameters: [ { name: 'Authorization', value: 'Bearer FAKEtoken1234567890abcdefXYZ' }, { name: 'Content-Type', value: 'application/json' } ] } },
        id: 'a2', name: 'Create CRM contact', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [240, 0] },
      { parameters: { resource: 'chat', apiKey: 'sk-FAKEFAKEFAKEFAKEFAKEFAKEFAKE1234', prompt: 'Summarise: {{ $json.message }}' },
        id: 'a3', name: 'OpenAI', type: 'n8n-nodes-base.openAi', typeVersion: 1, position: [480, 0],
        credentials: { openAiApi: { id: '42', name: 'OpenAI - jane@example.com' } } },
      { parameters: { url: 'https://hook.eu1.make.com/FAKEhookid1234567890abcdef', sendBody: true, email: 'jane.doe@example.com' },
        id: 'a4', name: 'Notify Make', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [720, 0] },
      { parameters: { url: 'https://hooks.slack.com/services/T00000000/B00000000/FAKEFAKEFAKEFAKE' },
        id: 'a5', name: 'Slack alert', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [960, 0] }
    ],
    connections: { Webhook: { main: [[{ node: 'Create CRM contact', type: 'main', index: 0 }]] } },
    pinData: { Webhook: [ { json: { name: 'Jane Doe', email: 'jane.doe@example.com', phone: '+1 415 555 0100' } } ] },
    meta: { instanceId: 'FAKEinstance0123456789' }
  };

  var KEY_RE = /(api[-_]?key|apikey|secret|passw(or)?d|token|authorization|bearer|private[-_]?key|access[-_]?key|signature|cookie)/i;
  var HOOK_KEYS = /^(webhookId|__IMTHOOK__|hook|instanceId)$/;
  var PATTERNS = {
    hooks: [
      /https?:\/\/hook\.[a-z0-9.-]*(?:make|integromat)\.com\/[A-Za-z0-9_-]+/gi,
      /https?:\/\/[^\s"'<>]+\/webhook(?:-test|-waiting)?\/[A-Za-z0-9\-_\/]+/gi,
      /https:\/\/hooks\.zapier\.com\/hooks\/(?:catch|standard)\/[A-Za-z0-9\/]+/gi,
      /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/]+/gi,
      /https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d+\/[\w-]+/gi
    ],
    keys: [
      /\bsk-[A-Za-z0-9_-]{16,}/g,
      /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
      /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
      /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
      /\bAIza[0-9A-Za-z_-]{30,}/g,
      /\bAKIA[0-9A-Z]{16}\b/g,
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
      /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/g
    ]
  };
  var QS_RE = /([?&](?:api[_-]?key|key|token|access_token|secret|sig|signature|password)=)[^&\s"'<>]+/gi;
  var URLCRED_RE = /(https?:\/\/)[^\s\/:@"']+:[^\s\/@"']+@/g;
  var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  function opts() {
    var o = {};
    document.querySelectorAll('#opts input').forEach(function (c) { o[c.getAttribute('data-opt')] = c.checked; });
    return o;
  }

  function Run(o) { this.o = o; this.hits = []; }
  Run.prototype.hit = function (cat, path) { this.hits.push({ cat: cat, path: path }); };
  Run.prototype.str = function (s, path) {
    var self = this;
    if (/^=/.test(s) || /\{\{[^}]*\$env/.test(s)) return s; // expressions / env refs hold no secret
    function sub(list, repl, cat) {
      list.forEach(function (re) { s = s.replace(re, function () { self.hit(cat, path); return repl; }); });
    }
    if (this.o.hooks) sub(PATTERNS.hooks, 'https://[REDACTED-WEBHOOK-URL]', 'Webhook URL');
    if (this.o.keys) {
      sub(PATTERNS.keys, '[REDACTED-KEY]', 'API key / token');
      s = s.replace(QS_RE, function (m, p) { self.hit('API key / token', path); return p + '[REDACTED]'; });
      s = s.replace(URLCRED_RE, function (m, p) { self.hit('API key / token', path); return p + '[REDACTED]@'; });
    }
    if (this.o.emails) s = s.replace(EMAIL_RE, function () { self.hit('Email address', path); return '[REDACTED-EMAIL]'; });
    return s;
  };
  Run.prototype.walk = function (v, path, key) {
    var self = this, o = this.o;
    if (Array.isArray(v)) return v.map(function (x, i) { return self.walk(x, path + '[' + i + ']'); });
    if (v && typeof v === 'object') {
      var res = {};
      var nameSecret = o.fields && typeof v.name === 'string' && KEY_RE.test(v.name) && typeof v.value === 'string';
      Object.keys(v).forEach(function (k) {
        var p = path ? path + '.' + k : k, val = v[k];
        if (k === 'pinData' && o.pin) { self.hit('Pinned sample data', p); return; }
        if (k === 'credentials' && o.creds && val && typeof val === 'object' && !Array.isArray(val)) {
          var cr = {}; var n = 0;
          Object.keys(val).forEach(function (t) {
            n++; self.hit('Credential reference', p + '.' + t);
            cr[t] = { id: 'REDACTED_CREDENTIAL_ID', name: 'Credential ' + n };
          });
          res[k] = cr; return;
        }
        if (o.hooks && HOOK_KEYS.test(k) && (typeof val === 'string' || typeof val === 'number') && String(val) !== '') {
          self.hit('Webhook ID', p); res[k] = typeof val === 'number' ? 0 : 'REDACTED_WEBHOOK_ID'; return;
        }
        if (o.creds && k === '__IMTCONN__' && (typeof val === 'number' || typeof val === 'string')) {
          self.hit('Credential reference', p); res[k] = 0; return;
        }
        if (nameSecret && k === 'value') { self.hit('Secret-named field', p); res[k] = '[REDACTED]'; return; }
        if (o.fields && typeof val === 'string' && val !== '' && KEY_RE.test(k) && !/^=/.test(val) && !/\{\{/.test(val)) {
          self.hit('Secret-named field', p); res[k] = '[REDACTED]'; return;
        }
        res[k] = self.walk(val, p, k);
      });
      return res;
    }
    if (typeof v === 'string') return this.str(v, path);
    return v;
  };

  function sanitize() {
    var raw = inp.value.trim();
    msg.className = 'tool-msg'; stats.innerHTML = ''; log.innerHTML = '';
    if (!raw) { msg.className = 'tool-msg err'; msg.textContent = 'Paste a workflow first, or press Load Sample Data.'; out.value = ''; return; }
    var run = new Run(opts()), result, mode = 'JSON';
    try { result = JSON.stringify(run.walk(JSON.parse(raw), ''), null, 2); }
    catch (e) { mode = 'text'; result = run.str(raw, '(text)'); }
    out.value = result;
    var counts = {};
    run.hits.forEach(function (h) { counts[h.cat] = (counts[h.cat] || 0) + 1; });
    msg.className = 'tool-msg ' + (run.hits.length ? 'ok' : '');
    msg.textContent = run.hits.length
      ? 'Done. ' + run.hits.length + ' value' + (run.hits.length === 1 ? '' : 's') + ' removed' + (mode === 'text' ? ' (input was not valid JSON, so text patterns were used).' : '.')
      : 'No sensitive values found with the selected options. Check the output anyway before sharing.';
    stats.innerHTML = '<div class="tool-stat"><b>' + run.hits.length + '</b>total redactions</div>' +
      Object.keys(counts).map(function (c) { return '<div class="tool-stat"><b>' + counts[c] + '</b>' + T.esc(c) + '</div>'; }).join('');
    log.innerHTML = run.hits.slice(0, 60).map(function (h) { return '<div>' + T.esc(h.cat) + ' <code>' + T.esc(h.path) + '</code></div>'; }).join('') +
      (run.hits.length > 60 ? '<div>... and ' + (run.hits.length - 60) + ' more</div>' : '');
  }

  $('run').onclick = sanitize;
  $('sample').onclick = function () {
    inp.value = JSON.stringify(SAMPLE, null, 2);
    sanitize();
  };
  $('copy').onclick = function () { if (out.value) T.copy(out.value, this); };
  $('dl').onclick = function () { if (out.value) T.download('sanitized-workflow.json', out.value, 'application/json'); };
  $('clear').onclick = function () { inp.value = ''; out.value = ''; msg.textContent = ''; stats.innerHTML = ''; log.innerHTML = ''; };
})();
