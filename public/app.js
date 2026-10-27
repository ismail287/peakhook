/* PeakHook dashboard. No framework. All dynamic text goes through textContent, never innerHTML. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var state = { endpoints: [], logs: [], total: 0, selected: null, tab: 'body', filter: '', detail: null, fails: 0 };

  /* ---------- tiny DOM helper ---------- */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  /* ---------- API ---------- */
  var PW_KEY = 'peakhook_pw';
  function getPw() { try { return sessionStorage.getItem(PW_KEY) || ''; } catch (e) { return state.pw || ''; } }
  function setPw(v) { state.pw = v; try { if (v) sessionStorage.setItem(PW_KEY, v); else sessionStorage.removeItem(PW_KEY); } catch (e) { /* private mode */ } }

  function api(method, url, body) {
    var opts = { method: method, headers: { 'X-Admin-Password': getPw() }, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401) { showLogin(getPw() ? 'Wrong password.' : ''); }
        if (!r.ok) { var e = new Error(data.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return data;
      });
    });
  }

  /* ---------- login ---------- */
  function showLogin(message) {
    state.authed = false;
    $('login').hidden = false;
    $('login-msg').className = 'form-msg' + (message ? ' err' : ''); $('login-msg').textContent = message || '';
    $('login-pw').value = ''; $('login-pw').focus();
  }
  function start() {
    $('login').hidden = true; state.authed = true;
    api('GET', '/api/config').then(function (c) {
      state.config = c; $('version').textContent = 'v' + c.version; $('weak-banner').hidden = !c.weak_password;
    }).catch(function () { /* handled by api() */ });
    loadEndpoints().catch(function () {}); loadLogs().catch(function () {});
  }
  var toastTimer;
  function toast(msg, isErr) {
    var t = $('toast'); t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  /* ---------- formatting ---------- */
  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function bytes(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }
  function statusBadge(d) {
    if (!d) return h('span', { class: 'badge b-none', text: 'Stored' });
    if (d.status == null) return h('span', { class: 'badge b-fail', text: /timed out/i.test(d.error || '') ? 'Timeout' : 'Error' });
    if (d.status >= 200 && d.status < 300) return h('span', { class: 'badge b-ok', text: d.status + ' OK' });
    if (d.status >= 300 && d.status < 400) return h('span', { class: 'badge b-warn', text: d.status + ' Redirect' });
    return h('span', { class: 'badge b-fail', text: d.status + ' Failed' });
  }

  /* ---------- JSON syntax viewer (safe: spans built with textContent) ---------- */
  var TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  function jsonView(text) {
    var pre = h('pre', { class: 'code' });
    var pretty = text, isJson = false;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); isJson = true; } catch (e) { /* show raw */ }
    if (!isJson) { pre.textContent = text || '(empty body)'; return pre; }
    var last = 0, m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(pretty))) {
      if (m.index > last) pre.appendChild(document.createTextNode(pretty.slice(last, m.index)));
      var cls = m[1] ? (m[2] ? 'j-key' : 'j-str') : (m[3] ? 'j-lit' : 'j-num');
      if (m[1] && m[2]) { pre.appendChild(h('span', { class: 'j-key', text: m[1] })); pre.appendChild(document.createTextNode(m[2])); }
      else pre.appendChild(h('span', { class: cls, text: m[0] }));
      last = TOKEN.lastIndex;
    }
    pre.appendChild(document.createTextNode(pretty.slice(last)));
    return pre;
  }

  function copy(text, label) {
    var done = function () { toast(label || 'Copied to clipboard'); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
    function fallback() {
      var t = h('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed: select the text manually', true); }
      document.body.removeChild(t);
    }
  }

  /* ---------- endpoints panel ---------- */
  function renderEndpoints() {
    var list = $('ep-list'); clear(list);
    state.endpoints.forEach(function (ep) {
      var fwd = h('input', { type: 'url', value: ep.forward_url, placeholder: 'Forward URL (n8n / Make / Zapier)', 'aria-label': 'Forward URL for ' + ep.name });
      list.appendChild(h('li', { class: 'ep' },
        h('div', { class: 'ep-top' }, h('span', { class: 'ep-name', text: ep.name }), h('span', { class: 'ep-count', text: ep.log_count + ' captured' })),
        h('div', { class: 'ep-url' }, h('code', { text: ep.url }),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Copy', onclick: function () { copy(ep.url, 'Webhook URL copied'); } })),
        h('div', { class: 'ep-fwd' }, fwd,
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Save', onclick: function () {
            api('PATCH', '/api/endpoints/' + ep.id, { forward_url: fwd.value.trim() }).then(function () { toast('Forward URL saved'); loadEndpoints(); })
              .catch(function (e) { toast(e.message, true); });
          } })),
        h('div', { class: 'ep-actions' }, h('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Delete', onclick: function () {
          if (!confirm('Delete "' + ep.name + '" and all of its captured webhooks?')) return;
          api('DELETE', '/api/endpoints/' + ep.id).then(function () { toast('Endpoint deleted'); if (state.filter == ep.id) state.filter = ''; loadEndpoints(); loadLogs(); })
            .catch(function (e) { toast(e.message, true); });
        } }))));
    });
    if (!state.endpoints.length) list.appendChild(h('li', { class: 'empty', text: 'No endpoints yet. Create one above.' }));
    var sel = $('filter'), cur = String(state.filter || '');
    clear(sel); sel.appendChild(h('option', { value: '', text: 'All endpoints' }));
    state.endpoints.forEach(function (ep) { sel.appendChild(h('option', { value: ep.id, text: ep.name })); });
    sel.value = cur;
  }

  /* ---------- stream panel ---------- */
  function renderLogs() {
    var list = $('log-list'); clear(list);
    $('count').textContent = state.total ? '(' + state.total + ')' : '';
    $('empty').hidden = state.logs.length > 0;
    state.logs.forEach(function (l) {
      var d = l.last_delivery;
      var row = h('button', { class: 'log' + (l.id === state.selected ? ' sel' : ''), type: 'button', onclick: function () { select(l.id); } },
        h('span', { class: 'method', text: l.method }),
        h('span', { class: 'log-main' },
          h('div', { class: 'log-title', text: l.event || (l.source === 'generic' ? 'Webhook #' + l.id : l.source + ' event') }),
          h('div', { class: 'log-sub' }, h('span', { class: 'src', text: l.source }), ' · ' + l.endpoint_name + ' · ' + ago(l.received_at) + ' · ' + bytes(l.body_size))),
        h('span', { class: 'log-side' }, statusBadge(d), h('span', { class: 'log-ms', text: d ? d.latency_ms + ' ms' : '—' })));
      list.appendChild(h('li', null, row));
    });
  }

  /* ---------- detail panel ---------- */
  function select(id) {
    state.selected = id; state.tab = 'body'; renderLogs();
    api('GET', '/api/logs/' + id).then(function (d) { state.detail = d; renderDetail(); }).catch(function (e) { toast(e.message, true); });
  }

  function replay(d, btn) {
    var body = {};
    if (!d.forward_url && !state.config.default_forward_url) {
      var url = prompt('This endpoint has no forward URL. Paste the n8n / Make / Zapier webhook URL to replay to:');
      if (!url) return;
      body.url = url.trim();
    }
    btn.disabled = true; btn.textContent = 'Replaying...';
    api('POST', '/api/replay/' + d.id, body).then(function (r) {
      var x = r.delivery;
      toast(x.status == null ? 'Replay failed: ' + x.error : 'Replayed: HTTP ' + x.status + ' in ' + x.latency_ms + ' ms', !r.ok);
      return Promise.all([loadLogs(), api('GET', '/api/logs/' + d.id).then(function (nd) { state.detail = nd; state.tab = 'deliveries'; renderDetail(); })]);
    }).catch(function (e) { toast(e.message, true); }).then(function () { btn.disabled = false; btn.textContent = 'Replay to n8n'; });
  }

  function renderDetail() {
    var box = $('detail'), d = state.detail; clear(box);
    if (!d) { box.appendChild(h('p', { class: 'empty', text: 'Select a webhook to inspect headers, payload and delivery history.' })); return; }
    var rbtn = h('button', { class: 'btn btn-primary', type: 'button', text: 'Replay to n8n' });
    rbtn.addEventListener('click', function () { replay(d, rbtn); });
    box.appendChild(h('div', { class: 'detail-head' },
      h('div', null,
        h('h3', { class: 'detail-title', text: (d.event || 'Webhook') + '  ·  #' + d.id }),
        h('div', { class: 'detail-meta' },
          h('span', { text: d.method + ' /hook/' + d.slug + d.search }), h('span', { text: new Date(d.received_at).toLocaleString() }),
          h('span', { text: 'from ' + (d.ip || 'unknown') }), h('span', { text: bytes(d.body_size) }))),
      h('div', { class: 'detail-actions' }, rbtn,
        h('button', { class: 'btn btn-ghost', type: 'button', text: 'Copy body', onclick: function () { copy(d.body, 'Body copied'); } }),
        h('button', { class: 'btn btn-danger', type: 'button', text: 'Delete', onclick: function () {
          api('DELETE', '/api/logs/' + d.id).then(function () { state.selected = null; state.detail = null; renderDetail(); loadLogs(); loadEndpoints(); }).catch(function (e) { toast(e.message, true); });
        } }))));
    var tabs = h('div', { class: 'tabs', role: 'tablist' });
    [['body', 'Payload'], ['headers', 'Headers'], ['query', 'Query'], ['deliveries', 'Deliveries (' + d.deliveries.length + ')']].forEach(function (t) {
      tabs.appendChild(h('button', { class: 'tab' + (state.tab === t[0] ? ' on' : ''), type: 'button', role: 'tab', text: t[1], onclick: function () { state.tab = t[0]; renderDetail(); } }));
    });
    box.appendChild(tabs);
    if (state.tab === 'body') {
      if (d.binary) box.appendChild(h('p', { class: 'empty', text: 'Binary payload (base64):' }));
      box.appendChild(d.binary ? h('pre', { class: 'code', text: d.body }) : jsonView(d.body));
    } else if (state.tab === 'headers') {
      box.appendChild(kvTable(d.headers));
    } else if (state.tab === 'query') {
      var qs = {}; new URLSearchParams(d.search).forEach(function (v, k) { qs[k] = v; });
      box.appendChild(Object.keys(qs).length ? kvTable(qs) : h('p', { class: 'empty', text: 'No query parameters.' }));
    } else {
      var wrap = h('div', { class: 'deliv' });
      if (!d.deliveries.length) wrap.appendChild(h('p', { class: 'empty', text: 'Not forwarded yet. Set a forward URL on the endpoint to relay webhooks automatically.' }));
      d.deliveries.forEach(function (x) {
        wrap.appendChild(h('div', { class: 'deliv-item' },
          h('div', { class: 'deliv-top' }, statusBadge(x), h('b', { text: x.kind === 'replay' ? 'Replay' : 'Forward' }),
            h('span', { class: 'log-ms', text: x.latency_ms + ' ms' }), h('span', { class: 'log-ms', text: new Date(x.created_at).toLocaleString() })),
          h('div', { class: 'deliv-url', text: x.url }),
          x.error ? h('div', { class: 'deliv-snip' }, h('span', { class: 'badge b-fail', text: x.error })) : null,
          x.response_snippet ? h('pre', { class: 'code deliv-snip', text: x.response_snippet }) : null));
      });
      box.appendChild(wrap);
    }
  }

  function kvTable(obj) {
    var t = h('table', { class: 'kv' });
    Object.keys(obj).sort().forEach(function (k) { t.appendChild(h('tr', null, h('td', { text: k }), h('td', { text: obj[k] }))); });
    return t;
  }

  /* ---------- loaders ---------- */
  function loadEndpoints() { return api('GET', '/api/endpoints').then(function (r) { state.endpoints = r.endpoints; renderEndpoints(); }); }
  function loadLogs() {
    var u = '/api/logs?limit=100' + (state.filter ? '&endpoint_id=' + encodeURIComponent(state.filter) : '');
    return api('GET', u).then(function (r) {
      state.logs = r.logs; state.total = r.total; state.fails = 0; $('live').className = 'live'; renderLogs();
    }).catch(function (e) { state.fails++; if (state.fails > 1) $('live').className = 'live off'; throw e; });
  }

  /* ---------- wire up ---------- */
  $('filter').addEventListener('change', function () { state.filter = this.value; loadLogs(); });
  $('ep-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var f = ev.target, msg = $('ep-msg'), btn = f.querySelector('button');
    btn.disabled = true; msg.className = 'form-msg'; msg.textContent = '';
    api('POST', '/api/endpoints', { name: f.name.value, slug: f.slug.value, forward_url: f.forward_url.value })
      .then(function (ep) { f.reset(); msg.className = 'form-msg ok'; msg.textContent = 'Created: ' + ep.url; return loadEndpoints(); })
      .catch(function (e) { msg.className = 'form-msg err'; msg.textContent = e.message; })
      .then(function () { btn.disabled = false; });
  });
  $('btn-demo').addEventListener('click', function () {
    var b = this; b.disabled = true;
    api('POST', '/api/seed-demo').then(function (r) { toast('Loaded 5 demo webhooks'); return Promise.all([loadEndpoints(), loadLogs()]).then(function () { if (r.log_ids.length) select(r.log_ids[r.log_ids.length - 1]); }); })
      .catch(function (e) { toast(e.message, true); }).then(function () { b.disabled = false; });
  });
  $('btn-clear').addEventListener('click', function () {
    if (!confirm('Delete ALL captured webhooks? Endpoints are kept.')) return;
    api('DELETE', '/api/logs').then(function (r) { toast('Deleted ' + r.deleted + ' webhook(s)'); state.selected = null; state.detail = null; renderDetail(); loadLogs(); loadEndpoints(); })
      .catch(function (e) { toast(e.message, true); });
  });

  $('login-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    setPw($('login-pw').value);
    start();
  });
  $('btn-logout').addEventListener('click', function () { setPw(''); state.logs = []; state.endpoints = []; state.detail = null; state.selected = null; renderLogs(); renderEndpoints(); renderDetail(); showLogin(''); });

  state.config = { default_forward_url: '' };
  if (getPw()) start(); else showLogin('');

  setInterval(function () { if (state.authed && !document.hidden) loadLogs().catch(function () {}); }, 3000);
  setInterval(function () { if (state.authed && !document.hidden) loadEndpoints().catch(function () {}); }, 15000);
})();
