// Unit test for sw.js (C-14, v3.29.0): runs the real service worker file in a
// Node vm with fake self/caches/fetch and drives its install and fetch handlers.
// Run: node tests/sw.test.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

function makeEnv() {
  const handlers = {};
  const stores = new Map();       // cacheName -> Map(url -> response)
  const calls = { fetch: [], put: [] };
  const mkRes = (body, ok = true) => ({ ok, type: 'basic', body, clone() { return this; } });
  const cacheApi = {
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return { put: async (req, res) => { calls.put.push(req.url || req); m.set(req.url || req, res); }, addAll: async (urls) => { urls.forEach((u) => m.set(u, mkRes('pre:' + u))); } };
    },
    match: async (req) => { for (const m of stores.values()) if (m.has(req.url || req)) return m.get(req.url || req); return undefined; },
    keys: async () => [...stores.keys()],
    delete: async (k) => stores.delete(k),
  };
  const env = { fetchImpl: async () => mkRes('net') };
  const self = {
    location: { origin: 'https://app.example' },
    addEventListener: (t, fn) => { handlers[t] = fn; },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };
  const ctx = vm.createContext({
    self, caches: cacheApi, URL, Promise,
    fetch: (req, init) => { calls.fetch.push({ url: req.url, init }); return env.fetchImpl(req, init); },
  });
  vm.runInContext(src, ctx);
  const fire = async (req) => {
    let p;
    handlers.fetch({ request: req, respondWith: (x) => { p = x; } });
    return p === undefined ? undefined : p;
  };
  return { handlers, stores, calls, env, fire, mkRes, cacheApi };
}
const req = (url, extra = {}) => ({ url, method: 'GET', mode: 'cors', ...extra });

(async () => {
  await test('install precaches Firebase SDK, mermaid and the app shell', async () => {
    const e = makeEnv();
    let pending;
    e.handlers.install({ waitUntil: (p) => { pending = p; } });
    await pending;
    const cached = [...e.stores.values()][0];
    for (const u of [
      'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
      'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
      'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js',
      'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js',
      '/app.js', '/tree-utils.js', '/styles.css', '/index.html',
    ]) assert.ok(cached.has(u), 'missing from precache: ' + u);
  });

  await test('same-origin app.js is network-first and revalidated (no stale copy)', async () => {
    const e = makeEnv();
    await (await e.cacheApi.open('em-dash-md-v18')).put(req('https://app.example/app.js'), e.mkRes('OLD'));
    e.env.fetchImpl = async () => e.mkRes('NEW');
    const res = await e.fire(req('https://app.example/app.js'));
    assert.strictEqual(res.body, 'NEW');
    assert.strictEqual(e.calls.fetch[0].init.cache, 'no-cache');
    assert.ok(e.calls.put.includes('https://app.example/app.js'), 'fresh copy was not written back to the cache');
  });

  await test('same-origin falls back to the cached copy when offline', async () => {
    const e = makeEnv();
    await (await e.cacheApi.open('em-dash-md-v18')).put(req('https://app.example/app.js'), e.mkRes('CACHED'));
    e.env.fetchImpl = async () => { throw new Error('offline'); };
    const res = await e.fire(req('https://app.example/app.js'));
    assert.strictEqual(res.body, 'CACHED');
  });

  await test('a failed (non-ok) network response is not written over a good cache entry', async () => {
    const e = makeEnv();
    e.env.fetchImpl = async () => e.mkRes('oops', false);
    await e.fire(req('https://app.example/app.js'));
    assert.strictEqual(e.calls.put.length, 0);
  });

  await test('versioned CDN files stay cache-first (no network when cached)', async () => {
    const e = makeEnv();
    const u = 'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js';
    await (await e.cacheApi.open('em-dash-md-v18')).put(req(u), e.mkRes('CDN-CACHED'));
    const res = await e.fire(req(u));
    assert.strictEqual(res.body, 'CDN-CACHED');
    assert.strictEqual(e.calls.fetch.length, 0);
  });

  await test('gstatic responses may be cached at runtime, other origins may not', async () => {
    const e = makeEnv();
    await e.fire(req('https://www.gstatic.com/firebasejs/9.23.0/other.js'));
    await e.fire(req('https://evil.example/x.js'));
    assert.ok(e.calls.put.includes('https://www.gstatic.com/firebasejs/9.23.0/other.js'));
    assert.ok(!e.calls.put.includes('https://evil.example/x.js'));
  });

  await test('navigation stays network-first with index.html offline fallback', async () => {
    const e = makeEnv();
    await (await e.cacheApi.open('em-dash-md-v18')).put(req('/index.html'), e.mkRes('SHELL'));
    e.env.fetchImpl = async () => { throw new Error('offline'); };
    const res = await e.fire(req('https://app.example/', { mode: 'navigate' }));
    assert.strictEqual(res.body, 'SHELL');
  });

  await test('Firestore and auth traffic is never intercepted', async () => {
    const e = makeEnv();
    assert.strictEqual(await e.fire(req('https://firestore.googleapis.com/v1/x')), undefined);
    assert.strictEqual(await e.fire(req('https://app.example/__/auth/handler')), undefined);
  });

  await test('cache name is em-dash-md-v19', () => { assert.ok(/CACHE = 'em-dash-md-v19'/.test(src)); });

  console.log('\n' + passed + ' passed');
})();
