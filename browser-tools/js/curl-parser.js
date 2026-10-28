/* ════════════════════════════════════════════════
   PEAK AUTOMATIONS — cURL → n8n HTTP Request node
   100% client-side. Works in the browser (window.CurlToN8n)
   and in Node (module.exports) so it can be unit tested.
   ════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CurlToN8n = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── Sample commands (all keys are fake) ─────── */
  var SAMPLES = {
    stripe: {
      label: 'Stripe Charge API',
      curl: "curl https://api.stripe.com/v1/charges \\\n" +
        "  -u sk_test_YOUR_SECRET_KEY: \\\n" +
        "  -d amount=2000 \\\n" +
        "  -d currency=usd \\\n" +
        "  -d source=tok_visa \\\n" +
        "  -d description=\"Charge for jenny.rosen@example.com\""
    },
    openai: {
      label: 'OpenAI Chat Completions',
      curl: "curl https://api.openai.com/v1/chat/completions \\\n" +
        "  -H \"Content-Type: application/json\" \\\n" +
        "  -H \"Authorization: Bearer sk-FAKEFAKEFAKEFAKEFAKEFAKEFAKE1234\" \\\n" +
        "  -d '{\n" +
        "    \"model\": \"gpt-4o-mini\",\n" +
        "    \"messages\": [{\"role\": \"user\", \"content\": \"Summarise this support ticket in one sentence.\"}],\n" +
        "    \"temperature\": 0.2\n" +
        "  }'"
    },
    webhook: {
      label: 'Webhook POST',
      curl: "curl -X POST 'https://n8n.example.com/webhook/new-lead?source=landing-page' \\\n" +
        "  -H 'Content-Type: application/json' \\\n" +
        "  -H 'X-Webhook-Secret: demo-secret-123' \\\n" +
        "  -d '{\"name\":\"Priya Nair\",\"email\":\"priya@example.com\",\"interest\":\"Invoice automation\"}'"
    }
  };

  /* ── Helpers ─────────────────────────────────── */
  function b64(s) {
    if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(s)));
    return Buffer.from(s, 'utf8').toString('base64');
  }
  function unb64(s) {
    try {
      if (typeof atob === 'function') return decodeURIComponent(escape(atob(s)));
      return Buffer.from(s, 'base64').toString('utf8');
    } catch (e) { return ''; }
  }
  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }
  function safeDecode(s) {
    try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return s; }
  }
  function pairsFromQuery(qs) {
    var out = [];
    if (!qs) return out;
    qs.split('&').forEach(function (part) {
      if (part === '') return;
      var i = part.indexOf('=');
      out.push(i === -1 ? { name: safeDecode(part), value: '' } : { name: safeDecode(part.slice(0, i)), value: safeDecode(part.slice(i + 1)) });
    });
    return out;
  }
  function headerGet(headers, name) {
    var n = name.toLowerCase();
    for (var i = headers.length - 1; i >= 0; i--) if (headers[i].name.toLowerCase() === n) return headers[i].value;
    return null;
  }
  function headerHas(headers, name) { return headerGet(headers, name) !== null; }
  function headerRemove(headers, name) {
    var n = name.toLowerCase();
    return headers.filter(function (h) { return h.name.toLowerCase() !== n; });
  }

  /* ── Shell-style tokenizer ───────────────────── */
  function shellSplit(input) {
    var s = String(input)
      .replace(/\\\r?\n/g, ' ')    // bash line continuation
      .replace(/\^\r?\n/g, ' ');   // Windows cmd line continuation
    var tokens = [], cur = '', has = false, i = 0, n = s.length;
    function push() { if (has) { tokens.push(cur); cur = ''; has = false; } }
    while (i < n) {
      var c = s[i];
      if (/\s/.test(c)) { push(); i++; continue; }
      if (c === "'") {
        var j = s.indexOf("'", i + 1);
        if (j === -1) throw new Error('Unterminated single quote in the command');
        cur += s.slice(i + 1, j); has = true; i = j + 1; continue;
      }
      if (c === '$' && s[i + 1] === "'") {            // $'...' (Chrome "Copy as cURL (bash)")
        i += 2; has = true;
        var closed = false;
        while (i < n) {
          var d = s[i];
          if (d === "'") { closed = true; i++; break; }
          if (d === '\\' && i + 1 < n) {
            var e = s[i + 1];
            if (e === 'n') { cur += '\n'; i += 2; }
            else if (e === 't') { cur += '\t'; i += 2; }
            else if (e === 'r') { cur += '\r'; i += 2; }
            else if (e === 'x' && /^[0-9a-fA-F]{2}/.test(s.substr(i + 2, 2))) { cur += String.fromCharCode(parseInt(s.substr(i + 2, 2), 16)); i += 4; }
            else if (e === 'u' && /^[0-9a-fA-F]{4}/.test(s.substr(i + 2, 4))) { cur += String.fromCharCode(parseInt(s.substr(i + 2, 4), 16)); i += 6; }
            else { cur += e; i += 2; }                // \\ \' \" and unknown escapes
          } else { cur += d; i++; }
        }
        if (!closed) throw new Error("Unterminated $'...' quote in the command");
        continue;
      }
      if (c === '"') {
        i++; has = true;
        var ok = false;
        while (i < n) {
          var q = s[i];
          if (q === '"') { ok = true; i++; break; }
          if (q === '\\' && i + 1 < n) {
            var nx = s[i + 1];
            if (nx === '"' || nx === '\\' || nx === '$' || nx === '`') { cur += nx; i += 2; }
            else { cur += '\\' + nx; i += 2; }
          } else { cur += q; i++; }
        }
        if (!ok) throw new Error('Unterminated double quote in the command');
        continue;
      }
      if (c === '\\' && i + 1 < n) { cur += s[i + 1]; has = true; i += 2; continue; }
      cur += c; has = true; i++;
    }
    push();
    return tokens;
  }

  /* ── Option tables ───────────────────────────── */
  var SHORT_VALUED = 'XHduFAebmoxwcKTEzyYrCQUtP';
  var SHORT_NAMES = { X: 'request', H: 'header', d: 'data', u: 'user', F: 'form', A: 'user-agent', e: 'referer', b: 'cookie', m: 'max-time', x: 'proxy' };
  var LONG_VALUED = {};
  ('request header data data-raw data-binary data-ascii data-urlencode json user url form form-string user-agent referer cookie max-time oauth2-bearer ' +
    'proxy output connect-timeout retry retry-delay retry-max-time cacert cert key capath resolve write-out config limit-rate interface proxy-user ' +
    'upload-file cookie-jar range continue-at dump-header trace trace-ascii time-cond expect100-timeout aws-sigv4 unix-socket cert-type key-type pass ' +
    'ciphers tls-max netrc-file variable etag-save etag-compare dns-servers doh-url proxy-header').split(' ').forEach(function (k) { LONG_VALUED[k] = true; });

  /* ── Parser ──────────────────────────────────── */
  function parse(input) {
    var text = String(input || '').trim();
    if (!text) throw new Error('Paste a cURL command first.');
    var tokens = shellSplit(text);
    while (tokens.length && /^(\$|sudo|time)$/.test(tokens[0])) tokens.shift();
    if (!tokens.length || !/^curl(\.exe)?$/i.test(tokens[0])) throw new Error('The command should start with "curl".');
    tokens.shift();

    var st = {
      method: null, headers: [], data: [], forms: [], user: null, getMode: false, head: false, json: false,
      timeout: null, insecure: false, proxy: null, url: null, positionals: [], warnings: [], location: false
    };

    function opt(name, val) {
      switch (name) {
        case 'request': st.method = String(val).toUpperCase(); break;
        case 'header': {
          var i = val.indexOf(':');
          if (i === -1) { if (/;\s*$/.test(val)) break; st.warnings.push('Ignored header without ":": ' + val); break; }
          var hn = val.slice(0, i).trim(), hv = val.slice(i + 1).trim();
          if (hn && hv !== '') st.headers.push({ name: hn, value: hv });
          else if (hn) st.warnings.push('Header "' + hn + '" has no value (curl would remove it), so it was skipped.');
          break;
        }
        case 'data': case 'data-ascii':
          if (/^@/.test(val)) { st.warnings.push('"-d ' + val + '" reads a file; files cannot be read in the browser, so it was skipped.'); break; }
          st.data.push({ v: val, raw: true }); break;
        case 'data-raw': st.data.push({ v: val, raw: true }); break;
        case 'data-binary':
          if (/^@/.test(val)) { st.warnings.push('"--data-binary ' + val + '" reads a file; it was skipped.'); break; }
          st.data.push({ v: val, raw: true }); break;
        case 'data-urlencode': {
          var eq = val.indexOf('=');
          if (/^@/.test(val) || /^[^=]*@/.test(val) && eq === -1) { st.warnings.push('"--data-urlencode ' + val + '" reads a file; it was skipped.'); break; }
          var enc = eq === -1 ? encodeURIComponent(val) : (eq === 0 ? encodeURIComponent(val.slice(1)) : val.slice(0, eq) + '=' + encodeURIComponent(val.slice(eq + 1)));
          st.data.push({ v: enc, raw: false }); break;
        }
        case 'json': st.json = true; st.data.push({ v: val, raw: true, json: true }); break;
        case 'user': st.user = val; break;
        case 'url': st.positionals.unshift(val); break;
        case 'form': case 'form-string': {
          var fi = val.indexOf('=');
          if (fi === -1) { st.warnings.push('Ignored form field without "=": ' + val); break; }
          var fv = val.slice(fi + 1);
          if (name === 'form' && /^[@<]/.test(fv)) { st.warnings.push('Form field "' + val.slice(0, fi) + '" uploads a file (' + fv + '); files cannot be read in the browser, so it was skipped.'); break; }
          st.forms.push({ name: val.slice(0, fi), value: fv }); break;
        }
        case 'user-agent': st.headers.push({ name: 'User-Agent', value: val }); break;
        case 'referer': st.headers.push({ name: 'Referer', value: val }); break;
        case 'cookie':
          if (val.indexOf('=') === -1) st.warnings.push('"-b ' + val + '" reads a cookie file; it was skipped.');
          else st.headers.push({ name: 'Cookie', value: val });
          break;
        case 'max-time': st.timeout = Math.round(parseFloat(val) * 1000) || null; break;
        case 'oauth2-bearer': st.headers.push({ name: 'Authorization', value: 'Bearer ' + val }); break;
        case 'proxy': st.proxy = val; break;
        default: break; // valued option we do not need (output, retry, ...)
      }
    }
    function flag(name) {
      if (name === 'get') st.getMode = true;
      else if (name === 'head') st.head = true;
      else if (name === 'insecure') st.insecure = true;
      else if (name === 'location') st.location = true;
    }
    var SHORT_FLAGS = { G: 'get', I: 'head', k: 'insecure', L: 'location' };

    var i = 0, rest = false;
    while (i < tokens.length) {
      var t = tokens[i];
      if (rest || t === '-' || t.charAt(0) !== '-') { st.positionals.push(t); i++; continue; }
      if (t === '--') { rest = true; i++; continue; }
      if (t.slice(0, 2) === '--') {
        var eqi = t.indexOf('='), name = (eqi === -1 ? t.slice(2) : t.slice(2, eqi));
        if (LONG_VALUED[name]) {
          var v = eqi !== -1 ? t.slice(eqi + 1) : tokens[++i];
          if (v === undefined) st.warnings.push('Option --' + name + ' is missing its value.'); else opt(name, v);
        } else flag(name);
        i++; continue;
      }
      for (var j = 1; j < t.length; j++) {
        var ch = t.charAt(j);
        if (SHORT_VALUED.indexOf(ch) !== -1) {
          var val = t.slice(j + 1) || tokens[++i];
          if (val === undefined) st.warnings.push('Option -' + ch + ' is missing its value.');
          else if (SHORT_NAMES[ch]) opt(SHORT_NAMES[ch], val);
          break;
        }
        if (SHORT_FLAGS[ch]) flag(SHORT_FLAGS[ch]);
      }
      i++;
    }

    /* URL */
    var urlTok = null;
    for (var p = 0; p < st.positionals.length; p++) if (/^[a-z][a-z0-9+.-]*:\/\//i.test(st.positionals[p])) { urlTok = st.positionals[p]; break; }
    if (!urlTok) for (p = 0; p < st.positionals.length; p++) if (/^[\w.-]+(:\d+)?(\/|$)/.test(st.positionals[p]) && /[.:]|localhost/.test(st.positionals[p])) { urlTok = st.positionals[p]; break; }
    if (!urlTok) throw new Error('No URL found in the command.');
    var absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(urlTok) ? urlTok : 'http://' + urlTok;
    var u;
    try { u = new URL(absolute); } catch (e) { throw new Error('That URL is not valid: ' + urlTok); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https URLs are supported (found ' + u.protocol + ').');
    if (st.positionals.length > 1) st.warnings.push('Extra arguments were ignored: ' + st.positionals.filter(function (x) { return x !== urlTok; }).join(' '));
    var query = pairsFromQuery(u.search.replace(/^\?/, ''));
    var userInfo = u.username ? decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password) : null;
    var baseUrl = u.origin + (u.pathname === '/' && !/\/$/.test(absolute.split('?')[0].split('#')[0]) ? '' : u.pathname);

    /* Headers that come from other options */
    var headers = st.headers.slice();
    var userStr = st.user || userInfo;
    if (userStr) {
      if (userStr.indexOf(':') === -1) st.warnings.push('"-u ' + userStr.split(':')[0] + '" has no password (curl would ask for one), so an empty password was used.');
      headers.push({ name: 'Authorization', value: 'Basic ' + b64(userStr.indexOf(':') === -1 ? userStr + ':' : userStr) });
    }
    if (st.json) {
      if (!headerHas(headers, 'content-type')) headers.push({ name: 'Content-Type', value: 'application/json' });
      if (!headerHas(headers, 'accept')) headers.push({ name: 'Accept', value: 'application/json' });
    }

    /* Method + body */
    var hasData = st.data.length > 0, hasForm = st.forms.length > 0;
    var method = st.method || (st.head ? 'HEAD' : (hasData || hasForm) && !st.getMode ? 'POST' : 'GET');
    var body = { kind: 'none' };
    var ct = headerGet(headers, 'content-type');
    var bodyNote = null;

    if (hasData && st.getMode) {
      st.data.forEach(function (d) { query = query.concat(pairsFromQuery(d.v)); });
    } else if (hasForm) {
      body = { kind: 'multipart', pairs: st.forms.slice() };
      if (hasData) st.warnings.push('Both -F and -d were given; the -d data was ignored.');
    } else if (hasData) {
      var raw = st.data.map(function (d) { return d.v; }).join(st.json ? '' : '&');
      var looksJson = /^\s*[\[{]/.test(raw);
      if (ct && /json/i.test(ct)) {
        body = { kind: 'json', raw: raw };
      } else if (!ct && looksJson) {
        body = { kind: 'json', raw: raw };
        bodyNote = 'No Content-Type header was given. curl would send this body as application/x-www-form-urlencoded; it looks like JSON, so it was converted as a JSON body.';
      } else if (!ct || /x-www-form-urlencoded/i.test(ct)) {
        if (raw.indexOf('=') === -1) body = { kind: 'raw', raw: raw, contentType: 'application/x-www-form-urlencoded' };
        else body = { kind: 'form', pairs: pairsFromQuery(raw) };
      } else {
        body = { kind: 'raw', raw: raw, contentType: ct };
      }
      if (body.kind === 'json') {
        try { body.json = JSON.parse(raw); } catch (e) { st.warnings.push('The body is declared as JSON but is not valid JSON (' + e.message + '). It was kept as typed.'); }
      }
    }
    if (bodyNote) st.warnings.push(bodyNote);
    if (body.kind !== 'none') headers = headerRemove(headers, 'content-type'); // the n8n node sets it from the body type

    /* Shell variables the user forgot to replace */
    var blob = JSON.stringify([baseUrl, query, headers, body]);
    var vars = blob.match(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g);
    if (vars) st.warnings.push('Unresolved shell variable(s) found: ' + vars.filter(function (x, k) { return vars.indexOf(x) === k; }).join(', ') + '. Replace them with real values or n8n expressions.');

    var model = {
      method: method, url: baseUrl, query: query, headers: headers, body: body,
      options: { timeout: st.timeout, allowUnauthorizedCerts: st.insecure, proxy: st.proxy },
      warnings: st.warnings, secrets: 0
    };
    model.auth = detectAuth(headers, userStr);
    return model;
  }

  function detectAuth(headers, userStr) {
    var a = headerGet(headers, 'authorization');
    if (a) {
      if (/^bearer\s/i.test(a)) return { type: 'Bearer token', detail: 'Authorization header' };
      if (/^basic\s/i.test(a)) {
        var dec = unb64(a.replace(/^basic\s+/i, ''));
        return { type: 'Basic auth', detail: 'user: ' + (dec.split(':')[0] || (userStr || '').split(':')[0] || '(empty)') };
      }
      return { type: 'Authorization header', detail: a.split(' ')[0] };
    }
    var k = headers.filter(function (h) { return SECRET_HEADER.test(h.name); })[0];
    return k ? { type: 'API key header', detail: k.name } : { type: 'None', detail: '' };
  }

  /* ── Secrets ─────────────────────────────────── */
  var SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-.*(secret|token|key|signature).*)$/i;
  var SECRET_QUERY = /^(api[_-]?key|apikey|key|token|access[_-]?token|secret|client[_-]?secret|sig|signature|password)$/i;
  var SECRET_FIELD = /(secret|passw(or)?d|token|api[_-]?key|authorization)/i;

  function placeholder(name) { return 'YOUR_' + String(name).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase(); }

  function redactJson(v, counter) {
    if (Array.isArray(v)) return v.map(function (x) { return redactJson(x, counter); });
    if (v && typeof v === 'object') {
      var o = {};
      Object.keys(v).forEach(function (k) {
        if (SECRET_FIELD.test(k) && typeof v[k] === 'string' && v[k] !== '') { counter.n++; o[k] = placeholder(k); }
        else o[k] = redactJson(v[k], counter);
      });
      return o;
    }
    return v;
  }

  /** Returns a copy of the model with secret values replaced by YOUR_* placeholders. */
  function redact(model) {
    var m = JSON.parse(JSON.stringify(model)), c = { n: 0 };
    m.headers = m.headers.map(function (h) {
      if (!SECRET_HEADER.test(h.name)) return h;
      c.n++;
      if (/^authorization$/i.test(h.name)) {
        if (/^bearer\s/i.test(h.value)) return { name: h.name, value: 'Bearer YOUR_TOKEN' };
        if (/^basic\s/i.test(h.value)) return { name: h.name, value: 'Basic YOUR_BASE64_CREDENTIALS' };
      }
      return { name: h.name, value: placeholder(h.name) };
    });
    m.query = m.query.map(function (q) { if (SECRET_QUERY.test(q.name) && q.value) { c.n++; return { name: q.name, value: placeholder(q.name) }; } return q; });
    if (m.body.kind === 'json' && m.body.json !== undefined) { m.body.json = redactJson(m.body.json, c); m.body.raw = JSON.stringify(m.body.json); }
    if (m.body.kind === 'form' || m.body.kind === 'multipart') m.body.pairs = m.body.pairs.map(function (p) {
      if (SECRET_FIELD.test(p.name) && p.value) { c.n++; return { name: p.name, value: placeholder(p.name) }; } return p;
    });
    m.secrets = c.n;
    return m;
  }

  function countSecrets(model) {
    var n = 0;
    model.headers.forEach(function (h) { if (SECRET_HEADER.test(h.name)) n++; });
    model.query.forEach(function (q) { if (SECRET_QUERY.test(q.name) && q.value) n++; });
    if (model.body.kind === 'json' && model.body.json !== undefined) { var c = { n: 0 }; redactJson(model.body.json, c); n += c.n; }
    if (model.body.pairs) model.body.pairs.forEach(function (p) { if (SECRET_FIELD.test(p.name) && p.value) n++; });
    return n;
  }

  /* ── n8n HTTP Request node ───────────────────── */
  function toN8n(model, opts) {
    opts = opts || {};
    var p = { method: model.method, url: model.url };
    if (model.query.length) {
      p.sendQuery = true;
      p.queryParameters = { parameters: model.query.map(function (q) { return { name: q.name, value: q.value }; }) };
    }
    if (model.headers.length) {
      p.sendHeaders = true;
      p.headerParameters = { parameters: model.headers.map(function (h) { return { name: h.name, value: h.value }; }) };
    }
    var b = model.body;
    if (b.kind === 'json') {
      p.sendBody = true; p.contentType = 'json'; p.specifyBody = 'json';
      p.jsonBody = (b.json !== undefined && opts.pretty !== false) ? JSON.stringify(b.json, null, 2) : b.raw;
    } else if (b.kind === 'form') {
      p.sendBody = true; p.contentType = 'form-urlencoded'; p.specifyBody = 'keypair';
      p.bodyParameters = { parameters: b.pairs.map(function (x) { return { name: x.name, value: x.value }; }) };
    } else if (b.kind === 'multipart') {
      p.sendBody = true; p.contentType = 'multipart-form-data';
      p.bodyParameters = { parameters: b.pairs.map(function (x) { return { parameterType: 'formData', name: x.name, value: x.value }; }) };
    } else if (b.kind === 'raw') {
      p.sendBody = true; p.contentType = 'raw'; p.rawContentType = b.contentType; p.body = b.raw;
    }
    var o = {};
    if (model.options.timeout) o.timeout = model.options.timeout;
    if (model.options.allowUnauthorizedCerts) o.allowUnauthorizedCerts = true;
    if (model.options.proxy) o.proxy = model.options.proxy;
    p.options = o;

    var host = '';
    try { host = new URL(model.url).host; } catch (e) { /* ignore */ }
    return {
      nodes: [{
        parameters: p,
        id: opts.id || uuid(),
        name: (model.method + ' ' + host).slice(0, 60),
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [0, 0]
      }],
      connections: {}
    };
  }

  /* ── Breakdown (for the inspection table) ────── */
  function toBreakdown(model) {
    var rows = [];
    rows.push({ section: 'Method', items: [{ k: 'Method', v: model.method }] });
    rows.push({ section: 'URL', items: [{ k: 'URL', v: model.url }] });
    rows.push({ section: 'Query parameters', items: model.query.map(function (q) { return { k: q.name, v: q.value }; }) });
    rows.push({ section: 'Headers', items: model.headers.map(function (h) { return { k: h.name, v: h.value }; }) });
    var b = model.body, items = [];
    if (b.kind === 'json') items = [{ k: 'Type', v: 'JSON' }, { k: 'Body', v: b.json !== undefined ? JSON.stringify(b.json, null, 2) : b.raw }];
    else if (b.kind === 'form') items = [{ k: 'Type', v: 'Form URL-encoded' }].concat(b.pairs.map(function (x) { return { k: x.name, v: x.value }; }));
    else if (b.kind === 'multipart') items = [{ k: 'Type', v: 'Multipart form-data' }].concat(b.pairs.map(function (x) { return { k: x.name, v: x.value }; }));
    else if (b.kind === 'raw') items = [{ k: 'Type', v: 'Raw (' + b.contentType + ')' }, { k: 'Body', v: b.raw }];
    rows.push({ section: 'Body', items: items });
    rows.push({ section: 'Authentication', items: model.auth.type === 'None' ? [] : [{ k: model.auth.type, v: model.auth.detail }] });
    var opt = [];
    if (model.options.timeout) opt.push({ k: 'Timeout', v: model.options.timeout + ' ms' });
    if (model.options.allowUnauthorizedCerts) opt.push({ k: 'Ignore SSL issues', v: 'true' });
    if (model.options.proxy) opt.push({ k: 'Proxy', v: model.options.proxy });
    rows.push({ section: 'Options', items: opt });
    return rows;
  }

  function breakdownText(rows) {
    return rows.filter(function (r) { return r.items.length; }).map(function (r) {
      return r.section + '\n' + r.items.map(function (i) { return '  ' + i.k + ': ' + i.v; }).join('\n');
    }).join('\n\n');
  }

  return { SAMPLES: SAMPLES, parse: parse, redact: redact, countSecrets: countSecrets, toN8n: toN8n, toBreakdown: toBreakdown, breakdownText: breakdownText, shellSplit: shellSplit };
});
