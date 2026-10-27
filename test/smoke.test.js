'use strict';
// End-to-end smoke test: starts the real server, a mock n8n receiver, and exercises every endpoint.
// Run with:  npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const PASSWORD = 'test-secret-pw';
const AUTH = 'Basic ' + Buffer.from('admin:' + PASSWORD).toString('base64');
let proc, base, dataDir, mock, mockPort;
const received = [];
let mockStatus = 200;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const call = (method, p, body, headers = {}) =>
  fetch(base + p, { method, headers: { Authorization: AUTH, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timed out waiting for condition');
};

before(async () => {
  mockPort = await freePort();
  mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(mockStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: mockStatus === 200 ? 'Workflow was started' : 'boom' }));
    });
  }).listen(mockPort, '127.0.0.1');

  const port = await freePort();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peakhook-test-'));
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: PASSWORD, DATA_DIR: dataDir, MAX_BODY_BYTES: '2048', FORWARD_TIMEOUT_MS: '3000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  await until(() => /listening on/.test(out) || (proc.exitCode !== null && Promise.reject(new Error('server exited: ' + out))));
});

after(async () => {
  if (mock) mock.close();
  if (proc && proc.exitCode === null) {
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await exited; // Windows keeps the SQLite files locked until the process is gone
  }
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp dir: best effort */ }
});

test('GET /api/health is public and returns 200', async () => {
  const r = await fetch(base + '/api/health');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'ok');
});

test('the dashboard loads, but every /api call needs the admin password', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /PeakHook/);
  assert.equal((await fetch(base + '/app.js')).status, 200);
  assert.equal((await fetch(base + '/styles.css')).status, 200);
  assert.equal((await fetch(base + '/api/logs')).status, 401);
  assert.equal((await fetch(base + '/api/endpoints')).status, 401);
  assert.equal((await fetch(base + '/api/seed-demo', { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + '/api/logs', { headers: { Authorization: 'Basic ' + Buffer.from('x:wrong').toString('base64') } })).status, 401);
  assert.equal((await fetch(base + '/api/logs', { headers: { Authorization: AUTH } })).status, 200); // Basic
  assert.equal((await fetch(base + '/api/logs', { headers: { Authorization: 'Bearer ' + PASSWORD } })).status, 200); // Bearer
  assert.equal((await fetch(base + '/api/logs', { headers: { 'X-Admin-Password': PASSWORD } })).status, 200); // header
});

test('static files cannot escape the public folder', async () => {
  assert.equal((await fetch(base + '/..%2fserver.js')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
});

let endpoint, logId;

test('POST /api/endpoints creates an endpoint; GET lists it', async () => {
  const bad = await call('POST', '/api/endpoints', { name: 'x', forward_url: 'ftp://nope' });
  assert.equal(bad.status, 400);
  const r = await call('POST', '/api/endpoints', { name: 'Stripe payments', slug: 'stripe-test', forward_url: `http://127.0.0.1:${mockPort}/webhook/abc` });
  assert.equal(r.status, 201);
  endpoint = await r.json();
  assert.equal(endpoint.slug, 'stripe-test');
  assert.match(endpoint.url, /\/hook\/stripe-test$/);
  assert.equal((await call('POST', '/api/endpoints', { name: 'dupe', slug: 'stripe-test' })).status, 409);
  const list = await (await call('GET', '/api/endpoints')).json();
  assert.equal(list.endpoints.length, 1);
});

test('ALL /hook/:slug captures, stores and forwards the exact bytes', async () => {
  const payload = JSON.stringify({ type: 'invoice.payment_failed', data: { amount: 4900 } });
  const r = await fetch(base + '/hook/stripe-test?src=test&a=1', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=abc' }, body: payload });
  assert.equal(r.status, 200); // public: no auth header
  const j = await r.json();
  assert.equal(j.ok, true);
  logId = j.id;
  const fwd = await until(() => received.find((x) => x.url === '/webhook/abc'));
  assert.equal(fwd.body, payload);
  assert.equal(fwd.headers['stripe-signature'], 't=1,v1=abc');
  assert.equal(fwd.headers['x-peakhook-hop'], '1');
  const logs = await until(async () => {
    const l = (await (await call('GET', '/api/logs')).json()).logs;
    return l[0] && l[0].last_delivery ? l : null;
  });
  assert.equal(logs[0].source, 'stripe');
  assert.equal(logs[0].event, 'invoice.payment_failed');
  assert.equal(logs[0].last_delivery.status, 200);
  assert.ok(logs[0].last_delivery.latency_ms >= 0);
});

test('GET /api/logs/:id returns headers, query, body and deliveries', async () => {
  const d = await (await call('GET', '/api/logs/' + logId)).json();
  assert.equal(d.method, 'POST');
  assert.equal(d.search, '?src=test&a=1');
  assert.equal(d.headers['stripe-signature'], 't=1,v1=abc');
  assert.equal(JSON.parse(d.body).data.amount, 4900);
  assert.equal(d.deliveries.length, 1);
});

test('POST /api/replay/:id re-sends the payload and records the new status', async () => {
  const before = received.length;
  const r = await call('POST', '/api/replay/' + logId, {});
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.delivery.kind, 'replay');
  assert.equal(j.delivery.status, 200);
  assert.equal(received.length, before + 1);
  assert.equal(received[received.length - 1].headers['x-peakhook-replay'], 'true');

  mockStatus = 500;
  const failed = await (await call('POST', '/api/replay/' + logId, {})).json();
  mockStatus = 200;
  assert.equal(failed.ok, false);
  assert.equal(failed.delivery.status, 500);
  const d = await (await call('GET', '/api/logs/' + logId)).json();
  assert.equal(d.deliveries.length, 3);
});

test('replay reports a clear error when no target URL exists', async () => {
  const ep = await (await call('POST', '/api/endpoints', { name: 'No forward', slug: 'no-forward' })).json();
  const hook = await (await fetch(base + '/hook/no-forward', { method: 'POST', body: 'hello' })).json();
  assert.equal(ep.forward_url, '');
  const r = await call('POST', '/api/replay/' + hook.id, {});
  assert.equal(r.status, 400);
  const viaOverride = await call('POST', '/api/replay/' + hook.id, { url: `http://127.0.0.1:${mockPort}/override` });
  assert.equal((await viaOverride.json()).delivery.status, 200);
});

test('unreachable targets are recorded as failures, not crashes', async () => {
  const dead = await freePort();
  const r = await call('POST', '/api/replay/' + logId, { url: `http://127.0.0.1:${dead}/x` });
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.delivery.status, null);
  assert.ok(j.delivery.error);
});

test('unknown slug, loops and oversized bodies are rejected', async () => {
  assert.equal((await fetch(base + '/hook/does-not-exist', { method: 'POST' })).status, 404);
  assert.equal((await fetch(base + '/hook/stripe-test', { method: 'POST', headers: { 'x-peakhook-hop': '1' } })).status, 508);
  assert.equal((await fetch(base + '/hook/stripe-test', { method: 'POST', body: 'x'.repeat(5000) })).status, 413);
});

test('any HTTP method is captured (GET with query string)', async () => {
  const r = await fetch(base + '/hook/no-forward?challenge=abc123');
  assert.equal(r.status, 200);
});

test('POST /api/seed-demo creates 5 realistic webhooks', async () => {
  const r = await call('POST', '/api/seed-demo');
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.log_ids.length, 5);
  const logs = (await (await call('GET', '/api/logs?endpoint_id=' + j.endpoint_id)).json()).logs;
  assert.equal(logs.length, 5);
  const events = logs.map((l) => l.event).sort();
  assert.ok(events.includes('invoice.payment_failed'));
  assert.ok(events.includes('orders/create'));
  assert.ok(events.includes('form_response'));
  assert.ok(logs.some((l) => l.last_delivery && l.last_delivery.status === 500));
});

test('PATCH and DELETE endpoints and logs', async () => {
  const p = await call('PATCH', '/api/endpoints/' + endpoint.id, { forward_url: '' });
  assert.equal((await p.json()).forward_url, '');
  assert.equal((await call('DELETE', '/api/logs/' + logId)).status, 200);
  assert.equal((await call('GET', '/api/logs/' + logId)).status, 404);
  assert.equal((await call('DELETE', '/api/endpoints/' + endpoint.id)).status, 200);
  assert.equal((await call('DELETE', '/api/logs')).status, 200);
  assert.equal((await (await call('GET', '/api/logs')).json()).total, 0);
});
