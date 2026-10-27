'use strict';
/**
 * PeakHook - self-hosted webhook vault, inspector and replay gateway.
 * Built by Peak Automations (https://peakautomations.online). MIT licensed.
 *
 * One dependency (better-sqlite3). Everything else is Node 20 built-ins.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const VERSION = require('./package.json').version;

/* ---------- config ---------- */
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const cfg = {
  port: int(process.env.PORT, 3000),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  retentionDays: int(process.env.RETENTION_DAYS, 30),
  defaultForwardUrl: (process.env.DEFAULT_FORWARD_URL || '').trim(),
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  maxBody: int(process.env.MAX_BODY_BYTES, 1024 * 1024),
  forwardTimeout: int(process.env.FORWARD_TIMEOUT_MS, 10000),
  trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || ''),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
};
const WEAK_PASSWORDS = new Set(['changeme', 'admin123', 'admin', 'password', '123456']);

if (!cfg.adminPassword) {
  console.error('ADMIN_PASSWORD is not set. Set it in your environment or .env file and start again.');
  process.exit(1);
}
if (WEAK_PASSWORDS.has(cfg.adminPassword.toLowerCase())) {
  console.warn('WARNING: ADMIN_PASSWORD is a well-known default. Change it before exposing PeakHook to the internet.');
}

/* ---------- database ---------- */
fs.mkdirSync(cfg.dataDir, { recursive: true });
const db = new Database(path.join(cfg.dataDir, 'peakhook.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS endpoints (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    forward_url TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
    method      TEXT NOT NULL,
    search      TEXT NOT NULL DEFAULT '',
    headers     TEXT NOT NULL,
    body        BLOB NOT NULL,
    body_size   INTEGER NOT NULL,
    ip          TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'generic',
    event       TEXT NOT NULL DEFAULT '',
    received_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS deliveries (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    log_id           INTEGER NOT NULL REFERENCES logs(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL,           -- 'forward' | 'replay'
    url              TEXT NOT NULL,
    status           INTEGER,                 -- HTTP status, NULL when the request failed
    latency_ms       INTEGER NOT NULL,
    error            TEXT,
    response_snippet TEXT,
    created_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_logs_received  ON logs(received_at);
  CREATE INDEX IF NOT EXISTS idx_logs_endpoint  ON logs(endpoint_id);
  CREATE INDEX IF NOT EXISTS idx_deliv_log      ON deliveries(log_id);
`);

const q = {
  endpointBySlug: db.prepare('SELECT * FROM endpoints WHERE slug = ?'),
  endpointById: db.prepare('SELECT * FROM endpoints WHERE id = ?'),
  endpoints: db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM logs l WHERE l.endpoint_id = e.id) AS log_count
                         FROM endpoints e ORDER BY e.id DESC`),
  insertEndpoint: db.prepare('INSERT INTO endpoints (slug, name, forward_url, created_at) VALUES (?, ?, ?, ?)'),
  deleteEndpoint: db.prepare('DELETE FROM endpoints WHERE id = ?'),
  insertLog: db.prepare(`INSERT INTO logs (endpoint_id, method, search, headers, body, body_size, ip, source, event, received_at)
                         VALUES (@endpoint_id, @method, @search, @headers, @body, @body_size, @ip, @source, @event, @received_at)`),
  logById: db.prepare(`SELECT l.*, e.slug, e.name AS endpoint_name, e.forward_url FROM logs l
                       JOIN endpoints e ON e.id = l.endpoint_id WHERE l.id = ?`),
  deleteLog: db.prepare('DELETE FROM logs WHERE id = ?'),
  insertDelivery: db.prepare(`INSERT INTO deliveries (log_id, kind, url, status, latency_ms, error, response_snippet, created_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  deliveriesForLog: db.prepare('SELECT * FROM deliveries WHERE log_id = ? ORDER BY id DESC'),
  lastDelivery: db.prepare('SELECT * FROM deliveries WHERE log_id = ? ORDER BY id DESC LIMIT 1'),
  purge: db.prepare('DELETE FROM logs WHERE received_at < ?'),
};

/* ---------- small helpers ---------- */
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'content-length', 'accept-encoding', 'expect',
]);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const PUBLIC_DIR = path.join(__dirname, 'public');
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function sendJson(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > limit) { req.resume(); return reject(new HttpError(413, `Payload too large (limit ${limit} bytes)`)); }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); return reject(new HttpError(413, `Payload too large (limit ${limit} bytes)`)); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req, 64 * 1024);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Request body must be valid JSON'); }
}

function clientIp(req) {
  if (cfg.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function flatHeaders(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
}

function detect(headers, body) {
  let json = null;
  try { json = JSON.parse(body.toString('utf8')); } catch { /* not JSON */ }
  if (headers['stripe-signature']) return { source: 'stripe', event: (json && json.type) || '' };
  if (headers['x-shopify-topic']) return { source: 'shopify', event: headers['x-shopify-topic'] };
  if (headers['x-github-event']) return { source: 'github', event: headers['x-github-event'] };
  if (headers['typeform-signature'] || (json && json.event_type === 'form_response')) return { source: 'typeform', event: (json && json.event_type) || 'form_response' };
  return { source: 'generic', event: (json && (json.type || json.event || json.event_type)) || '' };
}

function validateForwardUrl(value) {
  if (!value) return '';
  let u;
  try { u = new URL(value); } catch { throw new HttpError(400, 'forward_url must be a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'forward_url must start with http:// or https://');
  return u.toString();
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function publicBase(req) {
  if (cfg.publicUrl) return cfg.publicUrl;
  const proto = (cfg.trustProxy && req.headers['x-forwarded-proto']) || 'http';
  return `${String(proto).split(',')[0].trim()}://${req.headers.host || 'localhost:' + cfg.port}`;
}

/* ---------- auth ---------- */
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const failures = new Map(); // ip -> { count, resetAt }

function isAuthed(req) {
  const h = req.headers.authorization || '';
  let supplied = '';
  if (/^basic /i.test(h)) {
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    supplied = decoded.slice(decoded.indexOf(':') + 1);
  } else if (/^bearer /i.test(h)) supplied = h.slice(7);
  else if (req.headers['x-admin-password']) supplied = String(req.headers['x-admin-password']);
  if (!supplied) return false;
  return crypto.timingSafeEqual(sha(supplied), sha(cfg.adminPassword));
}

function requireAuth(req, res) {
  const ip = clientIp(req);
  const f = failures.get(ip);
  if (f && f.resetAt > Date.now() && f.count >= 10) {
    sendJson(res, 429, { error: 'Too many failed logins. Try again in a minute.' }, { 'Retry-After': '60' });
    return false;
  }
  if (isAuthed(req)) { failures.delete(ip); return true; }
  if (req.headers.authorization || req.headers['x-admin-password']) {
    const cur = f && f.resetAt > Date.now() ? f : { count: 0, resetAt: Date.now() + 60000 };
    cur.count++; failures.set(ip, cur);
  }
  // No WWW-Authenticate header on purpose: the dashboard has its own login form, and we don't want a browser pop-up.
  sendJson(res, 401, { error: 'Authentication required' });
  return false;
}

/* ---------- delivery (forward + replay) ---------- */
async function readLimited(res, max) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value)); size += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(parts).subarray(0, max).toString('utf8');
}

async function deliver(log, url, kind) {
  const started = performance.now();
  let status = null, error = null, snippet = null;
  try {
    const target = validateForwardUrl(url);
    const original = JSON.parse(log.headers);
    const headers = {};
    for (const [k, v] of Object.entries(original)) if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    headers['x-peakhook-hop'] = '1';
    headers['x-peakhook-log-id'] = String(log.id);
    if (kind === 'replay') headers['x-peakhook-replay'] = 'true';
    const hasBody = !['GET', 'HEAD'].includes(log.method) && log.body.length > 0;
    const res = await fetch(target, {
      method: log.method,
      headers,
      body: hasBody ? log.body : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(cfg.forwardTimeout),
    });
    status = res.status;
    snippet = await readLimited(res, 2048);
  } catch (e) {
    error = e.name === 'TimeoutError' ? `Timed out after ${cfg.forwardTimeout} ms`
      : (e.cause && e.cause.code) ? `${e.cause.code}: ${e.message}` : e.message;
  }
  const latency = Math.round(performance.now() - started);
  const info = q.insertDelivery.run(log.id, kind, url, status, latency, error, snippet, Date.now());
  return { id: Number(info.lastInsertRowid), log_id: log.id, kind, url, status, latency_ms: latency, error, response_snippet: snippet };
}

/* ---------- serializers ---------- */
function bodyView(buf) {
  const text = buf.toString('utf8');
  const binary = text.includes('�');
  return binary ? { binary: true, body: buf.toString('base64') } : { binary: false, body: text };
}

function logSummary(row) {
  const last = q.lastDelivery.get(row.id) || null;
  return {
    id: row.id, endpoint_id: row.endpoint_id, slug: row.slug, endpoint_name: row.endpoint_name,
    method: row.method, search: row.search, ip: row.ip, source: row.source, event: row.event,
    body_size: row.body_size, received_at: row.received_at, last_delivery: last,
  };
}

function endpointView(row, req) {
  return { id: row.id, slug: row.slug, name: row.name, forward_url: row.forward_url, created_at: row.created_at,
    log_count: row.log_count, url: `${publicBase(req)}/hook/${row.slug}` };
}

/* ---------- demo data ---------- */
function seedDemo() {
  let ep = q.endpointBySlug.get('demo');
  if (!ep) {
    const info = q.insertEndpoint.run('demo', 'Demo endpoint (sample data)', '', Date.now());
    ep = q.endpointById.get(info.lastInsertRowid);
  }
  const now = Date.now();
  const rand = (n) => crypto.randomBytes(n).toString('hex');
  const t = Math.floor(now / 1000);
  const demo = (minsAgo, method, headers, payload, delivery) => ({ minsAgo, method, headers, payload, delivery });
  const items = [
    demo(42, 'POST', {
      'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)', 'content-type': 'application/json',
      'stripe-signature': `t=${t},v1=${rand(32)}`,
    }, {
      id: 'evt_' + rand(12), object: 'event', api_version: '2024-06-20', created: t - 2520, type: 'invoice.payment_failed',
      data: { object: { id: 'in_' + rand(10), object: 'invoice', customer: 'cus_' + rand(7), customer_email: 'jane.doe@example.com',
        amount_due: 4900, currency: 'usd', attempt_count: 2, next_payment_attempt: t + 86400,
        hosted_invoice_url: 'https://invoice.stripe.com/i/acct_demo/test_' + rand(8) } },
    }, { status: 200, ms: 138, snippet: '{"message":"Workflow was started"}' }),
    demo(31, 'POST', {
      'user-agent': 'Shopify-Captain-Hook', 'content-type': 'application/json', 'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': 'demo-store.myshopify.com', 'x-shopify-webhook-id': crypto.randomUUID(),
      'x-shopify-hmac-sha256': crypto.randomBytes(32).toString('base64'),
    }, {
      id: 820982911946154, order_number: 1042, email: 'sam.rivera@example.com', total_price: '129.00', currency: 'USD',
      financial_status: 'paid', fulfillment_status: null,
      line_items: [{ title: 'Standing Desk Mat', quantity: 1, price: '49.00' }, { title: 'Cable Management Kit', quantity: 2, price: '40.00' }],
      shipping_address: { first_name: 'Sam', city: 'Austin', country_code: 'US' },
    }, { status: 200, ms: 96, snippet: '{"ok":true}' }),
    demo(18, 'POST', {
      'user-agent': 'Typeform Webhooks', 'content-type': 'application/json', 'typeform-signature': 'sha256=' + crypto.randomBytes(32).toString('base64'),
    }, {
      event_id: rand(13), event_type: 'form_response',
      form_response: { form_id: 'aB3dE9', submitted_at: new Date(now - 18 * 60000).toISOString(),
        definition: { title: 'Free automation audit request' },
        answers: [
          { type: 'text', field: { ref: 'name' }, text: 'Priya Nair' },
          { type: 'email', field: { ref: 'email' }, email: 'priya@example.com' },
          { type: 'choice', field: { ref: 'tool' }, choice: { label: 'n8n' } },
          { type: 'number', field: { ref: 'hours' }, number: 12 },
        ] },
    }, { status: 500, ms: 1210, snippet: '{"code":500,"message":"Error in workflow: Gmail credential expired"}' }),
    demo(9, 'POST', {
      'user-agent': 'GitHub-Hookshot/' + rand(3), 'content-type': 'application/json', 'x-github-event': 'push',
      'x-github-delivery': crypto.randomUUID(), 'x-hub-signature-256': 'sha256=' + rand(32),
    }, {
      ref: 'refs/heads/main', before: rand(20), after: rand(20),
      repository: { full_name: 'acme/billing-service', private: true },
      pusher: { name: 'dev-user' },
      commits: [{ id: rand(20), message: 'Fix retry backoff for failed invoices', author: { name: 'Dev User' } }],
    }, { status: 200, ms: 211, snippet: '{"message":"Workflow was started"}' }),
    demo(3, 'POST', {
      'user-agent': 'PeakHook-Demo/1.0', 'content-type': 'application/json',
    }, {
      type: 'lead.created', source: 'landing-page', lead: { name: 'Omar Haddad', email: 'omar@example.ae', phone: '+971 50 123 4567', interest: 'Invoice automation' },
    }, { status: null, ms: 10000, error: 'Timed out after 10000 ms' }),
  ];
  const insert = db.transaction(() => items.map((it) => {
    const body = Buffer.from(JSON.stringify(it.payload, null, 2));
    const headers = { host: 'peakhook.local', ...it.headers, 'content-length': String(body.length) };
    const meta = detect(headers, body);
    const at = now - it.minsAgo * 60000;
    const info = q.insertLog.run({ endpoint_id: ep.id, method: it.method, search: '', headers: JSON.stringify(headers), body,
      body_size: body.length, ip: '203.0.113.' + (10 + Math.floor(Math.random() * 200)), source: meta.source, event: meta.event, received_at: at });
    q.insertDelivery.run(info.lastInsertRowid, 'forward', 'https://n8n.example.com/webhook/demo', it.delivery.status, it.delivery.ms,
      it.delivery.error || null, it.delivery.snippet || null, at + 50);
    return Number(info.lastInsertRowid);
  }));
  return { endpoint_id: ep.id, slug: ep.slug, log_ids: insert() };
}

/* ---------- request handlers ---------- */
async function handleHook(req, res, slug) {
  const ep = q.endpointBySlug.get(slug);
  if (!ep) return sendJson(res, 404, { error: 'Unknown webhook endpoint' });
  if (req.headers['x-peakhook-hop']) return sendJson(res, 508, { error: 'Loop detected: this request already passed through PeakHook' });
  const body = await readBody(req, cfg.maxBody);
  const headers = flatHeaders(req);
  const url = new URL(req.url, 'http://localhost');
  const meta = detect(headers, body);
  const info = q.insertLog.run({ endpoint_id: ep.id, method: req.method, search: url.search, headers: JSON.stringify(headers), body,
    body_size: body.length, ip: clientIp(req), source: meta.source, event: meta.event, received_at: Date.now() });
  const logId = Number(info.lastInsertRowid);
  // Acknowledge first so senders (Stripe, Shopify...) never wait on your n8n.
  sendJson(res, 200, { ok: true, id: logId, endpoint: ep.slug });
  const target = ep.forward_url || cfg.defaultForwardUrl;
  if (target) {
    const log = q.logById.get(logId);
    deliver(log, target, 'forward').catch((e) => console.error('forward failed unexpectedly:', e.message));
  }
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'logs', '12']
  const [, resource, idPart] = parts;
  const id = idPart !== undefined ? parseInt(idPart, 10) : null;
  const m = req.method;

  if (resource === 'config' && m === 'GET') {
    return sendJson(res, 200, { version: VERSION, retention_days: cfg.retentionDays,
      default_forward_url: cfg.defaultForwardUrl, weak_password: WEAK_PASSWORDS.has(cfg.adminPassword.toLowerCase()) });
  }

  if (resource === 'endpoints') {
    if (!idPart && m === 'GET') return sendJson(res, 200, { endpoints: q.endpoints.all().map((r) => endpointView(r, req)) });
    if (!idPart && m === 'POST') {
      const b = await readJson(req);
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) throw new HttpError(400, 'name is required');
      const slug = slugify(b.slug) || crypto.randomBytes(8).toString('hex');
      if (slug.length < 3) throw new HttpError(400, 'slug must be at least 3 characters (a-z, 0-9, - or _)');
      if (q.endpointBySlug.get(slug)) throw new HttpError(409, 'slug already exists');
      const info = q.insertEndpoint.run(slug, name, validateForwardUrl(String(b.forward_url || '').trim()), Date.now());
      const row = { ...q.endpointById.get(info.lastInsertRowid), log_count: 0 };
      return sendJson(res, 201, endpointView(row, req));
    }
    if (id && m === 'PATCH') {
      const cur = q.endpointById.get(id);
      if (!cur) throw new HttpError(404, 'Endpoint not found');
      const b = await readJson(req);
      const name = b.name !== undefined ? String(b.name).trim().slice(0, 80) : cur.name;
      if (!name) throw new HttpError(400, 'name cannot be empty');
      const fwd = b.forward_url !== undefined ? validateForwardUrl(String(b.forward_url).trim()) : cur.forward_url;
      db.prepare('UPDATE endpoints SET name = ?, forward_url = ? WHERE id = ?').run(name, fwd, id);
      const row = { ...q.endpointById.get(id), log_count: db.prepare('SELECT COUNT(*) c FROM logs WHERE endpoint_id = ?').get(id).c };
      return sendJson(res, 200, endpointView(row, req));
    }
    if (id && m === 'DELETE') {
      if (!q.endpointById.get(id)) throw new HttpError(404, 'Endpoint not found');
      q.deleteEndpoint.run(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (resource === 'logs') {
    if (!idPart && m === 'GET') {
      const limit = Math.min(Math.max(int(url.searchParams.get('limit'), 50), 1), 200);
      const endpointId = int(url.searchParams.get('endpoint_id'), 0);
      const where = [], args = [];
      if (endpointId) { where.push('l.endpoint_id = ?'); args.push(endpointId); }
      const before = int(url.searchParams.get('before_id'), 0);
      if (before) { where.push('l.id < ?'); args.push(before); }
      const rows = db.prepare(`SELECT l.*, e.slug, e.name AS endpoint_name FROM logs l JOIN endpoints e ON e.id = l.endpoint_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.id DESC LIMIT ?`).all(...args, limit);
      const total = db.prepare('SELECT COUNT(*) c FROM logs').get().c;
      return sendJson(res, 200, { total, logs: rows.map(logSummary) });
    }
    if (id && m === 'GET') {
      const row = q.logById.get(id);
      if (!row) throw new HttpError(404, 'Log not found');
      return sendJson(res, 200, { ...logSummary(row), headers: JSON.parse(row.headers), ...bodyView(row.body),
        forward_url: row.forward_url, deliveries: q.deliveriesForLog.all(id) });
    }
    if (id && m === 'DELETE') {
      if (!q.logById.get(id)) throw new HttpError(404, 'Log not found');
      q.deleteLog.run(id);
      return sendJson(res, 200, { ok: true });
    }
    if (!idPart && m === 'DELETE') {
      const endpointId = int(url.searchParams.get('endpoint_id'), 0);
      const info = endpointId ? db.prepare('DELETE FROM logs WHERE endpoint_id = ?').run(endpointId) : db.prepare('DELETE FROM logs').run();
      return sendJson(res, 200, { ok: true, deleted: info.changes });
    }
  }

  if (resource === 'replay' && id && m === 'POST') {
    const log = q.logById.get(id);
    if (!log) throw new HttpError(404, 'Log not found');
    const b = await readJson(req);
    const target = validateForwardUrl(String(b.url || '').trim()) || log.forward_url || cfg.defaultForwardUrl;
    if (!target) throw new HttpError(400, 'No target URL. Set a forward URL on the endpoint, set DEFAULT_FORWARD_URL, or pass {"url": "..."}.');
    const delivery = await deliver(log, target, 'replay');
    return sendJson(res, 200, { ok: delivery.status !== null && delivery.status < 400, delivery });
  }

  if (resource === 'seed-demo' && m === 'POST') return sendJson(res, 201, seedDemo());

  throw new HttpError(404, 'Not found');
}

function serveStatic(req, res, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Method not allowed');
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Not found');
  const data = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': data.length,
    'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
  res.end(req.method === 'HEAD' ? undefined : data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p === '/api/health') return sendJson(res, 200, { status: 'ok', version: VERSION, uptime_s: Math.round(process.uptime()) });
    const hook = /^\/hook\/([A-Za-z0-9_-]{3,64})\/?$/.exec(p);
    if (hook) return await handleHook(req, res, hook[1]);
    // The dashboard files are public (no secrets in them); every /api/* call needs the admin password.
    if (!p.startsWith('/api/')) return serveStatic(req, res, p);
    if (!requireAuth(req, res)) return;
    return await handleApi(req, res, url);
  } catch (e) {
    if (res.headersSent) return;
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;

/* ---------- retention + lifecycle ---------- */
function purgeOld() {
  if (cfg.retentionDays <= 0) return;
  const info = q.purge.run(Date.now() - cfg.retentionDays * 86400000);
  if (info.changes) console.log(`Retention: removed ${info.changes} webhook(s) older than ${cfg.retentionDays} days`);
}
purgeOld();
setInterval(purgeOld, 3600000).unref();

server.listen(cfg.port, '0.0.0.0', () => console.log(`PeakHook ${VERSION} listening on http://0.0.0.0:${cfg.port}  (data: ${cfg.dataDir})`));

function shutdown() {
  console.log('Shutting down...');
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
