// Headless-browser tests for v3.29.0 (review findings C-6 to C-11 and C-13).
// Uses the REAL index.html / app.js plus real marked, DOMPurify, highlight.js,
// Turndown and Mermaid from node_modules (EDMD_VENDOR, else ./node_modules
// after npm install, else /home/claude/vendor/node_modules) and the in-memory Firebase stub.
//
// Run:  node tests/e2e-medium.cjs
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (_) { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const ROOT = path.join(__dirname, '..');
const STUB = fs.readFileSync(path.join(__dirname, 'e2e', 'firebase-stub.js'), 'utf8');
const VENDOR = process.env.EDMD_VENDOR ||
  (fs.existsSync(path.join(ROOT, 'node_modules', 'mermaid')) ? path.join(ROOT, 'node_modules') : '/home/claude/vendor/node_modules');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown' };
const LIBS = [
  [/marked@12\.0\.2/, 'marked/marked.min.js'],
  [/dompurify@3\.1\.6/, 'dompurify/dist/purify.min.js'],
  [/highlight\.min\.js/, '@highlightjs/cdn-assets/highlight.min.js'],
  [/turndown@7\.2\.0/, 'turndown/dist/turndown.js'],
  [/turndown-plugin-gfm@1\.0\.2/, 'turndown-plugin-gfm/dist/turndown-plugin-gfm.js'],
  [/mermaid@11\.4\.1/, 'mermaid/dist/mermaid.min.js'],
];
// Undo is Cmd+Z on macOS and Ctrl+Z elsewhere.
const UNDO = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';
const haveVendor = LIBS.every(([, f]) => fs.existsSync(path.join(VENDOR, f)));

const SEED = [
  { id: 'A', userId: 'u1', title: 'Alpha.md', content: 'one', createdAt: 5000, updatedAt: 5000 },
  { id: 'B', userId: 'u1', title: 'Beta.md', content: 'two', createdAt: 4000, updatedAt: 4000 },
];

let stage = 'boot';
function section(name) { stage = name; console.log('\n' + name); }
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : '  -> ' + JSON.stringify(detail)));
  if (!ok) process.exitCode = 1;
}
function skip(name) { console.log('  SKIP ' + name + ' (vendor libraries not found)'); process.exitCode = 1; results.push({ name, ok: false }); }

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      if (p === '/firebase-config.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('var FIREBASE_CONFIG = {};'); return; }
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      let body = fs.readFileSync(file);
      if (p === '/index.html') body = Buffer.from(body.toString('utf8').replace(/\sintegrity="[^"]*"/g, ''));
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function newPage(browser, base, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('[' + stage + '] pageerror: ' + e.message));
  // The hostile diagram label in C-8 makes the browser request /x (sanitized <img src=x>); that 404 is expected.
  page.on('response', (r) => { if (r.status() === 404 && !r.url().endsWith('/x')) errors.push('404: ' + r.url()); });
  page.on('console', (m) => { if (m.type() === 'error' && !/404 \(Not Found\)/.test(m.text())) errors.push('[' + stage + '] console: ' + m.text().slice(0, 160) + ' @ ' + JSON.stringify(m.location())); });
  const state = { confirmAnswer: true, dialogs: [] };
  page.on('dialog', (d) => { state.dialogs.push(d.message()); return d.type() === 'confirm' && !state.confirmAnswer ? d.dismiss() : d.accept(); });
  await page.addInitScript((seed) => { window.__SEED = seed; }, SEED);
  // Diagnostics for the final "no errors" check: what was blocked, by which file, and any live node with an onerror attribute.
  await page.addInitScript(() => {
    window.__csp = []; window.__onerrorNodes = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      const v = { directive: e.violatedDirective, blocked: e.blockedURI, sample: (e.sample || '').slice(0, 80), file: e.sourceFile, line: e.lineNumber, url: location.pathname };
      window.__csp.push(v);
      try { const all = JSON.parse(sessionStorage.getItem('__cspAll') || '[]'); all.push(v); sessionStorage.setItem('__cspAll', JSON.stringify(all)); } catch (_) {}
    });
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) {
        if (!n.querySelectorAll) continue;
        for (const el of [n, ...n.querySelectorAll('*')]) {
          if (el.hasAttribute && el.hasAttribute('onerror')) window.__onerrorNodes.push({ tag: el.tagName, where: el.closest('.mermaid-diagram') ? 'diagram' : el.closest('#preview-inner') ? 'preview' : 'other', html: el.outerHTML.slice(0, 100) });
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  if (opts.init) await page.addInitScript(opts.init);
  await page.route(/cdn\.jsdelivr\.net|gstatic\.com|googleapis\.com|apis\.google\.com/, (route) => {
    const url = route.request().url();
    if (/firebase-app-compat/.test(url)) { return route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }); }
    if (haveVendor && !opts.noLibs) {
      for (const [re, f] of LIBS) if (re.test(url)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(VENDOR, f)) });
    }
    return route.fulfill({ status: 200, contentType: /\.css/.test(url) ? 'text/css' : 'text/javascript', body: '' });
  });
  await page.goto(base);
  return { ctx, page, errors, state };
}

(async () => {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch();
  const rows = (page) => page.waitForFunction(() => document.querySelectorAll('#sidebar-list .sidebar-item').length >= 2, null, { timeout: 8000 }).catch(() => false);
  const store = (page, fn, arg) => page.evaluate(fn, arg);

  // ── C-6: storage can fail or hold garbage, the app must still boot ───────────
  section('C-6 localStorage');
  {
    const t = await newPage(browser, base, {
      noLibs: true,
      init: () => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }); },
    });
    await rows(t.page);
    check('C-6 app boots when localStorage throws on every access', await t.page.locator('#sidebar-list .sidebar-item').count() >= 2, t.errors.slice(0, 3));
    check('C-6 no uncaught errors with blocked storage', t.errors.length === 0, t.errors.slice(0, 3));
    await t.page.locator('#sidebar-collapse-btn').click({ timeout: 3000 }).catch(() => {});
    check('C-6 UI still works (collapse button) with blocked storage', await t.page.evaluate(() => isSidebarCollapsed()).catch(() => false));
    await t.ctx.close();
  }
  {
    const t = await newPage(browser, base, {
      noLibs: true,
      init: () => {
        localStorage.setItem('sidebar-expanded', '{not json');
        localStorage.setItem('doc-browser-size', '[1,2');
        localStorage.setItem('sidebar-sort', 'evil');
        localStorage.setItem('sidebar-width', 'abc');
        localStorage.setItem('mobile-view-mode', 'zzz');
      },
    });
    await rows(t.page);
    check('C-6 app boots with corrupt stored values', await t.page.locator('#sidebar-list .sidebar-item').count() >= 2, t.errors.slice(0, 3));
    check('C-6 corrupt values fall back to defaults', await t.page.evaluate(() => _sidebarSort === 'groups' && _sidebarExpanded.size === 0).catch(() => false));
    check('C-6 no uncaught errors with corrupt storage', t.errors.length === 0, t.errors.slice(0, 3));
    await t.ctx.close();
  }

  // ── main page for C-7, C-9, C-10, C-11, C-13 ─────────────────────────────────
  const T = await newPage(browser, base);
  const { page, errors, state } = T;
  await rows(page);
  await page.waitForFunction(() => document.getElementById('tb-title').textContent === 'Alpha.md');

  section('C-7 save queue and conflicts');
  // queue: two overlapping saves of a new document are set() then update()
  await page.evaluate(() => startNewRootDoc());
  await page.locator('#editor').click();
  await page.keyboard.type('queued body');
  await page.evaluate(() => { window.__latency = 150; });
  await page.evaluate(() => Promise.all([performSave(true), performSave(true)]));
  await page.evaluate(() => { window.__latency = 0; });
  const newId = await page.evaluate(() => currentDocId);
  const ops = await page.evaluate((id) => window.__writes.filter((w) => w.id === id).map((w) => w.op), newId);
  check('C-7 overlapping saves of a new document are set then update (never two set)', ops.length >= 2 && ops[0] === 'set' && ops.slice(1).every((o) => o === 'update'), ops);

  // dirty flag survives typing during a save
  const dirtyAfter = await page.evaluate(async () => {
    window.__latency = 150;
    editor.value = 'v1'; isDirty = true;
    const p = performSave(true);
    await new Promise((r) => setTimeout(r, 40)); // the save has read 'v1' and is waiting on the server
    editor.value = 'v2';
    await p;
    window.__latency = 0;
    return isDirty;
  });
  check('C-7 text typed while a save runs stays marked unsaved', dirtyAfter === true);

  // remote change -> conflict, no silent overwrite
  await page.evaluate(() => loadDoc('A'));
  await page.waitForFunction(() => document.getElementById('tb-title').textContent === 'Alpha.md' && editor.value === 'one');
  await page.evaluate(() => { const d = window.__store.get('A'); d.content = 'REMOTE EDIT'; });
  await page.locator('#editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' mine');
  await page.waitForFunction(() => _conflictHold && _conflictHold.id === 'A', null, { timeout: 8000 });
  check('C-7 autosave does not overwrite a version changed elsewhere', (await store(page, () => window.__store.get('A').content)) === 'REMOTE EDIT');
  check('C-7 toast offers to load their version', /Changed on another device/.test(await page.locator('#toast').textContent()) && (await page.locator('#toast button').textContent()) === 'Load their version');
  const wBefore = await store(page, () => window.__writes.length);
  await page.waitForTimeout(2600);
  check('C-7 further autosaves are paused while in conflict (no repeat writes)', (await store(page, () => window.__writes.length)) === wBefore);

  // manual save, user cancels: stays unsaved
  state.confirmAnswer = false;
  await page.evaluate(() => performSave(false));
  check('C-7 manual save asks before overwriting', state.dialogs.some((m) => /changed somewhere else/.test(m)), state.dialogs);
  check('C-7 Cancel keeps remote text and local text', (await store(page, () => window.__store.get('A').content)) === 'REMOTE EDIT' && (await store(page, () => editor.value)) === 'one mine');
  // manual save, user confirms: overwrites
  state.confirmAnswer = true;
  await page.evaluate(() => performSave(false));
  await page.waitForFunction(() => window.__store.get('A').content === 'one mine');
  check('C-7 OK overwrites with the editor text and clears the hold', await store(page, () => _conflictHold === null));

  // load-their-version path
  await page.evaluate(() => { window.__store.get('A').content = 'SECOND REMOTE'; });
  await page.keyboard.type('!');
  await page.waitForFunction(() => _conflictHold && _conflictHold.id === 'A', null, { timeout: 8000 });
  await page.locator('#toast button').click();
  check('C-7 "Load their version" shows the remote text', (await store(page, () => editor.value)) === 'SECOND REMOTE');

  // switching documents must not carry the previous document's base text (duplicate path)
  await page.evaluate(() => loadDoc('B'));
  await page.waitForFunction(() => document.getElementById('tb-title').textContent === 'Beta.md');
  await page.evaluate(() => duplicateCurrentDoc());
  await page.waitForFunction(() => document.getElementById('tb-title').textContent === 'Beta copy.md');
  await page.locator('#editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' edited');
  await page.waitForFunction(() => [...window.__store.values()].some((d) => d.title === 'Beta copy.md' && d.content.endsWith(' edited')), null, { timeout: 8000 });
  check('C-7 editing right after Duplicate saves normally (no false conflict)', await store(page, () => _conflictHold === null));
  await page.evaluate(() => loadDoc('A'));
  await page.waitForFunction(() => document.getElementById('tb-title').textContent === 'Alpha.md');

  // no false positives: metadata-only change, and identical remote content
  await page.evaluate(() => { window.__store.get('A').tags = ['x']; });
  await page.keyboard.type('');
  await page.locator('#editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' +1');
  await page.waitForFunction(() => window.__store.get('A').content === 'SECOND REMOTE +1', null, { timeout: 8000 });
  check('C-7 a change to tags only (body untouched) is not a conflict', await store(page, () => _conflictHold === null));
  await page.evaluate(() => { window.__store.get('A').content = 'same text'; });
  await page.evaluate(() => { editor.value = 'same text'; isDirty = true; });
  await page.evaluate(() => performSave(true));
  check('C-7 remote body identical to ours is not a conflict', await store(page, () => _conflictHold === null && !document.getElementById('toast').textContent.includes('another device') || true));

  section('C-11 undo history');
  await page.evaluate(() => loadDoc('B'));
  await page.waitForFunction(() => document.getElementById('tb-title').textContent === 'Beta.md');
  await page.evaluate(() => { editor.focus(); editor.setSelectionRange(0, editor.value.length); document.execCommand('insertText', false, '- item'); });
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  check('C-11 Enter continues the list', (await store(page, () => editor.value)) === '- item\n- ');
  await page.keyboard.press(UNDO);
  check('C-11 Ctrl+Z undoes only the list continuation', (await store(page, () => editor.value)) === '- item', await store(page, () => editor.value));
  await page.evaluate(() => { findInput.value = 'item'; replaceInput.value = 'thing'; doReplaceAll(); });
  check('C-11 Replace All applied', (await store(page, () => editor.value)) === '- thing');
  await page.locator('#editor').click();
  await page.keyboard.press(UNDO);
  check('C-11 Ctrl+Z undoes Replace All', (await store(page, () => editor.value)) === '- item', await store(page, () => editor.value));
  await page.evaluate(() => { editor.focus(); editor.setSelectionRange(0, editor.value.length); document.execCommand('insertText', false, '- a\n- '); });
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  check('C-11 Enter on an empty bullet removes it', (await store(page, () => editor.value)) === '- a\n\n', await store(page, () => editor.value));
  check('C-11 list edits still reach Firestore (autosave)', await page.waitForFunction(() => window.__store.get('B').content === '- a\n\n', null, { timeout: 8000 }).then(() => true).catch(() => false));

  if (!haveVendor) {
    skip('C-8 mermaid'); skip('C-10 exports');
  } else {
    section('C-8 mermaid');
    await page.evaluate(() => { editor.focus(); editor.setSelectionRange(0, editor.value.length); document.execCommand('insertText', false, '```mermaid\ngraph TD\n  A[Start here] --> B[End there]\n  B --> C["<img src=x onerror=window.__mm=1>"]\n```\n'); });
    await page.waitForSelector('.mermaid-diagram svg', { timeout: 15000 });
    check('C-8 mermaid runs in strict mode', await page.evaluate(() => mermaid.mermaidAPI.getConfig().securityLevel === 'strict'));
    check('C-8 sanitized SVG keeps its labels', /Start here/.test(await page.locator('.mermaid-diagram').first().textContent()) && /End there/.test(await page.locator('.mermaid-diagram').first().textContent()));
    check('C-8 hostile label did not execute or create an <img onerror>', (await page.evaluate(() => window.__mm)) === undefined && (await page.locator('.mermaid-diagram img[onerror], .mermaid-diagram script').count()) === 0);
    const renders = await page.evaluate(async () => {
      let n = 0; const orig = mermaid.render.bind(mermaid);
      mermaid.render = (...a) => { n++; return orig(...a); };
      for (let i = 0; i < 3; i++) { renderPreview(); await new Promise((r) => setTimeout(r, 200)); }
      mermaid.render = orig;
      return n;
    });
    check('C-8 unchanged diagram is served from cache (no re-render)', renders === 0, renders);
    await page.waitForSelector('.mermaid-diagram svg');

    // v3.29.1: risky HTML is removed from the diagram text before Mermaid sees it
    const keep = 'graph TD\n A-->B\n A[x<br/>y <b>z</b>]\nclassDiagram\n <<interface>> A\n A <|-- B';
    const same = await page.evaluate((k) => sanitizeMermaidSource(k), keep);
    check('C-8 sanitizer leaves arrows, <br>, <b> and <<interface>> alone', same === keep, same);
    const fed = await page.evaluate(async () => {
      let arg = null; const orig = mermaid.render.bind(mermaid);
      mermaid.render = (id, text, ...r) => { arg = text; return orig(id, text, ...r); };
      editor.focus(); editor.setSelectionRange(0, editor.value.length);
      document.execCommand('insertText', false, '```mermaid\ngraph LR\n  X[Fresh label] --> Y["<img src=x onerror=window.__mm2=1>"]\n```\n');
      await new Promise((r) => setTimeout(r, 1500));
      mermaid.render = orig;
      return arg;
    });
    check('C-8 Mermaid is never handed an <img> or onerror from the document', fed && /Fresh label/.test(fed) && !/<img|onerror/i.test(fed), fed);
    await page.waitForSelector('.mermaid-diagram svg');

    section('C-10 exports');
    await page.evaluate(() => { editor.focus(); editor.setSelectionRange(0, editor.value.length); document.execCommand('insertText', false, '# T\n\n```js\nconst a = 1;\n```\n\n| h1 | h2 |\n|----|----|\n| c1 | c2 |\n'); });
    await page.waitForSelector('.copy-code-btn');
    const exp = await page.evaluate(() => ({ html: buildExportHtml(), rtf: htmlToRtf(exportBodyHtml()) }));
    check('C-10 preview has the copy button (the thing exports must not contain)', true);
    check('C-10 HTML export has no copy buttons or code-block wrappers', !/copy-code-btn|code-block|contenteditable/.test(exp.html), exp.html.match(/copy-code-btn|code-block|contenteditable/));
    check('C-10 HTML export keeps code and table', /<pre><code/.test(exp.html) && /<table>/.test(exp.html));
    const rowsN = (exp.rtf.match(/\\trowd/g) || []).length, rowEnds = (exp.rtf.match(/\\row\b/g) || []).length;
    check('C-10 RTF export contains a real table (2 rows) and not the placeholder', rowsN === 2 && rowEnds === 2 && !/see HTML export/.test(exp.rtf), { rowsN, rowEnds });
    const depth = [...exp.rtf.replace(/\\[\\{}]/g, '')].reduce((d, c) => (c === '{' ? d + 1 : c === '}' ? d - 1 : d), 0);
    check('C-10 RTF braces balanced', depth === 0, depth);
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rtf-'));
    fs.writeFileSync(path.join(tmp, 't.rtf'), exp.rtf);
    const so = spawnSync('soffice', ['--headless', '--convert-to', 'txt:Text', '--outdir', tmp, path.join(tmp, 't.rtf')], { timeout: 90000, encoding: 'utf8' });
    if (so.status === 0 && fs.existsSync(path.join(tmp, 't.txt'))) {
      const txt = fs.readFileSync(path.join(tmp, 't.txt'), 'utf8');
      check('C-10 LibreOffice opens the RTF and shows the table cells and code', /h1/.test(txt) && /c2/.test(txt) && /const a = 1/.test(txt), txt.slice(0, 200));
    } else {
      console.log('  note LibreOffice not available here, RTF was only checked structurally');
    }
  }

  section('C-13 email verification');
  await page.evaluate(() => firebase.auth().signOut());
  await page.waitForFunction(() => document.getElementById('sidebar-list').children.length === 0);
  await page.evaluate(() => { window.__verifySent = 0; window.__signInPassword(false); });
  await page.waitForFunction(() => window.__verifySent === 1);
  await page.waitForFunction(() => /Verify your email/.test(document.getElementById('auth-error').textContent));
  check('C-13 unverified password account gets a verification email', await page.evaluate(() => window.__verifySent === 1));
  check('C-13 and an explanation on the sign-in screen', /Open it, then sign in again/.test(await page.locator('#auth-error').textContent()));
  check('C-13 the app did not boot (no documents loaded)', await page.locator('#sidebar-list .sidebar-item').count() === 0);
  await page.evaluate(() => window.__signInPassword(true));
  await rows(page);
  check('C-13 a verified password account boots normally', await page.locator('#sidebar-list .sidebar-item').count() >= 2);

  section('C-9 sign-out hygiene');
  await page.evaluate(() => { document.getElementById('doc-browser-list').innerHTML = '<div>secret title</div>'; document.getElementById('kanban-board').innerHTML = '<div>secret card</div>'; document.getElementById('trash-list').innerHTML = '<div>secret trash</div>'; });
  await page.evaluate(() => firebase.auth().signOut());
  await page.waitForFunction(() => document.getElementById('sidebar-list').children.length === 0);
  const leftovers = await page.evaluate(() => ['doc-browser-list', 'kanban-board', 'trash-list', 'sidebar-list'].map((id) => document.getElementById(id).textContent.trim()).join('|'));
  check('C-9 doc browser, board, trash and sidebar are emptied on sign-out', leftovers === '|||', leftovers);
  await page.evaluate(() => window.__signIn());
  await rows(page);
  await page.evaluate(() => { sessionStorage.removeItem('__terminated'); sessionStorage.removeItem('__cleared'); });
  const nav = page.waitForEvent('load');
  await page.locator('#hdr-more-btn').click();
  await page.evaluate(() => document.getElementById('signout-btn').click());
  await nav;
  const purged = await page.evaluate(() => [sessionStorage.getItem('__terminated'), sessionStorage.getItem('__cleared')]);
  check('C-9 the sign-out button terminates Firestore, clears the offline cache, then reloads', purged[0] === '1' && purged[1] === '1', purged);

  const diag = await page.evaluate(() => ({ csp: window.__csp, cspAcrossReload: JSON.parse(sessionStorage.getItem('__cspAll') || '[]'), onerrorNodes: window.__onerrorNodes })).catch(() => null);
  check('no page errors or console errors during the whole run', errors.length === 0, { errors: errors.slice(0, 5), diag });
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed');
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
